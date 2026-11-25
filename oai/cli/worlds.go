package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"
)

// VR Worlds (the web UI's /app/worlds): one picture in, a Gaussian-splat world out.
// Wraps routes/worlds.rs, mirroring frontend/src/api/worlds.ts. The server picks the
// generator when -model is omitted (the user's most used online one that fits the
// picture and the options) and rejects options a generator would ignore, so none of
// those rules are repeated here.

// worldStartRequest mirrors StartJobRequest; unset options stay off the wire so the
// server's defaults apply.
type worldStartRequest struct {
	Capability   string   `json:"capability,omitempty"`
	InputImageID string   `json:"input_image_id"`
	Mode         string   `json:"mode,omitempty"`
	MaxWidth     *int     `json:"max_width,omitempty"`
	FillLean     *float64 `json:"fill_lean,omitempty"`
	HFov         *float64 `json:"hfov,omitempty"`
	Near         *float64 `json:"near,omitempty"`
	Far          *float64 `json:"far,omitempty"`
	Prompt       string   `json:"prompt,omitempty"`
	Pitch        *float64 `json:"pitch,omitempty"`
	Seed         *uint64  `json:"seed,omitempty"`
}

// worldJob mirrors JobDetailsResponse in routes/worlds.rs. The list endpoint leaves
// input_image null.
type worldJob struct {
	JobID                 string            `json:"job_id"`
	Status                string            `json:"status"`
	Capability            string            `json:"capability"`
	Mode                  string            `json:"mode"`
	Params                json.RawMessage   `json:"params"`
	InputImageID          *string           `json:"input_image_id"`
	InputImage            *imgUtilsImageRef `json:"input_image"`
	Result                json.RawMessage   `json:"result"`
	HasScene              bool              `json:"has_scene"`
	HasPreview            bool              `json:"has_preview"`
	PlyBytes              *int64            `json:"ply_bytes"`
	Stage                 *string           `json:"stage"`
	Error                 *string           `json:"error"`
	StartedAt             *string           `json:"started_at"`
	TypicalRuntimeSeconds *float64          `json:"typical_runtime_seconds"`
	CreatedAt             string            `json:"created_at"`
	UpdatedAt             string            `json:"updated_at"`
}

// worldResult is the part of the agent's summary the CLI prints.
type worldResult struct {
	Mode       string   `json:"mode"`
	SplatCount int64    `json:"splat_count"`
	Coverage   *float64 `json:"coverage"`
}

type worldShareLink struct {
	ViewerURL  string  `json:"viewer_url"`
	PlyURL     string  `json:"ply_url"`
	PreviewURL *string `json:"preview_url"`
	ExpiresAt  string  `json:"expires_at"`
}

func (j worldJob) progressState() jobProgressState {
	stage := ""
	if j.Stage != nil {
		stage = *j.Stage
	}
	created := j.CreatedAt
	return jobProgressState{
		Status:                j.Status,
		Stage:                 stage,
		StartedAt:             j.StartedAt,
		TypicalRuntimeSeconds: j.TypicalRuntimeSeconds,
		SubmittedAt:           &created,
	}
}

const worldUsage = "usage: oai world <models|generate|jobs|job|poll|cancel|retry|delete|download|share> ..."

func cmdWorld(args []string) error {
	if len(args) == 0 {
		return errors.New(worldUsage)
	}
	switch args[0] {
	case "models", "capabilities":
		return cmdWorldModels(args[1:])
	case "generate", "run":
		return cmdWorldGenerate(args[1:])
	case "jobs":
		return cmdWorldJobs(args[1:])
	case "job":
		return cmdWorldJob(args[1:], false)
	case "poll":
		return cmdWorldJob(args[1:], true)
	case "cancel":
		return cmdWorldCancel(args[1:])
	case "retry":
		return cmdWorldRetry(args[1:])
	case "delete":
		return cmdWorldDelete(args[1:])
	case "download":
		return cmdWorldDownload(args[1:])
	case "share":
		return cmdWorldShare(args[1:])
	default:
		return fmt.Errorf("unknown world command %q (%s)", args[0], strings.TrimPrefix(worldUsage, "usage: "))
	}
}

func worldURL(cfg *Config, parts ...string) string {
	u := cfg.serverURL("") + "/api/worlds"
	for _, p := range parts {
		u += "/" + url.PathEscape(p)
	}
	return u
}

