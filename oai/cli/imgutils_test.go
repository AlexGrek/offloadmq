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

var (
	upscaleCap = imgUtilCapability{Base: "img-utils.seedvr2", Utility: "seedvr2", Workflows: []string{"upscale"}, Kind: "comfy"}
	depthCap   = imgUtilCapability{Base: "img-utils.lotus", Utility: "lotus", Workflows: []string{"depth"}, Kind: "comfy"}
	swapCap    = imgUtilCapability{Base: "img-utils.reactor", Utility: "reactor", Workflows: []string{"face_swap"}, Kind: "comfy", NeedsSourceImage: true}
	resizeCap  = imgUtilCapability{Base: "image_resize", Utility: "image_resize", Workflows: []string{"basic_resize"}, Kind: "resize", Methods: []string{"lanczos"}}
)

// fakeImgUtils stands in for routes/img_utils.rs plus the shared image upload and
// file download. Every job completes on its first poll with a PNG output.
type fakeImgUtils struct {
	mu       sync.Mutex
	caps     []imgUtilCapability
	uploads  int
	requests []imgUtilsStartRequest
	jobs     map[string]*imgUtilsJob
	polls    int
}

func (f *fakeImgUtils) server(t *testing.T) {
	t.Helper()
	f.jobs = map[string]*imgUtilsJob{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/img-utils/capabilities", func(w http.ResponseWriter, r *http.Request) {
		caps := f.caps
		if caps == nil {
			caps = []imgUtilCapability{}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"capabilities": caps})
	})
	mux.HandleFunc("POST /api/images/upload", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.uploads++
		_ = json.NewEncoder(w).Encode(uploadResponse{ImageID: fmt.Sprintf("up-%d", f.uploads)})
	})
	mux.HandleFunc("POST /api/img-utils/jobs", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		var req imgUtilsStartRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.requests = append(f.requests, req)
		id := fmt.Sprintf("job-%d", len(f.requests))
		f.jobs[id] = &imgUtilsJob{JobID: id, Status: "submitted", Capability: req.Capability, Workflow: req.Workflow, CreatedAt: "2026-09-30T10:00:00Z"}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(startJobResponse{JobID: id, Status: "submitted"})
	})
	mux.HandleFunc("POST /api/img-utils/jobs/{id}/poll", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.polls++
		job := f.jobs[r.PathValue("id")]
		out := "out-" + job.JobID
		job.Status, job.OutputImageID = "completed", &out
		job.OutputImage = &imgUtilsImageRef{ImageID: out, Filename: "x.png", ContentType: "image/png", Width: 64, Height: 64}
		_ = json.NewEncoder(w).Encode(job)
	})
	mux.HandleFunc("GET /api/img-utils/jobs/{id}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		job, ok := f.jobs[r.PathValue("id")]
		if !ok {
			http.Error(w, `{"error":"Not found"}`, http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(job)
	})
	mux.HandleFunc("GET /api/img-utils/jobs", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		var list []imgUtilsJob
		for _, j := range f.jobs {
			list = append(list, *j)
		}
		_ = json.NewEncoder(w).Encode(list)
	})
	mux.HandleFunc("GET /api/images/files/{id}", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("png:" + r.PathValue("id")))
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	configureTestServer(t, server.URL)
}

