package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
)

// fakePersonas stands in for routes/personas.rs, the REST chat endpoints and the
// shared image upload/download. Photos complete on their first poll; chat
// replies complete on their second read.
type fakePersonas struct {
	mu       sync.Mutex
	personas map[string]*persona
	photos   map[string]*personaPhoto
	starts   []startPhotoRequest
	chats    []chatSummary
	sent     []map[string]string
	reads    int
	uploads  int
	nextID   int
}

func (f *fakePersonas) id() string {
	f.nextID++
	return fmt.Sprintf("%d", 100+f.nextID)
}

func (f *fakePersonas) store(in personaInput, id string) *persona {
	p := &persona{ID: id, Name: in.Name, Look: in.Look, SystemPrompt: in.SystemPrompt,
		RenderedSystemPrompt: strings.ReplaceAll(in.SystemPrompt, "{p_name}", in.Name),
		FaceImageIDs:         in.FaceImageIDs, LLMCapability: in.LLMCapability}
	for _, fid := range in.FaceImageIDs {
		p.Faces = append(p.Faces, personaImageRef{ImageID: fid, Width: 64, Height: 64})
	}
	f.personas[id] = p
	return p
}

func (f *fakePersonas) server(t *testing.T) {
	t.Helper()
	f.personas, f.photos = map[string]*persona{}, map[string]*personaPhoto{}
	mux := http.NewServeMux()
	write := func(w http.ResponseWriter, code int, v any) {
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("GET /api/personas", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		list := []persona{}
		for _, p := range f.personas {
			list = append(list, *p)
		}
		write(w, 200, list)
	})
	mux.HandleFunc("POST /api/personas", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		var in personaInput
		_ = json.NewDecoder(r.Body).Decode(&in)
		write(w, 201, f.store(in, f.id()))
	})
	mux.HandleFunc("GET /api/personas/{id}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		write(w, 200, f.personas[r.PathValue("id")])
	})
	mux.HandleFunc("PUT /api/personas/{id}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		var in personaInput
		_ = json.NewDecoder(r.Body).Decode(&in)
		write(w, 200, f.store(in, r.PathValue("id")))
	})
	mux.HandleFunc("DELETE /api/personas/{id}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		delete(f.personas, r.PathValue("id"))
		w.WriteHeader(204)
	})
	mux.HandleFunc("POST /api/personas/{id}/photos", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		var req startPhotoRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.starts = append(f.starts, req)
		n := max(req.Count, 1)
		ids := []string{}
		for range n {
			id := "ph-" + f.id()
			f.photos[id] = &personaPhoto{JobID: id, Status: "running", Steps: []photoStep{{Kind: "generate", Status: "running"}}, CreatedAt: "2026-11-13T10:00:00Z"}
			ids = append(ids, id)
		}
		write(w, 201, map[string]any{"job_ids": ids})
	})
	mux.HandleFunc("POST /api/persona-photos/{id}/poll", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		ph := f.photos[r.PathValue("id")]
		img := "img-" + ph.JobID
		ph.Status, ph.FinalImageID = "completed", &img
		ph.FinalImage = &personaImageRef{ImageID: img, Width: 2048, Height: 2048}
		write(w, 200, ph)
	})
	mux.HandleFunc("POST /api/images/upload", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.uploads++
		write(w, 201, uploadResponse{ImageID: fmt.Sprintf("face-%d", f.uploads)})
	})
	mux.HandleFunc("GET /api/images/files/{id}", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("jpg:" + r.PathValue("id")))
	})
	mux.HandleFunc("GET /api/chats", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.URL.Query().Get("kind") != "persona" || r.URL.Query().Get("persona_id") == "" {
			http.Error(w, `{"error":"bad filter"}`, 400)
			return
		}
		write(w, 200, f.chats)
	})
	mux.HandleFunc("POST /api/chats", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		c := chatSummary{ID: "chat-" + f.id(), Kind: "persona"}
		f.chats = append([]chatSummary{c}, f.chats...)
		write(w, 201, c)
	})
	mux.HandleFunc("POST /api/chats/{id}/messages", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		body["chat"] = r.PathValue("id")
		f.sent = append(f.sent, body)
		write(w, 201, sendMessageResponse{ChatID: r.PathValue("id"), AssistantMessageID: "m1", Capability: "llm.fake"})
	})
	mux.HandleFunc("GET /api/chats/{id}/messages/{mid}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.reads++
		msg := chatMessage{ID: "m1", Role: "assistant", Status: "pending"}
		if f.reads >= 2 {
			msg.Status, msg.Content = "complete", "Hello from Ada"
		}
		write(w, 200, msg)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	configureTestServer(t, server.URL)
}

