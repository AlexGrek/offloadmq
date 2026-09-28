package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"text/tabwriter"
	"time"
)

// Same default/range as NudeDetectorPage.tsx / nudeDetectLabels.ts and the
// backend's start_job validation (threshold must be 0.05..0.95).
const (
	defaultNudeThreshold = 0.25
	nudeThresholdMin     = 0.05
	nudeThresholdMax     = 0.95
)

type nudeBox struct {
	X1 float64 `json:"x1"`
	Y1 float64 `json:"y1"`
	X2 float64 `json:"x2"`
	Y2 float64 `json:"y2"`
}

type nudeDetection struct {
	Label      string  `json:"label"`
	Confidence float64 `json:"confidence"`
	Box        nudeBox `json:"box"`
}

type nudeImageResult struct {
	File           string          `json:"file"`
	Detections     []nudeDetection `json:"detections"`
	DetectionCount int             `json:"detection_count"`
	Error          string          `json:"error,omitempty"`
}

type nudeResultPayload struct {
	Model           string            `json:"model"`
	Threshold       float64           `json:"threshold"`
	ImagesProcessed int               `json:"images_processed"`
	Results         []nudeImageResult `json:"results"`
}

type nudeJob struct {
	JobID         string             `json:"job_id"`
	Status        string             `json:"status"`
	Threshold     float64            `json:"threshold"`
	InputImageID  *string            `json:"input_image_id"`
	Result        *nudeResultPayload `json:"result"`
	Stage         *string            `json:"stage"`
	Error         *string            `json:"error"`
	OffloadCap    *string            `json:"offload_cap"`
	OffloadTaskID *string            `json:"offload_task_id"`
	CreatedAt     string             `json:"created_at"`
	UpdatedAt     string             `json:"updated_at"`
}

func (j nudeJob) progressState() jobProgressState {
	stage := ""
	if j.Stage != nil {
		stage = *j.Stage
	}
	createdAt := j.CreatedAt
	return jobProgressState{
		Status:      j.Status,
		Stage:       stage,
		SubmittedAt: &createdAt,
	}
}

func nudeTotalDetections(result *nudeResultPayload) int {
	total := 0
	for _, r := range result.Results {
		total += r.DetectionCount
	}
	return total
}

type nudeActiveRunner struct {
	UID         string  `json:"uid"`
	UIDShort    string  `json:"uid_short"`
	DisplayName *string `json:"display_name"`
	Tier        uint8   `json:"tier"`
	Capacity    uint32  `json:"capacity"`
	LastContact *string `json:"last_contact"`
}

type nudeAvailability struct {
	Available     bool               `json:"available"`
	Capability    string             `json:"capability"`
	ActiveRunners []nudeActiveRunner `json:"active_runners"`
	RunnersError  *string            `json:"runners_error"`
}

type nudeStartRequest struct {
	ImageID   string  `json:"image_id"`
	Threshold float64 `json:"threshold"`
}

type nudeCancelResponse struct {
	JobID   string `json:"job_id"`
	Status  string `json:"status"`
	Message string `json:"message"`
}

func cmdNude(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: oai nude <scan|availability|jobs|job|poll|cancel|retry|delete> ...")
	}
	switch args[0] {
	case "scan":
		return cmdNudeScan(args[1:])
	case "availability":
		return cmdNudeAvailability(args[1:])
	case "jobs":
		return cmdNudeJobs(args[1:])
	case "job":
		return cmdNudeJob(args[1:])
	case "poll":
		return cmdNudePoll(args[1:])
	case "cancel":
		return cmdNudeCancel(args[1:])
	case "retry":
		return cmdNudeRetry(args[1:])
	case "delete":
		return cmdNudeDelete(args[1:])
	default:
		return fmt.Errorf("unknown nude command %q (want scan, availability, jobs, job, poll, cancel, retry or delete)", args[0])
	}
}

func fetchNudeAvailability(cfg *Config) (nudeAvailability, error) {
	var resp nudeAvailability
	err := doJSON("GET", cfg.serverURL("")+"/api/nude-detect/availability", cfg.Token, nil, &resp)
	return resp, err
}

func cmdNudeAvailability(args []string) error {
	fs := flag.NewFlagSet("nude availability", flag.ContinueOnError)
	if _, err := parseInterleaved(fs, args); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	resp, err := fetchNudeAvailability(cfg)
	if err != nil {
		return err
	}
	status := "not available"
	if resp.Available {
		status = "online"
	}
	fmt.Printf("Capability: %s (%s)\n", resp.Capability, status)
	if resp.RunnersError != nil && *resp.RunnersError != "" {
		fmt.Printf("Runners error: %s\n", *resp.RunnersError)
	}
	if len(resp.ActiveRunners) == 0 {
		fmt.Println("No active runners.")
		return nil
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "UID\tNAME\tTIER\tCAPACITY\tLAST CONTACT")
	for _, r := range resp.ActiveRunners {
		name := ""
		if r.DisplayName != nil {
			name = *r.DisplayName
		}
		lastContact := ""
		if r.LastContact != nil {
			lastContact = *r.LastContact
		}
		fmt.Fprintf(w, "%s\t%s\t%d\t%d\t%s\n", r.UIDShort, name, r.Tier, r.Capacity, lastContact)
	}
	return w.Flush()
}

