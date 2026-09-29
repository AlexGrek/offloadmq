package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"
)

// Same cadence as ImageGenerationPage.tsx (POLL_MS). A var only so tests can
// shorten it.
var pollInterval = 5 * time.Second

// A job poll may fail this many times in a row before the command gives up.
// Poll failures are usually transient (backend restart, gateway blip) and
// the job keeps running on the server regardless.
const maxPollFailures = 3

// Where non-interactive "retrying" notices go: stderr, so they never mix into
// a result a script reads from stdout. A var only so tests can capture it.
var pollNotices io.Writer = os.Stderr

// Keep the CLI's batch limit aligned with ImageGenerationPage.tsx.
const maxGenerateCount = 10

// capabilityInfo is the capability row shared by /api/images/capabilities and
// /api/describe/capabilities.
type capabilityInfo struct {
	Base            string   `json:"base"`
	Tags            []string `json:"tags"`
	Raw             string   `json:"raw"`
	Online          bool     `json:"online"`
	LastAvailableAt string   `json:"last_available_at"`
	UsageCount      uint32   `json:"usage_count"`
}

type contentRequest struct {
	Content string `json:"content"`
}

type startJobRequest struct {
	Capability     string `json:"capability"`
	Prompt         string `json:"prompt"`
	NegativePrompt string `json:"negative_prompt,omitempty"`
	// OverrideNegative makes the backend send NegativePrompt instead of the workflow default.
	OverrideNegative bool   `json:"override_negative"`
	Width            int    `json:"width"`
	Height           int    `json:"height"`
	Seed             *int64 `json:"seed,omitempty"`
	Workflow         string `json:"workflow,omitempty"`
	// PromptTemplate is the raw prompt before placeholder expansion; the server
	// stores it so Retry / saved-prompt previews see the template, like the web UI.
	PromptTemplate string `json:"prompt_template,omitempty"`
}

type startJobResponse struct {
	JobID  string `json:"job_id"`
	Status string `json:"status"`
}

type imageRef struct {
	ImageID     string `json:"image_id"`
	Filename    string `json:"filename"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
}

type pollResponse struct {
	JobID                 string     `json:"job_id"`
	Status                string     `json:"status"`
	Stage                 *string    `json:"stage"`
	Error                 *string    `json:"error"`
	OutputImages          []imageRef `json:"output_images"`
	StartedAt             *string    `json:"started_at"`
	TypicalRuntimeSeconds *float64   `json:"typical_runtime_seconds"`
	SubmittedAt           *string    `json:"submitted_at"`
	QueuedSeconds         *float64   `json:"queued_seconds"`
	ExecutionSeconds      *float64   `json:"execution_seconds"`
}

// imageJobFile is an input or output file attached to an image-generation job.
// The job detail endpoint includes both, while the poll endpoint includes only
// output images.
type imageJobFile struct {
	ImageID     string `json:"image_id"`
	Direction   string `json:"direction"`
	Source      string `json:"source"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	SizeBytes   int64  `json:"size_bytes"`
}

// imageJobDetail mirrors the fields used from GET /api/images/jobs/{id}.
// Keep optional backend fields as pointers so null remains distinguishable.
type imageJobDetail struct {
	JobID                 string         `json:"job_id"`
	DisplayName           string         `json:"display_name"`
	Status                string         `json:"status"`
	Capability            string         `json:"capability"`
	Workflow              string         `json:"workflow"`
	Error                 *string        `json:"error"`
	StartedAt             *string        `json:"started_at"`
	TypicalRuntimeSeconds *float64       `json:"typical_runtime_seconds"`
	SubmittedAt           *string        `json:"submitted_at"`
	QueuedSeconds         *float64       `json:"queued_seconds"`
	ExecutionSeconds      *float64       `json:"execution_seconds"`
	Files                 []imageJobFile `json:"files"`
}