func cmdWorldModels(args []string) error {
	fs := flag.NewFlagSet("world models", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print the raw JSON list")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 0 {
		return errors.New("usage: oai world models [-json]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var resp struct {
		Capabilities []capabilityInfo `json:"capabilities"`
	}
	if err := doJSON("GET", worldURL(cfg, "capabilities"), cfg.Token, nil, &resp); err != nil {
		return err
	}
	if *asJSON {
		if resp.Capabilities == nil {
			resp.Capabilities = []capabilityInfo{}
		}
		return printJSON(&resp.Capabilities)
	}
	// Already sorted by the server: most used first.
	return printCapabilities(resp.Capabilities, "world")
}

// isImageID reports whether an argument looks like a library image ID (a snowflake).
func isImageID(s string) bool {
	return s != "" && strings.Trim(s, "0123456789") == ""
}

type worldInput struct {
	arg    string
	upload bool
}

// worldInputs classifies every argument before anything is uploaded: an existing file,
// or else the ID of an image already in the library.
func worldInputs(args []string) ([]worldInput, error) {
	inputs := make([]worldInput, 0, len(args))
	for _, a := range args {
		info, err := os.Stat(a)
		switch {
		case err == nil && info.IsDir():
			return nil, fmt.Errorf("%s: is a directory", a)
		case err == nil:
			inputs = append(inputs, worldInput{arg: a, upload: true})
		case isImageID(a):
			inputs = append(inputs, worldInput{arg: a})
		default:
			return nil, fmt.Errorf("%s: not a file or an image ID: %w", a, err)
		}
	}
	return inputs, nil
}

type worldRun struct {
	input, jobID, outPath string
}

// cmdWorldGenerate starts one world per picture, then waits and saves the scenes.
// Progress and job lines go to stderr; stdout gets "Saved <path>" lines (plus viewer
// URLs with -share) or, with --no-wait, bare job IDs.
func cmdWorldGenerate(args []string) error {
	fs := flag.NewFlagSet("world generate", flag.ContinueOnError)
	out := fs.String("o", "", "output scene (default <input>_world.ply; _2, _3, ... for several inputs)")
	model := fs.String("model", "", "generator, e.g. sharp, splat or pano360 (default: your most used one that fits)")
	mode := fs.String("mode", "", "projection: auto, perspective or pano (360° input, splat only)")
	maxWidth := fs.Int("max-width", 0, "splat budget as grid width 256-2048: 1024 suits a Quest, 2048 is full (not sharp)")
	lean := fs.Float64("lean", 0, "head movement in metres the background layer covers, 0-1 (not sharp)")
	fov := fs.Float64("fov", 0, "horizontal field of view of the picture in degrees, 20-150")
	near := fs.Float64("near", 0, "nearest depth in metres, 0.1-20 (not sharp)")
	far := fs.Float64("far", 0, "farthest depth in metres, 1-1000 (not sharp)")
	prompt := fs.String("prompt", "", "pano360: what surrounds the picture (default: the prompt that generated it)")
	pitch := fs.Float64("pitch", 0, "pano360: camera tilt in degrees, -60..60, negative looks down")
	seed := fs.Uint64("seed", 0, "pano360: seed for the painted surroundings")
	share := fs.Bool("share", false, "also print a login-free viewer link for each finished world")
	noWait := fs.Bool("no-wait", false, "submit without waiting; print job IDs to stdout")
	timeout := timeoutFlag(fs)
	showProgress := progressFlag(fs)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		return errors.New("usage: oai world generate <image|image-id> [...] [-o out.ply] [-model M] [-mode auto|perspective|pano] [-fov DEG] [flags]")
	}
	if *noWait && (*out != "" || *share) {
		return errors.New("-o and -share cannot be used with --no-wait; use `oai world download` / `share` later")
	}
	inputs, err := worldInputs(rest)
	if err != nil {
		return err
	}

	options := worldStartRequest{Capability: *model, Mode: *mode, Prompt: *prompt}
	fs.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "max-width":
			options.MaxWidth = maxWidth
		case "lean":
			options.FillLean = lean
		case "fov":
			options.HFov = fov
		case "near":
			options.Near = near
		case "far":
			options.Far = far
		case "pitch":
			options.Pitch = pitch
		case "seed":
			options.Seed = seed
		}
	})

	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var runs []worldRun
	var errs []error
	for i, input := range inputs {
		req := options
		req.InputImageID = input.arg
		if input.upload {
			var up uploadResponse
			if err := uploadFile(cfg.serverURL("")+"/api/images/upload", cfg.Token, input.arg, &up); err != nil {
				errs = append(errs, fmt.Errorf("%s: upload: %w", input.arg, err))
				continue
			}
			req.InputImageID = up.ImageID
		}
		var started startJobResponse
		if err := doJSON("POST", worldURL(cfg, "jobs"), cfg.Token, req, &started); err != nil {
			errs = append(errs, fmt.Errorf("%s: submit: %w", input.arg, err))
			continue
		}
		if *noWait {
			fmt.Println(started.JobID)
		} else {
			fmt.Fprintf(os.Stderr, "Job: %s (%s)\n", started.JobID, input.arg)
		}
		outPath := *out
		if outPath != "" {
			outPath = indexedOutputPath(outPath, i)
		} else if input.upload {
			stem := strings.TrimSuffix(filepath.Base(input.arg), filepath.Ext(input.arg))
			outPath = stem + "_world.ply"
		}
		runs = append(runs, worldRun{input: input.arg, jobID: started.JobID, outPath: outPath})
	}
	if *noWait {
		return errors.Join(errs...)
	}
	for _, run := range runs {
		job, err := waitForWorldJob(cfg, run.jobID, filepath.Base(run.input), *timeout, *showProgress)
		if err == nil {
			err = saveWorld(cfg, job, defaultWorldDest(run.outPath, job))
		}
		if err == nil && *share {
			err = printWorldShare(cfg, job.JobID, false)
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("%s (job %s): %w", run.input, run.jobID, err))
		}
	}
	return errors.Join(errs...)
}

