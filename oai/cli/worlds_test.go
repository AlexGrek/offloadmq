package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"
)

// fakeWorlds stands in for routes/worlds.rs plus the shared image upload. Every job
// completes on its first poll.
type fakeWorlds struct {
	uploads  int
	requests []map[string]any
	deleted  []string
}

func (f *fakeWorlds) job(id, status string) worldJob {
	size := int64(63 << 20)
	return worldJob{
		JobID: id, Status: status, Capability: "world.sharp", Mode: "perspective",
		HasScene: status == "completed", HasPreview: status == "completed", PlyBytes: &size,
		Result:    json.RawMessage(`{"mode":"perspective","splat_count":1179648}`),
		CreatedAt: "2026-11-26T10:00:00Z",
	}
}

func (f *fakeWorlds) server(t *testing.T) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/images/upload", func(w http.ResponseWriter, r *http.Request) {
		f.uploads++
		_ = json.NewEncoder(w).Encode(uploadResponse{ImageID: fmt.Sprintf("90%d", f.uploads)})
	})
	mux.HandleFunc("POST /api/worlds/jobs", func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.requests = append(f.requests, req)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(startJobResponse{JobID: fmt.Sprintf("job-%d", len(f.requests)), Status: "submitted"})
	})
	mux.HandleFunc("POST /api/worlds/jobs/{id}/poll", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(f.job(r.PathValue("id"), "completed"))
	})
	mux.HandleFunc("GET /api/worlds/jobs/{id}", func(w http.ResponseWriter, r *http.Request) {
		status := "completed"
		if r.PathValue("id") == "running" {
			status = "running"
		}
		_ = json.NewEncoder(w).Encode(f.job(r.PathValue("id"), status))
	})
	mux.HandleFunc("DELETE /api/worlds/jobs/{id}", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("id") == "missing" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"Not found"}`))
			return
		}
		f.deleted = append(f.deleted, r.PathValue("id"))
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /api/worlds/jobs/{id}/scene.ply", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ply:" + r.PathValue("id")))
	})
	mux.HandleFunc("GET /api/worlds/jobs/{id}/preview.png", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("png"))
	})
	mux.HandleFunc("POST /api/worlds/jobs/{id}/share", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(worldShareLink{
			ViewerURL: "https://oai.test/worlds/view/" + r.PathValue("id"),
			ExpiresAt: "2026-11-27T10:00:00Z",
		})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	configureTestServer(t, server.URL)
}

func TestWorldGenerateSendsOnlyGivenOptionsAndSavesScene(t *testing.T) {
	f := &fakeWorlds{}
	f.server(t)
	path := testImage(t, "temple.jpg")
	if err := cmdWorld([]string{"generate", path, "--progress=false"}); err != nil {
		t.Fatal(err)
	}
	// No -model and no options: the server picks everything.
	want := map[string]any{"input_image_id": "901"}
	if got := f.requests[0]; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("request = %v, want %v", got, want)
	}
	if data, err := os.ReadFile("temple_world.ply"); err != nil || string(data) != "ply:job-1" {
		t.Fatalf("scene = %q, %v", data, err)
	}
}

func TestWorldGenerateFromImageIDWithOptions(t *testing.T) {
	f := &fakeWorlds{}
	f.server(t)
	t.Chdir(t.TempDir())
	// A zero value that was typed is sent; unset options are not.
	err := cmdWorld([]string{"generate", "12345", "-model", "pano360", "-pitch", "0", "-seed", "7",
		"-max-width", "2048", "-prompt", "a shrine", "-share", "--progress=false"})
	if err != nil {
		t.Fatal(err)
	}
	if f.uploads != 0 {
		t.Fatalf("an image ID must not upload, got %d", f.uploads)
	}
	want := map[string]any{"capability": "pano360", "input_image_id": "12345", "prompt": "a shrine",
		"pitch": float64(0), "seed": float64(7), "max_width": float64(2048)}
	if got := f.requests[0]; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("request = %v, want %v", got, want)
	}
	if _, err := os.Stat("world_job-1.ply"); err != nil {
		t.Fatal(err)
	}
}

func TestWorldGenerateRejectsBadInputBeforeUploading(t *testing.T) {
	f := &fakeWorlds{}
	f.server(t)
	path := testImage(t, "a.jpg")
	for _, args := range [][]string{
		{"generate", path, "nope.jpg"},
		{"generate", path, "--no-wait", "-o", "x.ply"},
		{"generate", path, "--no-wait", "-share"},
		{"generate"},
	} {
		if err := cmdWorld(args); err == nil {
			t.Errorf("%v: expected an error", args)
		}
	}
	if f.uploads != 0 || len(f.requests) != 0 {
		t.Fatalf("uploads = %d, requests = %d; want none", f.uploads, len(f.requests))
	}
}

func TestWorldNoWaitPrintsBareIDs(t *testing.T) {
	f := &fakeWorlds{}
	f.server(t)
	t.Chdir(t.TempDir())
	out, err := captureCLIStdout(t, func() error { return cmdWorld([]string{"generate", "1", "2", "--no-wait"}) })
	if err != nil {
		t.Fatal(err)
	}
	if out != "job-1\njob-2\n" {
		t.Fatalf("stdout = %q", out)
	}
}

func TestWorldDownloadShareAndDelete(t *testing.T) {
	f := &fakeWorlds{}
	f.server(t)
	t.Chdir(t.TempDir())
	if err := cmdWorld([]string{"download", "running"}); err == nil || !strings.Contains(err.Error(), "running") {
		t.Fatalf("unfinished download = %v", err)
	}
	if err := cmdWorld([]string{"download", "7", "-preview", "p.png"}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"world_7.ply", "p.png"} {
		if _, err := os.Stat(name); err != nil {
			t.Fatal(err)
		}
	}
	out, err := captureCLIStdout(t, func() error { return cmdWorld([]string{"share", "7"}) })
	if err != nil || out != "https://oai.test/worlds/view/7\n" {
		t.Fatalf("share stdout = %q, %v", out, err)
	}
	// One failing ID doesn't stop the others.
	err = cmdWorld([]string{"delete", "missing", "7"})
	if err == nil || !slices.Equal(f.deleted, []string{"7"}) {
		t.Fatalf("delete = %v, deleted %v", err, f.deleted)
	}
}
