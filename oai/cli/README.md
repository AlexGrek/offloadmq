# oai CLI

Command-line client for OAI. Talks to the same HTTP API as the web frontend, using the same JWT bearer auth.

## Build

```bash
cd oai/cli
go build -o oai .
```

## Usage

```bash
# Log in (prompts for whatever is missing; default server is https://oai.alexgr.space)
./oai login
./oai login -server http://localhost:3001 -login root

# Non-interactive login
OAI_PASSWORD=000000 ./oai login -server http://localhost:3001 -login root

# Check the stored session
./oai whoami

# List imggen.* capabilities and whether an agent is online for them
./oai image capabilities

# Generate images (txt2img). Capability defaults to the first online one and is printed.
./oai image generate "a red bicycle" -o bike.jpg
./oai image generate "a cat" -capability imggen.flux-schnell -width 1024 -height 1024 -seed 42 -o cat.jpg
./oai image generate "four variations of a lighthouse" -n 4 -o lighthouse.jpg
./oai image generate "quiet scripting mode" --progress=false -o quiet.jpg

# Describe an image with a vision LLM (description on stdout, progress on stderr)
./oai image describe-capabilities
./oai image describe cat.jpg
./oai image describe cat.jpg -prompt "What breed is this?" -capability llm.qwen3-vl:8b -o desc.txt
./oai image describe cat.jpg dog.jpg bird.png -o description.txt
```

`image describe` accepts one or more image paths and creates a separate job for each image. Results stay in input order and multi-image stdout is labeled with each path. Flags: `-prompt` (default `Describe this image in detail`), `-capability` (default: first online vision LLM, printed to stderr), `-o` (also write the text to a file; multiple inputs use `<name>_2.txt`, `<name>_3.txt`, ...), `--progress=false`, `-t` / `-timeout` (default `5m`; also accepted as `--timeout`). Each image is uploaded first, so anything the backend can decode (JPEG, PNG, ...) works. If a model fails server-side (`job failed: vision task failed`), pick another with `-capability`.

`image generate` creates one separate job per requested image. Use `-n 4` (or `-count 4`) to request four images, up to 10; outputs are saved as `<name>.jpg`, `<name>_2.jpg`, and so on (if a job returns several images, they get `<name>_<job>_<image>.jpg` suffixes so batches never overwrite each other). With `-n > 1`, a non-zero `-seed` is incremented per image (`seed`, `seed+1`, …) so the results differ but stay reproducible. Other flags: `-o` (default `output.jpg`), `-capability`, `-negative`, `-width` / `-height` (default 768), `-seed` (0 = random), `-workflow` (default `txt2img`), `--progress=false`, `-t` / `-timeout` (default `5m`; also accepted as `--timeout`), `-prompt` (alternative to the positional argument). Flags may come before or after the prompt.

### Prompt placeholders

`image generate` expands `{token}` placeholders in the prompt the same way the web UI does, once per job, so `-n 4` never repeats a value:

- `{color}` `{animal}` `{adjective}` `{country}` `{language}` `{name}` — random words. The web UI draws them from unique-names-generator; the CLI uses [gofakeit](https://github.com/brianvoe/gofakeit), so the word pools differ. `{starwars}` has no Go equivalent: it is sent literally (with a warning).
- `{item}`, `{.cinematic}`, … — your **custom placeholders**, loaded from the same server-side definitions as the web UI (`GET /api/prompt-placeholders`; edit them in the web app). A random variant is picked per job, and variants may contain further placeholders (depth-capped). If they cannot be loaded, the CLI warns and sends those tokens literally.
- `{?}` — random two-word name, expanded by the server; the CLI leaves it alone.

Tokens are case-insensitive and unknown ones are left untouched. The expanded prompt is printed before each job, and the raw template is sent as `prompt_template` so Retry and saved-prompt previews in the web UI see it.

Each job is polled every 5s, like the web UI. If `-timeout` expires for a job, it keeps running on the server; only the CLI stops waiting for it.

## Progress UI

Live progress is enabled by default for `image generate` and `image describe`. On a terminal, the CLI renders a responsive Unicode spinner/bar with color, the current status and stage, queue time, estimated time remaining, and percentage. Image generation uses the same heuristic as the web UI: progress begins when an agent starts executing, divides elapsed time by `typical_runtime_seconds`, caps at 99% until completion, and switches to `finishing…` after the estimate is exceeded.

Use `--progress=false` to disable the live bar. The `--profress` spelling is also accepted as an alias. Redirected output and `TERM=dumb` automatically fall back to plain stage lines; `NO_COLOR` keeps the live bar but removes color.

## Config

Stored in `~/.oai-cli.json` (mode `0600`): `server`, `token`, `login`. The token is a bearer JWT — treat the file as a credential.
