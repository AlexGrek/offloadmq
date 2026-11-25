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

const placeholderReferenceHelp = `Numbered references work with built-in and custom placeholders. The first {color}
and {color:1} share one value in either order. Additional bare {color} tokens draw
again. Repeated {color:2} tokens reuse a separate draw. References reset per prompt.`

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
                     [--no-wait] [--star] [--high-priority] [--progress=false] [--history=false]
                     [-t|-timeout 5m]
  oai image jobs [-status S[,S]] [-active] [-ids] [-json]
  oai image job <job-id> [-json]
  oai image poll <job-id> [-json]
  oai image download <job-id> [-o out.jpg]
  oai image cancel <job-id> [job-id ...]
  oai image retry <job-id> [-o out.jpg] [--no-wait] [--progress=false] [-t|-timeout 5m]
  oai image delete <job-id> [job-id ...]
  oai image prompts recent|starred [-negative] [-q TEXT] [-limit N] [-cursor C] [-all]
                                   [-full] [-json]
  oai image prompts show <id> [-json]
  oai image prompts star "text" [-negative]  |  star -id <entry-id>
  oai image prompts unstar "text" [-negative]
  oai image prompts record "text" [-negative]
  oai image prompts edit <id> "new text"
  oai image prompts delete <id> [id ...]
  oai image prompts preview <id> [-o preview.jpg]
  oai image placeholders list [-full] [-json]
  oai image placeholders show <name|id> [-json]
  oai image placeholders create|set|add|remove <name|id> "variant" [...]   (- reads stdin)
  oai image placeholders rename <name|id> <new-name>
  oai image placeholders edit <name|id>          (opens $VISUAL / $EDITOR)
  oai image placeholders delete <name|id> [...]
  oai image placeholders expand "prompt" [-n COUNT]
  oai img-utils tools [-json]
  oai img-utils run <tool> <image> [image ...] [-o out.jpg] [-capability C] [--no-wait]
                    [-source FACE] [-scale N] [-opt key=value ...]
                    [-width N] [-height N] [-mode fit|exact|cover] [-method M] [-format F]
                    [-quality Q] [-allow-upscale] [--progress=false] [-t|-timeout 5m]
  oai upscale <image> [image ...] [-scale 1-3] [-o out.png] ...   (= img-utils run upscale)
  oai img-utils jobs [-status S[,S]] [-active] [-ids] [-json]
  oai img-utils job|poll <job-id> [-json]
  oai img-utils cancel|delete <job-id> [job-id ...]
  oai img-utils retry <job-id> [-o out.jpg] [--no-wait]
  oai img-utils download <job-id> [-o out.jpg]
  oai bgremove models [-json]
  oai bgremove run <image> [image ...] [-o out.png] [-model M] [-format png|webp|jpeg]
                   [-background transparent|#RRGGBB] [-crop] [-padding N] [-refine=false]
                   [-hard-edges 0..1] [-quality N] [--no-wait] [--progress=false] [-t|-timeout 5m]
  oai bgremove jobs|job|poll|cancel|retry|delete|download   (same shape as img-utils; see README)
  oai world models [-json]
  oai world generate <image|image-id> [...] [-o out.ply] [-model sharp|splat|pano360]
                   [-mode auto|perspective|pano] [-fov DEG] [-max-width N] [-lean M] [-near M]
                   [-far M] [-prompt TEXT] [-pitch DEG] [-seed N] [-share] [--no-wait]
                   [--progress=false] [-t|-timeout 5m]
  oai world jobs [-status S[,S]] [-active] [-ids] [-json]
  oai world job|poll <job-id> [-json]
  oai world cancel|delete <job-id> [job-id ...]
  oai world retry <job-id> [-o out.ply] [--no-wait]
  oai world download <job-id> [-o out.ply] [-preview preview.png]
  oai world share <job-id> [-json]               (login-free headset viewer link)
  oai nude scan <file> [file ...] [-threshold 0.25] [-json] [-o out.json]
                [--progress=false] [-t|-timeout 5m]
  oai nude availability
  oai nude jobs
  oai nude job <job-id> [-json]
  oai nude poll <job-id> [-json]
  oai nude cancel <job-id>
  oai nude retry <job-id> [--progress=false] [-t|-timeout 5m]
  oai nude delete <job-id>
  oai langgraph capabilities [-json]
  oai langgraph init <dir> [-force]              (writes the default main.py, tools.py, pyproject.toml)
  oai langgraph run ["user prompt"] [-dir D] [-main F] [-tools F] [-pyproject F]
                    [-system T|-system-file F] [-user T|-user-file F] [-model M|-capability C]
                    [-role name=model ...] [-allowed-tools all|none|a,b] [-resources JSON|@F]
                    [-data-file result.json] [-file out.md ...] [-runtime SECS] [-o DIR]
                    [--no-wait] [-json] [--progress=false] [-t|-timeout 5m]
  oai langgraph jobs [-status S[,S]] [-active] [-ids] [-json]
  oai langgraph job|poll <job-id> [-json]
  oai langgraph cancel|delete <job-id> [job-id ...]
  oai langgraph retry <job-id> [-o DIR] [--no-wait] [-json]
  oai langgraph download <job-id> [-o DIR]
  oai persona list [-json]  |  show <persona> [-json]  |  models [-json]
  oai persona create -name NAME [-look TEXT|-look-file F] [-system TEXT|-system-file F]
                     [-llm C] [-txt2img C] [-img2img C] [-faceswap C] [-upscaler C]
                     [-face img.jpg ...]          (model flags take a capability or auto)
  oai persona update <persona> [same flags as create]
  oai persona delete <persona> [persona ...]
  oai persona face list|add|remove|primary <persona> [img.jpg ... | image-id ...]
  oai persona photo <persona> "prompt" [-o out.jpg] [-n N] [-input img.jpg] [-face ID]
                    [-no-faceswap] [-no-upscale] [-scale 2] [-negative TEXT] [-seed N]
                    [-width N] [-height N] [-model imggen.X] [--no-wait] [-t|-timeout 5m]
  oai persona photo <persona> -from photo.jpg|<image-id> [-o out.jpg] [-face ID] [-no-upscale]
                    [-scale 2] [--no-wait]          # no generation: face swap an existing photo
  oai persona photos <persona> [-limit N] [-json]
  oai persona photo-job|photo-poll <job-id> [-json]
  oai persona photo-cancel|photo-delete <job-id> [job-id ...]
  oai persona photo-retry <job-id> [-o out.jpg] [--no-wait]
  oai persona photo-reface <job-id> <face-image-id> [-o out.jpg] [--no-wait]
  oai persona photo-download <job-id> [-o out.jpg]
  oai persona chat <persona> "message" [-chat ID | -new] [-model llm.X] [-t|-timeout 5m]
  oai persona chats <persona> [-json]  |  history <chat-id> [-limit N] [-json]

Prompts may use {color} {animal} {adjective} {country} {language} {name}, your custom
{placeholders} (manage with oai image placeholders), {random}, and {?} (expanded by the server).
` + placeholderReferenceHelp + `
Inline {a|b|c} choices pick one literal option independently per occurrence (repeats allowed).
LangGraph prompts also take {tools} (expanded at run time by the default main.py).
Persona prompts also take {p_name}, {p_look} and {p_system} (substituted by the server).

Config is stored in ~/.oai-cli.json. Set OAI_PASSWORD for non-interactive login.
`

func setPromptUsage(fs *flag.FlagSet, synopsis string) {
	fs.Usage = func() {
		fmt.Fprintf(fs.Output(), "Usage: %s\n\n%s\n\n", synopsis, placeholderReferenceHelp)
		fs.PrintDefaults()
	}
}

// parseInterleaved parses flags that may appear before or after positional
// arguments (flag.Parse alone stops at the first positional), returning the
// positionals.
func parseInterleaved(fs *flag.FlagSet, args []string) ([]string, error) {
	fs.SetOutput(io.Discard)
	var positional []string
	for {
		if err := fs.Parse(args); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				fs.SetOutput(os.Stderr)
				fs.Usage()
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
	case "nude":
		err = cmdNude(os.Args[2:])
	case "img-utils", "imgutils":
		err = cmdImgUtils(os.Args[2:])
	case "upscale":
		err = cmdUpscale(os.Args[2:])
	case "bgremove", "bg-remove", "bg-remover":
		err = cmdBgRemove(os.Args[2:])
	case "langgraph":
		err = cmdLanggraph(os.Args[2:])
	case "world", "worlds":
		err = cmdWorld(os.Args[2:])
	case "persona", "personas":
		err = cmdPersona(os.Args[2:])
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
