# Custom Skills System

Custom skills are predefined, reusable tasks stored as YAML files on the agent. They support two execution types: **shell** (bash scripts with environment variable injection) and **llm** (prompt templates sent to local LLM models).

## Why Custom Skills?

Instead of defining tasks in clients, agents can pre-define safe, audited execution patterns:

- **Agent operator** authors skills with full control over what's executed
- **Task submitter** provides only parameter values (no code)
- **Injection protection** — values passed as env vars, never interpolated into commands
- **Reusability** — same skill serves multiple task submissions

Example: A deployment operator defines a `deploy-app` skill; any downstream client can trigger deployment by submitting parameter values (branch, environment), without knowing deployment details.

---

## YAML Schema

### Common Fields

```yaml
name: unique-skill-name           # required, alphanumerics/dots/hyphens
type: shell | llm                 # required, execution type
description: Human-readable      # required
timeout: 120                      # optional, seconds (default 120, max 86400)
params:                           # optional, parameter list
  - name: param_name
    type: string | int | float | bool | text | json   # default: string
    default: value                # optional, used if not provided
    description: human-readable   # optional
```

### Shell Skills

Execute a bash script. Parameters passed as `SKILL_<NAME>` environment variables.

```yaml
name: deploy-app
type: shell
description: Deploy application to server
script: |
  #!/bin/bash
  set -euo pipefail

  echo "Deploying branch: $SKILL_BRANCH"
  echo "To environment: $SKILL_ENVIRONMENT"
  git checkout "$SKILL_BRANCH"
  ./deploy.sh "$SKILL_ENVIRONMENT"
params:
  - name: branch
    type: string
    default: main
  - name: environment
    type: string
    # no default = required
timeout: 300
env:                              # optional, static env vars
  DEPLOY_KEY: /secrets/deploy.key
  CI: "true"
```

**Execution:**
1. Parameters validated and coerced to their types
2. Script written to temp file with executable permissions
3. Bash spawned with merged environment (system + skill env + SKILL_* vars)
4. Output (stdout/stderr) streamed in real-time to task logs
5. Timeout enforced; process killed if it exceeds `timeout` seconds

**Security:** The script is trusted (on disk, authored by operator). Only parameter *values* come from untrusted task submitters. Bash env var expansion is safe from injection — `$SKILL_BRANCH` remains a literal string even if its value contains `; rm -rf /`.

### LLM Skills

Render a prompt template with parameter substitution and send to a local Ollama model.

```yaml
name: summarize
type: llm
description: Summarize text using LLM
model: mistral:7b
prompt: |
  Summarize the following text in {{style}} style:
  {{text}}
system: You are a helpful writing assistant.
temperature: 0.7
max_tokens: 512
params:
  - name: text
    type: text         # triggers textarea input
  - name: style
    type: string
    default: concise
```

**Execution:**
1. Parameters resolved with defaults and type coercion
2. Prompt template: `{{param_name}}` placeholders replaced with parameter values
3. Ollama API called with model + system prompt + rendered prompt
4. Response streamed back in real-time
5. Final response returned as structured JSON with metrics

**Security:** No shell injection risk — template rendering is text substitution only, no command parsing.

---

## Managing Skills

### Web UI (Agent Dashboard)

1. Navigate to **Skills** tab
2. **Editor section:**
   - Paste YAML directly, or
   - Click "Shell template" / "LLM template" for quick-start
   - Click "Save skill" to persist
3. **Upload section:**
   - Select a `.yaml` or `.yml` file from disk
   - Click "Upload"
4. **Installed skills list:**
   - Shows all discovered skills with metadata
   - Click "Delete" to remove a skill

### CLI

```bash
# List all skills
offload-agent skills list

# Validate a YAML file without importing
offload-agent skills validate /path/to/skill.yaml

# Import a skill from disk
offload-agent skills import /path/to/skill.yaml

# Export a skill to stdout
offload-agent skills export skill-name
```

### File Storage

Skills stored in `~/.offload-agent/custom/` by default (or `$OFFLOAD_CUSTOM_CAPS_DIR` env var).
The legacy path `~/.offload-agent/skills/` is still recognised for backward compatibility.

```
~/.offload-agent/custom/
  ├── deploy-app.yaml
  ├── summarize.yaml
  └── ...
```

---

## Submitting Tasks

Once a skill is registered, clients use the `CustomApp` sandbox or direct API to submit tasks.

### Via Management UI (CustomApp Sandbox)

1. Open management frontend
2. Select "Custom" app from tile grid
3. Select capability (e.g., `skill.deploy-app`)
4. Auto-generated form appears with fields for each parameter
5. Enter values, click "Run"
6. Results stream in real-time

### Via API

```bash
curl -X POST http://localhost:3069/api/task/submit \
  -H "Content-Type: application/json" \
  -d '{
    "capability": "skill.deploy-app",
    "urgent": false,
    "payload": {
      "branch": "feature/new-ui",
      "environment": "staging"
    },
    "apiKey": "client_secret_key_123"
  }'
```

Response includes task ID for polling:

```json
{
  "id": {
    "id": "abc123...",
    "cap": "skill.deploy-app"
  }
}
```

Poll for results:

```bash
curl -X POST http://localhost:3069/api/task/poll/skill.deploy-app/abc123 \
  -H "Content-Type: application/json" \
  -d '{"apiKey": "client_secret_key_123"}'
```

---

## Capability Strings

Skills register as extended capabilities:

```
skill.<name>[<param1>[:<type>];<param2>[:<type>];...]
```

Example: `skill.deploy-app[branch;environment]`

The extended attributes (`[...]`) are stripped when submitting tasks — clients always use the base capability.

---

## Examples

### Example 1: Database Backup (Shell Skill)

