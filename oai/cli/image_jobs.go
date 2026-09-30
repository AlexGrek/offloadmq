package main

import (
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"strings"
	"text/tabwriter"
	"time"
)

// Image-job history management — the web UI's Images history sidebar actions:
// GET /api/images/jobs (the 50 newest), POST …/{id}/cancel, POST …/{id}/retry,
// DELETE …/{id}.

// imageCancelResponse mirrors CancelJobResponse in backend/src/routes/images.rs.
type imageCancelResponse struct {
	JobID   string `json:"job_id"`
	Status  string `json:"status"`
	Message string `json:"message"`
}

func cmdImageJobs(args []string) error {
	fs := flag.NewFlagSet("image jobs", flag.ContinueOnError)
	status := fs.String("status", "", "only jobs with this status (comma-separated, e.g. failed,canceled)")
	active := fs.Bool("active", false, "only jobs that have not finished yet")
	idsOnly := fs.Bool("ids", false, "print bare job IDs, one per line (e.g. for image cancel / delete)")
	asJSON := fs.Bool("json", false, "print the raw JSON list")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 0 {
		return errors.New("usage: oai image jobs [-status S[,S]] [-active] [-ids] [-json]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var jobs []imageJobDetail
	if err := doJSON("GET", cfg.serverURL("")+"/api/images/jobs", cfg.Token, nil, &jobs); err != nil {
		return err
	}
	jobs = filterImageJobs(jobs, *status, *active)
	switch {
	case *asJSON:
		if jobs == nil {
			jobs = []imageJobDetail{}
		}
		return printJSON(&jobs)
	case *idsOnly:
		for _, j := range jobs {
			fmt.Println(j.JobID)
		}
		return nil
	case len(jobs) == 0 && (*status != "" || *active):
		fmt.Println("No matching image jobs.")
		return nil
	case len(jobs) == 0:
		fmt.Println("No image jobs.")
		return nil
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "JOB ID\tSTATUS\tWORKFLOW\tCAPABILITY\tSUBMITTED\tOUT\tPROMPT")
	for _, j := range jobs {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%d\t%s\n", j.JobID, j.Status, j.Workflow, j.Capability,
			localTime(j.SubmittedAt), len(outputImageFiles(j.Files)), promptOneLine(j.Prompt, 60))
	}
	return w.Flush()
}

func filterImageJobs(jobs []imageJobDetail, status string, active bool) []imageJobDetail {
	var want map[string]bool
	if status = strings.TrimSpace(status); status != "" {
		want = map[string]bool{}
		for _, s := range strings.Split(status, ",") {
			want[strings.TrimSpace(s)] = true
		}
	}
	var out []imageJobDetail
	for _, j := range jobs {
		if (want == nil || want[j.Status]) && (!active || !isTerminal(j.Status)) {
			out = append(out, j)
		}
	}
	return out
}

func localTime(raw *string) string {
	if raw == nil || *raw == "" {
		return "-"
	}
	t, err := time.Parse(time.RFC3339Nano, *raw)
	if err != nil {
		return *raw
	}
	return t.Local().Format("2006-01-02 15:04")
}

func cmdImageCancel(args []string) error {
	fs := flag.NewFlagSet("image cancel", flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		return errors.New("usage: oai image cancel <job-id> [job-id ...]")
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
		u := cfg.serverURL("") + "/api/images/jobs/" + url.PathEscape(id) + "/cancel"
		if err := doJSON("POST", u, cfg.Token, nil, &resp); err != nil {
			errs = append(errs, fmt.Errorf("cancel %s: %w", id, err))
			continue
		}
		fmt.Printf("%s: %s (%s)\n", resp.JobID, resp.Status, resp.Message)
	}
	return errors.Join(errs...)
}

// cmdImageRetry resubmits a finished job with its stored settings — a new job ID
// — then waits and downloads like generate (or, with --no-wait, prints only the
// new ID, keeping generate's detached stdout contract).
func cmdImageRetry(args []string) error {
	fs := flag.NewFlagSet("image retry", flag.ContinueOnError)
	out := fs.String("o", "output.jpg", "output file (extra images get _2, _3, ... suffixes)")
	noWait := fs.Bool("no-wait", false, "resubmit without waiting; print the new job ID to stdout")
	timeout := timeoutFlag(fs)
	showProgress := progressFlag(fs)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai image retry <job-id> [-o output.jpg] [--no-wait] [--progress=false] [-t|-timeout 5m]")
	}
	if err := requireIDs(rest); err != nil {
		return err
	}
	if *noWait && flagSet(fs, "o") {
		return errors.New("-o cannot be used with --no-wait; download later with `oai image download <job-id> -o output.jpg`")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	base := cfg.serverURL("")
	var started startJobResponse
	u := base + "/api/images/jobs/" + url.PathEscape(rest[0]) + "/retry"
	if err := doJSON("POST", u, cfg.Token, nil, &started); err != nil {
		return err
	}
	if *noWait {
		fmt.Println(started.JobID)
		return nil
	}
	fmt.Printf("Job: %s (retry of %s)\n", started.JobID, rest[0])
	p, err := waitForImageJob(base, cfg.Token, started.JobID, "Image", *timeout, *showProgress)
	if err != nil {
		return err
	}
	return finishJob(base, cfg.Token, p, *out, 0, false)
}

// cmdImageDelete removes jobs from history, like the sidebar's delete button.
func cmdImageDelete(args []string) error {
	fs := flag.NewFlagSet("image delete", flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		return errors.New("usage: oai image delete <job-id> [job-id ...]")
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
		if err := doJSON("DELETE", cfg.serverURL("")+"/api/images/jobs/"+url.PathEscape(id), cfg.Token, nil, nil); err != nil {
			errs = append(errs, fmt.Errorf("delete %s: %w", id, err))
			continue
		}
		fmt.Printf("Deleted %s\n", id)
	}
	return errors.Join(errs...)
}

// flagSet reports whether name was given explicitly (for flags whose default is
// non-empty, like -o).
func flagSet(fs *flag.FlagSet, name string) bool {
	found := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == name {
			found = true
		}
	})
	return found
}

// requireIDs rejects blank IDs (e.g. an empty $(…) expansion), which would
// otherwise hit the collection URL instead of a job.
func requireIDs(ids []string) error {
	for _, id := range ids {
		if strings.TrimSpace(id) == "" {
			return errors.New("empty job ID")
		}
	}
	return nil
}
