package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type wsRequest struct {
	ReqID  string          `json:"req_id"`
	Action string          `json:"action"`
	Params json.RawMessage `json:"params"`
}

type wsResponse struct {
	ReqID  string          `json:"req_id"`
	Type   string          `json:"type"`
	Status int             `json:"status"`
	Data   json.RawMessage `json:"data"`
	Error  *wsError        `json:"error,omitempty"`
}

type wsError struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

type TaskID struct {
	Cap string `json:"cap"`
	ID  string `json:"id"`
}

type UnassignedTask struct {
	ID   TaskID          `json:"id"`
	Data json.RawMessage `json:"data"`
}

type AssignedTask struct {
	ID   TaskID          `json:"id"`
	Data json.RawMessage `json:"data"`
}

type TaskUpdate struct {
	ID        TaskID `json:"id"`
	Stage     string `json:"stage,omitempty"`
	LogUpdate string `json:"log_update,omitempty"`
	Status    string `json:"status,omitempty"`
}

type TaskResultReport struct {
	ID         TaskID          `json:"id"`
	Capability string          `json:"capability"`
	Status     TaskResultStatus `json:"status"`
	Output     interface{}     `json:"output,omitempty"`
}

type TaskResultStatus struct {
	Success     *float64      `json:"Success,omitempty"`
	Failure     []interface{} `json:"Failure,omitempty"`
	NotExecuted *string       `json:"NotExecuted,omitempty"`
}

func successStatus(elapsedSecs float64) TaskResultStatus {
	v := elapsedSecs
	return TaskResultStatus{Success: &v}
}

func failureStatus(msg string, elapsedSecs float64) TaskResultStatus {
	return TaskResultStatus{Failure: []interface{}{msg, elapsedSecs}}
}

func notExecutedStatus(msg string) TaskResultStatus {
	s := msg
	return TaskResultStatus{NotExecuted: &s}
}

type WSTransport struct {
	conn     *websocket.Conn
	mu       sync.Mutex
	pending  map[string]chan wsResponse
	pendingMu sync.Mutex
	counter  int
}

func serverURLToWS(serverURL, token string) string {
	wsURL := serverURL
	wsURL = strings.Replace(wsURL, "https://", "wss://", 1)
	wsURL = strings.Replace(wsURL, "http://", "ws://", 1)
	return wsURL + "/private/agent/ws?token=" + token
}

func dialWS(cfg *Config) (*WSTransport, error) {
	url := serverURLToWS(cfg.Server, cfg.JWTToken)
	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	conn, resp, err := dialer.Dial(url, http.Header{})
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return nil, fmt.Errorf("auth_expired")
		}
		return nil, fmt.Errorf("dial %s: %w", url, err)
	}
	t := &WSTransport{
		conn:    conn,
		pending: map[string]chan wsResponse{},
	}
	go t.readLoop()
	return t, nil
}

func (t *WSTransport) readLoop() {
	for {
		_, data, err := t.conn.ReadMessage()
		if err != nil {
			// signal all pending waiters that connection is dead
			t.pendingMu.Lock()
			for _, ch := range t.pending {
				close(ch)
			}
			t.pending = map[string]chan wsResponse{}
			t.pendingMu.Unlock()
			return
		}

		var resp wsResponse
		if err := json.Unmarshal(data, &resp); err != nil {
			continue
		}

		if resp.Type == "heartbeat" || resp.Type == "connected" {
			continue
		}

		t.pendingMu.Lock()
		ch, ok := t.pending[resp.ReqID]
		if ok {
			delete(t.pending, resp.ReqID)
		}
		t.pendingMu.Unlock()

		if ok {
			ch <- resp
		}
	}
}

func (t *WSTransport) nextReqID() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.counter++
	return fmt.Sprintf("req-%d-%d", time.Now().UnixNano(), t.counter)
}

func (t *WSTransport) send(action string, params interface{}) (json.RawMessage, error) {
	paramBytes, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}

	reqID := t.nextReqID()
	req := wsRequest{ReqID: reqID, Action: action, Params: paramBytes}

	msgBytes, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}

	ch := make(chan wsResponse, 1)
	t.pendingMu.Lock()
	t.pending[reqID] = ch
	t.pendingMu.Unlock()

	t.mu.Lock()
	err = t.conn.WriteMessage(websocket.TextMessage, msgBytes)
	t.mu.Unlock()

	if err != nil {
		t.pendingMu.Lock()
		delete(t.pending, reqID)
		t.pendingMu.Unlock()
		return nil, fmt.Errorf("write: %w", err)
	}

	resp, ok := <-ch
	if !ok {
		return nil, fmt.Errorf("connection closed waiting for response")
	}

	if resp.Status == 401 || resp.Status == 403 {
		return nil, fmt.Errorf("auth_expired")
	}
	if resp.Status < 200 || resp.Status >= 300 {
		errMsg := "unknown error"
		if resp.Error != nil {
			errMsg = resp.Error.Message
		}
		return nil, fmt.Errorf("server error %d: %s", resp.Status, errMsg)
	}

	return resp.Data, nil
}

func (t *WSTransport) sendNoWait(action string, params interface{}) {
	paramBytes, _ := json.Marshal(params)
	reqID := t.nextReqID()
	req := wsRequest{ReqID: reqID, Action: action, Params: paramBytes}
	msgBytes, _ := json.Marshal(req)
	t.mu.Lock()
	_ = t.conn.WriteMessage(websocket.TextMessage, msgBytes)
	t.mu.Unlock()
}

func (t *WSTransport) close() {
	t.conn.Close()
}

func (t *WSTransport) pollTask() (*UnassignedTask, error) {
	data, err := t.send("poll_task", map[string]interface{}{})
	if err != nil {
		return nil, err
	}

	// null means no task available
	if string(data) == "null" {
		return nil, nil
	}

	var task UnassignedTask
	if err := json.Unmarshal(data, &task); err != nil {
		return nil, fmt.Errorf("parse poll response: %w", err)
	}
	return &task, nil
}

func (t *WSTransport) takeTask(taskID TaskID) (*AssignedTask, error) {
	params := map[string]string{"cap": taskID.Cap, "id": taskID.ID}
	data, err := t.send("take_task", params)
	if err != nil {
		return nil, err
	}

	var task AssignedTask
	if err := json.Unmarshal(data, &task); err != nil {
		return nil, fmt.Errorf("parse take response: %w", err)
	}
	return &task, nil
}

func (t *WSTransport) updateProgress(update TaskUpdate) {
	t.sendNoWait("update_progress", update)
}

func (t *WSTransport) resolveTask(report TaskResultReport) error {
	_, err := t.send("resolve_task", report)
	return err
}