func waitForWorldJob(cfg *Config, jobID, label string, timeout time.Duration, showProgress bool) (*worldJob, error) {
	var job worldJob
	pollURL := worldURL(cfg, "jobs", jobID, "poll")
	err := waitForJob(os.Stderr, jobID, timeout, jobProgressOptions{
		Enabled:      showProgress,
		Label:        label,
		RunningLabel: "Building world",
	}, func(ctx context.Context) (jobProgressState, error) {
		if err := doJSONContext(ctx, "POST", pollURL, cfg.Token, nil, &job); err != nil {
			return jobProgressState{}, err
		}
		return job.progressState(), nil
	})
	if err != nil {
		return nil, err
	}
	if job.Status != "completed" {
		msg := "no error message"
		if job.Error != nil && *job.Error != "" {
			msg = *job.Error
		}
		return nil, fmt.Errorf("job %s: %s", job.Status, msg)
	}
	return &job, nil
}

func defaultWorldDest(out string, job *worldJob) string {
	if out != "" {
		return out
	}
	return "world_" + job.JobID + ".ply"
}

// describeWorld summarises a finished world ("" before there is a result).
func describeWorld(job *worldJob) string {
	var r worldResult
	if len(job.Result) == 0 || json.Unmarshal(job.Result, &r) != nil {
		return ""
	}
	var parts []string
	switch r.Mode {
	case "pano":
		parts = append(parts, "360° panorama")
	case "perspective":
		parts = append(parts, "perspective")
	}
	if r.SplatCount > 0 {
		parts = append(parts, fmt.Sprintf("%.2f M splats", float64(r.SplatCount)/1e6))
	}
	if job.PlyBytes != nil {
		parts = append(parts, fmt.Sprintf("%.1f MiB", float64(*job.PlyBytes)/(1<<20)))
	}
	if r.Coverage != nil {
		parts = append(parts, fmt.Sprintf("picture covers %.0f%% of the sphere", *r.Coverage*100))
	}
	return strings.Join(parts, ", ")
}

func saveWorld(cfg *Config, job *worldJob, dest string) error {
	if !job.HasScene {
		return errors.New("job completed but has no scene")
	}
	if err := downloadFile(worldURL(cfg, "jobs", job.JobID, "scene.ply"), cfg.Token, dest); err != nil {
		return fmt.Errorf("download scene: %w", err)
	}
	if summary := describeWorld(job); summary != "" {
		fmt.Printf("Saved %s (%s: %s)\n", dest, job.Capability, summary)
	} else {
		fmt.Printf("Saved %s (%s)\n", dest, job.Capability)
	}
	return nil
}