func (p pollResponse) progressState() jobProgressState {
	stage := ""
	if p.Stage != nil {
		stage = *p.Stage
	}
	return jobProgressState{
		Status:                p.Status,
		Stage:                 stage,
		StartedAt:             p.StartedAt,
		TypicalRuntimeSeconds: p.TypicalRuntimeSeconds,
		SubmittedAt:           p.SubmittedAt,
		ExecutionSeconds:      p.ExecutionSeconds,
	}
}

func cmdImage(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: oai image <generate|capabilities|job|poll|download|prompts|describe|describe-capabilities> ...")
	}
	switch args[0] {
	case "generate":
		return cmdImageGenerate(args[1:])
	case "prompts":
		return cmdImagePrompts(args[1:])
	case "capabilities":
		return cmdImageCapabilities(args[1:])
	case "job":
		return cmdImageJob(args[1:])
	case "poll":
		return cmdImagePoll(args[1:])
	case "download":
		return cmdImageDownload(args[1:])
	case "describe":
		return cmdImageDescribe(args[1:])
	case "describe-capabilities":
		return cmdImageDescribeCapabilities(args[1:])
	default:
		return fmt.Errorf("unknown image command %q (want generate, capabilities, job, poll, download, prompts, describe or describe-capabilities)", args[0])
	}
}

func fetchImgCapabilities(cfg *Config) ([]capabilityInfo, error) {
	var caps []capabilityInfo
	err := doJSON("GET", cfg.serverURL("")+"/api/images/capabilities", cfg.Token, nil, &caps)
	return caps, err
}

func cmdImageCapabilities(args []string) error {
	fs := flag.NewFlagSet("image capabilities", flag.ContinueOnError)
	if _, err := parseInterleaved(fs, args); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	caps, err := fetchImgCapabilities(cfg)
	if err != nil {
		return err
	}
	return printCapabilities(caps, "imggen.*")
}

