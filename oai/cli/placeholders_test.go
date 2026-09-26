package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestExpandBuiltinCategories(t *testing.T) {
	e := newPlaceholderExpander(nil)
	got := e.Expand("a {Color} {animal} in {country}, speaking {language}, named {name}, very {adjective}")
	if strings.Contains(got, "{") {
		t.Fatalf("builtin placeholders left unexpanded: %q", got)
	}
}

func TestExpandLeavesServerAndUnknownTokens(t *testing.T) {
	e := newPlaceholderExpander(nil)
	for _, in := range []string{"a {?} b", "empty {} braces", "{nope}", "no braces"} {
		if got := e.Expand(in); got != in {
			t.Errorf("Expand(%q) = %q, want unchanged", in, got)
		}
	}
	if got := e.Expand("{starwars}"); got != "{starwars}" {
		t.Errorf("starwars = %q, want literal", got)
	}
	if u := e.Unsupported(); len(u) != 1 || u[0] != "{starwars}" {
		t.Errorf("Unsupported() = %v", u)
	}
}

func TestExpandCustomRecursiveAndCaseInsensitive(t *testing.T) {
	e := newPlaceholderExpander([]promptPlaceholder{
		{Name: ".Cinematic", Variants: []string{"moody {mood}"}},
		{Name: "mood", Variants: []string{"blue"}},
		{Name: "loop", Variants: []string{"{loop}"}},
	})
	if got := e.Expand("scene {.cinematic}"); got != "scene moody blue" {
		t.Errorf("got %q", got)
	}
	// A cyclic definition must terminate and stay literal once the depth cap is hit.
	if got := e.Expand("{loop}"); got != "{loop}" {
		t.Errorf("cyclic = %q", got)
	}
}

func TestExpandCustomDoesNotRepeatWithinBatch(t *testing.T) {
	variants := []string{"a", "b", "c", "d"}
	e := newPlaceholderExpander([]promptPlaceholder{{Name: "x", Variants: variants}})
	seen := map[string]bool{}
	for range variants {
		v := e.Expand("{x}")
		if seen[v] {
			t.Fatalf("repeated %q before pool exhausted", v)
		}
		seen[v] = true
	}
	// Pool exhausted: must start a new cycle rather than hang.
	if v := e.Expand("{x}"); v == "" {
		t.Fatal("empty value after exhaustion")
	}
}

func TestImageGenerateExpandsPlaceholders(t *testing.T) {
	var mu sync.Mutex
	var requests []startJobRequest

	mux := http.NewServeMux()
	mux.HandleFunc("/api/prompt-placeholders", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]promptPlaceholder{
			{ID: "1", Name: "item", Variants: []string{"lamp", "kettle", "chair"}},
		})
	})
	mux.HandleFunc("/api/images/jobs", func(w http.ResponseWriter, r *http.Request) {
		var req startJobRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		mu.Lock()
		requests = append(requests, req)
		n := len(requests)
		mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(startJobResponse{JobID: fmt.Sprintf("job-%d", n), Status: "submitted"})
	})
	mux.HandleFunc("/api/images/jobs/", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(pollResponse{
			JobID:        "x",
			Status:       "completed",
			OutputImages: []imageRef{{ImageID: "img"}},
		})
	})
	mux.HandleFunc("/api/images/files/", func(w http.ResponseWriter, r *http.Request) {})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	configureTestServer(t, server.URL)

	const template = "a {item} at {?}"
	err := cmdImageGenerate([]string{
		template, "-capability", "imggen.test", "-n", "3",
		"-o", filepath.Join(t.TempDir(), "r.jpg"), "--progress=false",
	})
	if err != nil {
		t.Fatalf("generate: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	seen := map[string]bool{}
	for i, req := range requests {
		if req.PromptTemplate != template {
			t.Errorf("request %d template = %q, want %q", i+1, req.PromptTemplate, template)
		}
		if strings.Contains(req.Prompt, "{item}") || !strings.HasSuffix(req.Prompt, " at {?}") {
			t.Errorf("request %d prompt = %q ({item} must expand, {?} must stay for the server)", i+1, req.Prompt)
		}
		if seen[req.Prompt] {
			t.Errorf("request %d repeated prompt %q", i+1, req.Prompt)
		}
		seen[req.Prompt] = true
	}
	if len(requests) != 3 {
		t.Fatalf("requests = %d, want 3", len(requests))
	}
}

func TestImageGenerateSurvivesPlaceholderFetchFailure(t *testing.T) {
	var got startJobRequest
	mux := http.NewServeMux()
	mux.HandleFunc("/api/prompt-placeholders", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"boom"}`, http.StatusInternalServerError)
	})
	mux.HandleFunc("/api/images/jobs", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(startJobResponse{JobID: "j", Status: "submitted"})
	})
	mux.HandleFunc("/api/images/jobs/", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(pollResponse{Status: "completed", OutputImages: []imageRef{{ImageID: "img"}}})
	})
	mux.HandleFunc("/api/images/files/", func(w http.ResponseWriter, r *http.Request) {})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	configureTestServer(t, server.URL)

	err := cmdImageGenerate([]string{
		"a {item} and a {color} cat", "-capability", "imggen.test",
		"-o", filepath.Join(t.TempDir(), "r.jpg"), "--progress=false",
	})
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if !strings.HasPrefix(got.Prompt, "a {item} and a ") || strings.Contains(got.Prompt, "{color}") {
		t.Errorf("prompt = %q: custom token should stay literal, builtin should expand", got.Prompt)
	}
}