// testImage writes a stub input image and returns its path, chdir-ing into its
// directory so default output names land there.
func testImage(t *testing.T, name string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("jpeg"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	return path
}

func TestPickImgTool(t *testing.T) {
	tools := toolsFromCapabilities([]imgUtilCapability{
		upscaleCap, depthCap, swapCap, resizeCap,
		{Base: "img-utils.aaa", Utility: "aaa", Workflows: []string{"upscale"}, Kind: "comfy"},
	})
	for name, wantCap := range map[string]string{
		"upscale":           "img-utils.aaa", // first by pack when several offer the operation
		"face-swap":         "img-utils.reactor",
		"FaceSwap":          "img-utils.reactor",
		"resize":            "image_resize",
		"lotus":             "img-utils.lotus",
		"img-utils.seedvr2": "img-utils.seedvr2",
	} {
		got, err := pickImgTool(tools, name, "")
		if err != nil || got.Capability != wantCap {
			t.Errorf("pick %q = %s, %v; want %s", name, got.Capability, err, wantCap)
		}
	}
	if got, err := pickImgTool(tools, "upscale", "img-utils.seedvr2"); err != nil || got.Capability != "img-utils.seedvr2" {
		t.Errorf("-capability restriction = %s, %v", got.Capability, err)
	}
	if got, _ := pickImgTool(tools, "face_swap", ""); !got.NeedsSource || got.TakesScale {
		t.Errorf("face_swap flags = %+v", got)
	}
	if _, err := pickImgTool(tools, "upscale", "img-utils.lotus"); err == nil {
		t.Error("a capability without the tool must not match")
	}
	if _, err := pickImgTool(nil, "upscale", ""); err == nil || !strings.Contains(err.Error(), "no Image Tools capability is online") {
		t.Errorf("no tools err = %v", err)
	}
}

func TestUpscaleShortcutDefaultsAndSaves(t *testing.T) {
	shortPollInterval(t)
	f := &fakeImgUtils{caps: []imgUtilCapability{resizeCap, upscaleCap}}
	f.server(t)
	in := testImage(t, "photo.jpg")

	out, err := captureCLIStdout(t, func() error { return cmdUpscale([]string{in, "--progress=false"}) })
	if err != nil {
		t.Fatalf("upscale: %v", err)
	}
	req := f.requests[0]
	if req.Capability != "img-utils.seedvr2" || req.Workflow != "upscale" || req.InputImageID != "up-1" {
		t.Errorf("request = %+v", req)
	}
	// JSON numbers decode as float64; the CLI must send the web UI's default, 4.
	if req.Options["scale_multiplier"] != float64(4) {
		t.Errorf("options = %v, want scale_multiplier 4", req.Options)
	}
	if out != "Saved photo_upscale.png (64x64)\n" {
		t.Errorf("stdout = %q, want only the saved line", out)
	}
	if data, _ := os.ReadFile("photo_upscale.png"); string(data) != "png:out-job-1" {
		t.Errorf("saved %q", data)
	}
}

func TestUpscaleFailsWhenNoUpscaleToolIsOnline(t *testing.T) {
	f := &fakeImgUtils{caps: []imgUtilCapability{resizeCap, depthCap}}
	f.server(t)
	in := testImage(t, "photo.jpg")
	err := cmdUpscale([]string{in})
	if err == nil || !strings.Contains(err.Error(), "no upscale tool is available") || !strings.Contains(err.Error(), "depth") {
		t.Errorf("err = %v, want a clear 'not available' listing online tools", err)
	}
	if f.uploads != 0 || len(f.requests) != 0 {
		t.Errorf("uploads=%d requests=%d: nothing should be sent", f.uploads, len(f.requests))
	}
}

func TestImgUtilsRunOptionsPerTool(t *testing.T) {
	shortPollInterval(t)
	f := &fakeImgUtils{caps: []imgUtilCapability{upscaleCap, depthCap, swapCap, resizeCap}}
	f.server(t)
	in := testImage(t, "a.jpg")
	run := func(tool string, args ...string) error {
		_, err := captureCLIStdout(t, func() error {
			return cmdImgUtilsRun("run", tool, append([]string{in, "--progress=false"}, args...))
		})
		return err
	}

	if err := run("upscale", "-scale", "2.5", "-opt", "tile=true"); err != nil {
		t.Fatal(err)
	}
	if o := f.requests[len(f.requests)-1].Options; o["scale_multiplier"] != 2.5 || o["tile"] != true {
		t.Errorf("upscale options = %v", o)
	}
	if err := run("resize", "-width", "300", "-mode", "cover", "-height", "200", "-method", "lanczos", "-scale", "0.5"); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"width": float64(300), "height": float64(200), "mode": "cover", "method": "lanczos", "scale": 0.5}
	if o := f.requests[len(f.requests)-1].Options; fmt.Sprint(o) != fmt.Sprint(want) {
		t.Errorf("resize options = %v, want %v", o, want)
	}
	if err := run("depth"); err != nil {
		t.Fatal(err)
	}
	if o := f.requests[len(f.requests)-1].Options; o != nil {
		t.Errorf("depth options = %v, want none", o)
	}
	if err := run("face_swap", "-source", in); err != nil {
		t.Fatal(err)
	}
	if r := f.requests[len(f.requests)-1]; r.SourceImageID == "" || r.SourceImageID == r.InputImageID {
		t.Errorf("face_swap request = %+v: source must be uploaded separately", r)
	}

	sent := len(f.requests)
	for _, bad := range [][]string{
		{"upscale", "-scale", "9"},
		{"depth", "-scale", "2"},
		{"depth", "-width", "10"},
		{"depth", "-source", in},
		{"face_swap"},
		{"resize"},
		{"resize", "-scale", "2", "-opt", "x=1"},
		{"upscale", "--no-wait", "-o", "x.png"},
	} {
		if err := run(bad[0], bad[1:]...); err == nil {
			t.Errorf("%v: want an error", bad)
		}
	}
	if len(f.requests) != sent {
		t.Errorf("invalid invocations submitted %d jobs", len(f.requests)-sent)
	}
}

