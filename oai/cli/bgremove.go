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
	"strings"
	"text/tabwriter"
	"time"
)

// Background Remover (the web UI's /app/bg-remover): one image in, the subject cut
// out — a transparent PNG/WebP, or the subject on a flat colour. Wraps
// routes/bg_remover.rs, mirroring frontend/src/api/bgRemover.ts. The models are
// `onnx.bgremove.<model>` capabilities, one per model installed on an online agent;
// the options are the typed BgRemoverOptions (the server validates and normalizes
// them, so a typo is a 400 on submit rather than a failed job).

const (
	bgDefaultModel = "birefnet-default" // never sent: the server lists its default first
	// Mean-alpha thresholds, as foreground_warning in services/bg_remover.rs: below the low
	// one the model found no subject, above the high one it kept the background.
	bgLowForeground  = 0.01
	bgHighForeground = 0.95
)

// bgModel mirrors BgRemoverCapability. The endpoint lists only online models, the
// server's default (birefnet-general) first.
type bgModel struct {
	Base  string `json:"base"`
	Model string `json:"model"`
	Raw   string `json:"raw"`
}

// bgOptions mirrors BgRemoverOptions. The optional numbers are pointers so "not set"
// is omitted from requests and null from responses.
type bgOptions struct {
	Format           string   `json:"format"`
	Background       string   `json:"background"`
	Crop             bool     `json:"crop"`
	Padding          int      `json:"padding"`
	RefineForeground bool     `json:"refine_foreground"`
	AlphaThreshold   *float64 `json:"alpha_threshold,omitempty"`
	Quality          *int     `json:"quality,omitempty"`
}

type bgStartRequest struct {
	Capability   string    `json:"capability"`
	InputImageID string    `json:"input_image_id"`
	Options      bgOptions `json:"options"`
}

// bgJob mirrors JobDetailsResponse in routes/bg_remover.rs. The list endpoint leaves the
// *_image refs null.
type bgJob struct {
	JobID                 string            `json:"job_id"`
	Status                string            `json:"status"`
	Capability            string            `json:"capability"`
	Model                 string            `json:"model"`
	InputImageID          *string           `json:"input_image_id"`
	OutputImageID         *string           `json:"output_image_id"`
	InputImage            *imgUtilsImageRef `json:"input_image"`
	OutputImage           *imgUtilsImageRef `json:"output_image"`
	Options               bgOptions         `json:"options"`
	ForegroundRatio       *float64          `json:"foreground_ratio"`
	Stage                 *string           `json:"stage"`
	Error                 *string           `json:"error"`
	StartedAt             *string           `json:"started_at"`
	TypicalRuntimeSeconds *float64          `json:"typical_runtime_seconds"`
	CreatedAt             string            `json:"created_at"`
	UpdatedAt             string            `json:"updated_at"`
}

