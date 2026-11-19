package main

import (
	"context"
	"embed"
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

// The default program files mirror oai/frontend/src/lib/langgraph/defaults.ts;
// langgraph_test.go fails when they drift apart.
//
//go:embed langgraph_defaults/*
var langgraphDefaults embed.FS

const (
	defaultLanggraphSystem  = "You are a helpful assistant. Use tools when useful.\n\nAvailable tools:\n{tools}"
	defaultLanggraphUser    = "Say hello and explain what you can do."
	defaultLanggraphRuntime = 600
	runtimeCapPrefix        = "llm-runtime."
)

var langgraphFiles = []string{"main.py", "tools.py", "pyproject.toml"}

type langgraphOutput struct {
	DataFile *string  `json:"data_file,omitempty"`
	Files    []string `json:"files"`
}

// langgraphRequest mirrors services/langgraph.rs StartJobParams (deny_unknown_fields).
type langgraphRequest struct {
	Capability   string            `json:"capability"`
	Models       map[string]string `json:"models"`
	MainPy       string            `json:"main_py"`
	ToolsPy      string            `json:"tools_py"`
	Pyproject    string            `json:"pyproject"`
	SystemPrompt string            `json:"system_prompt"`
	UserPrompt   string            `json:"user_prompt"`
	AllowedTools *[]string         `json:"allowed_tools"` // null = all, [] = none
	Resources    json.RawMessage   `json:"resources"`
	Output       langgraphOutput   `json:"output"`
	RuntimeSecs  int               `json:"runtime_secs"`
}

type langgraphArtifact struct {
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
}

type langgraphJob struct {
	JobID         string              `json:"job_id"`
	Status        string              `json:"status"`
	Capability    string              `json:"capability"`
	Prompt        string              `json:"prompt"`
	Request       *langgraphRequest   `json:"request,omitempty"`
	Result        map[string]any      `json:"result"`
	Artifacts     []langgraphArtifact `json:"artifacts"`
	Stage         *string             `json:"stage"`
	Error         *string             `json:"error"`
	OffloadCap    *string             `json:"offload_cap"`
	OffloadTaskID *string             `json:"offload_task_id"`
	CreatedAt     string              `json:"created_at"`
	UpdatedAt     string              `json:"updated_at"`
}

func (j langgraphJob) progressState() jobProgressState {
	stage := ""
	if j.Stage != nil {
		stage = *j.Stage
	}
	created := j.CreatedAt
	return jobProgressState{Status: j.Status, Stage: stage, SubmittedAt: &created}
}

// roleFlag collects repeated -role name=model pairs.
type roleFlag map[string]string

func (r roleFlag) String() string { return "" }
func (r roleFlag) Set(s string) error {
	name, model, ok := strings.Cut(s, "=")
	name, model = strings.TrimSpace(name), strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(model), runtimeCapPrefix))
	if !ok || name == "" || model == "" {
		return fmt.Errorf("want name=model, got %q", s)
	}
	r[name] = model
	return nil
}

func cmdLanggraph(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: oai langgraph <capabilities|init|run|jobs|job|poll|cancel|retry|delete|download> ...")
	}
	switch args[0] {
	case "capabilities":
		return cmdLanggraphCapabilities(args[1:])
	case "init":
		return cmdLanggraphInit(args[1:])
	case "run":
		return cmdLanggraphRun(args[1:])
	case "jobs":
		return cmdLanggraphJobs(args[1:])
	case "job":
		return cmdLanggraphJob(args[1:], false)
	case "poll":
		return cmdLanggraphJob(args[1:], true)
	case "cancel":
		return cmdLanggraphCancel(args[1:])
	case "retry":
		return cmdLanggraphRetry(args[1:])
	case "delete":
		return cmdLanggraphDelete(args[1:])
	case "download":
		return cmdLanggraphDownload(args[1:])
	default:
		return fmt.Errorf("unknown langgraph command %q (want capabilities, init, run, jobs, job, poll, cancel, retry, delete or download)", args[0])
	}
}

func langgraphURL(cfg *Config, parts ...string) string {
	u := cfg.serverURL("") + "/api/langgraph"
	for _, p := range parts {
		u += "/" + url.PathEscape(p)
	}
	return u
}

