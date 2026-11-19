package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// The embedded default program must match the web UI's defaults.ts.
func TestLanggraphDefaultsMatchFrontend(t *testing.T) {
	src, err := os.ReadFile("../frontend/src/lib/langgraph/defaults.ts")
	if err != nil {
		t.Skip("frontend sources not available")
	}
	for name, file := range map[string]string{
		"DEFAULT_TOOLS": "tools.py", "DEFAULT_MAIN": "main.py", "DEFAULT_PYPROJECT": "pyproject.toml",
	} {
		m := regexp.MustCompile("(?s)" + name + " = `(.*?)`\n").FindSubmatch(src)
		if m == nil {
			t.Fatalf("%s not found in defaults.ts", name)
		}
		want := strings.ReplaceAll(string(m[1]), `\\`, `\`)
		got, _ := langgraphDefaults.ReadFile("langgraph_defaults/" + file)
		if string(got) != want {
			t.Errorf("%s drifted from defaults.ts %s", file, name)
		}
	}
	if !strings.Contains(string(src), strings.ReplaceAll(defaultLanggraphSystem, "\n", `\n`)) {
		t.Error("default system prompt drifted from defaults.ts")
	}
}

func TestParseAllowedTools(t *testing.T) {
	if v, err := parseAllowedTools("all"); err != nil || v != nil {
		t.Errorf("all = %v, %v", v, err)
	}
	if v, err := parseAllowedTools("none"); err != nil || v == nil || len(*v) != 0 {
		t.Errorf("none = %v, %v", v, err)
	}
	if v, err := parseAllowedTools(" a, b ,"); err != nil || strings.Join(*v, "|") != "a|b" {
		t.Errorf("list = %v, %v", v, err)
	}
	if _, err := parseAllowedTools(","); err == nil {
		t.Error("empty list must fail")
	}
}

type fakeLanggraph struct {
	mu       sync.Mutex
	requests []map[string]json.RawMessage
	status   string
}

func (f *fakeLanggraph) server(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/langgraph/capabilities", func(w http.ResponseWriter, r *http.Request) {
		// The real endpoint lists online capabilities only and has no online field.
		_ = json.NewEncoder(w).Encode([]runtimeCapability{{Base: "llm-runtime.qwen3:8b", Raw: "llm-runtime.qwen3:8b"}})
	})
	mux.HandleFunc("POST /api/langgraph/jobs", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.requests = append(f.requests, body)
		f.mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(startJobResponse{JobID: "7", Status: "submitted"})
	})
	job := func(w http.ResponseWriter, r *http.Request) {
		status := f.status
		if status == "" {
			status = "completed"
		}
		errMsg := "boom"
		j := langgraphJob{
			JobID: "7", Status: status, Capability: "llm-runtime.qwen3:8b", CreatedAt: "2026-11-19T10:00:00Z",
			Result:    map[string]any{"stdout": "the answer\n", "stderr": "warn", "files": []any{}, "return_code": 0},
			Artifacts: []langgraphArtifact{{Filename: "sub/report.md", ContentType: "text/markdown", SizeBytes: 4}},
		}
		if status == "failed" {
			j.Error = &errMsg
		}
		_ = json.NewEncoder(w).Encode(j)
	}
	mux.HandleFunc("POST /api/langgraph/jobs/{id}/poll", job)
	mux.HandleFunc("GET /api/langgraph/jobs/{id}", job)
	mux.HandleFunc("GET /api/langgraph/jobs/{id}/artifacts/{n}", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("body"))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	configureTestServer(t, srv.URL)
}

func TestLanggraphRunNoWaitSendsDefaultsAndPrintsOnlyID(t *testing.T) {
	f := &fakeLanggraph{}
	f.server(t)
	out, err := captureCLIStdout(t, func() error { return cmdLanggraph([]string{"run", "hi", "--no-wait"}) })
	if err != nil || out != "7\n" {
		t.Fatalf("out=%q err=%v", out, err)
	}
	req := f.requests[0]
	for k, want := range map[string]string{
		"capability": `"llm-runtime.qwen3:8b"`, "allowed_tools": `null`, "user_prompt": `"hi"`,
		"resources": `{}`, "runtime_secs": `600`, "models": `{}`,
	} {
		if string(req[k]) != want {
			t.Errorf("%s = %s, want %s", k, req[k], want)
		}
	}
	if !strings.Contains(string(req["system_prompt"]), "{tools}") || !strings.Contains(string(req["main_py"]), "describe_tools") {
		t.Error("default system prompt / main.py missing")
	}
	if string(req["output"]) != `{"data_file":"result.json","files":[]}` {
		t.Errorf("output = %s", req["output"])
	}
}

func TestLanggraphRunFlagsAndDir(t *testing.T) {
	f := &fakeLanggraph{}
	f.server(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "main.py"), []byte("print(1)\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := captureCLIStdout(t, func() error {
		return cmdLanggraph([]string{"run", "-dir", dir, "-allowed-tools", "none", "-role", "critic=llm-runtime.gemma3:12b",
			"-file", "a.md", "-data-file", "", "-resources", `{"k":1}`, "-model", "qwen3:8b", "--no-wait"})
	})
	if err != nil {
		t.Fatal(err)
	}
	req := f.requests[0]
	got := map[string]string{}
	for k, v := range req {
		got[k] = string(v)
	}
	if got["allowed_tools"] != `[]` || got["models"] != `{"critic":"gemma3:12b"}` || got["main_py"] != `"print(1)\n"` ||
		got["output"] != `{"files":["a.md"]}` || got["resources"] != `{"k":1}` {
		t.Errorf("request = %v", got)
	}
	if !strings.Contains(got["tools_py"], "dummy_tool") {
		t.Error("tools.py should fall back to the default")
	}
}

func TestLanggraphRunWaitsPrintsAnswerAndSavesArtifacts(t *testing.T) {
	f := &fakeLanggraph{}
	f.server(t)
	pollInterval = time.Millisecond
	t.Cleanup(func() { pollInterval = 5 * time.Second })
	dest := filepath.Join(t.TempDir(), "out")
	out, err := captureCLIStdout(t, func() error {
		return cmdLanggraph([]string{"run", "hi", "--progress=false", "-o", dest})
	})
	if err != nil || out != "the answer\n" {
		t.Fatalf("stdout=%q err=%v", out, err)
	}
	// A server-supplied path must collapse to its base name inside the output dir.
	if data, err := os.ReadFile(filepath.Join(dest, "report.md")); err != nil || string(data) != "body" {
		t.Errorf("artifact = %q, %v", data, err)
	}
}

func TestLanggraphRunFailureReturnsError(t *testing.T) {
	f := &fakeLanggraph{status: "failed"}
	f.server(t)
	pollInterval = time.Millisecond
	t.Cleanup(func() { pollInterval = 5 * time.Second })
	_, err := captureCLIStdout(t, func() error { return cmdLanggraph([]string{"run", "hi", "--progress=false"}) })
	if err == nil || !strings.Contains(err.Error(), "failed: boom") {
		t.Errorf("err = %v", err)
	}
}

func TestLanggraphInit(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "app")
	if _, err := captureCLIStdout(t, func() error { return cmdLanggraph([]string{"init", dir}) }); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "main.py")); err != nil {
		t.Error(err)
	}
	if err := cmdLanggraph([]string{"init", dir}); err == nil {
		t.Error("second init without -force must fail")
	}
}
