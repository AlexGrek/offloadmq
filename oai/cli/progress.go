package main

import (
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/term"
)

const progressTick = 125 * time.Millisecond

var spinnerFrames = [...]string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

type jobProgressState struct {
	Status                string
	Stage                 string
	StartedAt             *string
	TypicalRuntimeSeconds *float64
	SubmittedAt           *string
	ExecutionSeconds      *float64
}

type jobProgressOptions struct {
	Enabled      bool
	Label        string
	RunningLabel string
}

type progressMetrics struct {
	Determinate bool
	Executing   bool
	Overrun     bool
	Percent     int
	Readout     string
}

type jobProgressRenderer struct {
	w           io.Writer
	opts        jobProgressOptions
	interactive bool
	color       bool
	width       int
	frame       int
	localStart  time.Time
}

// progressFlag registers the canonical flag and its accepted misspelling.
// Progress is enabled by default; use --progress=false (or --profress=false)
// to turn it off.
func progressFlag(fs *flag.FlagSet) *bool {
	enabled := new(bool)
	fs.BoolVar(enabled, "progress", true, "show a live progress bar (disable with --progress=false)")
	fs.BoolVar(enabled, "profress", true, "alias for --progress")
	return enabled
}

func newJobProgressRenderer(w io.Writer, opts jobProgressOptions) *jobProgressRenderer {
	r := &jobProgressRenderer{
		w:          w,
		opts:       opts,
		width:      80,
		localStart: time.Now(),
	}
	if !opts.Enabled || strings.EqualFold(os.Getenv("TERM"), "dumb") {
		return r
	}
	file, ok := w.(*os.File)
	if !ok || !term.IsTerminal(int(file.Fd())) {
		return r
	}
	r.interactive = true
	r.color = os.Getenv("NO_COLOR") == ""
	if width, _, err := term.GetSize(int(file.Fd())); err == nil && width > 0 {
		// Leave the final terminal column unused so auto-wrap never moves the
		// in-place renderer onto a second line.
		r.width = maxInt(1, width-1)
	}
	return r
}

func (r *jobProgressRenderer) render(state jobProgressState, now time.Time) {
	if !r.interactive {
		return
	}
	state = r.withLocalSubmittedAt(state)
	line := r.line(state, now, false)
	fmt.Fprintf(r.w, "\r\x1b[2K%s", line)
	r.frame++
}

func (r *jobProgressRenderer) finish(state jobProgressState, now time.Time) {
	if !r.interactive {
		return
	}
	state = r.withLocalSubmittedAt(state)
	fmt.Fprintf(r.w, "\r\x1b[2K%s\n", r.line(state, now, true))
}

func (r *jobProgressRenderer) fail(message string) {
	if !r.interactive {
		return
	}
	label := r.opts.Label
	if label != "" {
		label += " · "
	}
	line := truncateRunes("! "+label+message, r.width)
	if strings.HasPrefix(line, "!") {
		line = r.paint("!", "33") + strings.TrimPrefix(line, "!")
	}
	fmt.Fprintf(r.w, "\r\x1b[2K%s\n", line)
}

func (r *jobProgressRenderer) withLocalSubmittedAt(state jobProgressState) jobProgressState {
	if state.SubmittedAt == nil {
		value := r.localStart.Format(time.RFC3339Nano)
		state.SubmittedAt = &value
	}
	return state
}

func (r *jobProgressRenderer) line(state jobProgressState, now time.Time, terminal bool) string {
	metrics := calculateProgress(state, now)
	status := progressStatusLabel(state.Status, r.opts.RunningLabel)
	left := r.opts.Label
	if left != "" && status != "" {
		left += " · "
	}
	left += status
	if state.Stage != "" && !isTerminal(state.Status) {
		if left != "" {
			left += " · "
		}
		left += state.Stage
	}

	icon := spinnerFrames[r.frame%len(spinnerFrames)]
	iconColor := "36"
	if terminal {
		switch state.Status {
		case "completed":
			icon, iconColor = "✓", "32"
		case "failed":
			icon, iconColor = "✗", "31"
		case "canceled":
			icon, iconColor = "■", "33"
		default:
			icon = "•"
		}
	}

	readout := metrics.Readout
	if terminal {
		switch {
		case state.Status == "completed" && state.ExecutionSeconds != nil:
			readout = formatElapsed(time.Duration(*state.ExecutionSeconds * float64(time.Second)))
		case state.Status == "completed":
			readout = "100%"
		case state.Status == "failed":
			readout = "failed"
		case state.Status == "canceled":
			readout = "canceled"
		}
	}
	if r.width < 20 {
		line := truncateRunes(icon+" "+left, r.width)
		if strings.HasPrefix(line, icon) {
			line = r.paint(icon, iconColor) + strings.TrimPrefix(line, icon)
		}
		return line
	}

	barWidth := minInt(28, maxInt(10, r.width/4))
	// Icon (1 column) plus the two double-space separators around the label.
	fixedWidth := 1 + 4 + barWidth
	if readout != "" {
		fixedWidth += 2 + utf8.RuneCountInString(readout)
	}
	leftWidth := r.width - fixedWidth
	if leftWidth < 8 {
		readout = ""
		leftWidth = r.width - (1 + 4 + barWidth)
	}
	if leftWidth < 4 {
		barWidth = maxInt(6, r.width/3)
		leftWidth = maxInt(1, r.width-(1+4+barWidth))
	}
	left = truncateRunes(left, leftWidth)

	bar := r.bar(state, metrics, barWidth, terminal)
	parts := []string{r.paint(icon, iconColor), left, bar}
	if readout != "" {
		readoutColor := "2"
		if metrics.Overrun {
			readoutColor = "33"
		}
		parts = append(parts, r.paint(readout, readoutColor))
	}
	return strings.Join(parts, "  ")
}

