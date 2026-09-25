package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"
)

// Same cadence as ImageGenerationPage.tsx (POLL_MS).
const pollInterval = 5 * time.Second

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
		return errors.New("usage: oai image <generate|capabilities|describe|describe-capabilities> ...")
	}
	switch args[0] {
	case "generate":
		return cmdImageGenerate(args[1:])
	case "capabilities":
		return cmdImageCapabilities(args[1:])
	case "describe":
		return cmdImageDescribe(args[1:])
	case "describe-capabilities":
		return cmdImageDescribeCapabilities(args[1:])
	default:
		return fmt.Errorf("unknown image command %q (want generate, capabilities, describe or describe-capabilities)", args[0])
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

func cmdImageGenerate(args []string) error {
	fs := flag.NewFlagSet("image generate", flag.ContinueOnError)
	out := fs.String("o", "output.jpg", "output file (extra images get _2, _3, ... suffixes)")
	capability := fs.String("capability", "", "imggen.* capability (default: first online)")
	negative := fs.String("negative", "", "negative prompt")
	width := fs.Int("width", 768, "image width")
	height := fs.Int("height", 768, "image height")
	seed := fs.Int64("seed", 0, "seed (0 = random)")
	workflow := fs.String("workflow", "txt2img", "workflow")
	count := 1
	fs.IntVar(&count, "n", 1, "number of separate image-generation runs (max 10)")
	fs.IntVar(&count, "count", 1, "alias for -n")
	timeout := timeoutFlag(fs)
	showProgress := progressFlag(fs)
	promptFlag := fs.String("prompt", "", "prompt text (or pass it as the first argument)")
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
		fmt.Printf("Using capability: %s (auto-selected, online)\n", capName)
	}

	req := startJobRequest{
		Capability: capName,
		Prompt:     prompt,
		Width:      *width,
		Height:     *height,
		Workflow:   *workflow,
	}
	if *negative != "" {
		req.NegativePrompt = *negative
		req.OverrideNegative = true
	}
	if *seed != 0 {
		req.Seed = seed
	}
	startedJobs := make([]startJobResponse, 0, count)
	var batchErrors []error
	for i := 0; i < count; i++ {
		var started startJobResponse
		if err := doJSON("POST", base+"/api/images/jobs", cfg.Token, req, &started); err != nil {
			batchErrors = append(batchErrors, fmt.Errorf("submit job %d of %d: %w", i+1, count, err))
			break
		}
		startedJobs = append(startedJobs, started)
		if count == 1 {
			fmt.Printf("Job: %s\n", started.JobID)
		} else {
			fmt.Printf("Job %d/%d: %s\n", i+1, count, started.JobID)
		}
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
		}, func() (jobProgressState, error) {
			if err := doJSON("POST", pollURL, cfg.Token, nil, &p); err != nil {
				return jobProgressState{}, err
			}
			return p.progressState(), nil
		})
		if err != nil {
			batchErrors = append(batchErrors, fmt.Errorf("job %d of %d (%s): %w", i+1, count, started.JobID, err))
			continue
		}
		if err := finishJob(base, cfg.Token, &p, indexedOutputPath(*out, i)); err != nil {
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
	poll func() (jobProgressState, error),
) error {
	deadline := time.Now().Add(timeout)
	renderer := newJobProgressRenderer(w, opts)
	lastStage := ""
	for {
		state, err := poll()
		if err != nil {
			renderer.fail("Poll failed")
			return err
		}
		now := time.Now()
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

		nextPoll := now.Add(pollInterval)
		for {
			now = time.Now()
			if !now.Before(deadline) {
				renderer.fail("Timed out")
				return fmt.Errorf("timed out after %s (job %s is still %s on the server)", timeout, jobID, state.Status)
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

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func finishJob(base, token string, p *pollResponse, out string) error {
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
	ext := filepath.Ext(out)
	stem := strings.TrimSuffix(out, ext)
	for i, img := range p.OutputImages {
		dest := out
		if i > 0 {
			dest = fmt.Sprintf("%s_%d%s", stem, i+1, ext)
		}
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