// runtimeCapability is a row of GET /api/langgraph/capabilities. The endpoint
// lists only online runtime capabilities, so presence means online (there is no
// online/usage field, unlike the image capability lists).
type runtimeCapability struct {
	Base string   `json:"base"`
	Tags []string `json:"tags"`
	Raw  string   `json:"raw"`
}

func fetchLanggraphCapabilities(cfg *Config) ([]runtimeCapability, error) {
	var caps []runtimeCapability
	err := doJSON("GET", langgraphURL(cfg, "capabilities"), cfg.Token, nil, &caps)
	return caps, err
}

func cmdLanggraphCapabilities(args []string) error {
	fs := flag.NewFlagSet("langgraph capabilities", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print raw JSON")
	if _, err := parseInterleaved(fs, args); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	caps, err := fetchLanggraphCapabilities(cfg)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(caps)
	}
	if len(caps) == 0 {
		fmt.Println("No llm-runtime capabilities are online. Enable the LLM runtime and approve each model on a runner.")
		return nil
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "CAPABILITY\tTAGS")
	for _, c := range caps {
		fmt.Fprintf(w, "%s\t%s\n", c.Base, strings.Join(c.Tags, ";"))
	}
	return w.Flush()
}

// cmdLanggraphInit writes the default program (main.py, tools.py, pyproject.toml)
// to a directory so it can be edited and passed back with `run -dir`.
func cmdLanggraphInit(args []string) error {
	fs := flag.NewFlagSet("langgraph init", flag.ContinueOnError)
	force := fs.Bool("force", false, "overwrite existing files")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai langgraph init <dir> [-force]")
	}
	dir := rest[0]
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, name := range langgraphFiles {
		dest := filepath.Join(dir, name)
		if _, err := os.Stat(dest); err == nil && !*force {
			return fmt.Errorf("%s already exists (use -force to overwrite)", dest)
		}
	}
	for _, name := range langgraphFiles {
		data, err := langgraphDefaults.ReadFile("langgraph_defaults/" + name)
		if err != nil {
			return err
		}
		dest := filepath.Join(dir, name)
		if err := os.WriteFile(dest, data, 0o644); err != nil {
			return err
		}
		fmt.Println("Wrote", dest)
	}
	return nil
}

// textOrFile resolves a -x TEXT / -x-file PATH flag pair; ok is false when neither was given.
func textOrFile(text, file *string, label string) (string, bool, error) {
	switch {
	case *file != "" && *text != "":
		return "", false, fmt.Errorf("use either -%s or -%s-file, not both", label, label)
	case *file != "":
		data, err := os.ReadFile(*file)
		if err != nil {
			return "", false, err
		}
		return string(data), true, nil
	case *text != "":
		return *text, true, nil
	}
	return "", false, nil
}

// programFile returns an explicit -main/-tools/-pyproject path, else <dir>/<name>,
// else the embedded default.
func programFile(explicit, dir, name string) (string, error) {
	path := explicit
	if path == "" && dir != "" {
		path = filepath.Join(dir, name)
	}
	if path != "" {
		data, err := os.ReadFile(path)
		// A file missing from -dir falls back to the default; an explicit path must exist.
		if err == nil || explicit != "" || !errors.Is(err, os.ErrNotExist) {
			return string(data), err
		}
	}
	data, err := langgraphDefaults.ReadFile("langgraph_defaults/" + name)
	return string(data), err
}

// parseAllowedTools turns "all" / "none" / "a,b" into the wire form (nil, [], names).
func parseAllowedTools(v string) (*[]string, error) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "all":
		return nil, nil
	case "none":
		none := []string{}
		return &none, nil
	}
	names := []string{}
	for _, n := range strings.Split(v, ",") {
		if n = strings.TrimSpace(n); n != "" {
			names = append(names, n)
		}
	}
	if len(names) == 0 {
		return nil, errors.New("-allowed-tools: want all, none or a comma-separated list")
	}
	return &names, nil
}