func (j bgJob) progressState() jobProgressState {
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

const bgUsage = "usage: oai bgremove <models|run|jobs|job|poll|cancel|retry|delete|download> ..."

func cmdBgRemove(args []string) error {
	if len(args) == 0 {
		return errors.New(bgUsage)
	}
	switch args[0] {
	case "models", "capabilities":
		return cmdBgModels(args[1:])
	case "run":
		return cmdBgRun(args[1:])
	case "jobs":
		return cmdBgJobs(args[1:])
	case "job":
		return cmdBgJob(args[1:], false)
	case "poll":
		return cmdBgJob(args[1:], true)
	case "cancel":
		return cmdBgCancel(args[1:])
	case "retry":
		return cmdBgRetry(args[1:])
	case "delete":
		return cmdBgDelete(args[1:])
	case "download":
		return cmdBgDownload(args[1:])
	default:
		return fmt.Errorf("unknown bgremove command %q (%s)", args[0], strings.TrimPrefix(bgUsage, "usage: "))
	}
}

func bgURL(cfg *Config, parts ...string) string {
	u := cfg.serverURL("") + "/api/bg-remover"
	for _, p := range parts {
		u += "/" + url.PathEscape(p)
	}
	return u
}

func fetchBgModels(cfg *Config) ([]bgModel, error) {
	var resp struct {
		Capabilities []bgModel `json:"capabilities"`
	}
	if err := doJSON("GET", bgURL(cfg, "capabilities"), cfg.Token, nil, &resp); err != nil {
		return nil, err
	}
	return resp.Capabilities, nil
}

// pickBgModel resolves a model name — `birefnet-general` or the full
// `onnx.bgremove.birefnet-general`, case-insensitive — to an online model; an empty name
// takes the first (the server's default). It never falls back to another model than the
// one asked for, so `run` fails before uploading anything.
func pickBgModel(models []bgModel, name string) (bgModel, error) {
	if len(models) == 0 {
		return bgModel{}, errors.New("no background-removal model is online (install one on an agent: bgremove-birefnet-general)")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return models[0], nil
	}
	for _, m := range models {
		if strings.EqualFold(m.Model, name) || strings.EqualFold(m.Base, name) {
			return m, nil
		}
	}
	online := make([]string, len(models))
	for i, m := range models {
		online[i] = m.Model
	}
	return bgModel{}, fmt.Errorf("model %q is not online; online models: %s", name, strings.Join(online, ", "))
}

func cmdBgModels(args []string) error {
	fs := flag.NewFlagSet("bgremove models", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print the raw JSON list")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 0 {
		return errors.New("usage: oai bgremove models [-json]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	models, err := fetchBgModels(cfg)
	if err != nil {
		return err
	}
	if *asJSON {
		if models == nil {
			models = []bgModel{}
		}
		return printJSON(&models)
	}
	if len(models) == 0 {
		fmt.Println("No background-removal model is online.")
		return nil
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "MODEL\tCAPABILITY\t")
	for i, m := range models {
		note := ""
		if i == 0 {
			note = "(default)"
		}
		fmt.Fprintf(w, "%s\t%s\t%s\n", m.Model, m.Base, note)
	}
	return w.Flush()
}

// bgWarning is the hint for a finished result that looks wrong ("" when fine), the same
// as the web UI's: a cropped result is mostly subject by construction, so "kept
// everything" does not apply to it.
func bgWarning(job *bgJob) string {
	if job.Status != "completed" || job.ForegroundRatio == nil {
		return ""
	}
	switch ratio := *job.ForegroundRatio; {
	case ratio < bgLowForeground:
		return "almost nothing was kept — the model may not have found a subject; try another -model"
	case ratio > bgHighForeground && !job.Options.Crop:
		return "almost everything was kept — the background may not have been removed; try another -model"
	}
	return ""
}

// describeBgOptions renders options the way the web UI's detail header does.
func describeBgOptions(o bgOptions) string {
	parts := []string{strings.ToUpper(o.Format)}
	if o.Background == "transparent" {
		parts = append(parts, "transparent")
	} else {
		parts = append(parts, "on "+o.Background)
	}
	if o.Crop {
		if o.Padding > 0 {
			parts = append(parts, fmt.Sprintf("cropped +%d px", o.Padding))
		} else {
			parts = append(parts, "cropped")
		}
	}
	if o.AlphaThreshold != nil {
		parts = append(parts, fmt.Sprintf("hard edges at %g", *o.AlphaThreshold))
	}
	if !o.RefineForeground {
		parts = append(parts, "raw edge colours")
	}
	return strings.Join(parts, ", ")
}

type bgRun struct {
	path, jobID, outPath string
}

// cmdBgRun uploads each image, starts one job per image with the chosen model and options,
// then waits and saves the cutouts. Progress and job lines go to stderr; stdout gets only
// the "Saved <path>" lines (or, with --no-wait, bare job IDs).
func cmdBgRun(args []string) error {
	fs := flag.NewFlagSet("bgremove run", flag.ContinueOnError)
	out := fs.String("o", "", "output file (default <input>_cutout.<ext>; _2, _3, ... for several inputs)")
	model := fs.String("model", "", "model, e.g. birefnet-portrait (default: the server's default, birefnet-general)")
	format := fs.String("format", "png", "png, webp (both can be transparent) or jpeg (always flattened onto a colour)")
	background := fs.String("background", "transparent", "transparent or #RRGGBB, the colour behind the subject")
	crop := fs.Bool("crop", false, "trim the result to the subject's bounding box")
	padding := fs.Int("padding", 0, "margin in pixels around the crop (needs -crop)")
	refine := fs.Bool("refine", true, "clean semi-transparent edge colours so the old background doesn't halo (-refine=false keeps raw colours)")
	hardEdges := fs.Float64("hard-edges", 0, "hard 0/1 alpha at this cut-off, 0..1 exclusive (default: soft edges)")
	quality := fs.Int("quality", 0, "webp/jpeg quality 1-100 (default: the agent's)")
	noWait := fs.Bool("no-wait", false, "submit without waiting; print job IDs to stdout")
	timeout := timeoutFlag(fs)
	showProgress := progressFlag(fs)
	inputs, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(inputs) == 0 {
		return errors.New("usage: oai bgremove run <image> [image ...] [-o out.png] [-model M] [-format png|webp|jpeg] [-background transparent|#RRGGBB] [-crop [-padding N]] [flags]")
	}
	if *noWait && *out != "" {
		return errors.New("-o cannot be used with --no-wait; download later with `oai bgremove download <job-id> -o out.png`")
	}
	for _, p := range inputs {
		if info, err := os.Stat(p); err != nil {
			return err
		} else if info.IsDir() {
			return fmt.Errorf("%s: is a directory", p)
		}
	}

	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	if *padding != 0 && !*crop {
		return errors.New("-padding needs -crop")
	}
	options := bgOptions{
		Format:           *format,
		Background:       *background,
		Crop:             *crop,
		Padding:          *padding,
		RefineForeground: *refine,
	}
	if set["hard-edges"] {
		options.AlphaThreshold = hardEdges
	}
	if set["quality"] {
		options.Quality = quality
	}

	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	models, err := fetchBgModels(cfg)
	if err != nil {
		return err
	}
	picked, err := pickBgModel(models, *model)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Using %s on %s\n", picked.Model, picked.Base)

	base := cfg.serverURL("")
	var runs []bgRun
	var errs []error
	for i, path := range inputs {
		var up uploadResponse
		if err := uploadFile(base+"/api/images/upload", cfg.Token, path, &up); err != nil {
			errs = append(errs, fmt.Errorf("%s: upload: %w", path, err))
			continue
		}
		req := bgStartRequest{Capability: picked.Base, InputImageID: up.ImageID, Options: options}
		var started startJobResponse
		if err := doJSON("POST", bgURL(cfg, "jobs"), cfg.Token, req, &started); err != nil {
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
		runs = append(runs, bgRun{path: path, jobID: started.JobID, outPath: outPath})
	}
	if *noWait {
		return errors.Join(errs...)
	}
	for _, run := range runs {
		job, err := waitForBgJob(cfg, run.jobID, filepath.Base(run.path), *timeout, *showProgress)
		if err == nil {
			dest := run.outPath
			if dest == "" {
				stem := strings.TrimSuffix(filepath.Base(run.path), filepath.Ext(run.path))
				dest = stem + "_cutout" + bgOutputExt(job)
			}
			err = saveBgOutput(cfg, job, dest)
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("%s (job %s): %w", run.path, run.jobID, err))
		}
	}
	return errors.Join(errs...)
}

func waitForBgJob(cfg *Config, jobID, label string, timeout time.Duration, showProgress bool) (*bgJob, error) {
	var job bgJob
	pollURL := bgURL(cfg, "jobs", jobID, "poll")
	err := waitForJob(os.Stderr, jobID, timeout, jobProgressOptions{
		Enabled:      showProgress,
		Label:        label,
		RunningLabel: "Removing background",
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

// bgOutputExt picks the default extension from the stored cutout: PNG and WebP keep their
// transparency, a JPEG request comes back as .jpg.
func bgOutputExt(job *bgJob) string {
	if job.OutputImage != nil {
		if ext := filepath.Ext(job.OutputImage.Filename); ext != "" {
			return ext
		}
		switch job.OutputImage.ContentType {
		case "image/webp":
			return ".webp"
		case "image/jpeg":
			return ".jpg"
		}
	}
	return ".png"
}

// saveBgOutput downloads the cutout and, when the result looks wrong, says so on stderr.
func saveBgOutput(cfg *Config, job *bgJob, dest string) error {
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
	if w := bgWarning(job); w != "" {
		fmt.Fprintf(os.Stderr, "Note: %s: %s\n", dest, w)
	}
	return nil
}

func cmdBgJobs(args []string) error {
	fs := flag.NewFlagSet("bgremove jobs", flag.ContinueOnError)
	status := fs.String("status", "", "only jobs with this status (comma-separated)")
	active := fs.Bool("active", false, "only jobs that have not finished yet")
	idsOnly := fs.Bool("ids", false, "print bare job IDs, one per line")
	asJSON := fs.Bool("json", false, "print the raw JSON list")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 0 {
		return errors.New("usage: oai bgremove jobs [-status S[,S]] [-active] [-ids] [-json]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var all []bgJob
	if err := doJSON("GET", bgURL(cfg, "jobs"), cfg.Token, nil, &all); err != nil {
		return err
	}
	want := map[string]bool{}
	for _, s := range strings.Split(*status, ",") {
		if s = strings.TrimSpace(s); s != "" {
			want[s] = true
		}
	}
	jobs := []bgJob{}
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
		fmt.Println("No matching background removal jobs.")
		return nil
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "JOB ID\tSTATUS\tMODEL\tCREATED\tOUTPUT")
	for _, j := range jobs {
		output := "-"
		if j.OutputImageID != nil {
			output = *j.OutputImageID
		}
		created := j.CreatedAt
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", j.JobID, j.Status, j.Model, localTime(&created), output)
	}
	return w.Flush()
}

// cmdBgJob shows one job: the persisted state (job), or after one forced reconcile with
// OffloadMQ (poll).
func cmdBgJob(args []string, poll bool) error {
	name, method, suffix := "job", "GET", ""
	if poll {
		name, method, suffix = "poll", "POST", "/poll"
	}
	fs := flag.NewFlagSet("bgremove "+name, flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print the raw job JSON")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return fmt.Errorf("usage: oai bgremove %s <job-id> [-json]", name)
	}
	if err := requireIDs(rest); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var job bgJob
	if err := doJSON(method, bgURL(cfg, "jobs", rest[0])+suffix, cfg.Token, nil, &job); err != nil {
		return err
	}
	if *asJSON {
		return printJSON(&job)
	}
	fmt.Printf("Job:        %s\n", job.JobID)
	fmt.Printf("Status:     %s\n", job.Status)
	fmt.Printf("Model:      %s\n", job.Model)
	fmt.Printf("Capability: %s\n", job.Capability)
	if job.Stage != nil && *job.Stage != "" {
		fmt.Printf("Stage:      %s\n", *job.Stage)
	}
	fmt.Printf("Options:    %s\n", describeBgOptions(job.Options))
	if job.ForegroundRatio != nil {
		fmt.Printf("Foreground: %.1f%% of the result is subject\n", *job.ForegroundRatio*100)
	}
	if w := bgWarning(&job); w != "" {
		fmt.Printf("Note:       %s\n", w)
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

func cmdBgCancel(args []string) error {
	fs := flag.NewFlagSet("bgremove cancel", flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		return errors.New("usage: oai bgremove cancel <job-id> [job-id ...]")
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
		if err := doJSON("POST", bgURL(cfg, "jobs", id, "cancel"), cfg.Token, nil, &resp); err != nil {
			errs = append(errs, fmt.Errorf("cancel %s: %w", id, err))
			continue
		}
		fmt.Printf("%s: %s (%s)\n", resp.JobID, resp.Status, resp.Message)
	}
	return errors.Join(errs...)
}

// cmdBgRetry resubmits a failed or canceled job with its stored image, model and options.
func cmdBgRetry(args []string) error {
	fs := flag.NewFlagSet("bgremove retry", flag.ContinueOnError)
	out := fs.String("o", "", "output file (default cutout_<job-id>.<ext>)")
	noWait := fs.Bool("no-wait", false, "resubmit without waiting; print the new job ID to stdout")
	timeout := timeoutFlag(fs)
	showProgress := progressFlag(fs)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai bgremove retry <job-id> [-o out.png] [--no-wait] [--progress=false] [-t|-timeout 5m]")
	}
	if err := requireIDs(rest); err != nil {
		return err
	}
	if *noWait && *out != "" {
		return errors.New("-o cannot be used with --no-wait; download later with `oai bgremove download <job-id> -o out.png`")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var started startJobResponse
	if err := doJSON("POST", bgURL(cfg, "jobs", rest[0], "retry"), cfg.Token, nil, &started); err != nil {
		return err
	}
	if *noWait {
		fmt.Println(started.JobID)
		return nil
	}
	fmt.Fprintf(os.Stderr, "Job: %s (retry of %s)\n", started.JobID, rest[0])
	job, err := waitForBgJob(cfg, started.JobID, "Image", *timeout, *showProgress)
	if err != nil {
		return err
	}
	return saveBgOutput(cfg, job, defaultBgDest(*out, job))
}

func defaultBgDest(out string, job *bgJob) string {
	if out != "" {
		return out
	}
	return "cutout_" + job.JobID + bgOutputExt(job)
}

// cmdBgDelete removes jobs and their cutout (the input upload is shared and stays).
func cmdBgDelete(args []string) error {
	fs := flag.NewFlagSet("bgremove delete", flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		return errors.New("usage: oai bgremove delete <job-id> [job-id ...]")
	}
	if err := requireIDs(rest); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var errs []error
	for _, id := range slices.Clone(rest) {
		if err := doJSON("DELETE", bgURL(cfg, "jobs", id), cfg.Token, nil, nil); err != nil {
			errs = append(errs, fmt.Errorf("delete %s: %w", id, err))
			continue
		}
		fmt.Printf("Deleted %s\n", id)
	}
	return errors.Join(errs...)
}

// cmdBgDownload saves a completed job's cutout. Like image download it reads the persisted
// job and never polls.
func cmdBgDownload(args []string) error {
	fs := flag.NewFlagSet("bgremove download", flag.ContinueOnError)
	out := fs.String("o", "", "output file (default cutout_<job-id>.<ext>)")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai bgremove download <job-id> [-o out.png]")
	}
	if err := requireIDs(rest); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var job bgJob
	if err := doJSON("GET", bgURL(cfg, "jobs", rest[0]), cfg.Token, nil, &job); err != nil {
		return err
	}
	if job.Status != "completed" {
		return fmt.Errorf("job %s is %s; run `oai bgremove poll %s` until it completes", job.JobID, job.Status, job.JobID)
	}
	return saveBgOutput(cfg, &job, defaultBgDest(*out, &job))
}
