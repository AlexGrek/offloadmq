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
	"sync"
	"testing"
)

func configureTestServer(t *testing.T, serverURL string) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	if err := saveConfig(&Config{Server: serverURL, Token: "test-token", Login: "tester"}); err != nil {
		t.Fatalf("save test config: %v", err)
	}
}

func TestImageGenerateCountCreatesSeparateJobsAndFiles(t *testing.T) {
	var mu sync.Mutex
	var requests []startJobRequest

	mux := http.NewServeMux()
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
		mu.Lock()
		requests = append(requests, req)
		jobNumber := len(requests)
		mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(startJobResponse{
			JobID:  fmt.Sprintf("job-%d", jobNumber),
			Status: "submitted",
		})
	})
	mux.HandleFunc("/api/images/jobs/", func(w http.ResponseWriter, r *http.Request) {
		jobID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/images/jobs/"), "/poll")
		imageID := strings.Replace(jobID, "job-", "image-", 1)
		_ = json.NewEncoder(w).Encode(pollResponse{
			JobID:  jobID,
			Status: "completed",
			OutputImages: []imageRef{{
				ImageID:  imageID,
				Filename: imageID + ".jpg",
			}},
		})
	})
	mux.HandleFunc("/api/images/files/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.TrimPrefix(r.URL.Path, "/api/images/files/"))
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	configureTestServer(t, server.URL)

	out := filepath.Join(t.TempDir(), "result.jpg")
	err := cmdImageGenerate([]string{
		"a lighthouse",
		"-capability", "imggen.test",
		"-n", "3",
		"-o", out,
		"--profress=false",
	})
	if err != nil {
		t.Fatalf("generate batch: %v", err)
	}

	mu.Lock()
	gotRequests := append([]startJobRequest(nil), requests...)
	mu.Unlock()
	if len(gotRequests) != 3 {
		t.Fatalf("generation requests = %d, want 3", len(gotRequests))
	}
	for i, req := range gotRequests {
		if req.Prompt != "a lighthouse" || req.Capability != "imggen.test" {
			t.Errorf("request %d = %#v", i+1, req)
		}
		path := indexedOutputPath(out, i)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read output %d: %v", i+1, err)
		}
		want := fmt.Sprintf("image-%d", i+1)
		if string(data) != want {
			t.Errorf("output %d = %q, want %q", i+1, data, want)
		}
	}
}

func TestImageDescribeAcceptsMultipleInputs(t *testing.T) {
	var mu sync.Mutex
	uploadCount := 0
	var requests []describeStartRequest

	mux := http.NewServeMux()
	mux.HandleFunc("/api/images/upload", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		file, _, err := r.FormFile("file")
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_ = file.Close()
		mu.Lock()
		uploadCount++
		imageID := fmt.Sprintf("image-%d", uploadCount)
		mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(uploadResponse{ImageID: imageID})
	})
	mux.HandleFunc("/api/describe/jobs", func(w http.ResponseWriter, r *http.Request) {
		var req describeStartRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		mu.Lock()
		requests = append(requests, req)
		jobNumber := len(requests)
		mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(startJobResponse{
			JobID:  fmt.Sprintf("describe-%d", jobNumber),
			Status: "submitted",
		})
	})
	mux.HandleFunc("/api/describe/jobs/", func(w http.ResponseWriter, r *http.Request) {
		jobID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/describe/jobs/"), "/poll")
		result := "result for " + jobID
		_ = json.NewEncoder(w).Encode(describeJob{
			JobID:  jobID,
			Status: "completed",
			Result: &result,
		})
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	configureTestServer(t, server.URL)

	inputDir := t.TempDir()
	first := filepath.Join(inputDir, "first.jpg")
	second := filepath.Join(inputDir, "second.png")
	if err := os.WriteFile(first, []byte("first"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte("second"), 0600); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "description.txt")

	err := cmdImageDescribe([]string{
		first,
		"-prompt", "What is here?",
		second,
		"-capability", "llm.vision-test",
		"-o", out,
		"--progress=false",
	})
	if err != nil {
		t.Fatalf("describe batch: %v", err)
	}

	mu.Lock()
	gotUploadCount := uploadCount
	gotRequests := append([]describeStartRequest(nil), requests...)
	mu.Unlock()
	if gotUploadCount != 2 {
		t.Errorf("uploads = %d, want 2", gotUploadCount)
	}
	if len(gotRequests) != 2 {
		t.Fatalf("describe requests = %d, want 2", len(gotRequests))
	}
	for i, req := range gotRequests {
		wantImageID := fmt.Sprintf("image-%d", i+1)
		if req.ImageID != wantImageID || req.Prompt != "What is here?" || req.Capability != "llm.vision-test" {
			t.Errorf("request %d = %#v", i+1, req)
		}
		path := indexedOutputPath(out, i)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read description %d: %v", i+1, err)
		}
		want := fmt.Sprintf("result for describe-%d\n", i+1)
		if string(data) != want {
			t.Errorf("description %d = %q, want %q", i+1, data, want)
		}
	}
}

