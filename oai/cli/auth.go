package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
)

type authResponse struct {
	Token  string `json:"token"`
	UserID int64  `json:"user_id"`
}

type userResponse struct {
	ID               int64  `json:"id"`
	Login            string `json:"login"`
	CreatedAt        string `json:"created_at"`
	UsedStorageBytes int64  `json:"used_storage_bytes"`
}

func cmdLogin(args []string) error {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	server := fs.String("server", "", "OAI server URL (default "+defaultServer+")")
	login := fs.String("login", "", "login name")
	password := fs.String("password", "", "password (prefer the prompt or OAI_PASSWORD)")
	if _, err := parseInterleaved(fs, args); err != nil {
		return err
	}

	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	base := cfg.serverURL(*server)

	if *login == "" {
		if *login, err = readLine("Login: "); err != nil {
			return err
		}
	}
	if *password == "" {
		if *password, err = readPassword("Password: "); err != nil {
			return err
		}
	}
	if *login == "" || *password == "" {
		return errors.New("login and password are required")
	}

	var resp authResponse
	body := map[string]string{"login": *login, "password": *password}
	if err := doJSON("POST", base+"/api/auth/login", "", body, &resp); err != nil {
		return fmt.Errorf("login failed: %w", err)
	}

	cfg.Server = base
	cfg.Token = resp.Token
	cfg.Login = *login
	if err := saveConfig(cfg); err != nil {
		return err
	}
	path, _ := configFilePath()
	fmt.Printf("Logged in as %s (user id %d) on %s\nToken saved to %s\n", *login, resp.UserID, base, path)
	return nil
}

func cmdWhoami(args []string) error {
	fs := flag.NewFlagSet("whoami", flag.ContinueOnError)
	if _, err := parseInterleaved(fs, args); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var u userResponse
	if err := doJSON("GET", cfg.serverURL("")+"/api/me", cfg.Token, nil, &u); err != nil {
		return err
	}
	fmt.Fprintf(os.Stdout, "Server:  %s\nLogin:   %s\nID:      %d\nCreated: %s\nStorage: %d bytes\n",
		cfg.serverURL(""), u.Login, u.ID, u.CreatedAt, u.UsedStorageBytes)
	return nil
}
