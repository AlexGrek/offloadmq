package main

import (
	"flag"
	"fmt"
	"os"
	"time"
)

func main() {
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: micro-agent [flags]\n\nFlags:\n")
		flag.PrintDefaults()
		fmt.Fprintf(os.Stderr, "\nConfig is read from ~/.offload-agent.json\n")
		fmt.Fprintf(os.Stderr, "Supported capabilities: shell.bash, shellcmd.bash, debug.echo\n")
	}

	serverFlag := flag.String("server", "", "Override server URL from config")
	apiKeyFlag := flag.String("api-key", "", "Override API key from config")
	flag.Parse()

	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load config: %v\n", err)
		os.Exit(1)
	}

	if *serverFlag != "" {
		cfg.Server = *serverFlag
	}
	if *apiKeyFlag != "" {
		cfg.APIKey = *apiKeyFlag
	}

	if cfg.Server == "" {
		fmt.Fprintf(os.Stderr, "Error: server URL is required (set in ~/.offload-agent.json or use -server flag)\n")
		os.Exit(1)
	}
	if cfg.APIKey == "" {
		fmt.Fprintf(os.Stderr, "Error: API key is required (set in ~/.offload-agent.json or use -api-key flag)\n")
		os.Exit(1)
	}

	if cfg.Transport != "" && cfg.Transport != "websocket" {
		fmt.Printf("Warning: config transport=%q, but micro-agent only supports WebSocket\n", cfg.Transport)
	}

	fmt.Printf("micro-agent starting (server=%s, tier=%d, capacity=%d)\n", cfg.Server, cfg.Tier, cfg.Capacity)

	runLoop(cfg)
}

func runLoop(cfg *Config) {
	sem := make(chan struct{}, cfg.Capacity)
	backoff := time.Second

	for {
		if err := ensureAuth(cfg); err != nil {
			fmt.Printf("Auth error: %v (retrying in %v)\n", err, backoff)
			time.Sleep(backoff)
			backoff = min(backoff*2, 30*time.Second)
			continue
		}
		backoff = time.Second

		fmt.Printf("Connecting to %s...\n", cfg.Server)
		t, err := dialWS(cfg)
		if err != nil {
			if err.Error() == "auth_expired" {
				cfg.JWTToken = ""
				cfg.TokenExpiresIn = 0
				_ = saveConfig(cfg)
				continue
			}
			fmt.Printf("WebSocket connect error: %v (retrying in %v)\n", err, backoff)
			time.Sleep(backoff)
			backoff = min(backoff*2, 30*time.Second)
			continue
		}

		fmt.Println("Connected. Polling for tasks...")
		backoff = time.Second

		for {
			task, err := t.pollTask()
			if err != nil {
				if err.Error() == "auth_expired" {
					cfg.JWTToken = ""
					cfg.TokenExpiresIn = 0
					_ = saveConfig(cfg)
				} else {
					fmt.Printf("Poll error: %v\n", err)
				}
				t.close()
				break
			}

			if task == nil {
				time.Sleep(5 * time.Second)
				continue
			}

			fmt.Printf("Task received: %s/%s\n", task.ID.Cap, task.ID.ID)

			assigned, err := t.takeTask(task.ID)
			if err != nil {
				fmt.Printf("Take task error: %v\n", err)
				if err.Error() == "auth_expired" {
					cfg.JWTToken = ""
					cfg.TokenExpiresIn = 0
					_ = saveConfig(cfg)
					t.close()
					break
				}
				continue
			}

			sem <- struct{}{}
			go func(a *AssignedTask) {
				defer func() { <-sem }()
				executeTask(t, a)
				fmt.Printf("Task done: %s/%s\n", a.ID.Cap, a.ID.ID)
			}(assigned)
		}

		sleepDur := backoff
		fmt.Printf("Reconnecting in %v...\n", sleepDur)
		time.Sleep(sleepDur)
		backoff = min(backoff*2, 30*time.Second)
	}
}

func min(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
