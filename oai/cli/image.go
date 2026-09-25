package main

import (
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

// Same cadence as ImageGenerationPage.tsx (POLL_MS).
const pollInterval = 5 * time.Second

type imgGenCapability struct {
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
	JobID        string     `json:"job_id"`
	Status       string     `json:"status"`
	Stage        *string    `json:"stage"`
	Error        *string    `json:"error"`
	OutputImages []imageRef `json:"output_images"`
}

func isTerminal(status string) bool {
	return status == "completed" || status == "failed" || status == "canceled"
}

func cmdImage(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: oai image <generate|capabilities> ...")
	}
	switch args[0] {
	case "generate":
		return cmdImageGenerate(args[1:])
	case "capabilities":
		return cmdImageCapabilities(args[1:])
	default:
		return fmt.Errorf("unknown image command %q (want generate or capabilities)", args[0])
	}
}

func fetchImgCapabilities(cfg *Config) ([]imgGenCapability, error) {
	var caps []imgGenCapability
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
	if len(caps) == 0 {
		fmt.Println("No imggen.* capabilities known to the server.")
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

// pickCapability returns the first online capability, or an error listing all
// known ones when none are online.
func pickCapability(caps []imgGenCapability) (string, error) {
	for _, c := range caps {
		if c.Online {
			return c.Base, nil
		}
	}
	if len(caps) == 0 {
		return "", errors.New("no imggen.* capabilities are known to the server")
	}
	var names []string
	for _, c := range caps {
		names = append(names, c.Base+" (offline)")
	}
	return "", fmt.Errorf("no imggen.* capability is online; known: %s", strings.Join(names, ", "))
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
	timeout := fs.Duration("timeout", 5*time.Minute, "give up waiting after this long")
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
		if capName, err = pickCapability(caps); err != nil {
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
	var started startJobResponse
	if err := doJSON("POST", base+"/api/images/jobs", cfg.Token, req, &started); err != nil {
		return err
	}
	fmt.Printf("Job: %s\n", started.JobID)

	deadline := time.Now().Add(*timeout)
	lastStage := ""
	for {
		var p pollResponse
		pollURL := base + "/api/images/jobs/" + url.PathEscape(started.JobID) + "/poll"
		if err := doJSON("POST", pollURL, cfg.Token, nil, &p); err != nil {
			return err
		}
		if p.Stage != nil && *p.Stage != "" && *p.Stage != lastStage {
			lastStage = *p.Stage
			fmt.Printf("Stage: %s\n", lastStage)
		}
		if isTerminal(p.Status) {
			return finishJob(base, cfg.Token, &p, *out)
		}
		if time.Now().Add(pollInterval).After(deadline) {
			return fmt.Errorf("timed out after %s (job %s is still %s on the server)", *timeout, started.JobID, p.Status)
		}
		time.Sleep(pollInterval)
	}
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
