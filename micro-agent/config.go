package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
)

const configPath = ".offload-agent.json"

type Config struct {
	Server          string `json:"server"`
	APIKey          string `json:"apiKey"`
	AgentID         string `json:"agentId"`
	Key             string `json:"key"`
	JWTToken        string `json:"jwtToken"`
	TokenExpiresIn  int64  `json:"tokenExpiresIn"`
	Tier            int    `json:"tier"`
	Capacity        int    `json:"capacity"`
	DisplayName     string `json:"displayName,omitempty"`
	Transport       string `json:"transport,omitempty"`

	// extra holds any fields we don't understand, so we can round-trip them
	extra map[string]json.RawMessage
}

func configFilePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, configPath), nil
}

func loadConfig() (*Config, error) {
	path, err := configFilePath()
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			cfg := &Config{Tier: 1, Capacity: 1, extra: map[string]json.RawMessage{}}
			return cfg, nil
		}
		return nil, err
	}

	// First unmarshal into a raw map to capture unknown fields
	raw := map[string]json.RawMessage{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}

	cfg := &Config{extra: map[string]json.RawMessage{}}

	knownFields := map[string]bool{
		"server": true, "apiKey": true, "agentId": true, "key": true,
		"jwtToken": true, "tokenExpiresIn": true, "tier": true,
		"capacity": true, "displayName": true, "transport": true,
	}

	for k, v := range raw {
		if knownFields[k] {
			continue
		}
		cfg.extra[k] = v
	}

	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, err
	}

	if cfg.Tier == 0 {
		cfg.Tier = 1
	}
	if cfg.Capacity == 0 {
		cfg.Capacity = 1
	}

	return cfg, nil
}

func saveConfig(cfg *Config) error {
	path, err := configFilePath()
	if err != nil {
		return err
	}

	// Build a combined map: known fields + preserved extras
	combined := map[string]json.RawMessage{}

	for k, v := range cfg.extra {
		combined[k] = v
	}

	marshal := func(v any) json.RawMessage {
		b, _ := json.Marshal(v)
		return b
	}

	combined["server"] = marshal(cfg.Server)
	combined["apiKey"] = marshal(cfg.APIKey)
	combined["agentId"] = marshal(cfg.AgentID)
	combined["key"] = marshal(cfg.Key)
	combined["jwtToken"] = marshal(cfg.JWTToken)
	combined["tokenExpiresIn"] = marshal(cfg.TokenExpiresIn)
	combined["tier"] = marshal(cfg.Tier)
	combined["capacity"] = marshal(cfg.Capacity)
	if cfg.DisplayName != "" {
		combined["displayName"] = marshal(cfg.DisplayName)
	}
	if cfg.Transport != "" {
		combined["transport"] = marshal(cfg.Transport)
	}

	data, err := json.MarshalIndent(combined, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0600)
}

func currentOS() string {
	switch runtime.GOOS {
	case "darwin":
		return "macOS"
	case "linux":
		return "Linux"
	case "windows":
		return "Windows"
	default:
		return runtime.GOOS
	}
}