func TestPersonaCreateUploadsFacesAndResolvesByName(t *testing.T) {
	f := &fakePersonas{}
	f.server(t)
	face := testImage(t, "face.jpg")
	out, err := captureCLIStdout(t, func() error {
		return cmdPersona([]string{"create", "-name", "Ada", "-look", "silver hair", "-system", "You are {p_name}", "-llm", "llm.x", "-face", face, "-face", face})
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !strings.Contains(out, "Created persona Ada") || f.uploads != 2 {
		t.Fatalf("out=%q uploads=%d", out, f.uploads)
	}
	var created *persona
	for _, p := range f.personas {
		created = p
	}
	if created.Look != "silver hair" || *created.LLMCapability != "llm.x" || len(created.FaceImageIDs) != 2 {
		t.Fatalf("stored %+v", created)
	}

	// Lookup is case-insensitive by name; "auto" clears a preference; faces are kept.
	if _, err := captureCLIStdout(t, func() error { return cmdPersona([]string{"update", "ada", "-llm", "auto", "-name", "Ada L"}) }); err != nil {
		t.Fatalf("update: %v", err)
	}
	if created = f.personas[created.ID]; created.LLMCapability != nil || created.Name != "Ada L" || len(created.FaceImageIDs) != 2 {
		t.Fatalf("after update %+v", created)
	}
	if _, err := captureCLIStdout(t, func() error { return cmdPersona([]string{"face", "primary", "ada l", "face-2"}) }); err != nil {
		t.Fatalf("primary: %v", err)
	}
	if got := f.personas[created.ID].FaceImageIDs; got[0] != "face-2" || got[1] != "face-1" {
		t.Fatalf("faces after primary = %v", got)
	}
	if err := cmdPersona([]string{"face", "primary", "Ada L", "nope"}); err == nil {
		t.Fatal("unknown face must fail")
	}
	if err := cmdPersona([]string{"show", "Nobody"}); err == nil || !strings.Contains(err.Error(), "known: Ada L") {
		t.Fatalf("unknown persona err = %v", err)
	}
}

func TestPersonaPhotoDefaultsAndBatchNaming(t *testing.T) {
	shortPollInterval(t)
	f := &fakePersonas{}
	f.server(t)
	testImage(t, "x.jpg")
	f.store(personaInput{Name: "Ada", FaceImageIDs: []string{"f1"}}, "7")
	out, err := captureCLIStdout(t, func() error {
		return cmdPersona([]string{"photo", "Ada", "{p_look} on a beach", "-n", "2", "-o", "ada.jpg", "--progress=false"})
	})
	if err != nil {
		t.Fatalf("photo: %v", err)
	}
	req := f.starts[0]
	// Defaults: the server decides face swap (on with faces) and upscale (on); scale 2 is sent.
	if req.Prompt != "{p_look} on a beach" || req.Count != 2 || req.FaceSwap != nil || req.Upscale != nil || req.Scale == nil || *req.Scale != 2 {
		t.Fatalf("request %+v", req)
	}
	if out != "Saved ada.jpg (2048x2048)\nSaved ada_2.jpg (2048x2048)\n" {
		t.Fatalf("stdout %q", out)
	}
	if data, _ := os.ReadFile("ada_2.jpg"); !strings.HasPrefix(string(data), "jpg:img-ph-") {
		t.Fatalf("saved %q", data)
	}
}

func TestPersonaPhotoNoWaitPrintsOnlyIDs(t *testing.T) {
	f := &fakePersonas{}
	f.server(t)
	f.store(personaInput{Name: "Ada"}, "7")
	out, err := captureCLIStdout(t, func() error {
		return cmdPersona([]string{"photo", "7", "x", "--no-wait", "-no-faceswap", "-no-upscale"})
	})
	if err != nil {
		t.Fatalf("photo: %v", err)
	}
	if lines := strings.Fields(out); len(lines) != 1 || !strings.HasPrefix(lines[0], "ph-") {
		t.Fatalf("stdout %q", out)
	}
	req := f.starts[0]
	if req.FaceSwap == nil || *req.FaceSwap || req.Upscale == nil || *req.Upscale || req.Scale != nil {
		t.Fatalf("request %+v", req)
	}
	if err := cmdPersona([]string{"photo", "7", "x", "--no-wait", "-o", "y.jpg"}); err == nil {
		t.Fatal("-o with --no-wait must fail")
	}
}

func TestPersonaChatReusesLatestChatAndWaits(t *testing.T) {
	shortPollInterval(t)
	f := &fakePersonas{}
	f.server(t)
	f.store(personaInput{Name: "Ada"}, "7")
	out, err := captureCLIStdout(t, func() error {
		return cmdPersona([]string{"chat", "Ada", "hello", "--progress=false"})
	})
	if err != nil {
		t.Fatalf("chat: %v", err)
	}
	if out != "Hello from Ada\n" {
		t.Fatalf("stdout %q", out)
	}
	first := f.sent[0]["chat"]
	if len(f.chats) != 1 || first != f.chats[0].ID {
		t.Fatalf("expected a new chat to be created, got %v / %v", f.chats, first)
	}
	f.reads = 0
	if _, err := captureCLIStdout(t, func() error {
		return cmdPersona([]string{"chat", "Ada", "again", "-model", "llm.y", "--progress=false"})
	}); err != nil {
		t.Fatalf("chat 2: %v", err)
	}
	if len(f.chats) != 1 || f.sent[1]["chat"] != first || f.sent[1]["capability"] != "llm.y" {
		t.Fatalf("second message should reuse %s: %v", first, f.sent[1])
	}
	f.reads = 0
	if _, err := captureCLIStdout(t, func() error { return cmdPersona([]string{"chat", "Ada", "fresh", "-new", "--progress=false"}) }); err != nil {
		t.Fatalf("chat 3: %v", err)
	}
	if len(f.chats) != 2 || f.sent[2]["chat"] == first {
		t.Fatalf("-new should start a chat: %v", f.sent[2])
	}
}
