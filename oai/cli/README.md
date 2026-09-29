# oai CLI

Command-line client for OAI. Talks to the same HTTP API as the web frontend, using the same JWT bearer auth.

## Build

```bash
cd oai/cli
go build -o oai .
```

Or with [Task](https://taskfile.dev): `task build` (optimized: static, stripped, `-trimpath`),
`task install-mac` (build + install to `$(go env GOPATH)/bin`, i.e. `~/go/bin/oai`), `task clean`.

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

# Submit without waiting. stdout is exactly the job ID, ready for a script.
job_id=$(./oai image generate "a red bicycle" -capability imggen.flux-schnell --no-wait)
./oai image job "$job_id"       # read the last stored state
./oai image poll "$job_id"      # refresh it from OffloadMQ once
./oai image download "$job_id" -o bike.jpg

# Prompt history and starred prompts (the web UI's Saved Prompts drawer)
./oai image prompts recent                     # last 10 prompts you generated with
./oai image prompts starred -q castle -all     # search every favorite
./oai image prompts star "a {color} lighthouse at dusk"
./oai image prompts star -id 363426941451112448      # star a recent entry
./oai image prompts show 363426941451112448          # full text, bare on stdout
./oai image generate "$(./oai image prompts show 363426941451112448)" -o reuse.jpg
./oai image generate "a paper crane" --star -o crane.jpg   # generate and star
./oai image prompts edit 363426941451112448 "a {color} lighthouse at dawn"
./oai image prompts preview 363426941451112448 -o thumb.jpg
./oai image prompts unstar "a {color} lighthouse at dawn"
./oai image prompts delete 363426941451112448
./oai image prompts starred -negative          # negative-prompt library

# Custom prompt placeholders (the web UI's Prompt Placeholders page)
./oai image placeholders list
./oai image placeholders create .cinematic "cinematic lighting" "film grain" "anamorphic lens flare"
./oai image placeholders add .cinematic "35mm, shallow depth of field"
./oai image placeholders remove .cinematic "film grain"
./oai image placeholders edit .cinematic        # one variant per line in $VISUAL / $EDITOR
./oai image placeholders show .cinematic > variants.txt   # bare, one per line
./oai image placeholders set .cinematic - < variants.txt  # replace all (creates if missing)
./oai image placeholders rename .cinematic .film
./oai image placeholders expand "a {color} fox, {.film}" -n 4   # preview, nothing generated
./oai image placeholders delete .film

# Describe an image with a vision LLM (description on stdout, progress on stderr)
./oai image describe-capabilities
./oai image describe cat.jpg
./oai image describe cat.jpg -prompt "What breed is this?" -capability llm.qwen3-vl:8b -o desc.txt
./oai image describe cat.jpg dog.jpg bird.png -o description.txt

# NSFW detection with NudeNet (tunable confidence threshold)
./oai nude availability
./oai nude scan photo.jpg
./oai nude scan a.jpg b.jpg -threshold 0.4 -o results.json
./oai nude jobs
./oai nude job <job-id>
./oai nude cancel <job-id>
./oai nude retry <job-id>
./oai nude delete <job-id>
```

`image describe` accepts one or more image paths and creates a separate job for each image. Results stay in input order and multi-image stdout is labeled with each path. Flags: `-prompt` (default: a detailed one-paragraph description prompt, see `defaultDescribePrompt` in `describe.go`), `-capability` (default: first online vision LLM, printed to stderr), `-o` (also write the text to a file; multiple inputs use `<name>_2.txt`, `<name>_3.txt`, ...), `--progress=false`, `-t` / `-timeout` (default `5m`; also accepted as `--timeout`). Each image is uploaded first, so anything the backend can decode (JPEG, PNG, ...) works. If a model fails server-side (`job failed: vision task failed`), pick another with `-capability`.

`image generate` creates one separate job per requested image. Use `-n 4` (or `-count 4`) to request four images, up to 10; outputs are saved as `<name>.jpg`, `<name>_2.jpg`, and so on (if a job returns several images, they get `<name>_<job>_<image>.jpg` suffixes so batches never overwrite each other). With `-n > 1`, a non-zero `-seed` is incremented per image (`seed`, `seed+1`, …) so the results differ but stay reproducible. Other flags: `-o` (default `output.jpg`), `-capability`, `-negative`, `-width` / `-height` (default 1024), `-seed` (0 = random), `-workflow` (default `txt2img`), `--progress=false`, `--history=false` (to not record in web UI history), `--star` (also add the prompt template to your starred prompts — see [Prompt library](#prompt-library-history-and-starred-prompts)), `-t` / `-timeout` (default `5m`; also accepted as `--timeout`), `-prompt` (alternative to the positional argument). Flags may come before or after the prompt.

Pass `--no-wait` to submit detached work and return immediately. For one job, stdout contains exactly its bare job ID; for `-n` batches, it contains one bare ID per line. Status messages, capability auto-selection, and placeholder expansion go to stderr in this mode, so command substitution stays safe. `-o` cannot be combined with `--no-wait`, because no result has been downloaded yet. Use `image job <id>` to read the last stored state, `image poll <id>` to ask the backend to refresh that job once, and `image download <id> -o image.jpg` after it reaches `completed`. Download saves each output image, adding `_2`, `_3`, and so on when needed.

### Prompt placeholders

`image generate` expands `{token}` placeholders in the prompt the same way the web UI does, once per job, so `-n 4` never repeats a value:

- `{color}` `{animal}` `{adjective}` `{country}` `{language}` `{name}` — random words. The web UI draws them from unique-names-generator; the CLI uses [gofakeit](https://github.com/brianvoe/gofakeit), so the word pools differ. `{starwars}` has no Go equivalent: it is sent literally (with a warning).
- `{item}`, `{.cinematic}`, … — your **custom placeholders**, loaded from the same server-side definitions as the web UI (`GET /api/prompt-placeholders`; manage them with [`image placeholders`](#managing-custom-placeholders) or in the web app). A random variant is picked per job, and variants may contain further placeholders (depth-capped). If they cannot be loaded, the CLI warns and sends those tokens literally.
- `{?}` — random two-word name, expanded by the server; the CLI leaves it alone.

Tokens are case-insensitive and unknown ones are left untouched. The expanded prompt is printed before each job, and the raw template is sent as `prompt_template` so Retry and saved-prompt previews in the web UI see it.

Each job is polled every 5s, like the web UI. A failed poll caused by a network error or a gateway/overload response (502, 503, 504, 408, 429) is retried on the next tick, with a notice on stderr; the CLI gives up only after 3 such failures in a row. Any other error (auth, unknown job, a backend 500) fails immediately. `-timeout` also bounds an in-flight poll request. If `-timeout` expires for a job, it keeps running on the server; only the CLI stops waiting for it.

### Managing custom placeholders

`image placeholders` manages the same per-user definitions as the web UI's Prompt Placeholders page (`/api/prompt-placeholders`). A placeholder has a name (letters, digits, `.`, `-`, `_`; up to 64 characters; unique case-insensitively; not one of the built-in names above or `?`) and one or more variants. Everywhere a name is expected you may write it with or without braces (`.cinematic` or `{.cinematic}`, case-insensitive) or pass the placeholder's ID. Validation happens on the server, so its messages (`reserved placeholder name`, `already have a placeholder named …`) come through as-is.

| Command | What it does |
|---------|--------------|
| `list [-full] [-json]` | Table of name, ID, variant count and the first variant; `-full` prints every variant |
| `show <name> [-json]` | Print the variants, one per line, bare on stdout |
| `create <name> "v1" "v2" …` | Create a placeholder; fails if the name exists |
| `set <name> "v1" …` | Replace every variant, creating the placeholder if missing (idempotent, for scripts) |
| `add <name> "v" …` | Append variants; ones already present are skipped |
| `remove <name> "v" …` | Remove variants by exact text; refuses to remove the last one (use `delete`) |
| `rename <name> <new-name>` | Rename; prompts that already use the old `{name}` are not rewritten |
| `edit <name>` | Open the variants in `$VISUAL` / `$EDITOR` (default `vi`), one per line; blank lines are ignored. A new name is created on save; an empty file or a non-zero editor exit saves nothing |
| `delete <name> [name …]` | Delete placeholders |
| `expand "prompt" [-n N]` | Print N expansions of a prompt with the same expander as `generate` (no repeats until a pool runs out; `{?}` stays literal). Nothing is generated |

For `create`, `set`, `add` and `remove`, a lone `-` reads the variants from stdin, one per line — the format `show` prints, so `show NAME > f`, edit `f`, `set NAME - < f` round-trips.

### Prompt library: history and starred prompts

`image prompts` manages the same saved prompts as the web UI's Images page (the Saved Prompts drawer with its **Recent** and **Starred** tabs). Each user has two image libraries: **prompts** (`imggen-prompt`, the default) and **negative prompts** (`imggen-negative`, select with `-negative`). Each library has two lists:

- **Recent** — prompt history, managed by the server: the 10 most recently used unique prompts, newest first. `image generate` records the prompt (and the `-negative` text) here once per invocation, not once per `-n` job, unless you pass `--history=false`. Placeholders are stored unexpanded (`a {color} kite`).
- **Starred** — favorites you add explicitly; unlimited, newest-edited first, editable and deletable. Starring text that is already a favorite doesn't duplicate it; it just moves it to the top.

An entry may also have a **preview**: a thumbnail of the latest image generated from that exact text. The web UI shows it on the card; `PREVIEW yes` in the CLI table.

| Command | What it does | Web UI equivalent |
|---|---|---|
| `image prompts recent` | List prompt history | Recent tab |
| `image prompts starred` | List favorites | Starred tab |
| `image prompts show <id>` | Print one entry's full text, bare on stdout (`-json` for metadata) | Click a card to use it |
| `image prompts star "text"` | Add text to favorites (`-` reads stdin, for multi-line prompts) | "Add current prompt" star button |
| `image prompts star -id <id>` | Star an existing entry (typically a recent), in that entry's library | Star icon on a recent card |
| `image prompts unstar "text"` | Remove the favorite whose text matches exactly | Delete on a starred card |
| `image prompts edit <id> "new text"` | Replace an entry's text (`-` reads stdin); the preview carries over | Edit on a starred card |
| `image prompts delete <id> [id …]` | Delete entries, recent or starred | Delete button |
| `image prompts record "text"` | Push text onto the recent list without generating anything | — (done automatically on Generate) |
| `image prompts preview <id> [-o preview.jpg]` | Save the entry's preview thumbnail (JPEG) | Card thumbnail |
| `image generate … --star` | Star the prompt template once the job(s) are submitted | — |

Flags for `recent` / `starred`: `-negative` (negative-prompt library), `-q TEXT` (case-insensitive substring search across the whole list, done on the server), `-limit N` (page size; server default 40, max 100), `-cursor C` (next page — the CLI prints the cursor on stderr when there are more), `-all` (fetch every page), `-full` (print whole prompts instead of one truncated line per entry), `-json` (raw `{items, next_cursor}`). The table's `WHEN` column is the last use for recents and the last edit for favorites, as in the web UI.

`star`, `unstar` and `record` take `-negative` to target the negative-prompt library. Commands that take an `<id>` (`show`, `edit`, `delete`, `preview`, `star -id`) work in both libraries without `-negative`, because entry IDs are unique. There is no "unstar by ID" command: deleting a starred entry unstars it. Starring a recent entry copies it into the favorites and leaves the recent entry where it is.

`show` prints just the text, so a saved prompt can drive a generation: `oai image generate "$(oai image prompts show <id>)"`. Placeholders in it are expanded as usual.

### Nude detector (NudeNet)

`nude scan` uploads one or more images and runs NSFW detection (`onnx.nudenet`) with a tunable confidence threshold, mirroring the web UI's Nude Detector page — one job per image. Flags: `-threshold` (default `0.25`, must be `0.05`-`0.95`, same range as the UI slider), `-json` (print the raw result JSON instead of a label/confidence summary), `-o` (also save the raw JSON result; multiple inputs get `_2`, `_3`, ... suffixes), `--progress=false`, `-t` / `-timeout` (default `5m`).

Other `nude` subcommands manage jobs directly, matching the web UI's history sidebar actions:

- `nude availability` — whether an `onnx.nudenet` agent is online, plus any active runners
- `nude jobs` — table of your nude-detect jobs
- `nude job <id>` / `nude poll <id>` — job details (add `-json` for the raw response); `poll` re-checks the server, `job` just fetches the stored state
- `nude cancel <id>` — cancel a running job
- `nude retry <id>` — resubmit a failed/canceled job (reuses its original image and threshold) and wait for the new result
- `nude delete <id>` — delete a job's history entry

## Progress UI

Live progress is enabled by default for `image generate` and `image describe`. On a terminal, the CLI renders a responsive Unicode spinner/bar with color, the current status and stage, queue time, estimated time remaining, and percentage. Image generation uses the same heuristic as the web UI: progress begins when an agent starts executing, divides elapsed time by `typical_runtime_seconds`, caps at 99% until completion, and switches to `finishing…` after the estimate is exceeded.

Use `--progress=false` to disable the live bar. The `--profress` spelling is also accepted as an alias. Redirected output and `TERM=dumb` automatically fall back to plain stage lines; `NO_COLOR` keeps the live bar but removes color.

## Config

Stored in `~/.oai-cli.json` (mode `0600`): `server`, `token`, `login`. The token is a bearer JWT — treat the file as a credential.