// cmdImageJob reads the last state persisted by the backend. It does not
// contact OffloadMQ; use image poll when an immediate refresh is needed.
func cmdImageJob(args []string) error {
	fs := flag.NewFlagSet("image job", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print the raw job JSON")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai image job <job-id> [-json]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var job imageJobDetail
	u := cfg.serverURL("") + "/api/images/jobs/" + url.PathEscape(rest[0])
	if err := doJSON("GET", u, cfg.Token, nil, &job); err != nil {
		return err
	}
	if *asJSON {
		return printJSON(&job)
	}
	printImageJobDetail(&job)
	return nil
}

// cmdImagePoll asks the backend to reconcile one image job with OffloadMQ,
// then prints the refreshed state. A single invocation performs one poll.
func cmdImagePoll(args []string) error {
	fs := flag.NewFlagSet("image poll", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print the raw poll JSON")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai image poll <job-id> [-json]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var polled pollResponse
	u := cfg.serverURL("") + "/api/images/jobs/" + url.PathEscape(rest[0]) + "/poll"
	if err := doJSON("POST", u, cfg.Token, nil, &polled); err != nil {
		return err
	}
	if *asJSON {
		return printJSON(&polled)
	}
	printImagePoll(&polled)
	return nil
}

// cmdImageDownload saves every output attached to a completed image job. It
// deliberately reads the persisted job state instead of polling, so callers
// can choose when a foreground OffloadMQ poll occurs.
func cmdImageDownload(args []string) error {
	fs := flag.NewFlagSet("image download", flag.ContinueOnError)
	out := fs.String("o", "output.jpg", "output file (extra images get _2, _3, ... suffixes)")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai image download <job-id> [-o output.jpg]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	base := cfg.serverURL("")
	var job imageJobDetail
	u := base + "/api/images/jobs/" + url.PathEscape(rest[0])
	if err := doJSON("GET", u, cfg.Token, nil, &job); err != nil {
		return err
	}
	if job.Status != "completed" {
		return fmt.Errorf("job %s is %s; run `oai image poll %s` until it completes", job.JobID, job.Status, job.JobID)
	}
	outputs := outputImageFiles(job.Files)
	if len(outputs) == 0 {
		return fmt.Errorf("job %s completed but has no output images", job.JobID)
	}
	for i, image := range outputs {
		dest := indexedOutputPath(*out, i)
		if err := downloadFile(base+"/api/images/files/"+url.PathEscape(image.ImageID), cfg.Token, dest); err != nil {
			return fmt.Errorf("download %s: %w", image.ImageID, err)
		}
		fmt.Printf("Saved %s\n", dest)
	}
	return nil
}

func outputImageFiles(files []imageJobFile) []imageJobFile {
	outputs := make([]imageJobFile, 0, len(files))
	for _, file := range files {
		if file.Direction == "output" {
			outputs = append(outputs, file)
		}
	}
	return outputs
}

func printImageJobDetail(job *imageJobDetail) {
	fmt.Printf("Job:        %s\n", job.JobID)
	fmt.Printf("Status:     %s\n", job.Status)
	fmt.Printf("Capability: %s\n", job.Capability)
	fmt.Printf("Workflow:   %s\n", job.Workflow)
	if job.Error != nil && *job.Error != "" {
		fmt.Printf("Error:      %s\n", *job.Error)
	}
	if len(job.Files) == 0 {
		return
	}
	fmt.Println()
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "IMAGE ID\tDIRECTION\tFILENAME\tSIZE")
	for _, file := range job.Files {
		fmt.Fprintf(w, "%s\t%s\t%s\t%d\n", file.ImageID, file.Direction, file.Filename, file.SizeBytes)
	}
	_ = w.Flush()
}

func printImagePoll(polled *pollResponse) {
	fmt.Printf("Job:    %s\n", polled.JobID)
	fmt.Printf("Status: %s\n", polled.Status)
	if polled.Stage != nil && *polled.Stage != "" {
		fmt.Printf("Stage:  %s\n", *polled.Stage)
	}
	if polled.Error != nil && *polled.Error != "" {
		fmt.Printf("Error:  %s\n", *polled.Error)
	}
	if len(polled.OutputImages) == 0 {
		return
	}
	fmt.Println()
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "IMAGE ID\tFILENAME\tSIZE")
	for _, image := range polled.OutputImages {
		fmt.Fprintf(w, "%s\t%s\t%d\n", image.ImageID, image.Filename, image.SizeBytes)
	}
	_ = w.Flush()
}

// printCapabilities renders a capability table; kind names the family for the empty message.
func printCapabilities(caps []capabilityInfo, kind string) error {
	if len(caps) == 0 {
		fmt.Printf("No %s capabilities known to the server.\n", kind)
		return nil
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "CAPABILITY\tONLINE\tTAGS\tUSES")
	for _, c := range caps {
		online := "no"
		if c.Online {
			online = "yes"
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%d\n", c.Base, online, strings.Join(c.Tags, ";"), c.UsageCount)
	}
	return w.Flush()
}

// pickCapability returns the first online capability tagged with preferTag
// (imggen capabilities also cover img2img, video, ...), falling back to the
// first online one of any kind. It errors, listing all known capabilities, when
// none are online. kind names the family in error messages.
func pickCapability(caps []capabilityInfo, preferTag, kind string) (string, error) {
	first := ""
	for _, c := range caps {
		if !c.Online {
			continue
		}
		for _, t := range c.Tags {
			if t == preferTag {
				return c.Base, nil
			}
		}
		if first == "" {
			first = c.Base
		}
	}
	if first != "" {
		return first, nil
	}
	if len(caps) == 0 {
		return "", fmt.Errorf("no %s capabilities are known to the server", kind)
	}
	var names []string
	for _, c := range caps {
		names = append(names, c.Base+" (offline)")
	}
	return "", fmt.Errorf("no %s capability is online; known: %s", kind, strings.Join(names, ", "))
}

// fetchCustomPlaceholders loads the user's server-side custom placeholders. Like
// the web UI it is additive: any failure just means custom tokens stay literal
// (with a warning), never a failed submission. Skipped when the prompt has no braces.
func fetchCustomPlaceholders(cfg *Config, prompt string) []promptPlaceholder {
	if !strings.Contains(prompt, "{") {
		return nil
	}
	var items []promptPlaceholder
	if err := doJSON("GET", cfg.serverURL("")+"/api/prompt-placeholders", cfg.Token, nil, &items); err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not load custom placeholders: %v\n", err)
		return nil
	}
	return items
}

