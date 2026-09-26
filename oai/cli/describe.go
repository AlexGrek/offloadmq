package main

import (
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Same default as DescribeImagePage.tsx.
const defaultDescribePrompt = `Describe this image in detail. Use the following rules:
1. Describe main subject or person visually, do not use general words like "person", mention gender, age, body shape, skin color, race, hair, what person is wearing, pose, significant visual details.
2. Describe what the subject is doing, what is going on around, what is on background.
3. Describe atmosphere, dominant colors, lighting, weather, style.

Write one paragraph, no numeration, 6 sentences max.`

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
	JobID     string  `json:"job_id"`
	Status    string  `json:"status"`
	Result    *string `json:"result"`
	Stage     *string `json:"stage"`
	Error     *string `json:"error"`
	CreatedAt *string `json:"created_at"`
}

func (j describeJob) progressState() jobProgressState {
	stage := ""
	if j.Stage != nil {
		stage = *j.Stage
	}
	return jobProgressState{
		Status:      j.Status,
		Stage:       stage,
		SubmittedAt: j.CreatedAt,
	}
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

type describeRun struct {
	index   int
	path    string
	started startJobResponse
}

// cmdImageDescribe uploads each image and prints the vision model's descriptions
// to stdout. Every input is a separate job. Progress goes to stderr so the
// output can be piped.
func cmdImageDescribe(args []string) error {
	fs := flag.NewFlagSet("image describe", flag.ContinueOnError)
	prompt := fs.String("prompt", defaultDescribePrompt, "question/instruction for the model")
	capability := fs.String("capability", "", "vision LLM capability (default: first online)")
	out := fs.String("o", "", "also write descriptions to this file (_2, _3, ... for multiple inputs)")
	timeout := timeoutFlag(fs)
	showProgress := progressFlag(fs)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		return errors.New(`usage: oai image describe <image-file> [image-file ...] [-prompt "..."] [-capability llm.X] [-o out.txt]`)
	}
	for _, path := range rest {
		info, err := os.Stat(path)
		if err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		if info.IsDir() {
			return fmt.Errorf("%s: is a directory", path)
		}
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

	describePrompt := strings.TrimSpace(*prompt)
	if describePrompt == "" {
		describePrompt = defaultDescribePrompt
	}

	runs := make([]describeRun, 0, len(rest))
	var batchErrors []error
	for i, path := range rest {
		if len(rest) > 1 {
			fmt.Fprintf(os.Stderr, "Input %d/%d: %s\n", i+1, len(rest), path)
		}
		var up uploadResponse
		if err := uploadFile(base+"/api/images/upload", cfg.Token, path, &up); err != nil {
			batchErrors = append(batchErrors, fmt.Errorf("%s: upload: %w", path, err))
			continue
		}

		req := describeStartRequest{
			Capability: capName,
			Prompt:     describePrompt,
			ImageID:    up.ImageID,
		}
		var started startJobResponse
		if err := doJSON("POST", base+"/api/describe/jobs", cfg.Token, req, &started); err != nil {
			batchErrors = append(batchErrors, fmt.Errorf("%s: submit: %w", path, err))
			continue
		}
		runs = append(runs, describeRun{index: i, path: path, started: started})
		if len(rest) == 1 {
			fmt.Fprintf(os.Stderr, "Job: %s\n", started.JobID)
		} else {
			fmt.Fprintf(os.Stderr, "Job %d/%d: %s\n", i+1, len(rest), started.JobID)
		}
	}

	for _, run := range runs {
		var job describeJob
		pollURL := base + "/api/describe/jobs/" + url.PathEscape(run.started.JobID) + "/poll"
		err := waitForJob(os.Stderr, run.started.JobID, *timeout, jobProgressOptions{
			Enabled:      *showProgress,
			Label:        filepath.Base(run.path),
			RunningLabel: "Analyzing",
		}, func() (jobProgressState, error) {
			if err := doJSON("POST", pollURL, cfg.Token, nil, &job); err != nil {
				return jobProgressState{}, err
			}
			return job.progressState(), nil
		})
		if err != nil {
			batchErrors = append(batchErrors, fmt.Errorf("%s (job %s): %w", run.path, run.started.JobID, err))
			continue
		}
		if job.Status != "completed" {
			msg := "no error message"
			if job.Error != nil && *job.Error != "" {
				msg = *job.Error
			}
			batchErrors = append(batchErrors, fmt.Errorf("%s (job %s): job %s: %s", run.path, run.started.JobID, job.Status, msg))
			continue
		}
		if job.Result == nil {
			batchErrors = append(batchErrors, fmt.Errorf("%s (job %s): job completed but returned no result", run.path, run.started.JobID))
			continue
		}
		if len(rest) > 1 {
			fmt.Printf("==> %s <==\n", run.path)
		}
		fmt.Println(*job.Result)
		if *out != "" {
			dest := indexedOutputPath(*out, run.index)
			if err := os.WriteFile(dest, []byte(*job.Result+"\n"), 0644); err != nil {
				batchErrors = append(batchErrors, fmt.Errorf("%s: save %s: %w", run.path, dest, err))
				continue
			}
			fmt.Fprintf(os.Stderr, "Saved %s\n", dest)
		}
	}
	return errors.Join(batchErrors...)
}
