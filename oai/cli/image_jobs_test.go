package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// fakeImageJobs stands in for the image-job history routes: list, cancel,
// retry (new job, which completes on its first poll), delete, and file download.
type fakeImageJobs struct {
	mu      sync.Mutex
	jobs    []imageJobDetail // newest first
	deleted []string
	polls   int
}

func (f *fakeImageJobs) server(t *testing.T) {
	t.Helper()
	find := func(id string) int {
		for i, j := range f.jobs {
			if j.JobID == id {
				return i
			}
		}
		return -1
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/images/jobs", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(f.jobs)
	})
	mux.HandleFunc("POST /api/images/jobs/{id}/cancel", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		i := find(r.PathValue("id"))
		if i < 0 {
			http.Error(w, `{"error":"Not found"}`, http.StatusNotFound)
			return
		}
		if isTerminal(f.jobs[i].Status) {
			http.Error(w, `{"error":"job is already `+f.jobs[i].Status+`"}`, http.StatusBadRequest)
			return
		}
		f.jobs[i].Status = "cancelRequested"
		_ = json.NewEncoder(w).Encode(imageCancelResponse{JobID: f.jobs[i].JobID, Status: "cancelRequested", Message: "Cancellation requested"})
	})
	mux.HandleFunc("POST /api/images/jobs/{id}/retry", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		i := find(r.PathValue("id"))
		if i < 0 || !isTerminal(f.jobs[i].Status) {
			http.Error(w, `{"error":"only failed, canceled, or completed jobs can be resubmitted"}`, http.StatusBadRequest)
			return
		}
		retry := f.jobs[i]
		retry.JobID, retry.Status = "retry-"+retry.JobID, "submitted"
		f.jobs = append([]imageJobDetail{retry}, f.jobs...)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(startJobResponse{JobID: retry.JobID, Status: "submitted"})
	})
	mux.HandleFunc("POST /api/images/jobs/{id}/poll", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.polls++
		_ = json.NewEncoder(w).Encode(pollResponse{
			JobID: r.PathValue("id"), Status: "completed",
			OutputImages: []imageRef{{ImageID: "img-" + r.PathValue("id")}},
		})
	})
	mux.HandleFunc("DELETE /api/images/jobs/{id}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		i := find(r.PathValue("id"))
		if i < 0 {
			http.Error(w, `{"error":"Not found"}`, http.StatusNotFound)
			return
		}
		f.deleted = append(f.deleted, f.jobs[i].JobID)
		f.jobs = append(f.jobs[:i], f.jobs[i+1:]...)
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /api/images/files/{id}", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("jpeg:" + r.PathValue("id")))
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	configureTestServer(t, server.URL)
}

func sampleImageJobs() *fakeImageJobs {
	return &fakeImageJobs{jobs: []imageJobDetail{
		{JobID: "3", Status: "running", Workflow: "txt2img", Capability: "imggen.a", Prompt: "a running fox"},
		{JobID: "2", Status: "failed", Workflow: "txt2img", Capability: "imggen.a", Prompt: "a failed owl"},
		{JobID: "1", Status: "completed", Workflow: "img2img", Capability: "imggen.b", Prompt: "a done cat",
			Files: []imageJobFile{{ImageID: "in", Direction: "input"}, {ImageID: "out", Direction: "output"}}},
	}}
}

func TestImageJobsListAndFilters(t *testing.T) {
	sampleImageJobs().server(t)

	out, err := captureCLIStdout(t, func() error { return cmdImageJobs(nil) })
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"JOB ID", "a running fox", "a failed owl", "a done cat"} {
		if !strings.Contains(out, want) {
			t.Errorf("table missing %q:\n%s", want, out)
		}
	}
	for args, want := range map[string]string{
		"-ids":                          "3\n2\n1\n",
		"-ids -active":                  "3\n",
		"-ids -status failed,completed": "2\n1\n",
	} {
		got, err := captureCLIStdout(t, func() error { return cmdImageJobs(strings.Fields(args)) })
		if err != nil || got != want {
			t.Errorf("jobs %s = %q, %v; want %q", args, got, err, want)
		}
	}
	got, _ := captureCLIStdout(t, func() error { return cmdImageJobs([]string{"-status", "canceled"}) })
	if got != "No matching image jobs.\n" {
		t.Errorf("empty filtered list = %q", got)
	}
	var decoded []imageJobDetail
	got, _ = captureCLIStdout(t, func() error { return cmdImageJobs([]string{"-json", "-active"}) })
	if err := json.Unmarshal([]byte(got), &decoded); err != nil || len(decoded) != 1 || decoded[0].JobID != "3" {
		t.Errorf("jobs -json -active = %q (%v)", got, err)
	}
}

func TestImageCancelContinuesPastErrors(t *testing.T) {
	f := sampleImageJobs()
	f.server(t)
	out, err := captureCLIStdout(t, func() error { return cmdImageCancel([]string{"1", "3"}) })
	if err == nil || !strings.Contains(err.Error(), "cancel 1") {
		t.Errorf("err = %v, want the finished job's refusal reported", err)
	}
	if !strings.Contains(out, "3: cancelRequested") {
		t.Errorf("out = %q: later IDs must still be cancelled", out)
	}
	if err := cmdImageCancel([]string{""}); err == nil {
		t.Error("an empty ID must be rejected")
	}
}

func TestImageRetryWaitsAndDownloads(t *testing.T) {
	shortPollInterval(t)
	f := sampleImageJobs()
	f.server(t)
	dest := filepath.Join(t.TempDir(), "again.jpg")

	out, err := captureCLIStdout(t, func() error { return cmdImageRetry([]string{"2", "-o", dest, "--progress=false"}) })
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if !strings.Contains(out, "Job: retry-2 (retry of 2)") {
		t.Errorf("out = %q", out)
	}
	if data, _ := os.ReadFile(dest); string(data) != "jpeg:img-retry-2" {
		t.Errorf("downloaded %q", data)
	}
	if _, err := captureCLIStdout(t, func() error { return cmdImageRetry([]string{"3"}) }); err == nil {
		t.Error("retrying a running job must surface the server's refusal")
	}
}

func TestImageRetryNoWaitPrintsOnlyNewID(t *testing.T) {
	f := sampleImageJobs()
	f.server(t)
	out, err := captureCLIStdout(t, func() error { return cmdImageRetry([]string{"1", "--no-wait"}) })
	if err != nil || out != "retry-1\n" {
		t.Errorf("retry --no-wait = %q, %v; want only the new ID", out, err)
	}
	if f.polls != 0 {
		t.Errorf("polls = %d, want none", f.polls)
	}
	if err := cmdImageRetry([]string{"1", "--no-wait", "-o", "x.jpg"}); err == nil {
		t.Error("-o with --no-wait must be rejected")
	}
}

func TestImageDelete(t *testing.T) {
	f := sampleImageJobs()
	f.server(t)
	out, err := captureCLIStdout(t, func() error { return cmdImageDelete([]string{"1", "nope", "2"}) })
	if err == nil || !strings.Contains(err.Error(), "delete nope") {
		t.Errorf("err = %v", err)
	}
	if strings.Join(f.deleted, ",") != "1,2" || !strings.Contains(out, "Deleted 2") {
		t.Errorf("deleted = %v, out = %q", f.deleted, out)
	}
}