func (r *jobProgressRenderer) bar(state jobProgressState, metrics progressMetrics, width int, terminal bool) string {
	if terminal {
		switch state.Status {
		case "completed":
			return r.paint(strings.Repeat("━", width), "32")
		case "failed":
			return r.paint(strings.Repeat("─", width), "31")
		case "canceled":
			return r.paint(strings.Repeat("─", width), "33")
		}
	}
	if metrics.Determinate {
		filled := int(math.Round(float64(width) * float64(metrics.Percent) / 100))
		filled = minInt(width, maxInt(0, filled))
		color := "36"
		if metrics.Overrun {
			color = "33"
		}
		return r.paint(strings.Repeat("━", filled), color) +
			r.paint(strings.Repeat("─", width-filled), "2")
	}

	segmentWidth := maxInt(3, width/4)
	travel := width + segmentWidth
	// Three columns per tick gives roughly the web UI's 1.5s shimmer sweep.
	start := ((r.frame * 3) % travel) - segmentWidth
	var bar strings.Builder
	for i := 0; i < width; i++ {
		if i >= start && i < start+segmentWidth {
			bar.WriteString(r.paint("━", "36"))
		} else {
			bar.WriteString(r.paint("─", "2"))
		}
	}
	return bar.String()
}

func (r *jobProgressRenderer) paint(value, code string) string {
	if !r.color || value == "" {
		return value
	}
	return "\x1b[" + code + "m" + value + "\x1b[0m"
}

func calculateProgress(state jobProgressState, now time.Time) progressMetrics {
	metrics := progressMetrics{}
	startedAt := parseProgressTime(state.StartedAt)
	metrics.Executing = state.Status == "starting" || state.Status == "running"
	if startedAt != nil && !isQueuedStatus(state.Status) && !isTerminal(state.Status) {
		metrics.Executing = true
	}

	var elapsed time.Duration
	if startedAt != nil {
		elapsed = maxDuration(0, now.Sub(*startedAt))
	}
	if metrics.Executing && startedAt != nil && state.TypicalRuntimeSeconds != nil && *state.TypicalRuntimeSeconds > 0 {
		typical := time.Duration(*state.TypicalRuntimeSeconds * float64(time.Second))
		raw := float64(elapsed) / float64(typical)
		metrics.Determinate = true
		metrics.Overrun = raw > 1
		metrics.Percent = minInt(99, int(math.Round(raw*100)))
		if metrics.Overrun {
			metrics.Readout = formatElapsed(elapsed) + " · finishing…"
		} else {
			remaining := maxDuration(0, typical-elapsed)
			metrics.Readout = fmt.Sprintf("%s left · %d%%", formatElapsed(remaining), metrics.Percent)
		}
		return metrics
	}
	if metrics.Executing {
		if startedAt != nil {
			metrics.Readout = formatElapsed(elapsed)
		}
		return metrics
	}
	if submittedAt := parseProgressTime(state.SubmittedAt); submittedAt != nil {
		queued := now.Sub(*submittedAt)
		if queued >= 0 {
			metrics.Readout = "queued " + formatElapsed(queued)
		}
	}
	return metrics
}

func progressStatusLabel(status, runningLabel string) string {
	switch status {
	case "submitted":
		return "In queue"
	case "pending":
		return "Pending"
	case "queued":
		return "Queued"
	case "assigned":
		return "Assigned"
	case "starting":
		return "Starting"
	case "running":
		if runningLabel != "" {
			return runningLabel
		}
		return "Running"
	case "cancelRequested":
		return "Canceling"
	case "completed":
		return "Completed"
	case "failed":
		return "Failed"
	case "canceled":
		return "Canceled"
	default:
		return strings.ReplaceAll(status, "_", " ")
	}
}

func isQueuedStatus(status string) bool {
	return status == "submitted" || status == "pending" || status == "queued" || status == "assigned"
}

func isTerminal(status string) bool {
	return status == "completed" || status == "failed" || status == "canceled"
}

func parseProgressTime(value *string) *time.Time {
	if value == nil || *value == "" {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, *value)
	if err != nil {
		return nil
	}
	return &parsed
}

func formatElapsed(duration time.Duration) string {
	seconds := maxInt(0, int(duration/time.Second))
	hours := seconds / 3600
	minutes := (seconds % 3600) / 60
	remainder := seconds % 60
	if hours > 0 {
		return fmt.Sprintf("%d:%02d:%02d", hours, minutes, remainder)
	}
	return fmt.Sprintf("%d:%02d", minutes, remainder)
}

func truncateRunes(value string, width int) string {
	if width <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= width {
		return value
	}
	if width == 1 {
		return "…"
	}
	return string(runes[:width-1]) + "…"
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}
