package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
)

// Image Tools (the web UI's /app/img-utils): one-shot transforms, one image in,
// one image out, no prompt. Wraps routes/img_utils.rs, mirroring
// frontend/src/api/imgUtils.ts. Two families share every endpoint:
// ComfyUI `img-utils.<pack>` tools (depth, face_swap, upscale, …; knobs go in
// `options` → payload.secondary_prompts) and the built-in `image_resize`
// (flat, server-validated resize options).

const (
	imgUtilsKindResize = "resize"
	// resizeWorkflow is the synthetic operation the backend reports for resize.
	resizeWorkflow = "basic_resize"
	// Upscale scale_multiplier bounds/default, as in imgUtils.ts.
	defaultScaleMultiplier = 4
	minScaleMultiplier     = 1
	maxScaleMultiplier     = 8
)

// imgUtilCapability mirrors ImgUtilCapability in services/img_utils.rs. The
// endpoint only lists capabilities with an online agent.
type imgUtilCapability struct {
	Base             string   `json:"base"`
	Utility          string   `json:"utility"`
	Workflows        []string `json:"workflows"`
	Raw              string   `json:"raw"`
	NeedsSourceImage bool     `json:"needs_source_image"`
	Kind             string   `json:"kind"`
	Methods          []string `json:"methods"`
}

// imgTool is one pack/operation pair — what the user picks (toolsFromCapabilities
// in imgUtils.ts).
type imgTool struct {
	Capability  string   `json:"capability"`
	Pack        string   `json:"pack"`
	Workflow    string   `json:"workflow"`
	Kind        string   `json:"kind"`
	NeedsSource bool     `json:"needs_source_image"`
	TakesScale  bool     `json:"takes_scale"`
	Methods     []string `json:"methods,omitempty"`
}

type imgUtilsStartRequest struct {
	Capability    string         `json:"capability"`
	Workflow      string         `json:"workflow,omitempty"`
	InputImageID  string         `json:"input_image_id"`
	SourceImageID string         `json:"source_image_id,omitempty"`
	Options       map[string]any `json:"options,omitempty"`
}

