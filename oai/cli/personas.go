package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"text/tabwriter"
	"time"
)

// Personas (the web UI's /app/personas): characters with face images, a look
// description, a system prompt and model preferences. Wraps routes/personas.rs
// (/api/personas, /api/persona-photos) and the REST chat endpoints in
// routes/chats.rs; mirrors frontend/src/api/personas.ts.

type personaImageRef struct {
	ImageID     string `json:"image_id"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
}

type effectiveChoice struct {
	Capability string  `json:"capability"`
	Workflow   *string `json:"workflow"`
	Source     string  `json:"source"`
	Online     bool    `json:"online"`
}

type effectiveModels struct {
	LLM      *effectiveChoice `json:"llm"`
	Txt2img  *effectiveChoice `json:"txt2img"`
	Img2img  *effectiveChoice `json:"img2img"`
	FaceSwap *effectiveChoice `json:"face_swap"`
	Upscaler *effectiveChoice `json:"upscaler"`
	Errors   []string         `json:"errors"`
}

// persona mirrors PersonaView in services/personas.rs.
type persona struct {
	ID                   string            `json:"id"`
	Name                 string            `json:"name"`
	SystemPrompt         string            `json:"system_prompt"`
	RenderedSystemPrompt string            `json:"rendered_system_prompt"`
	Look                 string            `json:"look"`
	FaceImageIDs         []string          `json:"face_image_ids"`
	Faces                []personaImageRef `json:"faces"`
	LLMCapability        *string           `json:"llm_capability"`
	Txt2imgCapability    *string           `json:"txt2img_capability"`
	Img2imgCapability    *string           `json:"img2img_capability"`
	FaceSwapCapability   *string           `json:"face_swap_capability"`
	UpscalerCapability   *string           `json:"upscaler_capability"`
	Effective            *effectiveModels  `json:"effective,omitempty"`
	CreatedAt            string            `json:"created_at"`
	UpdatedAt            string            `json:"updated_at"`
}

// personaInput is the create / full-replace body (PersonaInput).
type personaInput struct {
	Name               string   `json:"name"`
	SystemPrompt       string   `json:"system_prompt"`
	Look               string   `json:"look"`
	FaceImageIDs       []string `json:"face_image_ids"`
	LLMCapability      *string  `json:"llm_capability"`
	Txt2imgCapability  *string  `json:"txt2img_capability"`
	Img2imgCapability  *string  `json:"img2img_capability"`
	FaceSwapCapability *string  `json:"face_swap_capability"`
	UpscalerCapability *string  `json:"upscaler_capability"`
}

func (p persona) input() personaInput {
	return personaInput{
		Name: p.Name, SystemPrompt: p.SystemPrompt, Look: p.Look,
		FaceImageIDs:      append([]string{}, p.FaceImageIDs...),
		LLMCapability:     p.LLMCapability,
		Txt2imgCapability: p.Txt2imgCapability, Img2imgCapability: p.Img2imgCapability,
		FaceSwapCapability: p.FaceSwapCapability, UpscalerCapability: p.UpscalerCapability,
	}
}

type photoStep struct {
	Kind          string  `json:"kind"`
	Status        string  `json:"status"`
	Capability    string  `json:"capability"`
	Workflow      string  `json:"workflow"`
	ChildJobID    *string `json:"child_job_id"`
	OutputImageID *string `json:"output_image_id"`
	Stage         *string `json:"stage"`
	Error         *string `json:"error"`
}

// personaPhoto mirrors PhotoView in services/persona_photos.rs.
type personaPhoto struct {
	JobID          string           `json:"job_id"`
	PersonaID      string           `json:"persona_id"`
	Status         string           `json:"status"`
	PromptTemplate string           `json:"prompt_template"`
	Prompt         string           `json:"prompt"`
	Steps          []photoStep      `json:"steps"`
	FinalImageID   *string          `json:"final_image_id"`
	FinalImage     *personaImageRef `json:"final_image"`
	Error          *string          `json:"error"`
	CreatedAt      string           `json:"created_at"`
	UpdatedAt      string           `json:"updated_at"`
}

// activeStep is the step currently running (or the last one).
func (p personaPhoto) activeStep() *photoStep {
	for i := range p.Steps {
		if p.Steps[i].Status != "completed" && p.Steps[i].Status != "skipped" {
			return &p.Steps[i]
		}
	}
	if len(p.Steps) == 0 {
		return nil
	}
	return &p.Steps[len(p.Steps)-1]
}

func (p personaPhoto) progressState() jobProgressState {
	stage := ""
	if s := p.activeStep(); s != nil && !isTerminal(p.Status) {
		stage = stepName(s.Kind)
		if s.Stage != nil && *s.Stage != "" {
			stage += ": " + *s.Stage
		}
	}
	created := p.CreatedAt
	return jobProgressState{Status: p.Status, Stage: stage, SubmittedAt: &created}
}

func stepName(kind string) string {
	switch kind {
	case "face_swap":
		return "face swap"
	default:
		return kind
	}
}

func (p personaPhoto) stepSummary() string {
	parts := make([]string, 0, len(p.Steps))
	for _, s := range p.Steps {
		parts = append(parts, stepName(s.Kind)+": "+s.Status)
	}
	return strings.Join(parts, " → ")
}

type startPhotoRequest struct {
	Prompt         string   `json:"prompt"`
	NegativePrompt string   `json:"negative_prompt,omitempty"`
	Workflow       string   `json:"workflow,omitempty"`
	InputImageID   string   `json:"input_image_id,omitempty"`
	Width          int      `json:"width,omitempty"`
	Height         int      `json:"height,omitempty"`
	Seed           *int64   `json:"seed,omitempty"`
	Count          int      `json:"count,omitempty"`
	FaceImageID    string   `json:"face_image_id,omitempty"`
	FaceSwap       *bool    `json:"face_swap,omitempty"`
	Upscale        *bool    `json:"upscale,omitempty"`
	Scale          *float64 `json:"scale,omitempty"`
	ImageModel     string   `json:"image_model,omitempty"`
}

type chatSummary struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	LastModel *string `json:"last_model"`
	Kind      string  `json:"kind"`
	PersonaID *string `json:"persona_id"`
	UpdatedAt string  `json:"updated_at"`
}

type chatMessage struct {
	ID        string  `json:"id"`
	Role      string  `json:"role"`
	Content   string  `json:"content"`
	Status    string  `json:"status"`
	Model     *string `json:"model"`
	CreatedAt string  `json:"created_at"`
}

type sendMessageResponse struct {
	ChatID             string `json:"chat_id"`
	AssistantMessageID string `json:"assistant_message_id"`
	Capability         string `json:"capability"`
}

const personaUsage = "usage: oai persona <list|show|models|create|update|delete|face|photo|photos|photo-job|photo-poll|photo-cancel|photo-retry|photo-delete|photo-download|chat|chats|history> ..."

func cmdPersona(args []string) error {
	if len(args) == 0 {
		return errors.New(personaUsage)
	}
	rest := args[1:]
	switch args[0] {
	case "list", "ls":
		return cmdPersonaList(rest)
	case "show":
		return cmdPersonaShow(rest)
	case "models":
		return cmdPersonaModels(rest)
	case "create", "new":
		return cmdPersonaCreate(rest)
	case "update", "edit":
		return cmdPersonaUpdate(rest)
	case "delete", "rm":
		return cmdPersonaDelete(rest)
	case "face", "faces":
		return cmdPersonaFace(rest)
	case "photo", "generate":
		return cmdPersonaPhoto(rest)
	case "photos":
		return cmdPersonaPhotos(rest)
	case "photo-job":
		return cmdPersonaPhotoJob(rest, false)
	case "photo-poll":
		return cmdPersonaPhotoJob(rest, true)
	case "photo-cancel":
		return cmdPersonaPhotoCancel(rest)
	case "photo-retry":
		return cmdPersonaPhotoRetry(rest)
	case "photo-delete":
		return cmdPersonaPhotoDelete(rest)
	case "photo-download":
		return cmdPersonaPhotoDownload(rest)
	case "chat", "say":
		return cmdPersonaChat(rest)
	case "chats":
		return cmdPersonaChats(rest)
	case "history":
		return cmdPersonaHistory(rest)
	}
	return fmt.Errorf("unknown persona command %q (%s)", args[0], personaUsage)
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

func personasURL(cfg *Config, parts ...string) string {
	u := cfg.serverURL("") + "/api/personas"
	for _, p := range parts {
		u += "/" + url.PathEscape(p)
	}
	return u
}

func personaPhotoURL(cfg *Config, id string, action ...string) string {
	u := cfg.serverURL("") + "/api/persona-photos/" + url.PathEscape(id)
	for _, a := range action {
		u += "/" + a
	}
	return u
}

func fetchPersonas(cfg *Config) ([]persona, error) {
	var list []persona
	err := doJSON("GET", personasURL(cfg), cfg.Token, nil, &list)
	return list, err
}

// resolvePersona finds a persona by id or (case-insensitive) name.
func resolvePersona(cfg *Config, ref string) (*persona, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return nil, errors.New("persona name or id is required")
	}
	list, err := fetchPersonas(cfg)
	if err != nil {
		return nil, err
	}
	for i := range list {
		if list[i].ID == ref {
			return &list[i], nil
		}
	}
	for i := range list {
		if strings.EqualFold(list[i].Name, ref) {
			return &list[i], nil
		}
	}
	names := make([]string, 0, len(list))
	for _, p := range list {
		names = append(names, p.Name)
	}
	if len(names) == 0 {
		return nil, fmt.Errorf("no persona %q (you have none — oai persona create -name …)", ref)
	}
	return nil, fmt.Errorf("no persona %q; known: %s", ref, strings.Join(names, ", "))
}

func putPersona(cfg *Config, id string, in personaInput) (*persona, error) {
	var out persona
	if err := doJSON("PUT", personasURL(cfg, id), cfg.Token, in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func uploadImages(cfg *Config, paths []string) ([]string, error) {
	ids := make([]string, 0, len(paths))
	for _, p := range paths {
		var up uploadResponse
		if err := uploadFile(cfg.serverURL("")+"/api/images/upload", cfg.Token, p, &up); err != nil {
			return nil, fmt.Errorf("upload %s: %w", p, err)
		}
		ids = append(ids, up.ImageID)
	}
	return ids, nil
}

func strOr(p *string, def string) string {
	if p == nil || *p == "" {
		return def
	}
	return *p
}

// ── Profile commands ─────────────────────────────────────────────────────────

func cmdPersonaList(args []string) error {
	fs := flag.NewFlagSet("persona list", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print JSON")
	if _, err := parseInterleaved(fs, args); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	list, err := fetchPersonas(cfg)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(list)
	}
	if len(list) == 0 {
		fmt.Println("No personas yet — create one with: oai persona create -name NAME")
		return nil
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tNAME\tFACES\tLLM\tTXT2IMG")
	for _, p := range list {
		fmt.Fprintf(tw, "%s\t%s\t%d\t%s\t%s\n", p.ID, p.Name, len(p.Faces), strOr(p.LLMCapability, "auto"), strOr(p.Txt2imgCapability, "auto"))
	}
	return tw.Flush()
}

func cmdPersonaShow(args []string) error {
	fs := flag.NewFlagSet("persona show", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print JSON")
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return errors.New("usage: oai persona show <persona> [-json]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	ref, err := resolvePersona(cfg, pos[0])
	if err != nil {
		return err
	}
	var p persona
	if err := doJSON("GET", personasURL(cfg, ref.ID), cfg.Token, nil, &p); err != nil {
		return err
	}
	if *asJSON {
		return printJSON(p)
	}
	printPersona(&p)
	return nil
}

func printPersona(p *persona) {
	fmt.Printf("Persona:  %s (%s)\n", p.Name, p.ID)
	if p.Look != "" {
		fmt.Printf("Look:     %s\n", p.Look)
	}
	if p.SystemPrompt != "" {
		fmt.Printf("System:   %s\n", strings.ReplaceAll(p.RenderedSystemPrompt, "\n", "\n          "))
	}
	for i, f := range p.Faces {
		primary := ""
		if i == 0 {
			primary = " (primary)"
		}
		fmt.Printf("Face %d:   %s %dx%d%s\n", i+1, f.ImageID, f.Width, f.Height, primary)
	}
	prefs := []struct {
		name string
		pref *string
		eff  *effectiveChoice
	}{
		{"LLM", p.LLMCapability, nil}, {"txt2img", p.Txt2imgCapability, nil}, {"img2img", p.Img2imgCapability, nil},
		{"Face swap", p.FaceSwapCapability, nil}, {"Upscaler", p.UpscalerCapability, nil},
	}
	if e := p.Effective; e != nil {
		prefs[0].eff, prefs[1].eff, prefs[2].eff, prefs[3].eff, prefs[4].eff = e.LLM, e.Txt2img, e.Img2img, e.FaceSwap, e.Upscaler
	}
	for _, s := range prefs {
		line := strOr(s.pref, "auto")
		if p.Effective != nil {
			if s.eff == nil {
				line += " → none online"
			} else {
				line += fmt.Sprintf(" → %s (%s", s.eff.Capability, strings.ReplaceAll(s.eff.Source, "_", " "))
				if !s.eff.Online {
					line += ", offline"
				}
				line += ")"
			}
		}
		fmt.Printf("%-10s %s\n", s.name+":", line)
	}
	if p.Effective != nil {
		for _, e := range p.Effective.Errors {
			fmt.Fprintf(os.Stderr, "warning: %s\n", e)
		}
	}
}

type modelOption struct {
	Capability string  `json:"capability"`
	Workflow   *string `json:"workflow"`
	Online     bool    `json:"online"`
}

func cmdPersonaModels(args []string) error {
	fs := flag.NewFlagSet("persona models", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print JSON")
	if _, err := parseInterleaved(fs, args); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var opts struct {
		LLM      []modelOption `json:"llm"`
		Txt2img  []modelOption `json:"txt2img"`
		Img2img  []modelOption `json:"img2img"`
		FaceSwap []modelOption `json:"face_swap"`
		Upscaler []modelOption `json:"upscaler"`
		Errors   []string      `json:"errors"`
	}
	if err := doJSON("GET", personasURL(cfg, "options"), cfg.Token, nil, &opts); err != nil {
		return err
	}
	if *asJSON {
		return printJSON(opts)
	}
	for _, g := range []struct {
		name string
		list []modelOption
	}{{"llm (-llm)", opts.LLM}, {"txt2img (-txt2img)", opts.Txt2img}, {"img2img (-img2img)", opts.Img2img}, {"face swap (-faceswap)", opts.FaceSwap}, {"upscaler (-upscaler)", opts.Upscaler}} {
		fmt.Printf("%s:\n", g.name)
		if len(g.list) == 0 {
			fmt.Println("  none")
		}
		for _, m := range g.list {
			suffix := ""
			if m.Workflow != nil {
				suffix = " [" + *m.Workflow + "]"
			}
			if !m.Online {
				suffix += " (offline)"
			}
			fmt.Printf("  %s%s\n", m.Capability, suffix)
		}
	}
	for _, e := range opts.Errors {
		fmt.Fprintf(os.Stderr, "warning: %s\n", e)
	}
	return nil
}

// profileFlags are shared by create and update. Text flags apply only when
// given; model flags take a capability or "auto".
type profileFlags struct {
	fs                                       *flag.FlagSet
	name, look, lookFile, system, systemFile *string
	llm, txt2img, img2img, faceswap, upscale *string
	faces                                    optionList
}

// optionList is a repeatable string flag.
type optionList []string

func (o *optionList) String() string { return strings.Join(*o, ",") }
func (o *optionList) Set(s string) error {
	*o = append(*o, s)
	return nil
}

func newProfileFlags(name string) *profileFlags {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	pf := &profileFlags{fs: fs}
	pf.name = fs.String("name", "", "display name")
	pf.look = fs.String("look", "", "how the persona looks ({p_look})")
	pf.lookFile = fs.String("look-file", "", "read the look description from a file (- = stdin)")
	pf.system = fs.String("system", "", "system prompt for chats (may use {p_name}, {p_look})")
	pf.systemFile = fs.String("system-file", "", "read the system prompt from a file (- = stdin)")
	pf.llm = fs.String("llm", "", "preferred chat model (llm.*) or auto")
	pf.txt2img = fs.String("txt2img", "", "preferred txt2img model (imggen.*) or auto")
	pf.img2img = fs.String("img2img", "", "preferred img2img model (imggen.*) or auto")
	pf.faceswap = fs.String("faceswap", "", "preferred face swap tool (img-utils.*) or auto")
	pf.upscale = fs.String("upscaler", "", "preferred upscaler (img-utils.*) or auto")
	fs.Var(&pf.faces, "face", "face image file to upload and add (repeatable; first = primary)")
	return pf
}

func readTextFlag(value, file string) (string, bool, error) {
	if file == "" {
		return value, value != "", nil
	}
	var data []byte
	var err error
	if file == "-" {
		data, err = io.ReadAll(os.Stdin)
	} else {
		data, err = os.ReadFile(file)
	}
	if err != nil {
		return "", false, err
	}
	return strings.TrimSpace(string(data)), true, nil
}

// apply overlays the given flags onto in (only flags that were set).
func (pf *profileFlags) apply(cfg *Config, in *personaInput) error {
	set := map[string]bool{}
	pf.fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	if set["name"] {
		in.Name = *pf.name
	}
	if look, ok, err := readTextFlag(*pf.look, *pf.lookFile); err != nil {
		return err
	} else if ok || set["look"] {
		in.Look = look
	}
	if sys, ok, err := readTextFlag(*pf.system, *pf.systemFile); err != nil {
		return err
	} else if ok || set["system"] {
		in.SystemPrompt = sys
	}
	for flagName, dst := range map[string]**string{
		"llm": &in.LLMCapability, "txt2img": &in.Txt2imgCapability, "img2img": &in.Img2imgCapability,
		"faceswap": &in.FaceSwapCapability, "upscaler": &in.UpscalerCapability,
	} {
		if !set[flagName] {
			continue
		}
		v := pf.fs.Lookup(flagName).Value.String()
		if v == "" || strings.EqualFold(v, "auto") {
			*dst = nil
		} else {
			*dst = &v
		}
	}
	if len(pf.faces) > 0 {
		ids, err := uploadImages(cfg, pf.faces)
		if err != nil {
			return err
		}
		in.FaceImageIDs = append(in.FaceImageIDs, ids...)
	}
	return nil
}

func cmdPersonaCreate(args []string) error {
	pf := newProfileFlags("persona create")
	asJSON := pf.fs.Bool("json", false, "print JSON")
	pos, err := parseInterleaved(pf.fs, args)
	if err != nil {
		return err
	}
	if *pf.name == "" && len(pos) == 1 {
		*pf.name = pos[0]
		_ = pf.fs.Set("name", pos[0])
	}
	if strings.TrimSpace(*pf.name) == "" {
		return errors.New("usage: oai persona create -name NAME [-look …] [-system …] [-face img.jpg …]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	in := personaInput{FaceImageIDs: []string{}}
	if err := pf.apply(cfg, &in); err != nil {
		return err
	}
	var out persona
	if err := doJSON("POST", personasURL(cfg), cfg.Token, in, &out); err != nil {
		return err
	}
	if *asJSON {
		return printJSON(out)
	}
	fmt.Printf("Created persona %s (%s) with %d face(s)\n", out.Name, out.ID, len(out.Faces))
	return nil
}

func cmdPersonaUpdate(args []string) error {
	pf := newProfileFlags("persona update")
	asJSON := pf.fs.Bool("json", false, "print JSON")
	pos, err := parseInterleaved(pf.fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return errors.New("usage: oai persona update <persona> [-name …] [-look …] [-system …] [-llm cap|auto] …")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	p, err := resolvePersona(cfg, pos[0])
	if err != nil {
		return err
	}
	in := p.input()
	if err := pf.apply(cfg, &in); err != nil {
		return err
	}
	out, err := putPersona(cfg, p.ID, in)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(out)
	}
	fmt.Printf("Updated persona %s (%s)\n", out.Name, out.ID)
	return nil
}

func cmdPersonaDelete(args []string) error {
	fs := flag.NewFlagSet("persona delete", flag.ContinueOnError)
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(pos) == 0 {
		return errors.New("usage: oai persona delete <persona> [persona ...]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var errs []error
	for _, ref := range pos {
		p, err := resolvePersona(cfg, ref)
		if err == nil {
			err = doJSON("DELETE", personasURL(cfg, p.ID), cfg.Token, nil, nil)
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", ref, err))
			continue
		}
		fmt.Printf("Deleted persona %s (%s)\n", p.Name, p.ID)
	}
	return errors.Join(errs...)
}

func cmdPersonaFace(args []string) error {
	const u = "usage: oai persona face <list|add|remove|primary> <persona> …"
	if len(args) < 2 {
		return errors.New(u)
	}
	sub, ref, rest := args[0], args[1], args[2:]
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	p, err := resolvePersona(cfg, ref)
	if err != nil {
		return err
	}
	in := p.input()
	switch sub {
	case "list", "ls":
		for i, f := range p.Faces {
			primary := ""
			if i == 0 {
				primary = "  (primary)"
			}
			fmt.Printf("%s  %dx%d  %s%s\n", f.ImageID, f.Width, f.Height, f.Filename, primary)
		}
		return nil
	case "add":
		if len(rest) == 0 {
			return errors.New("usage: oai persona face add <persona> image.jpg [image ...]")
		}
		ids, err := uploadImages(cfg, rest)
		if err != nil {
			return err
		}
		in.FaceImageIDs = append(in.FaceImageIDs, ids...)
	case "remove", "rm":
		if len(rest) == 0 {
			return errors.New("usage: oai persona face remove <persona> <image-id> [...]")
		}
		var kept []string
		for _, id := range in.FaceImageIDs {
			drop := false
			for _, r := range rest {
				drop = drop || r == id
			}
			if !drop {
				kept = append(kept, id)
			}
		}
		if len(kept) == len(in.FaceImageIDs) {
			return fmt.Errorf("none of %s are faces of %s", strings.Join(rest, ", "), p.Name)
		}
		in.FaceImageIDs = append([]string{}, kept...)
	case "primary":
		if len(rest) != 1 {
			return errors.New("usage: oai persona face primary <persona> <image-id>")
		}
		ordered := []string{rest[0]}
		found := false
		for _, id := range in.FaceImageIDs {
			if id == rest[0] {
				found = true
			} else {
				ordered = append(ordered, id)
			}
		}
		if !found {
			return fmt.Errorf("%s is not a face of %s (oai persona face list %q)", rest[0], p.Name, p.Name)
		}
		in.FaceImageIDs = ordered
	default:
		return errors.New(u)
	}
	out, err := putPersona(cfg, p.ID, in)
	if err != nil {
		return err
	}
	fmt.Printf("%s now has %d face(s)", out.Name, len(out.Faces))
	if len(out.Faces) > 0 {
		fmt.Printf("; primary %s", out.Faces[0].ImageID)
	}
	fmt.Println()
	return nil
}

// ── Photos ───────────────────────────────────────────────────────────────────

func cmdPersonaPhoto(args []string) error {
	fs := flag.NewFlagSet("persona photo", flag.ContinueOnError)
	out := fs.String("o", "persona.jpg", "output file (batches add _2, _3, …)")
	count := fs.Int("n", 1, "number of photos (1-8)")
	input := fs.String("input", "", "img2img: source image file")
	face := fs.String("face", "", "face image id to swap in (default: the primary face)")
	noSwap := fs.Bool("no-faceswap", false, "skip the face swap step")
	noUpscale := fs.Bool("no-upscale", false, "skip the upscale step")
	scale := fs.Float64("scale", 2, "upscale factor (1-8)")
	negative := fs.String("negative", "", "negative prompt")
	seed := fs.Int64("seed", 0, "seed (0 = random; batches add the index)")
	width := fs.Int("width", 0, "width (default 1024, or the input's size)")
	height := fs.Int("height", 0, "height")
	model := fs.String("model", "", "image model override (imggen.*)")
	noWait := fs.Bool("no-wait", false, "print the job id(s) and exit")
	progress := progressFlag(fs)
	timeout := timeoutFlag(fs)
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 2 {
		return errors.New(`usage: oai persona photo <persona> "prompt" [-o out.jpg] [-n N] [-input img.jpg] [-no-faceswap] [-no-upscale] [--no-wait]`)
	}
	if *noWait {
		set := false
		fs.Visit(func(f *flag.Flag) { set = set || f.Name == "o" })
		if set {
			return errors.New("-o cannot be used with --no-wait (use oai persona photo-download later)")
		}
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	p, err := resolvePersona(cfg, pos[0])
	if err != nil {
		return err
	}
	req := startPhotoRequest{
		Prompt: pos[1], NegativePrompt: *negative, Width: *width, Height: *height,
		Count: *count, FaceImageID: *face, ImageModel: *model,
	}
	if *seed != 0 {
		req.Seed = seed
	}
	if *noSwap {
		f := false
		req.FaceSwap = &f
	}
	if *noUpscale {
		f := false
		req.Upscale = &f
	} else {
		req.Scale = scale
	}
	if *input != "" {
		ids, err := uploadImages(cfg, []string{*input})
		if err != nil {
			return err
		}
		req.Workflow, req.InputImageID = "img2img", ids[0]
	}
	var started struct {
		JobIDs []string `json:"job_ids"`
	}
	if err := doJSON("POST", personasURL(cfg, p.ID, "photos"), cfg.Token, req, &started); err != nil {
		return err
	}
	if *noWait {
		for _, id := range started.JobIDs {
			fmt.Println(id)
		}
		return nil
	}
	var errs []error
	for i, id := range started.JobIDs {
		fmt.Fprintf(os.Stderr, "Photo job: %s\n", id)
		photo, err := waitForPersonaPhoto(cfg, id, p.Name, *timeout, *progress)
		if err == nil {
			err = savePersonaPhoto(cfg, photo, indexedOutputPath(*out, i))
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", id, err))
		}
	}
	return errors.Join(errs...)
}

func waitForPersonaPhoto(cfg *Config, id, label string, timeout time.Duration, showProgress bool) (*personaPhoto, error) {
	var photo personaPhoto
	err := waitForJob(os.Stderr, id, timeout, jobProgressOptions{
		Enabled: showProgress, Label: label, RunningLabel: "Generating",
	}, func(ctx context.Context) (jobProgressState, error) {
		if err := doJSONContext(ctx, "POST", personaPhotoURL(cfg, id, "poll"), cfg.Token, nil, &photo); err != nil {
			return jobProgressState{}, err
		}
		return photo.progressState(), nil
	})
	if err != nil {
		return nil, err
	}
	if photo.Status != "completed" {
		return nil, fmt.Errorf("photo %s: %s", photo.Status, strOr(photo.Error, "no error message"))
	}
	return &photo, nil
}

func savePersonaPhoto(cfg *Config, photo *personaPhoto, dest string) error {
	if photo.FinalImageID == nil {
		return errors.New("photo completed without an image")
	}
	if err := downloadFile(cfg.serverURL("")+"/api/images/files/"+url.PathEscape(*photo.FinalImageID), cfg.Token, dest); err != nil {
		return err
	}
	if photo.FinalImage != nil {
		fmt.Printf("Saved %s (%dx%d)\n", dest, photo.FinalImage.Width, photo.FinalImage.Height)
	} else {
		fmt.Printf("Saved %s\n", dest)
	}
	return nil
}

func cmdPersonaPhotos(args []string) error {
	fs := flag.NewFlagSet("persona photos", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print JSON")
	limit := fs.Int("limit", 50, "max runs")
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return errors.New("usage: oai persona photos <persona> [-limit N] [-json]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	p, err := resolvePersona(cfg, pos[0])
	if err != nil {
		return err
	}
	var list []personaPhoto
	if err := doJSON("GET", personasURL(cfg, p.ID, "photos")+fmt.Sprintf("?limit=%d", *limit), cfg.Token, nil, &list); err != nil {
		return err
	}
	if *asJSON {
		return printJSON(list)
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "JOB\tCREATED\tSTATUS\tIMAGE\tPROMPT")
	for _, ph := range list {
		created := ph.CreatedAt
		prompt := ph.PromptTemplate
		if len([]rune(prompt)) > 60 {
			prompt = string([]rune(prompt)[:59]) + "…"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", ph.JobID, localTime(&created), ph.Status, strOr(ph.FinalImageID, "-"), prompt)
	}
	return tw.Flush()
}

func cmdPersonaPhotoJob(args []string, poll bool) error {
	name := "persona photo-job"
	if poll {
		name = "persona photo-poll"
	}
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print JSON")
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 || requireIDs(pos) != nil {
		return fmt.Errorf("usage: oai %s <job-id> [-json]", name)
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var photo personaPhoto
	if poll {
		err = doJSON("POST", personaPhotoURL(cfg, pos[0], "poll"), cfg.Token, nil, &photo)
	} else {
		err = doJSON("GET", personaPhotoURL(cfg, pos[0]), cfg.Token, nil, &photo)
	}
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(photo)
	}
	fmt.Printf("Job:     %s\nStatus:  %s\nSteps:   %s\nPrompt:  %s\n", photo.JobID, photo.Status, photo.stepSummary(), photo.Prompt)
	if photo.FinalImageID != nil {
		fmt.Printf("Image:   %s\n", *photo.FinalImageID)
	}
	if photo.Error != nil {
		fmt.Printf("Error:   %s\n", *photo.Error)
	}
	return nil
}

func forEachPhotoID(args []string, usage string, run func(cfg *Config, id string) error) error {
	fs := flag.NewFlagSet("persona", flag.ContinueOnError)
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(pos) == 0 {
		return errors.New(usage)
	}
	if err := requireIDs(pos); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var errs []error
	for _, id := range pos {
		if err := run(cfg, id); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", id, err))
		}
	}
	return errors.Join(errs...)
}

func cmdPersonaPhotoCancel(args []string) error {
	return forEachPhotoID(args, "usage: oai persona photo-cancel <job-id> [...]", func(cfg *Config, id string) error {
		var photo personaPhoto
		if err := doJSON("POST", personaPhotoURL(cfg, id, "cancel"), cfg.Token, nil, &photo); err != nil {
			return err
		}
		fmt.Printf("%s: %s\n", id, photo.Status)
		return nil
	})
}

func cmdPersonaPhotoDelete(args []string) error {
	return forEachPhotoID(args, "usage: oai persona photo-delete <job-id> [...]", func(cfg *Config, id string) error {
		if err := doJSON("DELETE", personaPhotoURL(cfg, id), cfg.Token, nil, nil); err != nil {
			return err
		}
		fmt.Printf("%s: deleted\n", id)
		return nil
	})
}

func cmdPersonaPhotoRetry(args []string) error {
	fs := flag.NewFlagSet("persona photo-retry", flag.ContinueOnError)
	out := fs.String("o", "persona.jpg", "output file")
	noWait := fs.Bool("no-wait", false, "print the new job id and exit")
	progress := progressFlag(fs)
	timeout := timeoutFlag(fs)
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 || requireIDs(pos) != nil {
		return errors.New("usage: oai persona photo-retry <job-id> [-o out.jpg] [--no-wait]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var resp struct {
		JobID string `json:"job_id"`
	}
	if err := doJSON("POST", personaPhotoURL(cfg, pos[0], "retry"), cfg.Token, nil, &resp); err != nil {
		return err
	}
	if *noWait {
		fmt.Println(resp.JobID)
		return nil
	}
	fmt.Fprintf(os.Stderr, "Photo job: %s\n", resp.JobID)
	photo, err := waitForPersonaPhoto(cfg, resp.JobID, "retry", *timeout, *progress)
	if err != nil {
		return err
	}
	return savePersonaPhoto(cfg, photo, *out)
}

func cmdPersonaPhotoDownload(args []string) error {
	fs := flag.NewFlagSet("persona photo-download", flag.ContinueOnError)
	out := fs.String("o", "persona.jpg", "output file")
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 || requireIDs(pos) != nil {
		return errors.New("usage: oai persona photo-download <job-id> [-o out.jpg]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var photo personaPhoto
	if err := doJSON("GET", personaPhotoURL(cfg, pos[0]), cfg.Token, nil, &photo); err != nil {
		return err
	}
	if photo.Status != "completed" {
		return fmt.Errorf("photo %s is %s (oai persona photo-poll %s)", photo.JobID, photo.Status, photo.JobID)
	}
	return savePersonaPhoto(cfg, &photo, *out)
}

// ── Chat ─────────────────────────────────────────────────────────────────────

func personaChats(cfg *Config, personaID string) ([]chatSummary, error) {
	var list []chatSummary
	u := cfg.serverURL("") + "/api/chats?kind=persona&persona_id=" + url.QueryEscape(personaID)
	err := doJSON("GET", u, cfg.Token, nil, &list)
	return list, err
}

func cmdPersonaChat(args []string) error {
	fs := flag.NewFlagSet("persona chat", flag.ContinueOnError)
	chatID := fs.String("chat", "", "continue this chat (default: the persona's latest)")
	newChat := fs.Bool("new", false, "start a new chat")
	model := fs.String("model", "", "LLM override (llm.*)")
	progress := progressFlag(fs)
	timeout := timeoutFlag(fs)
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 2 {
		return errors.New(`usage: oai persona chat <persona> "message" [-chat ID | -new] [-model llm.X]`)
	}
	if *newChat && *chatID != "" {
		return errors.New("-chat and -new are mutually exclusive")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	p, err := resolvePersona(cfg, pos[0])
	if err != nil {
		return err
	}
	target := *chatID
	if target == "" && !*newChat {
		chats, err := personaChats(cfg, p.ID)
		if err != nil {
			return err
		}
		if len(chats) > 0 {
			target = chats[0].ID
		}
	}
	if target == "" {
		var created chatSummary
		body := map[string]string{"kind": "persona", "persona_id": p.ID}
		if err := doJSON("POST", cfg.serverURL("")+"/api/chats", cfg.Token, body, &created); err != nil {
			return err
		}
		target = created.ID
		fmt.Fprintf(os.Stderr, "New chat: %s\n", target)
	}
	msgsURL := cfg.serverURL("") + "/api/chats/" + url.PathEscape(target) + "/messages"
	var sent sendMessageResponse
	body := map[string]string{"content": pos[1]}
	if *model != "" {
		body["capability"] = *model
	}
	if err := doJSON("POST", msgsURL, cfg.Token, body, &sent); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Chat %s · %s\n", sent.ChatID, sent.Capability)
	var msg chatMessage
	err = waitForJob(os.Stderr, sent.AssistantMessageID, *timeout, jobProgressOptions{
		Enabled: *progress, Label: p.Name, RunningLabel: "Thinking",
	}, func(ctx context.Context) (jobProgressState, error) {
		if err := doJSONContext(ctx, "GET", msgsURL+"/"+url.PathEscape(sent.AssistantMessageID), cfg.Token, nil, &msg); err != nil {
			return jobProgressState{}, err
		}
		return jobProgressState{Status: chatStatus(msg.Status)}, nil
	})
	if err != nil {
		return err
	}
	if msg.Status == "failed" {
		return fmt.Errorf("reply failed: %s", msg.Content)
	}
	fmt.Println(msg.Content)
	return nil
}

// chatStatus maps a message status onto the job vocabulary waitForJob knows.
func chatStatus(s string) string {
	switch s {
	case "complete":
		return "completed"
	case "failed":
		return "failed"
	default:
		return "running"
	}
}

func cmdPersonaChats(args []string) error {
	fs := flag.NewFlagSet("persona chats", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print JSON")
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return errors.New("usage: oai persona chats <persona> [-json]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	p, err := resolvePersona(cfg, pos[0])
	if err != nil {
		return err
	}
	chats, err := personaChats(cfg, p.ID)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(chats)
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "CHAT\tUPDATED\tMODEL\tTITLE")
	for _, c := range chats {
		updated := c.UpdatedAt
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", c.ID, localTime(&updated), strOr(c.LastModel, "-"), c.Title)
	}
	return tw.Flush()
}

func cmdPersonaHistory(args []string) error {
	fs := flag.NewFlagSet("persona history", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print JSON")
	limit := fs.Int("limit", 0, "only the last N messages")
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 || requireIDs(pos) != nil {
		return errors.New("usage: oai persona history <chat-id> [-limit N] [-json]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var msgs []chatMessage
	if err := doJSON("GET", cfg.serverURL("")+"/api/chats/"+url.PathEscape(pos[0])+"/messages", cfg.Token, nil, &msgs); err != nil {
		return err
	}
	if *limit > 0 && len(msgs) > *limit {
		msgs = msgs[len(msgs)-*limit:]
	}
	if *asJSON {
		return printJSON(msgs)
	}
	for i, m := range msgs {
		if i > 0 {
			fmt.Println()
		}
		status := ""
		if m.Status != "complete" {
			status = " [" + m.Status + "]"
		}
		fmt.Printf("%s%s:\n%s\n", m.Role, status, m.Content)
	}
	return nil
}