func TestImgUtilsRunNoWaitAndBatchOutputs(t *testing.T) {
	shortPollInterval(t)
	f := &fakeImgUtils{caps: []imgUtilCapability{depthCap}}
	f.server(t)
	a := testImage(t, "a.jpg")
	b := filepath.Join(filepath.Dir(a), "b.jpg")
	_ = os.WriteFile(b, []byte("jpeg"), 0o644)

	out, err := captureCLIStdout(t, func() error { return cmdImgUtilsRun("run", "depth", []string{a, b, "--no-wait"}) })
	if err != nil || out != "job-1\njob-2\n" || f.polls != 0 {
		t.Errorf("--no-wait stdout = %q, err %v, polls %d; want bare IDs and no polling", out, err, f.polls)
	}

	out, err = captureCLIStdout(t, func() error {
		return cmdImgUtilsRun("run", "depth", []string{a, b, "-o", "d.png", "--progress=false"})
	})
	if err != nil || out != "Saved d.png (64x64)\nSaved d_2.png (64x64)\n" {
		t.Errorf("batch stdout = %q, %v", out, err)
	}
}

func TestImgUtilsDownloadAndJobs(t *testing.T) {
	shortPollInterval(t)
	f := &fakeImgUtils{caps: []imgUtilCapability{depthCap}}
	f.server(t)
	in := testImage(t, "a.jpg")
	id, _ := captureCLIStdout(t, func() error { return cmdImgUtilsRun("run", "depth", []string{in, "--no-wait"}) })
	id = strings.TrimSpace(id)

	if err := cmdImgUtilsDownload([]string{id}); err == nil || !strings.Contains(err.Error(), "is submitted") {
		t.Errorf("download before completion err = %v", err)
	}
	if ids, _ := captureCLIStdout(t, func() error { return cmdImgUtilsJobs([]string{"-active", "-ids"}) }); ids != id+"\n" {
		t.Errorf("jobs -active -ids = %q", ids)
	}
	if _, err := captureCLIStdout(t, func() error { return cmdImgUtilsJob([]string{id}, true) }); err != nil {
		t.Fatal(err)
	}
	out, err := captureCLIStdout(t, func() error { return cmdImgUtilsDownload([]string{id}) })
	if err != nil || out != "Saved depth_"+id+".png (64x64)\n" {
		t.Errorf("download = %q, %v", out, err)
	}
	if ids, _ := captureCLIStdout(t, func() error { return cmdImgUtilsJobs([]string{"-active", "-ids"}) }); ids != "" {
		t.Errorf("completed job still listed as active: %q", ids)
	}
}