func cmdWorldJobs(args []string) error {
	fs := flag.NewFlagSet("world jobs", flag.ContinueOnError)
	status := fs.String("status", "", "only jobs with this status (comma-separated)")
	active := fs.Bool("active", false, "only jobs that have not finished yet")
	idsOnly := fs.Bool("ids", false, "print bare job IDs, one per line")
	asJSON := fs.Bool("json", false, "print the raw JSON list")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 0 {
		return errors.New("usage: oai world jobs [-status S[,S]] [-active] [-ids] [-json]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var all []worldJob
	if err := doJSON("GET", worldURL(cfg, "jobs"), cfg.Token, nil, &all); err != nil {
		return err
	}
	want := map[string]bool{}
	for _, s := range strings.Split(*status, ",") {
		if s = strings.TrimSpace(s); s != "" {
			want[s] = true
		}
	}
	jobs := []worldJob{}
	for _, j := range all {
		if (len(want) == 0 || want[j.Status]) && (!*active || !isTerminal(j.Status)) {
			jobs = append(jobs, j)
		}
	}
	switch {
	case *asJSON:
		return printJSON(&jobs)
	case *idsOnly:
		for _, j := range jobs {
			fmt.Println(j.JobID)
		}
		return nil
	case len(jobs) == 0:
		fmt.Println("No matching world jobs.")
		return nil
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "JOB ID\tSTATUS\tMODEL\tCREATED\tRESULT")
	for _, j := range jobs {
		result := describeWorld(&j)
		if result == "" {
			result = "-"
		}
		created := j.CreatedAt
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", j.JobID, j.Status, j.Capability, localTime(&created), result)
	}
	return w.Flush()
}

// cmdWorldJob shows one job: the persisted state (job), or after one forced reconcile
// with OffloadMQ (poll).
func cmdWorldJob(args []string, poll bool) error {
	name, method, suffix := "job", "GET", ""
	if poll {
		name, method, suffix = "poll", "POST", "/poll"
	}
	fs := flag.NewFlagSet("world "+name, flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print the raw job JSON")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return fmt.Errorf("usage: oai world %s <job-id> [-json]", name)
	}
	if err := requireIDs(rest); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var job worldJob
	if err := doJSON(method, worldURL(cfg, "jobs", rest[0])+suffix, cfg.Token, nil, &job); err != nil {
		return err
	}
	if *asJSON {
		return printJSON(&job)
	}
	fmt.Printf("Job:        %s\n", job.JobID)
	fmt.Printf("Status:     %s\n", job.Status)
	fmt.Printf("Model:      %s\n", job.Capability)
	fmt.Printf("Mode:       %s\n", job.Mode)
	if job.Stage != nil && *job.Stage != "" {
		fmt.Printf("Stage:      %s\n", *job.Stage)
	}
	if len(job.Params) > 0 && string(job.Params) != "null" {
		fmt.Printf("Settings:   %s\n", job.Params)
	}
	if summary := describeWorld(&job); summary != "" {
		fmt.Printf("Result:     %s\n", summary)
	}
	if job.Error != nil && *job.Error != "" {
		fmt.Printf("Error:      %s\n", *job.Error)
	}
	if ref := job.InputImage; ref != nil {
		fmt.Printf("Input:      %s  %s  %dx%d  %d bytes\n", ref.ImageID, ref.Filename, ref.Width, ref.Height, ref.SizeBytes)
	}
	return nil
}

// worldIDArgs parses a command that takes only job IDs.
func worldIDArgs(name string, args []string) (*Config, []string, error) {
	fs := flag.NewFlagSet("world "+name, flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return nil, nil, err
	}
	if len(rest) == 0 {
		return nil, nil, fmt.Errorf("usage: oai world %s <job-id> [job-id ...]", name)
	}
	if err := requireIDs(rest); err != nil {
		return nil, nil, err
	}
	cfg, err := requireLogin()
	return cfg, rest, err
}

func cmdWorldCancel(args []string) error {
	cfg, ids, err := worldIDArgs("cancel", args)
	if err != nil {
		return err
	}
	var errs []error
	for _, id := range ids {
		var resp imageCancelResponse
		if err := doJSON("POST", worldURL(cfg, "jobs", id, "cancel"), cfg.Token, nil, &resp); err != nil {
			errs = append(errs, fmt.Errorf("cancel %s: %w", id, err))
			continue
		}
		fmt.Printf("%s: %s (%s)\n", resp.JobID, resp.Status, resp.Message)
	}
	return errors.Join(errs...)
}

// cmdWorldDelete removes finished jobs and their scenes (the input picture stays).
func cmdWorldDelete(args []string) error {
	cfg, ids, err := worldIDArgs("delete", args)
	if err != nil {
		return err
	}
	var errs []error
	for _, id := range ids {
		if err := doJSON("DELETE", worldURL(cfg, "jobs", id), cfg.Token, nil, nil); err != nil {
			errs = append(errs, fmt.Errorf("delete %s: %w", id, err))
			continue
		}
		fmt.Printf("Deleted %s\n", id)
	}
	return errors.Join(errs...)
}

// cmdWorldRetry resubmits a failed or canceled job with its stored picture and settings.
func cmdWorldRetry(args []string) error {
	fs := flag.NewFlagSet("world retry", flag.ContinueOnError)
	out := fs.String("o", "", "output scene (default world_<job-id>.ply)")
	noWait := fs.Bool("no-wait", false, "resubmit without waiting; print the new job ID to stdout")
	timeout := timeoutFlag(fs)
	showProgress := progressFlag(fs)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai world retry <job-id> [-o out.ply] [--no-wait] [--progress=false] [-t|-timeout 5m]")
	}
	if err := requireIDs(rest); err != nil {
		return err
	}
	if *noWait && *out != "" {
		return errors.New("-o cannot be used with --no-wait; download later with `oai world download <job-id> -o out.ply`")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var started startJobResponse
	if err := doJSON("POST", worldURL(cfg, "jobs", rest[0], "retry"), cfg.Token, nil, &started); err != nil {
		return err
	}
	if *noWait {
		fmt.Println(started.JobID)
		return nil
	}
	fmt.Fprintf(os.Stderr, "Job: %s (retry of %s)\n", started.JobID, rest[0])
	job, err := waitForWorldJob(cfg, started.JobID, "World", *timeout, *showProgress)
	if err != nil {
		return err
	}
	return saveWorld(cfg, job, defaultWorldDest(*out, job))
}

// cmdWorldDownload saves a completed job's scene (and optionally its preview). Like
// image download it reads the persisted job and never polls.
func cmdWorldDownload(args []string) error {
	fs := flag.NewFlagSet("world download", flag.ContinueOnError)
	out := fs.String("o", "", "output scene (default world_<job-id>.ply)")
	preview := fs.String("preview", "", "also save the preview picture (PNG) to this file")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai world download <job-id> [-o out.ply] [-preview preview.png]")
	}
	if err := requireIDs(rest); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var job worldJob
	if err := doJSON("GET", worldURL(cfg, "jobs", rest[0]), cfg.Token, nil, &job); err != nil {
		return err
	}
	if job.Status != "completed" {
		return fmt.Errorf("job %s is %s; run `oai world poll %s` until it completes", job.JobID, job.Status, job.JobID)
	}
	if *preview != "" {
		if !job.HasPreview {
			return fmt.Errorf("job %s has no preview", job.JobID)
		}
		if err := downloadFile(worldURL(cfg, "jobs", job.JobID, "preview.png"), cfg.Token, *preview); err != nil {
			return fmt.Errorf("download preview: %w", err)
		}
		fmt.Printf("Saved %s\n", *preview)
	}
	return saveWorld(cfg, &job, defaultWorldDest(*out, &job))
}

// printWorldShare creates login-free links. Stdout gets the bare viewer URL (or the
// JSON), the expiry goes to stderr.
func printWorldShare(cfg *Config, jobID string, asJSON bool) error {
	var link worldShareLink
	if err := doJSON("POST", worldURL(cfg, "jobs", jobID, "share"), cfg.Token, nil, &link); err != nil {
		return fmt.Errorf("share: %w", err)
	}
	if asJSON {
		return printJSON(&link)
	}
	fmt.Println(link.ViewerURL)
	fmt.Fprintf(os.Stderr, "Anyone with this link can view the world until %s\n", localTime(&link.ExpiresAt))
	return nil
}

func cmdWorldShare(args []string) error {
	fs := flag.NewFlagSet("world share", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print viewer, scene and preview URLs as JSON")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai world share <job-id> [-json]")
	}
	if err := requireIDs(rest); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	return printWorldShare(cfg, rest[0], *asJSON)
}