```yaml
name: backup-db
type: shell
description: Backup PostgreSQL database
script: |
  #!/bin/bash
  set -euo pipefail
  echo "Backing up $SKILL_DATABASE to $SKILL_BACKUP_DIR"
  pg_dump -U postgres "$SKILL_DATABASE" | gzip > "$SKILL_BACKUP_DIR/$SKILL_DATABASE-$(date +%s).sql.gz"
  echo "Backup complete"
params:
  - name: database
    description: Database name to backup
  - name: backup_dir
    description: Target directory for backup file
timeout: 600
env:
  PGPASSWORD: "postgres-password-from-env"
```

### Example 2: Code Review Prompt (LLM Skill)

```yaml
name: code-review
type: llm
description: Review code changes
model: mistral:7b
prompt: |
  Please review the following code changes for:
  - Bug risks
  - Performance issues
  - Code style inconsistencies

  {{code}}

  Focus on {{focus_area}}.
system: You are an expert code reviewer with experience in {{language}}.
temperature: 0.5
max_tokens: 1024
params:
  - name: code
    type: text
    description: Code snippet to review
  - name: language
    type: string
    default: python
  - name: focus_area
    type: string
    default: security
```

### Example 3: Multi-parameter CI Job (Shell Skill)

```yaml
name: run-tests
type: shell
description: Run test suite with custom options
script: |
  #!/bin/bash
  set -euo pipefail
  cd /app
  npm ci
  if [ "$SKILL_COVERAGE" = "true" ]; then
    npm run test:coverage
  else
    npm run test
  fi
  if [ "$SKILL_VERBOSE" = "true" ]; then
    npm run lint -- --format=detailed
  else
    npm run lint
  fi
params:
  - name: coverage
    type: bool
    default: "false"
  - name: verbose
    type: bool
    default: "false"
timeout: 180
```

---

## Type Hints for Parameters

| Type | Input Control | Coercion | Use Case |
|------|---------------|----------|----------|
| `string` | text input | none | Short text, names, paths |
| `int` / `integer` | number input | `parseInt()` | Counts, IDs, ports |
| `float` / `number` / `double` | number input (step=any) | `parseFloat()` | Decimals, percentages |
| `bool` / `boolean` | checkbox or true/false | `=== "true"` | Flags, toggles |
| `text` | textarea | none | Long text, multi-line |
| `json` / `object` | textarea | `JSON.parse()` | Structured data, configs |

---

## Troubleshooting

### Skill Not Detected

1. Check file is valid YAML: `offload-agent skills validate /path/to/skill.yaml`
2. Check filename matches skill name: e.g., `deploy-app.yaml` for skill named `deploy-app`
3. Rescan in web UI: **Capabilities** tab → **Rescan**
4. Check skills directory:
   ```bash
   echo $OFFLOAD_CUSTOM_CAPS_DIR  # if set
   ls -la ~/.offload-agent/custom/
   ls -la ~/.offload-agent/skills/  # legacy location
   ```

### Shell Skill Timeout

Increase `timeout` field (in seconds). Check if the script hangs or waits for input:

```bash
# Test script manually
bash /path/to/script.sh
```

### LLM Skill Not Generating

1. Verify Ollama is running: `curl http://localhost:11434`
2. Verify model is installed: `ollama list`
3. Check `model` field matches installed model exactly
4. Test prompt manually:
   ```bash
   curl http://localhost:11434/api/chat -d '{
     "model": "mistral:7b",
     "messages": [{"role": "user", "content": "Your prompt here"}]
   }'
   ```

### Parameter Validation Error

1. Check parameter names match `{{name}}` placeholders in LLM prompts
2. Verify type coercion: e.g., `int` parameters must parse as integers
3. Check for required parameters (no `default` value) — must be provided

---

## Best Practices

1. **Test before deploying** — validate with `offload-agent skills validate` and run manually
2. **Use defaults wisely** — reduce parameter burden for common scenarios
3. **Document parameters** — include descriptions in YAML for UI clarity
4. **Set reasonable timeouts** — prevent accidental resource exhaustion
5. **Shell: use `set -euo pipefail`** — fail fast on errors
6. **LLM: keep prompts focused** — simpler prompts = faster, more reliable responses
7. **Version skills** — use version suffixes if you need multiple variants (`deploy-app-v1`, `deploy-app-v2`)

---

## API Reference

### Task Submission Endpoint

**Endpoint:** `POST /api/task/submit`

**Request:**
```json
{
  "capability": "skill.name",
  "payload": { "param1": "value1", "param2": 42 },
  "urgent": false,
  "apiKey": "client_api_key"
}
```

**Response:**
```json
{
  "id": {
    "id": "task-uuid",
    "cap": "skill.name"
  }
}
```

### Task Polling Endpoint

**Endpoint:** `POST /api/task/poll/skill.name/{task-id}`

**Request:**
```json
{
  "apiKey": "client_api_key"
}
```

**Response (running):**
```json
{
  "status": "running",
  "log": "... output so far ..."
}
```

**Response (completed):**
```json
{
  "status": "completed",
  "output": {
    "stdout": "...",
    "stderr": "",
    "return_code": 0
  }
}
```

---

## Integration with CustomApp Sandbox

The [CustomApp](../management-frontend/src/components/CustomApp.jsx) sandbox component auto-detects skills and generates forms:

1. Fetches all extended capabilities: `GET /management/capabilities/list/online_ext` (standalone clients can use `POST /api/capabilities/list/online_ext` with a client API key — see [tasks-api.md](tasks-api.md#get-online-capabilities-extended-client-filtered))
2. Parses attributes to build field list
3. Generates input controls based on type hints
4. Submits task with validated payload
5. Polls and displays results in terminal-style output

Custom skills work seamlessly with this UI without any additional configuration.
