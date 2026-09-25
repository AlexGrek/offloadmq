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

# Generate an image (txt2img). Capability defaults to the first online one and is printed.
./oai image generate "a red bicycle" -o bike.jpg
./oai image generate "a cat" -capability imggen.flux-schnell -width 1024 -height 1024 -seed 42 -o cat.jpg

# Describe an image with a vision LLM (description on stdout, progress on stderr)
./oai image describe-capabilities
./oai image describe cat.jpg
./oai image describe cat.jpg -prompt "What breed is this?" -capability llm.qwen3-vl:8b -o desc.txt
```

`image describe` flags: `-prompt` (default `Describe this image in detail`), `-capability` (default: first online vision LLM, printed to stderr), `-o` (also write the text to a file), `-t` / `-timeout` (default `5m`; also accepted as `--timeout`). The image is uploaded first, so anything the backend can decode (JPEG, PNG, ...) works. If a model fails server-side (`job failed: vision task failed`), pick another with `-capability`.

`image generate` flags: `-o` (default `output.jpg`; extra images are saved as `<name>_2.jpg`, …), `-capability`, `-negative`, `-width` / `-height` (default 768), `-seed` (0 = random), `-workflow` (default `txt2img`), `-t` / `-timeout` (default `5m`; also accepted as `--timeout`), `-prompt` (alternative to the positional argument). Flags may come before or after the prompt.

The job is polled every 5s, like the web UI. If `-timeout` expires the job keeps running on the server; only the CLI stops waiting.

## Config

Stored in `~/.oai-cli.json` (mode `0600`): `server`, `token`, `login`. The token is a bearer JWT — treat the file as a credential.