func cmdLanggraphRun(args []string) error {
	fs := flag.NewFlagSet("langgraph run", flag.ContinueOnError)
	dir := fs.String("dir", "", "directory with main.py, tools.py, pyproject.toml (missing files use the defaults)")
	mainPath := fs.String("main", "", "main.py path (overrides -dir)")
	toolsPath := fs.String("tools", "", "tools.py path (overrides -dir)")
	pyprojectPath := fs.String("pyproject", "", "pyproject.toml path (overrides -dir)")
	system := fs.String("system", "", "system prompt (supports {tools})")
	systemFile := fs.String("system-file", "", "read the system prompt from a file")
	user := fs.String("user", "", "user prompt (same as the positional argument)")
	userFile := fs.String("user-file", "", "read the user prompt from a file")
	capability := fs.String("capability", "", "llm-runtime.<model> to run on (default: first online)")
	model := fs.String("model", "", "primary model name (same as -capability llm-runtime.<model>)")
	roles := roleFlag{}
	fs.Var(roles, "role", "named model role name=model (repeatable; local_llm(\"name\") in main.py)")
	allowed := fs.String("allowed-tools", "all", "all, none, or comma-separated tool names")
	resources := fs.String("resources", "", "resources JSON, or @file")
	dataFile := fs.String("data-file", "result.json", "JSON data file the program writes (empty = none)")
	var files optionList
	fs.Var(&files, "file", "output file the program writes (repeatable, relative path)")
	runtime := fs.Int("runtime", defaultLanggraphRuntime, "runtime limit in seconds (1-3600)")
	out := fs.String("o", "", "directory to save artifacts into when the run completes")
	noWait := fs.Bool("no-wait", false, "submit and print only the job ID")
	asJSON := fs.Bool("json", false, "print the final job as JSON")
	timeout := timeoutFlag(fs)
	showProgress := progressFlag(fs)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) > 1 {
		return errors.New(`usage: oai langgraph run ["user prompt"] [-dir D] [-system T] [-model M] [-role r=m] [-allowed-tools all|none|a,b] [-o dir] [--no-wait]`)
	}
	if *noWait && *out != "" {
		return errors.New("-o cannot be combined with --no-wait; use `oai langgraph download <job-id> -o dir` later")
	}

	outFiles := append([]string{}, files...) // never null on the wire
	req := langgraphRequest{Models: roles, RuntimeSecs: *runtime, Output: langgraphOutput{Files: outFiles}}
	if *dataFile != "" {
		req.Output.DataFile = dataFile
	}
	for _, p := range []struct {
		explicit, name string
		dst            *string
	}{
		{*mainPath, "main.py", &req.MainPy},
		{*toolsPath, "tools.py", &req.ToolsPy},
		{*pyprojectPath, "pyproject.toml", &req.Pyproject},
	} {
		if *p.dst, err = programFile(p.explicit, *dir, p.name); err != nil {
			return err
		}
	}
	req.SystemPrompt = defaultLanggraphSystem
	if v, ok, err := textOrFile(system, systemFile, "system"); err != nil {
		return err
	} else if ok {
		req.SystemPrompt = v
	}
	req.UserPrompt = defaultLanggraphUser
	if len(rest) == 1 {
		if *user != "" || *userFile != "" {
			return errors.New("give the user prompt either positionally or with -user/-user-file")
		}
		req.UserPrompt = rest[0]
	} else if v, ok, err := textOrFile(user, userFile, "user"); err != nil {
		return err
	} else if ok {
		req.UserPrompt = v
	}
	if req.AllowedTools, err = parseAllowedTools(*allowed); err != nil {
		return err
	}
	req.Resources = json.RawMessage("{}")
	if r := strings.TrimSpace(*resources); r != "" {
		if strings.HasPrefix(r, "@") {
			data, err := os.ReadFile(r[1:])
			if err != nil {
				return err
			}
			r = string(data)
		}
		if !json.Valid([]byte(r)) {
			return errors.New("-resources is not valid JSON")
		}
		req.Resources = json.RawMessage(r)
	}

	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	if req.Capability, err = resolveLanggraphCapability(cfg, *capability, *model, *noWait); err != nil {
		return err
	}

	var started startJobResponse
	if err := doJSON("POST", langgraphURL(cfg, "jobs"), cfg.Token, req, &started); err != nil {
		return err
	}
	if *noWait {
		fmt.Println(started.JobID)
		return nil
	}
	fmt.Fprintf(os.Stderr, "Job: %s\n", started.JobID)
	return finishLanggraphRun(cfg, started.JobID, *timeout, *showProgress, *asJSON, *out)
}