func cmdNudeJobs(args []string) error {
	fs := flag.NewFlagSet("nude jobs", flag.ContinueOnError)
	if _, err := parseInterleaved(fs, args); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var jobs []nudeJob
	if err := doJSON("GET", cfg.serverURL("")+"/api/nude-detect/jobs", cfg.Token, nil, &jobs); err != nil {
		return err
	}
	if len(jobs) == 0 {
		fmt.Println("No nude-detect jobs.")
		return nil
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "JOB ID\tSTATUS\tTHRESHOLD\tDETECTIONS\tCREATED")
	for _, j := range jobs {
		detections := "-"
		if j.Result != nil {
			detections = strconv.Itoa(nudeTotalDetections(j.Result))
		}
		fmt.Fprintf(w, "%s\t%s\t%.2f\t%s\t%s\n", j.JobID, j.Status, j.Threshold, detections, j.CreatedAt)
	}
	return w.Flush()
}

func cmdNudeJob(args []string) error {
	fs := flag.NewFlagSet("nude job", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print the raw job JSON")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai nude job <job-id> [-json]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var job nudeJob
	u := cfg.serverURL("") + "/api/nude-detect/jobs/" + url.PathEscape(rest[0])
	if err := doJSON("GET", u, cfg.Token, nil, &job); err != nil {
		return err
	}
	if *asJSON {
		return printJSON(&job)
	}
	printNudeJob(&job)
	return nil
}

func cmdNudePoll(args []string) error {
	fs := flag.NewFlagSet("nude poll", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print the raw job JSON")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai nude poll <job-id> [-json]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var job nudeJob
	u := cfg.serverURL("") + "/api/nude-detect/jobs/" + url.PathEscape(rest[0]) + "/poll"
	if err := doJSON("POST", u, cfg.Token, nil, &job); err != nil {
		return err
	}
	if *asJSON {
		return printJSON(&job)
	}
	printNudeJob(&job)
	return nil
}

func cmdNudeCancel(args []string) error {
	fs := flag.NewFlagSet("nude cancel", flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai nude cancel <job-id>")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var resp nudeCancelResponse
	u := cfg.serverURL("") + "/api/nude-detect/jobs/" + url.PathEscape(rest[0]) + "/cancel"
	if err := doJSON("POST", u, cfg.Token, nil, &resp); err != nil {
		return err
	}
	fmt.Printf("%s: %s (%s)\n", resp.JobID, resp.Status, resp.Message)
	return nil
}

func cmdNudeRetry(args []string) error {
	fs := flag.NewFlagSet("nude retry", flag.ContinueOnError)
	timeout := timeoutFlag(fs)
	showProgress := progressFlag(fs)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai nude retry <job-id> [--progress=false] [-t|-timeout 5m]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	base := cfg.serverURL("")
	var started startJobResponse
	u := base + "/api/nude-detect/jobs/" + url.PathEscape(rest[0]) + "/retry"
	if err := doJSON("POST", u, cfg.Token, nil, &started); err != nil {
		return err
	}
	fmt.Printf("Job: %s\n", started.JobID)
	return waitAndPrintNudeJob(base, cfg.Token, started.JobID, *timeout, *showProgress)
}

func cmdNudeDelete(args []string) error {
	fs := flag.NewFlagSet("nude delete", flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai nude delete <job-id>")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	u := cfg.serverURL("") + "/api/nude-detect/jobs/" + url.PathEscape(rest[0])
	if err := doJSON("DELETE", u, cfg.Token, nil, nil); err != nil {
		return err
	}
	fmt.Printf("Deleted %s\n", rest[0])
	return nil
}

type nudeScanRun struct {
	index   int
	path    string
	started startJobResponse
}

// cmdNudeScan uploads each image and runs NudeNet detection with a tunable
// confidence threshold, one job per image (mirrors NudeDetectorPage.tsx, which
// also submits one job per pending image). Progress goes to stderr so
// -json/-o output stays pipe-safe.
func cmdNudeScan(args []string) error {
	fs := flag.NewFlagSet("nude scan", flag.ContinueOnError)
	threshold := fs.Float64("threshold", defaultNudeThreshold, "confidence threshold (0.05-0.95)")
	out := fs.String("o", "", "also write the raw JSON result to this file (_2, _3, ... for multiple inputs)")
	asJSON := fs.Bool("json", false, "print the raw JSON result instead of a summary")
	timeout := timeoutFlag(fs)
	showProgress := progressFlag(fs)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		return errors.New(`usage: oai nude scan <image-file> [image-file ...] [-threshold 0.25] [-json] [-o out.json]`)
	}
	if *threshold < nudeThresholdMin || *threshold > nudeThresholdMax {
		return fmt.Errorf("-threshold must be between %.2f and %.2f", nudeThresholdMin, nudeThresholdMax)
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

	runs := make([]nudeScanRun, 0, len(rest))
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
		req := nudeStartRequest{ImageID: up.ImageID, Threshold: *threshold}
		var started startJobResponse
		if err := doJSON("POST", base+"/api/nude-detect/jobs", cfg.Token, req, &started); err != nil {
			batchErrors = append(batchErrors, fmt.Errorf("%s: submit: %w", path, err))
			continue
		}
		runs = append(runs, nudeScanRun{index: i, path: path, started: started})
		if len(rest) == 1 {
			fmt.Fprintf(os.Stderr, "Job: %s\n", started.JobID)
		} else {
			fmt.Fprintf(os.Stderr, "Job %d/%d: %s\n", i+1, len(rest), started.JobID)
		}
	}

	for _, run := range runs {
		var job nudeJob
		pollURL := base + "/api/nude-detect/jobs/" + url.PathEscape(run.started.JobID) + "/poll"
		err := waitForJob(os.Stderr, run.started.JobID, *timeout, jobProgressOptions{
			Enabled:      *showProgress,
			Label:        filepath.Base(run.path),
			RunningLabel: "Scanning",
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
		if *asJSON {
			if err := printJSON(job.Result); err != nil {
				batchErrors = append(batchErrors, fmt.Errorf("%s: encode result: %w", run.path, err))
				continue
			}
		} else {
			printNudeResult(job.Result)
		}
		if *out != "" {
			data, err := json.MarshalIndent(job.Result, "", "  ")
			if err != nil {
				batchErrors = append(batchErrors, fmt.Errorf("%s: encode result: %w", run.path, err))
				continue
			}
			dest := indexedOutputPath(*out, run.index)
			if err := os.WriteFile(dest, append(data, '\n'), 0644); err != nil {
				batchErrors = append(batchErrors, fmt.Errorf("%s: save %s: %w", run.path, dest, err))
				continue
			}
			fmt.Fprintf(os.Stderr, "Saved %s\n", dest)
		}
	}
	return errors.Join(batchErrors...)
}

// waitAndPrintNudeJob polls jobID to completion and prints its details; used by
// retry, which (unlike scan) already has a job id and no local file to label.
func waitAndPrintNudeJob(base, token, jobID string, timeout time.Duration, showProgress bool) error {
	var job nudeJob
	pollURL := base + "/api/nude-detect/jobs/" + url.PathEscape(jobID) + "/poll"
	err := waitForJob(os.Stdout, jobID, timeout, jobProgressOptions{
		Enabled:      showProgress,
		Label:        "Scan",
		RunningLabel: "Scanning",
	}, func() (jobProgressState, error) {
		if err := doJSON("POST", pollURL, token, nil, &job); err != nil {
			return jobProgressState{}, err
		}
		return job.progressState(), nil
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
	printNudeJob(&job)
	return nil
}

func printNudeResult(result *nudeResultPayload) {
	for _, r := range result.Results {
		if r.Error != "" {
			fmt.Printf("%s: error: %s\n", r.File, r.Error)
			continue
		}
		if r.DetectionCount == 0 {
			fmt.Printf("%s: clean\n", r.File)
			continue
		}
		fmt.Printf("%s: %d detection(s)\n", r.File, r.DetectionCount)
		w := tabwriter.NewWriter(os.Stdout, 2, 0, 2, ' ', 0)
		fmt.Fprintln(w, "  LABEL\tCONFIDENCE")
		for _, d := range r.Detections {
			fmt.Fprintf(w, "  %s\t%.2f\n", d.Label, d.Confidence)
		}
		w.Flush()
	}
}

func printNudeJob(j *nudeJob) {
	fmt.Printf("Job:       %s\n", j.JobID)
	fmt.Printf("Status:    %s\n", j.Status)
	fmt.Printf("Threshold: %.2f\n", j.Threshold)
	if j.Stage != nil && *j.Stage != "" {
		fmt.Printf("Stage:     %s\n", *j.Stage)
	}
	if j.Error != nil && *j.Error != "" {
		fmt.Printf("Error:     %s\n", *j.Error)
	}
	fmt.Printf("Created:   %s\n", j.CreatedAt)
	fmt.Printf("Updated:   %s\n", j.UpdatedAt)
	if j.Result == nil {
		return
	}
	fmt.Println()
	printNudeResult(j.Result)
}

func printJSON(v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(data))
	return nil
}
