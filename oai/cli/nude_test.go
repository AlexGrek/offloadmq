package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestNudeScanUploadsSubmitsAndSavesResult(t *testing.T) {
	var mu sync.Mutex
	uploadCount := 0
	var requests []nudeStartRequest

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
	mux.HandleFunc("/api/nude-detect/jobs", func(w http.ResponseWriter, r *http.Request) {
		var req nudeStartRequest
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
			JobID:  fmt.Sprintf("nude-%d", jobNumber),
			Status: "submitted",
		})
	})
	mux.HandleFunc("/api/nude-detect/jobs/", func(w http.ResponseWriter, r *http.Request) {
		jobID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/nude-detect/jobs/"), "/poll")
		_ = json.NewEncoder(w).Encode(nudeJob{
			JobID:     jobID,
			Status:    "completed",
			Threshold: 0.3,
			Result: &nudeResultPayload{
				Model:           "nudenet",
				Threshold:       0.3,
				ImagesProcessed: 1,
				Results: []nudeImageResult{{
					File:           jobID + ".jpg",
					DetectionCount: 1,
					Detections: []nudeDetection{{
						Label:      "FACE_FEMALE",
						Confidence: 0.91,
					}},
				}},
			},
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
	out := filepath.Join(t.TempDir(), "result.json")

	err := cmdNudeScan([]string{
		first,
		second,
		"-threshold", "0.3",
		"-o", out,
		"--progress=false",
	})
	if err != nil {
		t.Fatalf("scan batch: %v", err)
	}

	mu.Lock()
	gotUploadCount := uploadCount
	gotRequests := append([]nudeStartRequest(nil), requests...)
	mu.Unlock()
	if gotUploadCount != 2 {
		t.Errorf("uploads = %d, want 2", gotUploadCount)
	}
	if len(gotRequests) != 2 {
		t.Fatalf("nude-detect requests = %d, want 2", len(gotRequests))
	}
	for i, req := range gotRequests {
		wantImageID := fmt.Sprintf("image-%d", i+1)
		if req.ImageID != wantImageID || req.Threshold != 0.3 {
			t.Errorf("request %d = %#v", i+1, req)
		}
		path := indexedOutputPath(out, i)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read result %d: %v", i+1, err)
		}
		var saved nudeResultPayload
		if err := json.Unmarshal(data, &saved); err != nil {
			t.Fatalf("decode saved result %d: %v", i+1, err)
		}
		if len(saved.Results) != 1 || saved.Results[0].DetectionCount != 1 {
			t.Errorf("saved result %d = %#v", i+1, saved)
		}
	}
}

func TestNudeScanRejectsThresholdOutOfRange(t *testing.T) {
	for _, threshold := range []string{"0.01", "0.99"} {
		err := cmdNudeScan([]string{"whatever.jpg", "-threshold", threshold})
		if err == nil || !strings.Contains(err.Error(), "-threshold must be between") {
			t.Errorf("-threshold %s error = %v", threshold, err)
		}
	}
}

func TestNudeJobsListsAndFormatsDetections(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/nude-detect/jobs", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]nudeJob{
			{
				JobID:     "nude-1",
				Status:    "completed",
				Threshold: 0.25,
				CreatedAt: "2026-01-01T00:00:00Z",
				Result: &nudeResultPayload{
					Results: []nudeImageResult{{File: "a.jpg", DetectionCount: 2}},
				},
			},
			{
				JobID:     "nude-2",
				Status:    "failed",
				Threshold: 0.5,
				CreatedAt: "2026-01-02T00:00:00Z",
			},
		})
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	configureTestServer(t, server.URL)

	if err := cmdNudeJobs(nil); err != nil {
		t.Fatalf("nude jobs: %v", err)
	}
}

func TestNudeAvailabilityPrintsRunners(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/nude-detect/availability", func(w http.ResponseWriter, r *http.Request) {
		name := "runner-1"
		_ = json.NewEncoder(w).Encode(nudeAvailability{
			Available:  true,
			Capability: "onnx.nudenet",
			ActiveRunners: []nudeActiveRunner{{
				UID:         "uid-1",
				UIDShort:    "uid1",
				DisplayName: &name,
				Tier:        1,
				Capacity:    4,
			}},
		})
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	configureTestServer(t, server.URL)

	if err := cmdNudeAvailability(nil); err != nil {
		t.Fatalf("nude availability: %v", err)
	}
}

func TestNudeCancelAndDelete(t *testing.T) {
	var canceled, deleted bool
	mux := http.NewServeMux()
	mux.HandleFunc("/api/nude-detect/jobs/nude-1/cancel", func(w http.ResponseWriter, r *http.Request) {
		canceled = true
		_ = json.NewEncoder(w).Encode(nudeCancelResponse{JobID: "nude-1", Status: "canceled", Message: "ok"})
	})
	mux.HandleFunc("/api/nude-detect/jobs/nude-1", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			deleted = true
			w.WriteHeader(http.StatusNoContent)
			return
		}
		http.Error(w, "unexpected method", http.StatusMethodNotAllowed)
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	configureTestServer(t, server.URL)

	if err := cmdNudeCancel([]string{"nude-1"}); err != nil {
		t.Fatalf("nude cancel: %v", err)
	}
	if !canceled {
		t.Error("cancel endpoint was not called")
	}
	if err := cmdNudeDelete([]string{"nude-1"}); err != nil {
		t.Fatalf("nude delete: %v", err)
	}
	if !deleted {
		t.Error("delete endpoint was not called")
	}
}