func cmdImageGenerate(args []string) error {
	fs := flag.NewFlagSet("image generate", flag.ContinueOnError)
	out := fs.String("o", "output.jpg", "output file (extra images get _2, _3, ... suffixes)")
	capability := fs.String("capability", "", "imggen.* capability (default: first online)")
	negative := fs.String("negative", "", "negative prompt")
	width := fs.Int("width", 1024, "image width")
	height := fs.Int("height", 1024, "image height")
	seed := fs.Int64("seed", 0, "seed (0 = random)")
	workflow := fs.String("workflow", "txt2img", "workflow")
	count := 1
	fs.IntVar(&count, "n", 1, "number of separate image-generation runs (max 10)")
	fs.IntVar(&count, "count", 1, "alias for -n")
	noWait := fs.Bool("no-wait", false, "submit without waiting; print job IDs to stdout")
	timeout := timeoutFlag(fs)
	showProgress := progressFlag(fs)
	promptFlag := fs.String("prompt", "", "prompt text (or pass it as the first argument)")
	history := fs.Bool("history", true, "save prompt to history (OAI prompt library)")
	star := fs.Bool("star", false, "also add the prompt to your starred prompts")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	prompt := *promptFlag
	if prompt == "" {
		prompt = strings.Join(rest, " ")
	}
	if strings.TrimSpace(prompt) == "" {
		return errors.New(`prompt required: oai image generate "a red bicycle" -o bike.jpg`)
	}
	if count < 1 || count > maxGenerateCount {
		return fmt.Errorf("-n must be between 1 and %d", maxGenerateCount)
	}
	if *noWait {
		outputRequested := false
		fs.Visit(func(f *flag.Flag) {
			if f.Name == "o" {
				outputRequested = true
			}
		})
		if outputRequested {
			return errors.New("-o cannot be used with --no-wait; download later with `oai image download <job-id> -o output.jpg`")
		}
	}

	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	base := cfg.serverURL("")

	capName := *capability
	if capName == "" {
		caps, err := fetchImgCapabilities(cfg)
		if err != nil {
			return err
		}
		if capName, err = pickCapability(caps, *workflow, "imggen.*"); err != nil {
			return err
		}
		if *noWait {
			fmt.Fprintf(os.Stderr, "Using capability: %s (auto-selected, online)\n", capName)
		} else {
			fmt.Printf("Using capability: %s (auto-selected, online)\n", capName)
		}
	}

	// Placeholders ({color}, custom {.name}, ...) resolve per job, sharing one
	// expander so a batch never repeats a value. {?} is left for the server.
	template := strings.TrimSpace(prompt)
	expander := newPlaceholderExpander(fetchCustomPlaceholders(cfg, template))

	req := startJobRequest{
		Capability:     capName,
		PromptTemplate: template,
		Width:          *width,
		Height:         *height,
		Workflow:       *workflow,
	}
	if *negative != "" {
		req.NegativePrompt = *negative
		req.OverrideNegative = true
	}
	startedJobs := make([]startJobResponse, 0, count)
	var batchErrors []error
	for i := 0; i < count; i++ {
		jobReq := req
		jobReq.Prompt = strings.TrimSpace(expander.Expand(template))
		if jobReq.Prompt != template {
			output := io.Writer(os.Stdout)
			if *noWait {
				output = os.Stderr
			}
			if count == 1 {
				fmt.Fprintf(output, "Prompt: %s\n", jobReq.Prompt)
			} else {
				fmt.Fprintf(output, "Prompt %d/%d: %s\n", i+1, count, jobReq.Prompt)
			}
		}
		if *seed != 0 {
			// Offset the seed per job: one shared seed would make every image identical.
			jobSeed := *seed + int64(i)
			jobReq.Seed = &jobSeed
		}
		var started startJobResponse
		if err := doJSON("POST", base+"/api/images/jobs", cfg.Token, jobReq, &started); err != nil {
			batchErrors = append(batchErrors, fmt.Errorf("submit job %d of %d: %w", i+1, count, err))
			break
		}
		startedJobs = append(startedJobs, started)
		if *noWait {
			// Keep stdout machine-readable: a regular detached invocation emits
			// exactly one bare ID; detached batches emit one bare ID per line.
			fmt.Fprintln(os.Stdout, started.JobID)
		} else if count == 1 {
			fmt.Printf("Job: %s\n", started.JobID)
		} else {
			fmt.Printf("Job %d/%d: %s\n", i+1, count, started.JobID)
		}
	}

	if left := expander.Unsupported(); len(left) > 0 {
		fmt.Fprintf(os.Stderr, "warning: %s not supported by the CLI, sent literally\n", strings.Join(left, ", "))
	}

	if *history && len(startedJobs) > 0 {
		_ = doJSON("POST", base+"/api/prompts/"+imgPromptBucket+"/recent", cfg.Token, contentRequest{Content: template}, nil)
		if *negative != "" {
			_ = doJSON("POST", base+"/api/prompts/"+imgNegativeBucket+"/recent", cfg.Token, contentRequest{Content: *negative}, nil)
		}
	}
	// Star the template (placeholders unexpanded), as the web UI's favorite
	// button does. stderr keeps --no-wait stdout to bare job IDs.
	if *star && len(startedJobs) > 0 {
		if item, err := starPrompt(cfg, imgPromptBucket, template); err != nil {
			fmt.Fprintf(os.Stderr, "warning: could not star prompt: %v\n", err)
		} else {
			fmt.Fprintf(os.Stderr, "Starred prompt %s\n", item.ID)
		}
	}
	if *noWait {
		return errors.Join(batchErrors...)
	}

	for i, started := range startedJobs {
		if count > 1 {
			fmt.Printf("Waiting for job %d/%d: %s\n", i+1, count, started.JobID)
		}
		var p pollResponse
		pollURL := base + "/api/images/jobs/" + url.PathEscape(started.JobID) + "/poll"
		label := "Image"
		if count > 1 {
			label = fmt.Sprintf("Image %d/%d", i+1, count)
		}
		err := waitForJob(os.Stdout, started.JobID, *timeout, jobProgressOptions{
			Enabled:      *showProgress,
			Label:        label,
			RunningLabel: "Generating",
		}, func(ctx context.Context) (jobProgressState, error) {
			if err := doJSONContext(ctx, "POST", pollURL, cfg.Token, nil, &p); err != nil {
				return jobProgressState{}, err
			}
			return p.progressState(), nil
		})
		if err != nil {
			batchErrors = append(batchErrors, fmt.Errorf("job %d of %d (%s): %w", i+1, count, started.JobID, err))
			continue
		}
		if err := finishJob(base, cfg.Token, &p, *out, i, count > 1); err != nil {
			batchErrors = append(batchErrors, fmt.Errorf("job %d of %d (%s): %w", i+1, count, started.JobID, err))
		}
	}
	return errors.Join(batchErrors...)
}

