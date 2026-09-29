package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// fakePromptLibrary is an in-memory stand-in for backend/src/routes/prompts.rs:
// paged listing with q/cursor/limit, star (deduped), record, edit, delete and
// preview.
type fakePromptLibrary struct {
	mu      sync.Mutex
	nextID  int
	entries []fakePromptRow // newest first
	queries []string
}

type fakePromptRow struct {
	bucket string
	entry  promptEntry
}

func (f *fakePromptLibrary) add(bucket, kind, content string, preview bool) string {
	f.nextID++
	e := promptEntry{
		ID:         strconv.Itoa(f.nextID),
		Kind:       kind,
		Content:    content,
		CreatedAt:  "2026-09-01T10:00:00Z",
		LastUsedAt: "2026-09-01T10:00:00Z",
		UpdatedAt:  "2026-09-01T10:00:00Z",
	}
	if preview {
		v := "1"
		e.PreviewVersion = &v
	}
	f.entries = append([]fakePromptRow{{bucket, e}}, f.entries...)
	return e.ID
}

func (f *fakePromptLibrary) find(id string) int {
	for i, row := range f.entries {
		if row.entry.ID == id {
			return i
		}
	}
	return -1
}

func (f *fakePromptLibrary) server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/prompts/{bucket}/entries", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		q := r.URL.Query()
		f.queries = append(f.queries, r.URL.RawQuery)
		limit := 40
		if l := q.Get("limit"); l != "" {
			limit, _ = strconv.Atoi(l)
		}
		start := 0
		if c := q.Get("cursor"); c != "" {
			start, _ = strconv.Atoi(c)
		}
		var matched []promptEntry
		for _, row := range f.entries {
			if row.bucket == r.PathValue("bucket") && row.entry.Kind == q.Get("kind") &&
				strings.Contains(strings.ToLower(row.entry.Content), strings.ToLower(q.Get("q"))) {
				matched = append(matched, row.entry)
			}
		}
		page := promptPage{Items: []promptEntry{}}
		if start < len(matched) {
			end := min(start+limit, len(matched))
			page.Items = matched[start:end]
			if end < len(matched) {
				next := strconv.Itoa(end)
				page.NextCursor = &next
			}
		}
		_ = json.NewEncoder(w).Encode(page)
	})
	mux.HandleFunc("POST /api/prompts/{bucket}/{action}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		var req contentRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		kind := map[string]string{"star": promptKindStarred, "recent": promptKindRecent}[r.PathValue("action")]
		if kind == "" {
			http.NotFound(w, r)
			return
		}
		content := strings.TrimSpace(req.Content)
		for _, row := range f.entries {
			if row.bucket == r.PathValue("bucket") && row.entry.Kind == kind && row.entry.Content == content {
				_ = json.NewEncoder(w).Encode(promptItem{ID: row.entry.ID, Content: content})
				return
			}
		}
		id := f.add(r.PathValue("bucket"), kind, content, false)
		_ = json.NewEncoder(w).Encode(promptItem{ID: id, Content: content})
	})
	mux.HandleFunc("PATCH /api/prompt-entries/{id}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		i := f.find(r.PathValue("id"))
		if i < 0 {
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			return
		}
		var req contentRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.entries[i].entry.Content = strings.TrimSpace(req.Content)
		_ = json.NewEncoder(w).Encode(f.entries[i].entry)
	})
	mux.HandleFunc("DELETE /api/prompt-entries/{id}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		i := f.find(r.PathValue("id"))
		if i < 0 {
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			return
		}
		f.entries = append(f.entries[:i], f.entries[i+1:]...)
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /api/prompt-entries/{id}/preview", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		i := f.find(r.PathValue("id"))
		if i < 0 || f.entries[i].entry.PreviewVersion == nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = io.WriteString(w, "jpeg-"+r.PathValue("id"))
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func (f *fakePromptLibrary) contents(bucket, kind string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, row := range f.entries {
		if row.bucket == bucket && row.entry.Kind == kind {
			out = append(out, row.entry.Content)
		}
	}
	return out
}

func TestPromptsStarRecordEditUnstarDelete(t *testing.T) {
	lib := &fakePromptLibrary{}
	configureTestServer(t, lib.server(t).URL)

	if err := cmdImagePrompts([]string{"star", "a", "red", "bicycle"}); err != nil {
		t.Fatalf("star: %v", err)
	}
	// Starring the same text again must not duplicate it.
	if err := cmdImagePrompts([]string{"star", "a red bicycle"}); err != nil {
		t.Fatalf("star again: %v", err)
	}
	if err := cmdImagePrompts([]string{"star", "-negative", "blurry"}); err != nil {
		t.Fatalf("star negative: %v", err)
	}
	if err := cmdImagePrompts([]string{"record", "a blue car"}); err != nil {
		t.Fatalf("record: %v", err)
	}
	if got := lib.contents(imgPromptBucket, promptKindStarred); len(got) != 1 || got[0] != "a red bicycle" {
		t.Fatalf("starred prompts = %q", got)
	}
	if got := lib.contents(imgNegativeBucket, promptKindStarred); len(got) != 1 || got[0] != "blurry" {
		t.Fatalf("starred negatives = %q", got)
	}
	if got := lib.contents(imgPromptBucket, promptKindRecent); len(got) != 1 || got[0] != "a blue car" {
		t.Fatalf("recent prompts = %q", got)
	}

	// star -id promotes a recent entry, resolving its bucket by ID.
	recentID := lib.entries[0].entry.ID
	if err := cmdImagePrompts([]string{"star", "-id", recentID}); err != nil {
		t.Fatalf("star -id: %v", err)
	}
	if got := lib.contents(imgPromptBucket, promptKindStarred); len(got) != 2 || got[0] != "a blue car" {
		t.Fatalf("starred after star -id = %q", got)
	}

	starredID := lib.entries[0].entry.ID
	if err := cmdImagePrompts([]string{"edit", starredID, "a", "green", "car"}); err != nil {
		t.Fatalf("edit: %v", err)
	}
	if err := cmdImagePrompts([]string{"unstar", "a red bicycle"}); err != nil {
		t.Fatalf("unstar: %v", err)
	}
	if err := cmdImagePrompts([]string{"unstar", "not starred"}); err == nil {
		t.Fatal("unstar of unknown text should fail")
	}
	if got := lib.contents(imgPromptBucket, promptKindStarred); len(got) != 1 || got[0] != "a green car" {
		t.Fatalf("starred after edit+unstar = %q", got)
	}

	if err := cmdImagePrompts([]string{"delete", starredID, recentID}); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if got := lib.contents(imgPromptBucket, promptKindStarred); len(got) != 0 {
		t.Fatalf("starred after delete = %q", got)
	}
	if got := lib.contents(imgPromptBucket, promptKindRecent); len(got) != 0 {
		t.Fatalf("recent after delete = %q", got)
	}
}

func TestPromptsListPagesSearchAndJSON(t *testing.T) {
	lib := &fakePromptLibrary{}
	for i := 1; i <= 5; i++ {
		lib.add(imgPromptBucket, promptKindStarred, fmt.Sprintf("castle %d", i), i == 5)
	}
	lib.add(imgPromptBucket, promptKindStarred, "lighthouse", false)
	lib.add(imgNegativeBucket, promptKindStarred, "castle negative", false)
	configureTestServer(t, lib.server(t).URL)

	stdout, err := captureCLIStdout(t, func() error {
		return cmdImagePrompts([]string{"starred", "-q", "castle", "-all", "-limit", "2", "-json"})
	})
	if err != nil {
		t.Fatalf("list -all: %v", err)
	}
	var page promptPage
	if err := json.Unmarshal([]byte(stdout), &page); err != nil {
		t.Fatalf("decode list JSON %q: %v", stdout, err)
	}
	if len(page.Items) != 5 || page.NextCursor != nil {
		t.Fatalf("-all returned %d items, cursor %v; want 5 and none", len(page.Items), page.NextCursor)
	}

	stdout, err = captureCLIStdout(t, func() error {
		return cmdImagePrompts([]string{"starred", "-limit", "2", "-json"})
	})
	if err != nil {
		t.Fatalf("list page: %v", err)
	}
	page = promptPage{}
	if err := json.Unmarshal([]byte(stdout), &page); err != nil {
		t.Fatalf("decode page JSON: %v", err)
	}
	if len(page.Items) != 2 || page.NextCursor == nil {
		t.Fatalf("first page = %d items, cursor %v", len(page.Items), page.NextCursor)
	}
	stdout, err = captureCLIStdout(t, func() error {
		return cmdImagePrompts([]string{"starred", "-limit", "2", "-cursor", *page.NextCursor})
	})
	if err != nil {
		t.Fatalf("list next page: %v", err)
	}
	if !strings.Contains(stdout, "castle 3") || strings.Contains(stdout, "lighthouse") {
		t.Fatalf("second page table = %q", stdout)
	}

	stdout, err = captureCLIStdout(t, func() error {
		return cmdImagePrompts([]string{"starred", "-negative"})
	})
	if err != nil {
		t.Fatalf("list negative: %v", err)
	}
	if !strings.Contains(stdout, "castle negative") || strings.Contains(stdout, "lighthouse") {
		t.Fatalf("negative table = %q", stdout)
	}
}

func TestPromptsShowAndPreview(t *testing.T) {
	lib := &fakePromptLibrary{}
	withPreview := lib.add(imgPromptBucket, promptKindStarred, "line one\nline two", true)
	noPreview := lib.add(imgNegativeBucket, promptKindRecent, "watermark", false)
	configureTestServer(t, lib.server(t).URL)

	stdout, err := captureCLIStdout(t, func() error {
		return cmdImagePrompts([]string{"show", withPreview})
	})
	if err != nil {
		t.Fatalf("show: %v", err)
	}
	if stdout != "line one\nline two\n" {
		t.Fatalf("show stdout = %q, want the bare prompt text", stdout)
	}
	// IDs resolve across both image libraries.
	stdout, err = captureCLIStdout(t, func() error {
		return cmdImagePrompts([]string{"show", noPreview})
	})
	if err != nil || stdout != "watermark\n" {
		t.Fatalf("show negative = %q, %v", stdout, err)
	}
	if err := cmdImagePrompts([]string{"show", "999"}); err == nil {
		t.Fatal("show of unknown ID should fail")
	}

	out := filepath.Join(t.TempDir(), "p.jpg")
	if err := cmdImagePrompts([]string{"preview", withPreview, "-o", out}); err != nil {
		t.Fatalf("preview: %v", err)
	}
	if data, _ := os.ReadFile(out); string(data) != "jpeg-"+withPreview {
		t.Fatalf("preview bytes = %q", data)
	}
	missing := filepath.Join(t.TempDir(), "none.jpg")
	if err := cmdImagePrompts([]string{"preview", noPreview, "-o", missing}); err == nil || !strings.Contains(err.Error(), "no preview") {
		t.Fatalf("preview without image: err = %v", err)
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatal("failed preview must not leave a file behind")
	}
}

func TestImageGenerateStarStarsTemplateWithoutTouchingStdout(t *testing.T) {
	lib := &fakePromptLibrary{}
	var mu sync.Mutex
	mux := http.NewServeMux()
	libServer := lib.server(t)
	mux.HandleFunc("/api/prompts/", func(w http.ResponseWriter, r *http.Request) {
		proxyTo(t, libServer.URL, w, r)
	})
	mux.HandleFunc("/api/prompt-placeholders", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]promptPlaceholder{})
	})
	mux.HandleFunc("POST /api/images/jobs", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(startJobResponse{JobID: "job-1", Status: "submitted"})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	configureTestServer(t, server.URL)

	stdout, err := captureCLIStdout(t, func() error {
		return cmdImageGenerate([]string{"a {color} kite", "-capability", "imggen.test", "--no-wait", "--star"})
	})
	if err != nil {
		t.Fatalf("generate --star: %v", err)
	}
	if stdout != "job-1\n" {
		t.Fatalf("stdout = %q, want only the job ID", stdout)
	}
	if got := lib.contents(imgPromptBucket, promptKindStarred); len(got) != 1 || got[0] != "a {color} kite" {
		t.Fatalf("starred = %q, want the unexpanded template", got)
	}
	if got := lib.contents(imgPromptBucket, promptKindRecent); len(got) != 1 {
		t.Fatalf("recent = %q, want the template recorded once", got)
	}
}

// proxyTo forwards one request to another test server.
func proxyTo(t *testing.T, target string, w http.ResponseWriter, r *http.Request) {
	t.Helper()
	req, err := http.NewRequest(r.Method, target+r.URL.RequestURI(), r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header = r.Header.Clone()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}