// resolveLanggraphCapability picks -capability / -model, else the first online
// runtime capability. Informational output goes to stderr (stdout is the job ID with --no-wait
// and the program's answer otherwise).
func resolveLanggraphCapability(cfg *Config, capability, model string, quiet bool) (string, error) {
	if capability != "" && model != "" {
		return "", errors.New("use either -capability or -model, not both")
	}
	if model != "" {
		capability = runtimeCapPrefix + strings.TrimPrefix(model, runtimeCapPrefix)
	}
	if capability != "" {
		if !strings.HasPrefix(capability, runtimeCapPrefix) {
			capability = runtimeCapPrefix + capability
		}
		return capability, nil
	}
	caps, err := fetchLanggraphCapabilities(cfg)
	if err != nil {
		return "", err
	}
	if len(caps) == 0 {
		return "", errors.New("no llm-runtime capability is online (enable the LLM runtime and approve a model on a runner)")
	}
	if !quiet {
		fmt.Fprintf(os.Stderr, "Using capability %s\n", caps[0].Base)
	}
	return caps[0].Base, nil
}

// waitForLanggraphJob polls until terminal (progress on stderr) and returns the last state.
func waitForLanggraphJob(cfg *Config, jobID string, timeout time.Duration, showProgress bool) (*langgraphJob, error) {
	var job langgraphJob
	pollURL := langgraphURL(cfg, "jobs", jobID, "poll")
	err := waitForJob(os.Stderr, jobID, timeout, jobProgressOptions{
		Enabled:      showProgress,
		Label:        "LangGraph",
		RunningLabel: "Running",
	}, func(ctx context.Context) (jobProgressState, error) {
		if err := doJSONContext(ctx, "POST", pollURL, cfg.Token, nil, &job); err != nil {
			return jobProgressState{}, err
		}
		return job.progressState(), nil
	})
	return &job, err
}

func resultString(result map[string]any, key string) string {
	s, _ := result[key].(string)
	return s
}

// finishLanggraphRun waits for the job, prints the result and optionally saves
// artifacts. The program's answer is the only thing on stdout (progress, job id
// and diagnostics go to stderr), so `oai langgraph run ... > answer.txt` works.
func finishLanggraphRun(cfg *Config, jobID string, timeout time.Duration, showProgress, asJSON bool, outDir string) error {
	job, err := waitForLanggraphJob(cfg, jobID, timeout, showProgress)
	if err != nil {
		return err
	}
	if asJSON {
		if err := printJSON(job); err != nil {
			return err
		}
	} else if job.Result != nil {
		text := resultString(job.Result, "text")
		if text == "" {
			text = resultString(job.Result, "stdout")
		}
		fmt.Print(text)
		if text != "" && !strings.HasSuffix(text, "\n") {
			fmt.Println()
		}
		if e := resultString(job.Result, "stderr"); e != "" {
			fmt.Fprintf(os.Stderr, "--- stderr ---\n%s\n", strings.TrimRight(e, "\n"))
		}
		if data, ok := job.Result["data"]; ok {
			enc, _ := json.Marshal(data)
			fmt.Fprintf(os.Stderr, "Data: %s\n", enc)
		}
	}
	if job.Status != "completed" {
		msg := "no error message"
		if job.Error != nil && *job.Error != "" {
			msg = *job.Error
		}
		return fmt.Errorf("job %s %s: %s", job.JobID, job.Status, msg)
	}
	if outDir != "" {
		return downloadLanggraphArtifacts(cfg, job, outDir)
	}
	for i, a := range job.Artifacts {
		fmt.Fprintf(os.Stderr, "Artifact %d: %s (%d bytes) - save with: oai langgraph download %s\n", i, a.Filename, a.SizeBytes, job.JobID)
	}
	return nil
}

