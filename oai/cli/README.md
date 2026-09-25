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
```

`image generate` flags: `-o` (default `output.jpg`; extra images are saved as `<name>_2.jpg`, …), `-capability`, `-negative`, `-width` / `-height` (default 768), `-seed` (0 = random), `-workflow` (default `txt2img`), `-timeout` (default `5m`), `-prompt` (alternative to the positional argument). Flags may come before or after the prompt.

The job is polled every 5s, like the web UI. If `-timeout` expires the job keeps running on the server; only the CLI stops waiting.

## Config

Stored in `~/.oai-cli.json` (mode `0600`): `server`, `token`, `login`. The token is a bearer JWT — treat the file as a credential.