type imgUtilsImageRef struct {
	ImageID     string `json:"image_id"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	SizeBytes   int64  `json:"size_bytes"`
}

// imgUtilsJob mirrors JobDetailsResponse in routes/img_utils.rs. The list
// endpoint leaves the *_image refs null.
type imgUtilsJob struct {
	JobID                 string            `json:"job_id"`
	Status                string            `json:"status"`
	Capability            string            `json:"capability"`
	Utility               string            `json:"utility"`
	Workflow              string            `json:"workflow"`
	InputImageID          *string           `json:"input_image_id"`
	SourceImageID         *string           `json:"source_image_id"`
	OutputImageID         *string           `json:"output_image_id"`
	InputImage            *imgUtilsImageRef `json:"input_image"`
	OutputImage           *imgUtilsImageRef `json:"output_image"`
	Options               map[string]any    `json:"options"`
	Stage                 *string           `json:"stage"`
	Error                 *string           `json:"error"`
	StartedAt             *string           `json:"started_at"`
	TypicalRuntimeSeconds *float64          `json:"typical_runtime_seconds"`
	CreatedAt             string            `json:"created_at"`
	UpdatedAt             string            `json:"updated_at"`
}

func (j imgUtilsJob) progressState() jobProgressState {
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

const imgUtilsUsage = "usage: oai img-utils <tools|run|jobs|job|poll|cancel|retry|delete|download> ..."

func cmdImgUtils(args []string) error {
	if len(args) == 0 {
		return errors.New(imgUtilsUsage)
	}
	switch args[0] {
	case "tools", "capabilities":
		return cmdImgUtilsTools(args[1:])
	case "run":
		if len(args) < 2 || strings.HasPrefix(args[1], "-") {
			return errors.New("usage: oai img-utils run <tool> <image> [image ...] [flags]   (tools: oai img-utils tools)")
		}
		return cmdImgUtilsRun("img-utils run "+args[1], args[1], args[2:])
	case "jobs":
		return cmdImgUtilsJobs(args[1:])
	case "job":
		return cmdImgUtilsJob(args[1:], false)
	case "poll":
		return cmdImgUtilsJob(args[1:], true)
	case "cancel":
		return cmdImgUtilsCancel(args[1:])
	case "retry":
		return cmdImgUtilsRetry(args[1:])
	case "delete":
		return cmdImgUtilsDelete(args[1:])
	case "download":
		return cmdImgUtilsDownload(args[1:])
	default:
		return fmt.Errorf("unknown img-utils command %q (%s)", args[0], strings.TrimPrefix(imgUtilsUsage, "usage: "))
	}
}

// cmdUpscale is the `oai upscale` shortcut for `oai img-utils run upscale`.
func cmdUpscale(args []string) error {
	return cmdImgUtilsRun("upscale", "upscale", args)
}

func imgUtilsURL(cfg *Config, parts ...string) string {
	u := cfg.serverURL("") + "/api/img-utils"
	for _, p := range parts {
		u += "/" + url.PathEscape(p)
	}
	return u
}

func fetchImgTools(cfg *Config) ([]imgTool, error) {
	var resp struct {
		Capabilities []imgUtilCapability `json:"capabilities"`
	}
	if err := doJSON("GET", imgUtilsURL(cfg, "capabilities"), cfg.Token, nil, &resp); err != nil {
		return nil, err
	}
	return toolsFromCapabilities(resp.Capabilities), nil
}

// toolsFromCapabilities flattens capabilities to one tool per operation, sorted
// by operation then pack so "first available" is stable.
func toolsFromCapabilities(caps []imgUtilCapability) []imgTool {
	var tools []imgTool
	for _, c := range caps {
		workflows := c.Workflows
		if len(workflows) == 0 {
			workflows = []string{c.Utility}
		}
		for _, wf := range workflows {
			comfy := c.Kind != imgUtilsKindResize
			tools = append(tools, imgTool{
				Capability:  c.Base,
				Pack:        c.Utility,
				Workflow:    wf,
				Kind:        c.Kind,
				NeedsSource: comfy && strings.HasPrefix(normalizeToolName(wf), "faceswap"),
				TakesScale:  comfy && strings.HasPrefix(wf, "upscale"),
				Methods:     c.Methods,
			})
		}
	}
	slices.SortStableFunc(tools, func(a, b imgTool) int {
		if c := strings.Compare(a.Workflow, b.Workflow); c != 0 {
			return c
		}
		return strings.Compare(a.Pack, b.Pack)
	})
	return tools
}

// normalizeToolName lets face-swap / faceswap / Face_Swap all name face_swap.
func normalizeToolName(s string) string {
	return strings.NewReplacer("-", "", "_", "").Replace(strings.ToLower(strings.TrimSpace(s)))
}

// pickImgTool resolves a tool name — an operation (upscale, depth, face_swap,
// resize), a pack or a capability — to the first online match, optionally
// restricted to one capability. It fails when nothing online offers it.
func pickImgTool(tools []imgTool, name, capability string) (imgTool, error) {
	key := normalizeToolName(name)
	if key == "resize" {
		key = normalizeToolName(resizeWorkflow)
	}
	for _, t := range tools {
		if capability != "" && t.Capability != capability {
			continue
		}
		if normalizeToolName(t.Workflow) == key || normalizeToolName(t.Pack) == key || normalizeToolName(t.Capability) == key {
			return t, nil
		}
	}
	where := ""
	if capability != "" {
		where = " on " + capability
	}
	if len(tools) == 0 {
		return imgTool{}, fmt.Errorf("no %s tool is available%s: no Image Tools capability is online", name, where)
	}
	var online []string
	for _, t := range tools {
		online = append(online, t.Workflow)
	}
	return imgTool{}, fmt.Errorf("no %s tool is available%s; online tools: %s", name, where, strings.Join(slices.Compact(online), ", "))
}

func cmdImgUtilsTools(args []string) error {
	fs := flag.NewFlagSet("img-utils tools", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print the tools as JSON")
	if _, err := parseInterleaved(fs, args); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	tools, err := fetchImgTools(cfg)
	if err != nil {
		return err
	}
	if *asJSON {
		if tools == nil {
			tools = []imgTool{}
		}
		return printJSON(&tools)
	}
	if len(tools) == 0 {
		fmt.Println("No Image Tools are online.")
		return nil
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "TOOL\tCAPABILITY\tNOTES")
	for _, t := range tools {
		var notes []string
		if t.NeedsSource {
			notes = append(notes, "needs -source FACE_IMAGE")
		}
		if t.TakesScale {
			notes = append(notes, fmt.Sprintf("-scale %d-%d (default %d)", minScaleMultiplier, maxScaleMultiplier, defaultScaleMultiplier))
		}
		if t.Kind == imgUtilsKindResize {
			notes = append(notes, "-width/-height/-scale, methods: "+strings.Join(t.Methods, ","))
		}
		fmt.Fprintf(w, "%s\t%s\t%s\n", t.Workflow, t.Capability, strings.Join(notes, "; "))
	}
	return w.Flush()
}

// optionFlag collects repeated -opt key=value pairs.
type optionFlag map[string]any

func (o optionFlag) String() string { return "" }

func (o optionFlag) Set(s string) error {
	k, v, ok := strings.Cut(s, "=")
	if !ok || strings.TrimSpace(k) == "" {
		return fmt.Errorf("want key=value, got %q", s)
	}
	o[strings.TrimSpace(k)] = parseOptionValue(v)
	return nil
}

// parseOptionValue keeps numbers and booleans typed, as the web UI sends them.
func parseOptionValue(v string) any {
	if b, err := strconv.ParseBool(v); err == nil && (v == "true" || v == "false") {
		return b
	}
	if i, err := strconv.ParseInt(v, 10, 64); err == nil {
		return i
	}
	if f, err := strconv.ParseFloat(v, 64); err == nil {
		return f
	}
	return v
}

// numberOption sends whole numbers as integers (4, not 4.0).
func numberOption(f float64) any {
	if f == float64(int64(f)) {
		return int64(f)
	}
	return f
}

type imgUtilsRun struct {
	path    string
	jobID   string
	outPath string
}

// cmdImgUtilsRun uploads each image, starts one job per image with the chosen
// tool, then waits and saves the outputs. Progress and job lines go to stderr;
// stdout gets only the "Saved <path>" lines (or, with --no-wait, bare job IDs).
func cmdImgUtilsRun(cmdName, toolName string, args []string) error {
	fs := flag.NewFlagSet(cmdName, flag.ContinueOnError)
	out := fs.String("o", "", "output file (default <input>_<tool>.<ext>; _2, _3, ... for several inputs)")
	capability := fs.String("capability", "", "use this capability (default: first online one offering the tool)")
	source := fs.String("source", "", "second image for tools that need one (face_swap: the face to use)")
	scale := fs.Float64("scale", 0, "upscale: multiplier 1-8 (default 4); resize: scale factor (max 4)")
	width := fs.Int("width", 0, "resize: target width")
	height := fs.Int("height", 0, "resize: target height")
	mode := fs.String("mode", "", "resize: fit (default), exact or cover")
	method := fs.String("method", "", "resize: resampling filter (see img-utils tools)")
	format := fs.String("format", "", "resize: png, jpeg, webp, bmp or tiff")
	quality := fs.Int("quality", 0, "resize: 1-100 for lossy formats")
	allowUpscale := fs.Bool("allow-upscale", false, "resize: allow making the image larger")
	opts := optionFlag{}
	fs.Var(opts, "opt", "extra workflow option key=value (repeatable), sent as-is")
	noWait := fs.Bool("no-wait", false, "submit without waiting; print job IDs to stdout")
	timeout := timeoutFlag(fs)
	showProgress := progressFlag(fs)
	inputs, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(inputs) == 0 {
		return fmt.Errorf("usage: oai %s <image> [image ...] [-o out.jpg] [flags]", cmdName)
	}
	if *noWait && *out != "" {
		return fmt.Errorf("-o cannot be used with --no-wait; download later with `oai img-utils download <job-id> -o out.jpg`")
	}
	for _, p := range append(slices.Clone(inputs), *source) {
		if p == "" {
			continue
		}
		if info, err := os.Stat(p); err != nil {
			return err
		} else if info.IsDir() {
			return fmt.Errorf("%s: is a directory", p)
		}
	}

	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	tools, err := fetchImgTools(cfg)
	if err != nil {
		return err
	}
	tool, err := pickImgTool(tools, toolName, *capability)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Using %s on %s\n", tool.Workflow, tool.Capability)

	options, err := imgToolOptions(fs, tool, opts, *scale, *width, *height, *mode, *method, *format, *quality, *allowUpscale)
	if err != nil {
		return err
	}
	if tool.NeedsSource && *source == "" {
		return fmt.Errorf("%s needs a second image: add -source FACE_IMAGE", tool.Workflow)
	}
	if !tool.NeedsSource && *source != "" {
		return fmt.Errorf("%s takes no -source image", tool.Workflow)
	}

	base := cfg.serverURL("")
	sourceID := ""
	if *source != "" {
		var up uploadResponse
		if err := uploadFile(base+"/api/images/upload", cfg.Token, *source, &up); err != nil {
			return fmt.Errorf("%s: upload: %w", *source, err)
		}
		sourceID = up.ImageID
	}

	var runs []imgUtilsRun
	var errs []error
	for i, path := range inputs {
		var up uploadResponse
		if err := uploadFile(base+"/api/images/upload", cfg.Token, path, &up); err != nil {
			errs = append(errs, fmt.Errorf("%s: upload: %w", path, err))
			continue
		}
		req := imgUtilsStartRequest{
			Capability: tool.Capability, Workflow: tool.Workflow,
			InputImageID: up.ImageID, SourceImageID: sourceID, Options: options,
		}
		var started startJobResponse
		if err := doJSON("POST", imgUtilsURL(cfg, "jobs"), cfg.Token, req, &started); err != nil {
			errs = append(errs, fmt.Errorf("%s: submit: %w", path, err))
			continue
		}
		if *noWait {
			fmt.Println(started.JobID)
		} else {
			fmt.Fprintf(os.Stderr, "Job: %s (%s)\n", started.JobID, path)
		}
		outPath := *out
		if outPath != "" {
			outPath = indexedOutputPath(outPath, i)
		}
		runs = append(runs, imgUtilsRun{path: path, jobID: started.JobID, outPath: outPath})
	}
	if *noWait {
		return errors.Join(errs...)
	}
	for _, run := range runs {
		job, err := waitForImgUtilsJob(cfg, run.jobID, filepath.Base(run.path), *timeout, *showProgress)
		if err == nil {
			dest := run.outPath
			if dest == "" {
				stem := strings.TrimSuffix(filepath.Base(run.path), filepath.Ext(run.path))
				dest = stem + "_" + tool.Workflow + imgUtilsOutputExt(job)
			}
			err = saveImgUtilsOutput(cfg, job, dest)
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("%s (job %s): %w", run.path, run.jobID, err))
		}
	}
	return errors.Join(errs...)
}

// imgToolOptions builds the job's options for the chosen tool, rejecting flags
// that don't apply to it (resize knobs on a ComfyUI tool and vice versa).
func imgToolOptions(fs *flag.FlagSet, tool imgTool, extra optionFlag, scale float64, width, height int,
	mode, method, format string, quality int, allowUpscale bool) (map[string]any, error) {
	options := map[string]any{}
	for k, v := range extra {
		options[k] = v
	}
	resizeFlags := []string{"width", "height", "mode", "method", "format", "quality", "allow-upscale"}
	if tool.Kind == imgUtilsKindResize {
		if len(extra) > 0 {
			return nil, errors.New("-opt is for ComfyUI tools; resize takes -width/-height/-scale/-mode/-method/-format/-quality/-allow-upscale")
		}
		if width > 0 {
			options["width"] = width
		}
		if height > 0 {
			options["height"] = height
		}
		if flagSet(fs, "scale") {
			options["scale"] = numberOption(scale)
		}
		for key, v := range map[string]string{"mode": mode, "method": method, "format": format} {
			if v != "" {
				options[key] = v
			}
		}
		if flagSet(fs, "quality") {
			options["quality"] = quality
		}
		if flagSet(fs, "allow-upscale") {
			options["allow_upscale"] = allowUpscale
		}
		if len(options) == 0 {
			return nil, errors.New("resize needs a size: -scale F, or -width and/or -height")
		}
		return options, nil // the server validates and normalizes these
	}
	for _, name := range resizeFlags {
		if flagSet(fs, name) {
			return nil, fmt.Errorf("-%s only applies to resize, not %s", name, tool.Workflow)
		}
	}
	if tool.TakesScale {
		if !flagSet(fs, "scale") {
			scale = defaultScaleMultiplier
		}
		if scale < minScaleMultiplier || scale > maxScaleMultiplier {
			return nil, fmt.Errorf("-scale must be between %d and %d", minScaleMultiplier, maxScaleMultiplier)
		}
		if _, set := options["scale_multiplier"]; !set {
			options["scale_multiplier"] = numberOption(scale)
		}
	} else if flagSet(fs, "scale") {
		return nil, fmt.Errorf("%s takes no -scale", tool.Workflow)
	}
	if len(options) == 0 {
		return nil, nil
	}
	return options, nil
}

func waitForImgUtilsJob(cfg *Config, jobID, label string, timeout time.Duration, showProgress bool) (*imgUtilsJob, error) {
	var job imgUtilsJob
	pollURL := imgUtilsURL(cfg, "jobs", jobID, "poll")
	err := waitForJob(os.Stderr, jobID, timeout, jobProgressOptions{
		Enabled:      showProgress,
		Label:        label,
		RunningLabel: "Processing",
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

// imgUtilsOutputExt picks the default extension from the stored output (depth
// maps are PNG, SeedVR2 output may be PNG, resize follows -format).
func imgUtilsOutputExt(job *imgUtilsJob) string {
	if job.OutputImage != nil {
		if ext := filepath.Ext(job.OutputImage.Filename); ext != "" {
			return ext
		}
		switch job.OutputImage.ContentType {
		case "image/png":
			return ".png"
		case "image/webp":
			return ".webp"
		}
	}
	return ".jpg"
}

func saveImgUtilsOutput(cfg *Config, job *imgUtilsJob, dest string) error {
	if job.OutputImageID == nil || *job.OutputImageID == "" {
		return errors.New("job completed but has no output image")
	}
	if err := downloadFile(cfg.serverURL("")+"/api/images/files/"+url.PathEscape(*job.OutputImageID), cfg.Token, dest); err != nil {
		return fmt.Errorf("download %s: %w", *job.OutputImageID, err)
	}
	if job.OutputImage != nil && job.OutputImage.Width > 0 {
		fmt.Printf("Saved %s (%dx%d)\n", dest, job.OutputImage.Width, job.OutputImage.Height)
	} else {
		fmt.Printf("Saved %s\n", dest)
	}
	return nil
}

func cmdImgUtilsJobs(args []string) error {
	fs := flag.NewFlagSet("img-utils jobs", flag.ContinueOnError)
	status := fs.String("status", "", "only jobs with this status (comma-separated)")
	active := fs.Bool("active", false, "only jobs that have not finished yet")
	idsOnly := fs.Bool("ids", false, "print bare job IDs, one per line")
	asJSON := fs.Bool("json", false, "print the raw JSON list")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 0 {
		return errors.New("usage: oai img-utils jobs [-status S[,S]] [-active] [-ids] [-json]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var all []imgUtilsJob
	if err := doJSON("GET", imgUtilsURL(cfg, "jobs"), cfg.Token, nil, &all); err != nil {
		return err
	}
	want := map[string]bool{}
	for _, s := range strings.Split(*status, ",") {
		if s = strings.TrimSpace(s); s != "" {
			want[s] = true
		}
	}
	jobs := []imgUtilsJob{}
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
		fmt.Println("No matching Image Tools jobs.")
		return nil
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "JOB ID\tSTATUS\tTOOL\tCAPABILITY\tCREATED\tOUTPUT")
	for _, j := range jobs {
		output := "-"
		if j.OutputImageID != nil {
			output = *j.OutputImageID
		}
		created := j.CreatedAt
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\n", j.JobID, j.Status, j.Workflow, j.Capability, localTime(&created), output)
	}
	return w.Flush()
}

// cmdImgUtilsJob shows one job: the persisted state (job), or after one forced
// reconcile with OffloadMQ (poll).
func cmdImgUtilsJob(args []string, poll bool) error {
	name, method, suffix := "job", "GET", ""
	if poll {
		name, method, suffix = "poll", "POST", "/poll"
	}
	fs := flag.NewFlagSet("img-utils "+name, flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print the raw job JSON")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return fmt.Errorf("usage: oai img-utils %s <job-id> [-json]", name)
	}
	if err := requireIDs(rest); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var job imgUtilsJob
	if err := doJSON(method, imgUtilsURL(cfg, "jobs", rest[0])+suffix, cfg.Token, nil, &job); err != nil {
		return err
	}
	if *asJSON {
		return printJSON(&job)
	}
	fmt.Printf("Job:        %s\n", job.JobID)
	fmt.Printf("Status:     %s\n", job.Status)
	fmt.Printf("Tool:       %s\n", job.Workflow)
	fmt.Printf("Capability: %s\n", job.Capability)
	if job.Stage != nil && *job.Stage != "" {
		fmt.Printf("Stage:      %s\n", *job.Stage)
	}
	if len(job.Options) > 0 {
		keys := make([]string, 0, len(job.Options))
		for k := range job.Options {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		var parts []string
		for _, k := range keys {
			parts = append(parts, fmt.Sprintf("%s=%v", k, job.Options[k]))
		}
		fmt.Printf("Options:    %s\n", strings.Join(parts, " "))
	}
	if job.Error != nil && *job.Error != "" {
		fmt.Printf("Error:      %s\n", *job.Error)
	}
	for _, slot := range []struct {
		label string
		ref   *imgUtilsImageRef
	}{{"Input:     ", job.InputImage}, {"Output:    ", job.OutputImage}} {
		if ref := slot.ref; ref != nil {
			fmt.Printf("%s %s  %s  %dx%d  %d bytes\n", slot.label, ref.ImageID, ref.Filename, ref.Width, ref.Height, ref.SizeBytes)
		}
	}
	return nil
}

func cmdImgUtilsCancel(args []string) error {
	fs := flag.NewFlagSet("img-utils cancel", flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		return errors.New("usage: oai img-utils cancel <job-id> [job-id ...]")
	}
	if err := requireIDs(rest); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var errs []error
	for _, id := range rest {
		var resp imageCancelResponse
		if err := doJSON("POST", imgUtilsURL(cfg, "jobs", id, "cancel"), cfg.Token, nil, &resp); err != nil {
			errs = append(errs, fmt.Errorf("cancel %s: %w", id, err))
			continue
		}
		fmt.Printf("%s: %s (%s)\n", resp.JobID, resp.Status, resp.Message)
	}
	return errors.Join(errs...)
}

// cmdImgUtilsRetry resubmits a failed or canceled job with its stored tool,
// images and options.
func cmdImgUtilsRetry(args []string) error {
	fs := flag.NewFlagSet("img-utils retry", flag.ContinueOnError)
	out := fs.String("o", "", "output file (default <tool>_<job-id>.<ext>)")
	noWait := fs.Bool("no-wait", false, "resubmit without waiting; print the new job ID to stdout")
	timeout := timeoutFlag(fs)
	showProgress := progressFlag(fs)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai img-utils retry <job-id> [-o out.jpg] [--no-wait] [--progress=false] [-t|-timeout 5m]")
	}
	if err := requireIDs(rest); err != nil {
		return err
	}
	if *noWait && *out != "" {
		return errors.New("-o cannot be used with --no-wait; download later with `oai img-utils download <job-id> -o out.jpg`")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var started startJobResponse
	if err := doJSON("POST", imgUtilsURL(cfg, "jobs", rest[0], "retry"), cfg.Token, nil, &started); err != nil {
		return err
	}
	if *noWait {
		fmt.Println(started.JobID)
		return nil
	}
	fmt.Fprintf(os.Stderr, "Job: %s (retry of %s)\n", started.JobID, rest[0])
	job, err := waitForImgUtilsJob(cfg, started.JobID, "Image", *timeout, *showProgress)
	if err != nil {
		return err
	}
	return saveImgUtilsOutput(cfg, job, defaultImgUtilsDest(*out, job))
}

func defaultImgUtilsDest(out string, job *imgUtilsJob) string {
	if out != "" {
		return out
	}
	return job.Workflow + "_" + job.JobID + imgUtilsOutputExt(job)
}

// cmdImgUtilsDelete removes jobs and their output image (the input upload is
// shared and stays).
func cmdImgUtilsDelete(args []string) error {
	fs := flag.NewFlagSet("img-utils delete", flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		return errors.New("usage: oai img-utils delete <job-id> [job-id ...]")
	}
	if err := requireIDs(rest); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var errs []error
	for _, id := range rest {
		if err := doJSON("DELETE", imgUtilsURL(cfg, "jobs", id), cfg.Token, nil, nil); err != nil {
			errs = append(errs, fmt.Errorf("delete %s: %w", id, err))
			continue
		}
		fmt.Printf("Deleted %s\n", id)
	}
	return errors.Join(errs...)
}

// cmdImgUtilsDownload saves a completed job's output. Like image download it
// reads the persisted job and never polls.
func cmdImgUtilsDownload(args []string) error {
	fs := flag.NewFlagSet("img-utils download", flag.ContinueOnError)
	out := fs.String("o", "", "output file (default <tool>_<job-id>.<ext>)")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai img-utils download <job-id> [-o out.jpg]")
	}
	if err := requireIDs(rest); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var job imgUtilsJob
	if err := doJSON("GET", imgUtilsURL(cfg, "jobs", rest[0]), cfg.Token, nil, &job); err != nil {
		return err
	}
	if job.Status != "completed" {
		return fmt.Errorf("job %s is %s; run `oai img-utils poll %s` until it completes", job.JobID, job.Status, job.JobID)
	}
	return saveImgUtilsOutput(cfg, &job, defaultImgUtilsDest(*out, &job))
}