// waitForJob polls until the job reaches a terminal status or the timeout
// elapses. Interactive terminals get an animated progress bar between polls;
// redirected output and disabled progress retain plain stage-transition lines.
func waitForJob(
	w io.Writer,
	jobID string,
	timeout time.Duration,
	opts jobProgressOptions,
	poll func(ctx context.Context) (jobProgressState, error),
) error {
	deadline := time.Now().Add(timeout)
	// Bounds each poll request too, so a hung one can't overshoot -timeout.
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	renderer := newJobProgressRenderer(w, opts)
	lastStage := ""
	failures := 0
	var state jobProgressState
	timedOut := func() error {
		renderer.fail("Timed out")
		status := state.Status
		if status == "" {
			status = "in progress"
		}
		return fmt.Errorf("timed out after %s (job %s is still %s on the server)", timeout, jobID, status)
	}
	for {
		polled, err := poll(ctx)
		now := time.Now()
		if err != nil && ctx.Err() != nil {
			return timedOut()
		}
		if err == nil {
			failures = 0
			state = polled
			if renderer.interactive {
				renderer.render(state, now)
			} else if state.Stage != "" && state.Stage != lastStage {
				lastStage = state.Stage
				fmt.Fprintf(w, "Stage: %s\n", state.Stage)
			}
			if isTerminal(state.Status) {
				renderer.finish(state, now)
				return nil
			}
		} else {
			failures++
			if !isTransientPollError(err) || failures >= maxPollFailures {
				renderer.fail("Poll failed")
				return err
			}
			msg := fmt.Sprintf("Poll failed (%d/%d), retrying: %v", failures, maxPollFailures, err)
			if renderer.interactive {
				renderer.fail(msg)
			} else {
				fmt.Fprintln(pollNotices, msg)
			}
		}

		nextPoll := now.Add(pollInterval)
		for {
			now = time.Now()
			if !now.Before(deadline) {
				return timedOut()
			}
			untilPoll := nextPoll.Sub(now)
			if untilPoll <= 0 {
				break
			}
			pause := untilPoll
			if renderer.interactive {
				renderer.render(state, now)
				pause = minDuration(progressTick, untilPoll)
			}
			pause = minDuration(pause, deadline.Sub(now))
			if pause > 0 {
				time.Sleep(pause)
			}
		}
	}
}