func TestImageGenerateRejectsInvalidCount(t *testing.T) {
	for _, count := range []string{"0", "11"} {
		err := cmdImageGenerate([]string{"a lighthouse", "-n", count})
		if err == nil || !strings.Contains(err.Error(), "-n must be between 1 and 10") {
			t.Errorf("-n %s error = %v", count, err)
		}
	}
}

// newImageMux serves the generate endpoints. outputs(jobID, pollCount) supplies
// each poll response; requests captures submitted jobs.
func newImageMux(
	requests *[]startJobRequest,
	outputs func(jobID string, poll int) pollResponse,
) *http.ServeMux {
	var mu sync.Mutex
	polls := map[string]int{}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/images/jobs", func(w http.ResponseWriter, r *http.Request) {
		var req startJobRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		mu.Lock()
		*requests = append(*requests, req)
		n := len(*requests)
		mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(startJobResponse{JobID: fmt.Sprintf("job-%d", n), Status: "submitted"})
	})
	mux.HandleFunc("/api/images/jobs/", func(w http.ResponseWriter, r *http.Request) {
		jobID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/images/jobs/"), "/poll")
		mu.Lock()
		polls[jobID]++
		n := polls[jobID]
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(outputs(jobID, n))
	})
	mux.HandleFunc("/api/images/files/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.TrimPrefix(r.URL.Path, "/api/images/files/"))
	})
	return mux
}

func completedWith(jobID string, imageIDs ...string) pollResponse {
	p := pollResponse{JobID: jobID, Status: "completed"}
	for _, id := range imageIDs {
		p.OutputImages = append(p.OutputImages, imageRef{ImageID: id})
	}
	return p
}

func TestImageGenerateOffsetsSeedPerJob(t *testing.T) {
	var requests []startJobRequest
	server := httptest.NewServer(newImageMux(&requests, func(id string, _ int) pollResponse {
		return completedWith(id, "img-"+id)
	}))
	t.Cleanup(server.Close)
	configureTestServer(t, server.URL)

	out := filepath.Join(t.TempDir(), "r.jpg")
	if err := cmdImageGenerate([]string{"x", "-capability", "imggen.t", "-n", "3", "-seed", "100", "-o", out, "--progress=false"}); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 3 {
		t.Fatalf("requests = %d, want 3", len(requests))
	}
	for i, req := range requests {
		if req.Seed == nil || *req.Seed != int64(100+i) {
			t.Errorf("request %d seed = %v, want %d", i+1, req.Seed, 100+i)
		}
	}

	requests = nil
	if err := cmdImageGenerate([]string{"x", "-capability", "imggen.t", "-n", "2", "-o", out, "--progress=false"}); err != nil {
		t.Fatal(err)
	}
	for i, req := range requests {
		if req.Seed != nil {
			t.Errorf("request %d seed = %d, want omitted (random)", i+1, *req.Seed)
		}
	}
}

func TestImageGenerateBatchWithMultipleOutputsDoesNotOverwrite(t *testing.T) {
	var requests []startJobRequest
	server := httptest.NewServer(newImageMux(&requests, func(id string, _ int) pollResponse {
		return completedWith(id, id+"-a", id+"-b")
	}))
	t.Cleanup(server.Close)
	configureTestServer(t, server.URL)

	dir := t.TempDir()
	out := filepath.Join(dir, "r.jpg")
	if err := cmdImageGenerate([]string{"x", "-capability", "imggen.t", "-n", "2", "-o", out, "--progress=false"}); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"r.jpg":     "job-1-a",
		"r_1_2.jpg": "job-1-b",
		"r_2.jpg":   "job-2-a",
		"r_2_2.jpg": "job-2-b",
	}
	for name, content := range want {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Errorf("%s: %v", name, err)
		} else if string(data) != content {
			t.Errorf("%s = %q, want %q", name, data, content)
		}
	}
}

func TestImageGenerateSingleRunKeepsPlainSuffixes(t *testing.T) {
	var requests []startJobRequest
	server := httptest.NewServer(newImageMux(&requests, func(id string, _ int) pollResponse {
		return completedWith(id, "a", "b")
	}))
	t.Cleanup(server.Close)
	configureTestServer(t, server.URL)

	dir := t.TempDir()
	if err := cmdImageGenerate([]string{"x", "-capability", "imggen.t", "-o", filepath.Join(dir, "r.jpg"), "--progress=false"}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"r.jpg", "r_2.jpg"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}
