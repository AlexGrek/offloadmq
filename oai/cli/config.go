package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const (
	configPath    = ".oai-cli.json"
	defaultServer = "https://oai.alexgr.space"
)

type Config struct {
	Server string `json:"server"`
	Token  string `json:"token"`
	Login  string `json:"login"`
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
	cfg := &Config{}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

func saveConfig(cfg *Config) error {
	path, err := configFilePath()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		return err
	}
	// WriteFile does not tighten the mode of a pre-existing file.
	return os.Chmod(path, 0600)
}

// serverURL returns the effective server base URL: the explicit override, then
// the saved config, then the default. Trailing slashes are trimmed.
func (c *Config) serverURL(override string) string {
	s := override
	if s == "" {
		s = c.Server
	}
	if s == "" {
		s = defaultServer
	}
	return strings.TrimRight(s, "/")
}

// requireLogin loads the config and fails if no token is stored.
func requireLogin() (*Config, error) {
	cfg, err := loadConfig()
	if err != nil {
		return nil, err
	}
	if cfg.Token == "" {
		return nil, errNotLoggedIn
	}
	return cfg, nil
}
