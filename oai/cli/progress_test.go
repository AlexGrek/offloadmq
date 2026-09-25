package main

import (
	"bytes"
	"flag"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestWaitForJobFallsBackToPlainStageLines(t *testing.T) {
	var output bytes.Buffer
	err := waitForJob(&output, "job-1", time.Second, jobProgressOptions{
		Enabled: true,
		Label:   "Image",
	}, func() (jobProgressState, error) {
		return jobProgressState{Status: "completed", Stage: "saving output"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := output.String(), "Stage: saving output\n"; got != want {
		t.Fatalf("plain output = %q, want %q", got, want)
	}
}

func TestInteractiveRendererRedrawsAndFinishes(t *testing.T) {
	var output bytes.Buffer
	now := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	submitted := now.Add(-10 * time.Second).Format(time.RFC3339Nano)
	renderer := &jobProgressRenderer{
		w:           &output,
		opts:        jobProgressOptions{Label: "Image", RunningLabel: "Generating"},
		interactive: true,
		width:       60,
		localStart:  now,
	}
	renderer.render(jobProgressState{Status: "queued", SubmittedAt: &submitted}, now)
	renderer.finish(jobProgressState{Status: "completed"}, now)

	got := output.String()
	if strings.Count(got, "\r\x1b[2K") != 2 {
		t.Errorf("renderer output has wrong redraw count: %q", got)
	}
	for _, want := range []string{"queued 0:10", "✓", "Completed", "100%", "\n"} {
		if !strings.Contains(got, want) {
			t.Errorf("renderer output %q does not contain %q", got, want)
		}
	}
}

func TestCalculateProgressMatchesWebUIHeuristic(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	started := now.Add(-50 * time.Second).Format(time.RFC3339Nano)
	submitted := now.Add(-75 * time.Second).Format(time.RFC3339Nano)
	typical := 100.0

	metrics := calculateProgress(jobProgressState{
		Status:                "running",
		StartedAt:             &started,
		SubmittedAt:           &submitted,
		TypicalRuntimeSeconds: &typical,
	}, now)
	if !metrics.Determinate || !metrics.Executing || metrics.Overrun {
		t.Fatalf("running metrics = %#v", metrics)
	}
	if metrics.Percent != 50 || metrics.Readout != "0:50 left · 50%" {
		t.Errorf("running metrics = %#v", metrics)
	}

	overrunStarted := now.Add(-125 * time.Second).Format(time.RFC3339Nano)
	metrics = calculateProgress(jobProgressState{
		Status:                "running",
		StartedAt:             &overrunStarted,
		TypicalRuntimeSeconds: &typical,
	}, now)
	if !metrics.Overrun || metrics.Percent != 99 || metrics.Readout != "2:05 · finishing…" {
		t.Errorf("overrun metrics = %#v", metrics)
	}

	metrics = calculateProgress(jobProgressState{
		Status:      "queued",
		SubmittedAt: &submitted,
	}, now)
	if metrics.Determinate || metrics.Executing || metrics.Readout != "queued 1:15" {
		t.Errorf("queued metrics = %#v", metrics)
	}

	metrics = calculateProgress(jobProgressState{
		Status:      "running",
		SubmittedAt: &submitted,
	}, now)
	if !metrics.Executing || metrics.Determinate || metrics.Readout != "" {
		t.Errorf("running-without-timing metrics = %#v", metrics)
	}
}

func TestProgressFlagsDefaultOnAndSupportAlias(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		want bool
	}{
		{name: "default", want: true},
		{name: "progress off", args: []string{"--progress=false"}, want: false},
		{name: "profress off", args: []string{"--profress=false"}, want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fs := flag.NewFlagSet("test", flag.ContinueOnError)
			enabled := progressFlag(fs)
			if err := fs.Parse(tc.args); err != nil {
				t.Fatal(err)
			}
			if *enabled != tc.want {
				t.Errorf("enabled = %v, want %v", *enabled, tc.want)
			}
		})
	}
}

func TestProgressLineFitsTerminalWidth(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	started := now.Add(-30 * time.Second).Format(time.RFC3339Nano)
	typical := 90.0
	renderer := &jobProgressRenderer{
		opts: jobProgressOptions{
			Label:        "Image 2/4 with a deliberately long label",
			RunningLabel: "Generating",
		},
		width: 48,
	}
	line := renderer.line(jobProgressState{
		Status:                "running",
		Stage:                 "sampling diffusion model",
		StartedAt:             &started,
		TypicalRuntimeSeconds: &typical,
	}, now, false)
	if utf8.RuneCountInString(line) > renderer.width {
		t.Fatalf("line width = %d, want <= %d: %q", utf8.RuneCountInString(line), renderer.width, line)
	}
	for _, want := range []string{"Image", "━"} {
		if !strings.Contains(line, want) {
			t.Errorf("line %q does not contain %q", line, want)
		}
	}
	renderer.width = 12
	line = renderer.line(jobProgressState{Status: "running", Stage: "sampling"}, now, false)
	if utf8.RuneCountInString(line) > renderer.width {
		t.Fatalf("narrow line width = %d, want <= %d: %q", utf8.RuneCountInString(line), renderer.width, line)
	}
}