// isTransientPollError reports whether a failed poll is worth retrying:
// network errors and gateway/overload responses (502, 503, 504, 408, 429)
// are. Any other API error is not — including 500, which the backend returns
// for its own failures (misconfiguration, DB errors) that a retry won't fix.
func isTransientPollError(err error) bool {
	var he *httpError
	if !errors.As(err, &he) {
		return !errors.Is(err, errNotLoggedIn)
	}
	switch he.Status {
	case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout,
		http.StatusRequestTimeout, http.StatusTooManyRequests:
		return true
	}
	return false
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

// outputImagePath names the image-th (zero-based) result of job job. A single
// run uses out, out_2, ...; in a batch each job owns out / out_<job+1> and its
// extra images get an image suffix (out_1_2, out_2_2, ...) so jobs never collide.
func outputImagePath(out string, job, image int, batch bool) string {
	if !batch {
		return indexedOutputPath(out, image)
	}
	base := indexedOutputPath(out, job)
	if image == 0 {
		return base
	}
	ext := filepath.Ext(out)
	return fmt.Sprintf("%s_%d_%d%s", strings.TrimSuffix(out, ext), job+1, image+1, ext)
}

func finishJob(base, token string, p *pollResponse, out string, job int, batch bool) error {
	if p.Status != "completed" {
		msg := "no error message"
		if p.Error != nil && *p.Error != "" {
			msg = *p.Error
		}
		return fmt.Errorf("job %s: %s", p.Status, msg)
	}
	if len(p.OutputImages) == 0 {
		return errors.New("job completed but produced no images")
	}
	for i, img := range p.OutputImages {
		dest := outputImagePath(out, job, i, batch)
		if err := downloadFile(base+"/api/images/files/"+url.PathEscape(img.ImageID), token, dest); err != nil {
			return fmt.Errorf("download %s: %w", img.ImageID, err)
		}
		fmt.Printf("Saved %s\n", dest)
	}
	return nil
}

// indexedOutputPath keeps the requested name for the first result and adds a
// one-based suffix for later results: image.jpg, image_2.jpg, image_3.jpg.
func indexedOutputPath(path string, index int) string {
	if index == 0 {
		return path
	}
	ext := filepath.Ext(path)
	stem := strings.TrimSuffix(path, ext)
	return fmt.Sprintf("%s_%d%s", stem, index+1, ext)
}
