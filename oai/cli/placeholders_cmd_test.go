package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// fakePlaceholders is an in-memory stand-in for backend/src/routes/prompt_placeholders.rs,
// with the validation from db/prompt_placeholders.rs that the CLI relies on:
// reserved names, case-insensitive uniqueness, trimmed non-empty variants.
type fakePlaceholders struct {
	mu     sync.Mutex
	nextID int
	items  []promptPlaceholder
}

func (f *fakePlaceholders) validate(w http.ResponseWriter, req *placeholderRequest, excludeID string) bool {
	req.Name = strings.TrimSpace(req.Name)
	if slices.Contains([]string{"color", "animal", "adjective", "country", "language", "name", "starwars", "?"}, strings.ToLower(req.Name)) {
		http.Error(w, `{"error":"'`+req.Name+`' is a reserved placeholder name"}`, http.StatusBadRequest)
		return false
	}
	for _, p := range f.items {
		if p.ID != excludeID && strings.EqualFold(p.Name, req.Name) {
			http.Error(w, `{"error":"you already have a placeholder named '`+req.Name+`'"}`, http.StatusBadRequest)
			return false
		}
	}
	var cleaned []string
	for _, v := range req.Variants {
		if v = strings.TrimSpace(v); v != "" {
			cleaned = append(cleaned, v)
		}
	}
	if len(cleaned) == 0 {
		http.Error(w, `{"error":"at least one variant is required"}`, http.StatusBadRequest)
		return false
	}
	req.Variants = cleaned
	return true
}

func (f *fakePlaceholders) server(t *testing.T) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/prompt-placeholders", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		items := slices.Clone(f.items)
		slices.SortFunc(items, func(a, b promptPlaceholder) int { return strings.Compare(a.Name, b.Name) })
		if items == nil {
			items = []promptPlaceholder{}
		}
		_ = json.NewEncoder(w).Encode(items)
	})
	mux.HandleFunc("POST /api/prompt-placeholders", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		var req placeholderRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if !f.validate(w, &req, "") {
			return
		}
		f.nextID++
		p := promptPlaceholder{ID: strconv.Itoa(100 + f.nextID), Name: req.Name, Variants: req.Variants}
		f.items = append(f.items, p)
		_ = json.NewEncoder(w).Encode(p)
	})
	mux.HandleFunc("PATCH /api/prompt-placeholders/{id}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		var req placeholderRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		i := slices.IndexFunc(f.items, func(p promptPlaceholder) bool { return p.ID == r.PathValue("id") })
		if i < 0 {
			http.Error(w, `{"error":"Not found"}`, http.StatusNotFound)
			return
		}
		if !f.validate(w, &req, f.items[i].ID) {
			return
		}
		f.items[i].Name, f.items[i].Variants = req.Name, req.Variants
		_ = json.NewEncoder(w).Encode(f.items[i])
	})
	mux.HandleFunc("DELETE /api/prompt-placeholders/{id}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		i := slices.IndexFunc(f.items, func(p promptPlaceholder) bool { return p.ID == r.PathValue("id") })
		if i < 0 {
			http.Error(w, `{"error":"Not found"}`, http.StatusNotFound)
			return
		}
		f.items = slices.Delete(f.items, i, i+1)
		w.WriteHeader(http.StatusNoContent)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	configureTestServer(t, server.URL)
}

func (f *fakePlaceholders) get(name string) (promptPlaceholder, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return findPlaceholder(f.items, name)
}

func runPlaceholders(t *testing.T, args ...string) (string, error) {
	t.Helper()
	return captureCLIStdout(t, func() error { return cmdImagePlaceholders(args) })
}

func mustRunPlaceholders(t *testing.T, args ...string) string {
	t.Helper()
	out, err := runPlaceholders(t, args...)
	if err != nil {
		t.Fatalf("placeholders %v: %v", args, err)
	}
	return out
}

