package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func captureCLIStdout(t *testing.T, run func() error) (string, error) {
	t.Helper()
	previous := os.Stdout
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("create stdout pipe: %v", err)
	}
	os.Stdout = writer
	defer func() {
		os.Stdout = previous
		_ = reader.Close()
	}()

	runErr := run()
	if err := writer.Close(); err != nil && runErr == nil {
		runErr = err
	}
	os.Stdout = previous
	output, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read captured stdout: %v", err)
	}
	return string(output), runErr
}

func TestImageGenerateNoWaitPrintsOnlyJobIDs(t *testing.T) {
	submits := 0
	polls := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/api/images/capabilities", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		_ = json.NewEncoder(w).Encode([]capabilityInfo{{
			Base:   "imggen.test",
			Tags:   []string{"txt2img"},
			Online: true,
		}})
	})
	mux.HandleFunc("/api/prompt-placeholders", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		_ = json.NewEncoder(w).Encode([]promptPlaceholder{})
	})
	mux.HandleFunc("/api/images/jobs", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req startJobRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.Capability != "imggen.test" {
			http.Error(w, "unexpected capability", http.StatusBadRequest)
			return
		}
		submits++
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(startJobResponse{JobID: fmt.Sprintf("job-%d", submits), Status: "submitted"})
	})
	mux.HandleFunc("/api/images/jobs/", func(w http.ResponseWriter, r *http.Request) {
		polls++
		http.Error(w, "detached generation must not poll", http.StatusInternalServerError)
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	configureTestServer(t, server.URL)

	stdout, err := captureCLIStdout(t, func() error {
		return cmdImageGenerate([]string{
			"a {color} bicycle",
			"--no-wait",
			"-n", "2",
			"--history=false",
		})
	})
	if err != nil {
		t.Fatalf("detached generate: %v", err)
	}
	if stdout != "job-1\njob-2\n" {
		t.Fatalf("detached stdout = %q, want only bare job IDs", stdout)
	}
	if submits != 2 {
		t.Errorf("submits = %d, want 2", submits)
	}
	if polls != 0 {
		t.Errorf("polls = %d, want 0", polls)
	}
}

func TestImageJobPollAndDownloadCompletedOutputs(t *testing.T) {
	detailsCalls := 0
	pollCalls := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/api/images/jobs/job-1", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		detailsCalls++
		_ = json.NewEncoder(w).Encode(imageJobDetail{
			JobID:      "job-1",
			Status:     "completed",
			Capability: "imggen.test",
			Workflow:   "txt2img",
			Files: []imageJobFile{
				{ImageID: "input-1", Direction: "input", Filename: "source.jpg"},
				{ImageID: "output-1", Direction: "output", Filename: "first.jpg"},
				{ImageID: "output-2", Direction: "output", Filename: "second.jpg"},
			},
		})
	})
	mux.HandleFunc("/api/images/jobs/job-1/poll", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		pollCalls++
		_ = json.NewEncoder(w).Encode(pollResponse{
			JobID:  "job-1",
			Status: "completed",
			OutputImages: []imageRef{
				{ImageID: "output-1", Filename: "first.jpg"},
				{ImageID: "output-2", Filename: "second.jpg"},
			},
		})
	})
	mux.HandleFunc("/api/images/files/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.TrimPrefix(r.URL.Path, "/api/images/files/"))
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	configureTestServer(t, server.URL)

	if err := cmdImageJob([]string{"job-1"}); err != nil {
		t.Fatalf("image job: %v", err)
	}
	if err := cmdImagePoll([]string{"job-1"}); err != nil {
		t.Fatalf("image poll: %v", err)
	}
	out := filepath.Join(t.TempDir(), "result.jpg")
	if err := cmdImageDownload([]string{"job-1", "-o", out}); err != nil {
		t.Fatalf("image download: %v", err)
	}

	if detailsCalls != 2 {
		t.Errorf("job detail calls = %d, want 2", detailsCalls)
	}
	if pollCalls != 1 {
		t.Errorf("poll calls = %d, want 1", pollCalls)
	}
	for i, name := range []string{"result.jpg", "result_2.jpg"} {
		data, err := os.ReadFile(filepath.Join(filepath.Dir(out), name))
		if err != nil {
			t.Fatalf("read downloaded output %d: %v", i+1, err)
		}
		want := fmt.Sprintf("output-%d", i+1)
		if string(data) != want {
			t.Errorf("output %d = %q, want %q", i+1, data, want)
		}
	}
}
