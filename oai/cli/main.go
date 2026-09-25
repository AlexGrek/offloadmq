package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

const usage = `oai — command-line client for OAI

Usage:
  oai login [-server URL] [-login NAME] [-password PW]
  oai whoami
  oai image capabilities
  oai image describe-capabilities
  oai image describe <file> [file ...] [-prompt "..."] [-capability llm.X] [-o out.txt]
                     [--progress=false] [-t|-timeout 5m]
  oai image generate "prompt" [-o out.jpg] [-capability imggen.X] [-negative TEXT]
                     [-width N] [-height N] [-seed N] [-workflow W] [-n COUNT]
                     [--progress=false] [-t|-timeout 5m]

Config is stored in ~/.oai-cli.json. Set OAI_PASSWORD for non-interactive login.
`

// parseInterleaved parses flags that may appear before or after positional
// arguments (flag.Parse alone stops at the first positional), returning the
// positionals.
func parseInterleaved(fs *flag.FlagSet, args []string) ([]string, error) {
	fs.SetOutput(io.Discard)
	var positional []string
	for {
		if err := fs.Parse(args); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				fmt.Fprintf(os.Stderr, "Usage of %s:\n", fs.Name())
				fs.SetOutput(os.Stderr)
				fs.PrintDefaults()
				os.Exit(0)
			}
			return nil, err
		}
		args = fs.Args()
		if len(args) == 0 {
			return positional, nil
		}
		positional = append(positional, args[0])
		args = args[1:]
	}
}

// timeoutFlag registers -t / -timeout (one shared value) for job-style commands.
func timeoutFlag(fs *flag.FlagSet) *time.Duration {
	d := new(time.Duration)
	usage := "give up waiting after this long (e.g. 90s, 10m)"
	fs.DurationVar(d, "timeout", 5*time.Minute, usage)
	fs.DurationVar(d, "t", 5*time.Minute, "shorthand for -timeout")
	return d
}

func main() {
	if len(os.Args) < 2 || strings.HasPrefix(os.Args[1], "-") {
		fmt.Fprint(os.Stderr, usage)
		if len(os.Args) >= 2 && (os.Args[1] == "-h" || os.Args[1] == "--help" || os.Args[1] == "-help") {
			return
		}
		os.Exit(2)
	}

	var err error
	switch os.Args[1] {
	case "login":
		err = cmdLogin(os.Args[2:])
	case "whoami":
		err = cmdWhoami(os.Args[2:])
	case "image":
		err = cmdImage(os.Args[2:])
	case "help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
