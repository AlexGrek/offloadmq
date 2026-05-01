package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"time"
)

type systemInfo struct {
	OS        string `json:"os"`
	Client    string `json:"client"`
	Runtime   string `json:"runtime"`
	CPUArch   string `json:"cpu_arch"`
	CPUModel  string `json:"cpu_model"`
	MemoryGB  int    `json:"total_memory_gb"`
}

type registrationRequest struct {
	Capabilities []string   `json:"capabilities"`
	Tier         int        `json:"tier"`
	Capacity     int        `json:"capacity"`
	SystemInfo   systemInfo `json:"system_info"`
	APIKey       string     `json:"api_key"`
	AppVersion   string     `json:"app_version"`
	DisplayName  string     `json:"display_name,omitempty"`
}

type registrationResponse struct {
	AgentID string `json:"agent_id"`
	Key     string `json:"key"`
	Message string `json:"message"`
}

type authRequest struct {
	AgentID string `json:"agentId"`
	Key     string `json:"key"`
}

type authResponse struct {
	Token     string `json:"token"`
	ExpiresIn int64  `json:"expiresIn"`
}

var capabilities = []string{"shell.bash", "shellcmd.bash", "debug.echo"}

func register(cfg *Config) error {
	req := registrationRequest{
		Capabilities: capabilities,
		Tier:         cfg.Tier,
		Capacity:     cfg.Capacity,
		SystemInfo: systemInfo{
			OS:       currentOS(),
			Client:   "micro-agent",
			Runtime:  fmt.Sprintf("go%s", runtime.Version()),
			CPUArch:  runtime.GOARCH,
			CPUModel: "",
			MemoryGB: 0,
		},
		APIKey:      cfg.APIKey,
		AppVersion:  "micro-agent-v1",
		DisplayName: cfg.DisplayName,
	}

	body, err := json.Marshal(req)
	if err != nil {
		return err
	}

	resp, err := http.Post(cfg.Server+"/agent/register", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("register request failed: %w", err)
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("register failed: HTTP %d: %s", resp.StatusCode, data)
	}

	var regResp registrationResponse
	if err := json.Unmarshal(data, &regResp); err != nil {
		return fmt.Errorf("parse register response: %w", err)
	}

	cfg.AgentID = regResp.AgentID
	cfg.Key = regResp.Key
	return saveConfig(cfg)
}

func authenticate(cfg *Config) error {
	req := authRequest{AgentID: cfg.AgentID, Key: cfg.Key}
	body, err := json.Marshal(req)
	if err != nil {
		return err
	}

	resp, err := http.Post(cfg.Server+"/agent/auth", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("auth request failed: %w", err)
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("auth failed: HTTP %d: %s", resp.StatusCode, data)
	}

	var ar authResponse
	if err := json.Unmarshal(data, &ar); err != nil {
		return fmt.Errorf("parse auth response: %w", err)
	}

	cfg.JWTToken = ar.Token
	cfg.TokenExpiresIn = time.Now().Unix() + ar.ExpiresIn
	return saveConfig(cfg)
}

func ensureAuth(cfg *Config) error {
	if cfg.AgentID == "" || cfg.Key == "" {
		fmt.Println("Registering agent...")
		if err := register(cfg); err != nil {
			return fmt.Errorf("registration: %w", err)
		}
		fmt.Printf("Registered as %s\n", cfg.AgentID)
	}

	if cfg.JWTToken == "" || time.Now().Unix() >= cfg.TokenExpiresIn-60 {
		fmt.Println("Authenticating...")
		if err := authenticate(cfg); err != nil {
			return fmt.Errorf("authentication: %w", err)
		}
		fmt.Println("Authenticated")
	}

	return nil
}