func downloadLanggraphArtifacts(cfg *Config, job *langgraphJob, dir string) error {
	if job.Status != "completed" {
		return fmt.Errorf("job %s is %s; artifacts exist only for completed runs", job.JobID, job.Status)
	}
	if len(job.Artifacts) == 0 {
		fmt.Fprintln(os.Stderr, "No artifacts declared for this run.")
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	var errs []error
	for i, a := range job.Artifacts {
		// The server only validates relative paths; never trust them to stay inside dir.
		name := filepath.Base(filepath.FromSlash(a.Filename))
		dest := filepath.Join(dir, name)
		if err := downloadFile(langgraphURL(cfg, "jobs", job.JobID, "artifacts", fmt.Sprint(i)), cfg.Token, dest); err != nil {
			errs = append(errs, fmt.Errorf("artifact %d (%s): %w", i, a.Filename, err))
			continue
		}
		fmt.Fprintf(os.Stderr, "Saved %s\n", dest)
	}
	return errors.Join(errs...)
}

func cmdLanggraphDownload(args []string) error {
	fs := flag.NewFlagSet("langgraph download", flag.ContinueOnError)
	out := fs.String("o", ".", "directory to save artifacts into")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai langgraph download <job-id> [-o dir]")
	}
	if err := requireIDs(rest); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var job langgraphJob
	if err := doJSON("GET", langgraphURL(cfg, "jobs", rest[0]), cfg.Token, nil, &job); err != nil {
		return err
	}
	return downloadLanggraphArtifacts(cfg, &job, *out)
}

func cmdLanggraphJobs(args []string) error {
	fs := flag.NewFlagSet("langgraph jobs", flag.ContinueOnError)
	status := fs.String("status", "", "only these statuses (comma-separated)")
	active := fs.Bool("active", false, "only unfinished runs")
	ids := fs.Bool("ids", false, "print bare job IDs")
	asJSON := fs.Bool("json", false, "print raw JSON")
	if _, err := parseInterleaved(fs, args); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var jobs []langgraphJob
	if err := doJSON("GET", langgraphURL(cfg, "jobs"), cfg.Token, nil, &jobs); err != nil {
		return err
	}
	want := map[string]bool{}
	for _, s := range strings.Split(*status, ",") {
		if s = strings.TrimSpace(s); s != "" {
			want[s] = true
		}
	}
	var out []langgraphJob
	for _, j := range jobs {
		if len(want) > 0 && !want[j.Status] || *active && isTerminal(j.Status) {
			continue
		}
		out = append(out, j)
	}
	switch {
	case *asJSON:
		if out == nil {
			out = []langgraphJob{}
		}
		return printJSON(out)
	case *ids:
		for _, j := range out {
			fmt.Println(j.JobID)
		}
		return nil
	case len(out) == 0:
		fmt.Println("No LangGraph runs.")
		return nil
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "JOB ID\tSTATUS\tCAPABILITY\tCREATED\tPROMPT")
	for _, j := range out {
		created := j.CreatedAt
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", j.JobID, j.Status, j.Capability, localTime(&created), truncateRunes(strings.Join(strings.Fields(j.Prompt), " "), 50))
	}
	return w.Flush()
}

