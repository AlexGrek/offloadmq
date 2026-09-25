package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

var errNotLoggedIn = errors.New("not logged in — run `oai login` first")

var httpClient = &http.Client{Timeout: 60 * time.Second}

// apiError turns a non-2xx response into an error, preferring the backend's
// {"error": "..."} body (same as frontend/src/api/http.ts).
func apiError(resp *http.Response) error {
	var body struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if resp.StatusCode == http.StatusUnauthorized && body.Error == "" {
		return errors.New("unauthorized — run `oai login` again")
	}
	if body.Error != "" {
		return errors.New(body.Error)
	}
	return fmt.Errorf("HTTP %d", resp.StatusCode)
}

// doJSON sends an optional JSON body and decodes a JSON response into out.
// token may be empty for public endpoints; out may be nil.
func doJSON(method, url, token string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return apiError(resp)
	}
	if resp.StatusCode == http.StatusNoContent || out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// downloadFile GETs url with the bearer token and writes the body to destPath.
func downloadFile(url, token, destPath string) error {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	// Downloads can be large; don't apply the short API timeout.
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return apiError(resp)
	}
	f, err := os.Create(destPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(destPath)
		return err
	}
	return f.Close()
}
