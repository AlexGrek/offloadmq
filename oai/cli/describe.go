package main

import (
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"strings"
)

// Same default as DescribeImagePage.tsx.
const defaultDescribePrompt = "Describe this image in detail"

type describeCapabilitiesResponse struct {
	Capabilities []capabilityInfo `json:"capabilities"`
}

type uploadResponse struct {
	ImageID string `json:"image_id"`
}

type describeStartRequest struct {
	Capability string `json:"capability"`
	Prompt     string `json:"prompt"`
	ImageID    string `json:"image_id"`
}

type describeJob struct {
	JobID  string  `json:"job_id"`
	Status string  `json:"status"`
	Result *string `json:"result"`
	Stage  *string `json:"stage"`
	Error  *string `json:"error"`
}

func fetchDescribeCapabilities(cfg *Config) ([]capabilityInfo, error) {
	var resp describeCapabilitiesResponse
	err := doJSON("GET", cfg.serverURL("")+"/api/describe/capabilities", cfg.Token, nil, &resp)
	return resp.Capabilities, err
}

func cmdImageDescribeCapabilities(args []string) error {
	fs := flag.NewFlagSet("image describe-capabilities", flag.ContinueOnError)
	if _, err := parseInterleaved(fs, args); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	caps, err := fetchDescribeCapabilities(cfg)
	if err != nil {
		return err
	}
	return printCapabilities(caps, "vision LLM")
}

// cmdImageDescribe uploads an image and prints the vision model's description
// to stdout. Progress goes to stderr so the output can be piped.
func cmdImageDescribe(args []string) error {
	fs := flag.NewFlagSet("image describe", flag.ContinueOnError)
	prompt := fs.String("prompt", defaultDescribePrompt, "question/instruction for the model")
	capability := fs.String("capability", "", "vision LLM capability (default: first online)")
	out := fs.String("o", "", "also write the description to this file")
	timeout := timeoutFlag(fs)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New(`usage: oai image describe <image-file> [-prompt "..."] [-capability llm.X] [-o out.txt]`)
	}
	path := rest[0]
	if _, err := os.Stat(path); err != nil {
		return err
	}

	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	base := cfg.serverURL("")

	capName := *capability
	if capName == "" {
		caps, err := fetchDescribeCapabilities(cfg)
		if err != nil {
			return err
		}
		if capName, err = pickCapability(caps, "vision", "vision LLM"); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "Using capability: %s (auto-selected, online)\n", capName)
	}

	var up uploadResponse
	if err := uploadFile(base+"/api/images/upload", cfg.Token, path, &up); err != nil {
		return fmt.Errorf("upload: %w", err)
	}

	req := describeStartRequest{
		Capability: capName,
		Prompt:     strings.TrimSpace(*prompt),
		ImageID:    up.ImageID,
	}
	if req.Prompt == "" {
		req.Prompt = defaultDescribePrompt
	}
	var started startJobResponse
	if err := doJSON("POST", base+"/api/describe/jobs", cfg.Token, req, &started); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Job: %s\n", started.JobID)

	var job describeJob
	pollURL := base + "/api/describe/jobs/" + url.PathEscape(started.JobID) + "/poll"
	err = waitForJob(os.Stderr, started.JobID, *timeout, func() (string, string, error) {
		if err := doJSON("POST", pollURL, cfg.Token, nil, &job); err != nil {
			return "", "", err
		}
		stage := ""
		if job.Stage != nil {
			stage = *job.Stage
		}
		return job.Status, stage, nil
	})
	if err != nil {
		return err
	}
	if job.Status != "completed" {
		msg := "no error message"
		if job.Error != nil && *job.Error != "" {
			msg = *job.Error
		}
		return fmt.Errorf("job %s: %s", job.Status, msg)
	}
	if job.Result == nil {
		return errors.New("job completed but returned no result")
	}
	fmt.Println(*job.Result)
	if *out != "" {
		if err := os.WriteFile(*out, []byte(*job.Result+"\n"), 0644); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "Saved %s\n", *out)
	}
	return nil
}