func printLanggraphJob(j *langgraphJob) {
	fmt.Printf("Job:        %s\nStatus:     %s\nCapability: %s\n", j.JobID, j.Status, j.Capability)
	if j.Stage != nil && *j.Stage != "" {
		fmt.Printf("Stage:      %s\n", *j.Stage)
	}
	if j.Error != nil && *j.Error != "" {
		fmt.Printf("Error:      %s\n", *j.Error)
	}
	if j.Request != nil {
		tools := "all"
		if j.Request.AllowedTools != nil {
			tools = "none"
			if len(*j.Request.AllowedTools) > 0 {
				tools = strings.Join(*j.Request.AllowedTools, ",")
			}
		}
		fmt.Printf("Tools:      %s\n", tools)
		for role, m := range j.Request.Models {
			fmt.Printf("Role:       %s=%s\n", role, m)
		}
	}
	fmt.Printf("Created:    %s\nUpdated:    %s\n", j.CreatedAt, j.UpdatedAt)
	for i, a := range j.Artifacts {
		fmt.Printf("Artifact %d: %s (%d bytes)\n", i, a.Filename, a.SizeBytes)
	}
	if j.Result != nil {
		if rc, ok := j.Result["return_code"]; ok {
			fmt.Printf("Exit code:  %v\n", rc)
		}
		if t := resultString(j.Result, "text"); t != "" {
			fmt.Printf("\n%s\n", strings.TrimRight(t, "\n"))
		} else if t := resultString(j.Result, "stdout"); t != "" {
			fmt.Printf("\n%s\n", strings.TrimRight(t, "\n"))
		}
		if e := resultString(j.Result, "stderr"); e != "" {
			fmt.Printf("\n--- stderr ---\n%s\n", strings.TrimRight(e, "\n"))
		}
	}
}

// cmdLanggraphJob shows a saved run (GET) or, with poll, forces a reconcile first (POST).
func cmdLanggraphJob(args []string, poll bool) error {
	name := "job"
	if poll {
		name = "poll"
	}
	fs := flag.NewFlagSet("langgraph "+name, flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print the raw job JSON (includes the saved program)")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return fmt.Errorf("usage: oai langgraph %s <job-id> [-json]", name)
	}
	if err := requireIDs(rest); err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var job langgraphJob
	method, u := "GET", langgraphURL(cfg, "jobs", rest[0])
	if poll {
		method, u = "POST", u+"/poll"
	}
	if err := doJSON(method, u, cfg.Token, nil, &job); err != nil {
		return err
	}
	if *asJSON {
		return printJSON(&job)
	}
	printLanggraphJob(&job)
	return nil
}

func cmdLanggraphCancel(args []string) error {
	fs := flag.NewFlagSet("langgraph cancel", flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		return errors.New("usage: oai langgraph cancel <job-id> [job-id ...]")
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
		var resp nudeCancelResponse
		if err := doJSON("POST", langgraphURL(cfg, "jobs", id, "cancel"), cfg.Token, nil, &resp); err != nil {
			errs = append(errs, fmt.Errorf("cancel %s: %w", id, err))
			continue
		}
		fmt.Printf("%s: %s (%s)\n", resp.JobID, resp.Status, resp.Message)
	}
	return errors.Join(errs...)
}

func cmdLanggraphRetry(args []string) error {
	fs := flag.NewFlagSet("langgraph retry", flag.ContinueOnError)
	out := fs.String("o", "", "directory to save artifacts into when the run completes")
	noWait := fs.Bool("no-wait", false, "print only the new job ID")
	asJSON := fs.Bool("json", false, "print the final job as JSON")
	timeout := timeoutFlag(fs)
	showProgress := progressFlag(fs)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai langgraph retry <job-id> [-o dir] [--no-wait] [-json] [-t|-timeout 5m]")
	}
	if err := requireIDs(rest); err != nil {
		return err
	}
	if *noWait && *out != "" {
		return errors.New("-o cannot be combined with --no-wait")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var started startJobResponse
	if err := doJSON("POST", langgraphURL(cfg, "jobs", rest[0], "retry"), cfg.Token, nil, &started); err != nil {
		return err
	}
	if *noWait {
		fmt.Println(started.JobID)
		return nil
	}
	fmt.Fprintf(os.Stderr, "Job: %s\n", started.JobID)
	return finishLanggraphRun(cfg, started.JobID, *timeout, *showProgress, *asJSON, *out)
}

func cmdLanggraphDelete(args []string) error {
	fs := flag.NewFlagSet("langgraph delete", flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		return errors.New("usage: oai langgraph delete <job-id> [job-id ...]")
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
		if err := doJSON("DELETE", langgraphURL(cfg, "jobs", id), cfg.Token, nil, nil); err != nil {
			errs = append(errs, fmt.Errorf("delete %s: %w", id, err))
			continue
		}
		fmt.Printf("Deleted %s\n", id)
	}
	return errors.Join(errs...)
}