func TestPlaceholdersCreateListShow(t *testing.T) {
	f := &fakePlaceholders{}
	f.server(t)

	mustRunPlaceholders(t, "create", "{.cinematic}", "cinematic lighting", "  ", "film grain")
	p, ok := f.get(".cinematic")
	if !ok || !slices.Equal(p.Variants, []string{"cinematic lighting", "film grain"}) {
		t.Fatalf("stored = %+v (braces must be stripped, blank variants dropped)", p)
	}
	if _, err := runPlaceholders(t, "create", ".CINEMATIC", "x"); err == nil || !strings.Contains(err.Error(), "already have") {
		t.Fatalf("duplicate create err = %v", err)
	}
	if _, err := runPlaceholders(t, "create", "color", "x"); err == nil || !strings.Contains(err.Error(), "reserved") {
		t.Fatalf("reserved create err = %v", err)
	}

	list := mustRunPlaceholders(t, "list")
	if !strings.Contains(list, "{.cinematic}") || !strings.Contains(list, "cinematic lighting") {
		t.Errorf("list = %q", list)
	}
	// show is case-insensitive, accepts braces or the ID, and prints bare lines.
	for _, ref := range []string{"{.Cinematic}", p.ID} {
		if got := mustRunPlaceholders(t, "show", ref); got != "cinematic lighting\nfilm grain\n" {
			t.Errorf("show %s = %q", ref, got)
		}
	}
	var decoded []promptPlaceholder
	if err := json.Unmarshal([]byte(mustRunPlaceholders(t, "list", "-json")), &decoded); err != nil || len(decoded) != 1 {
		t.Errorf("list -json = %v, %v", decoded, err)
	}
	if _, err := runPlaceholders(t, "show", "nope"); err == nil {
		t.Error("show of a missing placeholder must fail")
	}
}

func TestPlaceholdersSetAddRemoveRename(t *testing.T) {
	f := &fakePlaceholders{}
	f.server(t)

	if out := mustRunPlaceholders(t, "set", "mood", "calm", "tense"); !strings.HasPrefix(out, "Created") {
		t.Errorf("set on a new name = %q", out)
	}
	if out := mustRunPlaceholders(t, "set", "Mood", "eerie"); !strings.HasPrefix(out, "Updated") {
		t.Errorf("set on an existing name = %q", out)
	}
	mustRunPlaceholders(t, "add", "mood", "eerie", "joyful", "calm")
	if p, _ := f.get("mood"); !slices.Equal(p.Variants, []string{"eerie", "joyful", "calm"}) {
		t.Fatalf("after add = %v (existing variants must not be duplicated)", p.Variants)
	}

	mustRunPlaceholders(t, "remove", "mood", "joyful")
	if p, _ := f.get("mood"); !slices.Equal(p.Variants, []string{"eerie", "calm"}) {
		t.Fatalf("after remove = %v", p.Variants)
	}
	if _, err := runPlaceholders(t, "remove", "mood", "missing"); err == nil {
		t.Error("removing an unknown variant must fail")
	}
	if _, err := runPlaceholders(t, "remove", "mood", "eerie", "calm"); err == nil || !strings.Contains(err.Error(), "delete") {
		t.Errorf("removing every variant err = %v, want a pointer to delete", err)
	}

	mustRunPlaceholders(t, "rename", "mood", "{atmosphere}")
	if _, ok := f.get("mood"); ok {
		t.Error("old name still present after rename")
	}
	if p, ok := f.get("atmosphere"); !ok || len(p.Variants) != 2 {
		t.Errorf("renamed = %+v, %v (variants must carry over)", p, ok)
	}
}

func TestPlaceholdersVariantsFromStdin(t *testing.T) {
	f := &fakePlaceholders{}
	f.server(t)

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.WriteString("wide shot\n\n  close-up  \n")
	_ = w.Close()
	prev := os.Stdin
	os.Stdin = r
	t.Cleanup(func() { os.Stdin = prev })

	mustRunPlaceholders(t, "create", "shot", "-")
	if p, _ := f.get("shot"); !slices.Equal(p.Variants, []string{"wide shot", "close-up"}) {
		t.Errorf("variants = %v", p.Variants)
	}
}

