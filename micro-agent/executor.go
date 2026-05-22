package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

type taskData struct {
	Payload json.RawMessage `json:"payload"`
}

func executeTask(t *WSTransport, task *AssignedTask) {
	cap := task.ID.Cap
	switch {
	case cap == "shell.bash":
		executeShellBash(t, task)
	case cap == "shellcmd.bash":
		executeShellcmdBash(t, task)
	case cap == "debug.echo":
		executeDebugEcho(t, task)
	default:
		reason := fmt.Sprintf("unsupported capability: %s", cap)
		_ = t.resolveTask(TaskResultReport{
			ID:         task.ID,
			Capability: cap,
			Status:     notExecutedStatus(reason),
		})
	}
}

func extractCommand(payload json.RawMessage) (string, error) {
	// Try plain string first
	var s string
	if err := json.Unmarshal(payload, &s); err == nil {
		return s, nil
	}
	// Try {"command": "..."}
	var obj struct {
		Command string `json:"command"`
	}
	if err := json.Unmarshal(payload, &obj); err == nil && obj.Command != "" {
		return obj.Command, nil
	}
	return "", fmt.Errorf("cannot extract command from payload: %s", payload)
}

func executeShellBash(t *WSTransport, task *AssignedTask) {
	cap := task.ID.Cap
	start := time.Now()

	var td taskData
	if err := json.Unmarshal(task.Data, &td); err != nil {
		_ = t.resolveTask(TaskResultReport{
			ID:         task.ID,
			Capability: cap,
			Status:     failureStatus("failed to parse task data: "+err.Error(), 0),
		})
		return
	}

	cmd, err := extractCommand(td.Payload)
	if err != nil {
		_ = t.resolveTask(TaskResultReport{
			ID:         task.ID,
			Capability: cap,
			Status:     failureStatus(err.Error(), 0),
		})
		return
	}

	t.updateProgress(TaskUpdate{
		ID:        task.ID,
		Stage:     "starting",
		LogUpdate: fmt.Sprintf("$ %s\n", cmd),
		Status:    "Starting",
	})

	proc := exec.Command("bash", "-c", cmd)
	stdoutPipe, _ := proc.StdoutPipe()
	stderrPipe, _ := proc.StderrPipe()

	if err := proc.Start(); err != nil {
		elapsed := time.Since(start).Seconds()
		_ = t.resolveTask(TaskResultReport{
			ID:         task.ID,
			Capability: cap,
			Status:     failureStatus("failed to start process: "+err.Error(), elapsed),
		})
		return
	}

	t.updateProgress(TaskUpdate{
		ID:     task.ID,
		Stage:  "running",
		Status: "Running",
	})

	var stdoutBuf, stderrBuf strings.Builder
	var wg sync.WaitGroup

	streamLines := func(scanner *bufio.Scanner, prefix string, buf *strings.Builder) {
		defer wg.Done()
		for scanner.Scan() {
			line := scanner.Text() + "\n"
			buf.WriteString(line)
			t.updateProgress(TaskUpdate{
				ID:        task.ID,
				Stage:     "running",
				LogUpdate: prefix + line,
				Status:    "Running",
			})
		}
	}

	wg.Add(2)
	go streamLines(bufio.NewScanner(stdoutPipe), "", &stdoutBuf)
	go streamLines(bufio.NewScanner(stderrPipe), "[stderr] ", &stderrBuf)

	wg.Wait()
	waitErr := proc.Wait()
	elapsed := time.Since(start).Seconds()

	output := map[string]string{
		"stdout": stdoutBuf.String(),
		"stderr": stderrBuf.String(),
	}

	if waitErr != nil {
		output["return_code"] = fmt.Sprintf("%d", proc.ProcessState.ExitCode())
		_ = t.resolveTask(TaskResultReport{
			ID:         task.ID,
			Capability: cap,
			Status:     failureStatus(fmt.Sprintf("exit code %d", proc.ProcessState.ExitCode()), elapsed),
			Output:     output,
		})
		return
	}

	_ = t.resolveTask(TaskResultReport{
		ID:         task.ID,
		Capability: cap,
		Status:     successStatus(elapsed),
		Output:     output,
	})
}

func executeShellcmdBash(t *WSTransport, task *AssignedTask) {
	cap := task.ID.Cap
	start := time.Now()

	var td taskData
	if err := json.Unmarshal(task.Data, &td); err != nil {
		_ = t.resolveTask(TaskResultReport{
			ID:         task.ID,
			Capability: cap,
			Status:     failureStatus("failed to parse task data: "+err.Error(), 0),
		})
		return
	}

	cmd, err := extractCommand(td.Payload)
	if err != nil {
		_ = t.resolveTask(TaskResultReport{
			ID:         task.ID,
			Capability: cap,
			Status:     failureStatus(err.Error(), 0),
		})
		return
	}

	t.updateProgress(TaskUpdate{
		ID:        task.ID,
		Stage:     "starting",
		LogUpdate: fmt.Sprintf("$ %s\n", cmd),
		Status:    "Starting",
	})

	out, err := exec.Command("bash", "-c", cmd).CombinedOutput()
	elapsed := time.Since(start).Seconds()

	output := map[string]string{"stdout": string(out)}

	if err != nil {
		_ = t.resolveTask(TaskResultReport{
			ID:         task.ID,
			Capability: cap,
			Status:     failureStatus(err.Error(), elapsed),
			Output:     output,
		})
		return
	}

	_ = t.resolveTask(TaskResultReport{
		ID:         task.ID,
		Capability: cap,
		Status:     successStatus(elapsed),
		Output:     output,
	})
}

func executeDebugEcho(t *WSTransport, task *AssignedTask) {
	var td taskData
	if err := json.Unmarshal(task.Data, &td); err != nil {
		_ = t.resolveTask(TaskResultReport{
			ID:         task.ID,
			Capability: task.ID.Cap,
			Status:     failureStatus("failed to parse task data: "+err.Error(), 0),
		})
		return
	}

	var payload interface{}
	_ = json.Unmarshal(td.Payload, &payload)

	_ = t.resolveTask(TaskResultReport{
		ID:         task.ID,
		Capability: task.ID.Cap,
		Status:     successStatus(0),
		Output:     map[string]interface{}{"output": payload},
	})
}