func TestPlaceholdersEditUsesEditor(t *testing.T) {
	f := &fakePlaceholders{}
	f.server(t)
	mustRunPlaceholders(t, "create", "item", "lamp", "kettle")

	// The editor is a shell script given the file path as $1, run via sh -c
	// '$EDITOR "$@"' like a real one. The first one records what it was given.
	dir := t.TempDir()
	scripts := 0
	setEditor := func(body string) {
		scripts++
		script := filepath.Join(dir, "editor"+strconv.Itoa(scripts)+".sh")
		if err := os.WriteFile(script, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		prev := editorCommand
		editorCommand = func() string { return `"` + script + `"` }
		t.Cleanup(func() { editorCommand = prev })
	}
	capture := filepath.Join(dir, "seen.txt")
	setEditor(`cp "$1" '` + capture + `' && printf 'lamp\n\n chair \n' > "$1"`)
	if out := mustRunPlaceholders(t, "edit", "item"); !strings.HasPrefix(out, "Updated") {
		t.Errorf("edit = %q", out)
	}
	if data, _ := os.ReadFile(capture); string(data) != "lamp\nkettle\n" {
		t.Errorf("editor was given %q", data)
	}
	if p, _ := f.get("item"); !slices.Equal(p.Variants, []string{"lamp", "chair"}) {
		t.Errorf("after edit = %v", p.Variants)
	}

	// Saving unchanged text is a no-op; emptying the file refuses to save.
	setEditor(`true`)
	if out := mustRunPlaceholders(t, "edit", "item"); !strings.HasPrefix(out, "No changes") {
		t.Errorf("unchanged edit = %q", out)
	}
	setEditor(`: > "$1"`)
	if _, err := runPlaceholders(t, "edit", "item"); err == nil {
		t.Error("emptying every variant must not save")
	}
	if p, _ := f.get("item"); len(p.Variants) != 2 {
		t.Errorf("variants changed after a refused edit: %v", p.Variants)
	}

	// A new name is created from the editor's contents; a failing editor saves nothing.
	setEditor(`printf 'dawn\ndusk\n' > "$1"`)
	if out := mustRunPlaceholders(t, "edit", "{time}"); !strings.HasPrefix(out, "Created {time}") {
		t.Errorf("edit of a new name = %q", out)
	}
	setEditor(`printf 'x\n' > "$1"; exit 1`)
	if _, err := runPlaceholders(t, "edit", "time"); err == nil {
		t.Error("a failing editor must abort")
	}
	if p, _ := f.get("time"); !slices.Equal(p.Variants, []string{"dawn", "dusk"}) {
		t.Errorf("variants changed after a failed editor run: %v", p.Variants)
	}
}

func TestPlaceholdersDelete(t *testing.T) {
	f := &fakePlaceholders{}
	f.server(t)
	mustRunPlaceholders(t, "create", "a", "1")
	mustRunPlaceholders(t, "create", "b", "2")
	b, _ := f.get("b")

	mustRunPlaceholders(t, "delete", "{A}", b.ID)
	if len(f.items) != 0 {
		t.Errorf("left = %+v", f.items)
	}
	if _, err := runPlaceholders(t, "delete", "a"); err == nil {
		t.Error("deleting a missing placeholder must fail")
	}
}

func TestPlaceholdersExpand(t *testing.T) {
	f := &fakePlaceholders{}
	f.server(t)
	mustRunPlaceholders(t, "create", "item", "lamp", "kettle", "chair")

	out := mustRunPlaceholders(t, "expand", "a {Item} at {?}", "-n", "3")
	lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("expand -n 3 = %q", out)
	}
	seen := map[string]bool{}
	for _, l := range lines {
		if strings.Contains(l, "{Item}") || !strings.HasSuffix(l, " at {?}") || seen[l] {
			t.Errorf("line %q: custom must expand without repeats, {?} must stay", l)
		}
		seen[l] = true
	}
}
