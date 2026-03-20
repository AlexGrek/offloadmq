# Custom Capabilities Convention

Custom capabilities let any agent expose arbitrary services through OffloadMQ without changes to the server. This document defines the naming, payload, and extended-attribute conventions so that agents and client apps can interoperate consistently.

---

## Table of Contents

1. [Overview](#overview)
2. [Naming Convention](#naming-convention)
3. [Extended Attributes as Field Descriptors](#extended-attributes-as-field-descriptors)
4. [Payload Convention](#payload-convention)
5. [Response Convention](#response-convention)
6. [Agent Implementation](#agent-implementation)
7. [Client Implementation](#client-implementation)
8. [Management UI (Custom Sandbox App)](#management-ui-custom-sandbox-app)
9. [Examples](#examples)

---

## Overview

OffloadMQ's scheduler is capability-agnostic — it matches tasks to agents by string prefix only (after stripping extended attributes). This means any agent can register an arbitrary capability string and any client can submit tasks targeting it, with no server-side changes required.

Custom capabilities build on the existing **extended attribute** system (`base.cap[attr1;attr2]`) to communicate the payload schema directly in the capability string. This lets generic client apps (like the management UI sandbox) auto-generate input forms and submit tasks without prior knowledge of the capability.

---

## Naming Convention

Custom capability names follow the same dot-separated hierarchy as built-in capabilities:

```
<namespace>.<service>[<field_descriptors>]
```

### Namespaces

| Prefix | Purpose | Example |
|--------|---------|---------|
| `custom.*` | User-defined generic services | `custom.weather[city;units]` |
| `ml.*` | Machine learning / inference | `ml.classify[model;image:file]` |
| `data.*` | Data processing / ETL | `data.transform[query:text;format]` |
| `tool.*` | External tool integrations | `tool.jira[action;project;summary:text]` |

You may also use any namespace not already claimed by built-in capabilities (`debug.`, `shell.`, `shellcmd.`, `docker.`, `llm.`, `imggen.`, `tts.`).

### Rules

- Base capability (before `[`) is used for task routing — it must match exactly between client submission and agent registration.
- Dots separate hierarchy levels: `custom.weather`, `ml.classify.bert`.
- Colons separate variant/version: `ml.classify:v2`, `custom.translate:en-fr`.
- No spaces or special characters other than `.`, `:`, `-`, `_`.

---

## Extended Attributes as Field Descriptors

Extended attributes (the `[...]` bracket notation) serve a dual purpose for custom capabilities:

1. **Informational** — describe what the capability supports (same as built-in capabilities)
2. **Schema declaration** — declare the expected payload fields so generic clients can auto-generate forms

### Attribute Format

Each semicolon-separated attribute can be:

| Format | Meaning | Example |
|--------|---------|---------|
| `name` | A string field (or a boolean flag) | `city` |
| `name:type` | A typed field | `temperature:float` |

### Supported Type Hints

| Type hint | Meaning | Client input | Coercion |
|-----------|---------|-------------|----------|
| *(none)* | String (default) | Text input | None |
| `string` | Explicit string | Text input | None |
| `int`, `integer` | Integer number | Number input | `parseInt()` |
| `float`, `number`, `double` | Decimal number | Number input (step=any) | `parseFloat()` |
| `bool`, `boolean` | Boolean flag | Text input ("true"/"false") | `=== "true"` |
| `text` | Multi-line string | Textarea | None |
| `json`, `object` | Structured JSON | Textarea | `JSON.parse()` |
| `file` | File reference (informational) | — | — |

### Examples

```
custom.weather[city;units]
  → fields: { city: string, units: string }

custom.translate[text:text;source_lang;target_lang]
  → fields: { text: (textarea), source_lang: string, target_lang: string }

ml.predict[model;input:json;temperature:float;max_tokens:int]
  → fields: { model: string, input: (textarea/JSON), temperature: float, max_tokens: int }
```

---

## Payload Convention

The task payload for custom capabilities is a **flat JSON object** where keys match the field names from extended attributes.

### Rules

1. **Keys match attribute names** — the payload object keys correspond 1:1 to the field names in `[...]`.
2. **Values use declared types** — clients coerce values according to type hints before submission.
3. **Extra keys are allowed** — agents should ignore unknown fields gracefully.
4. **Missing optional fields** — agents should handle missing fields with sensible defaults.

### Example

Capability: `custom.weather[city;units;days:int]`

Client submits:
```json
{
  "capability": "custom.weather",
  "payload": {
    "city": "Berlin",
    "units": "metric",
    "days": 5
  },
  "apiKey": "...",
  "urgent": false
}
```

Note: the `capability` field is always the **base capability** (no brackets).

---

## Response Convention

Agents should return results as a JSON object in the task's `output` field. There is no strict schema, but following these patterns helps generic clients render results:

### Standard Output Fields

| Field | Type | Purpose |
|-------|------|---------|
| `stdout` | string | Primary text output (rendered in terminal-style box) |
| `stderr` | string | Error/warning text |
| `result` | any | Structured result data |
| `error` | string | Error message (on failure) |

### Recommended Pattern

For text-heavy results:
```json
{
  "stdout": "Berlin: 18°C, partly cloudy\nForecast: ...",
  "stderr": ""
}
```

For structured results:
```json
{
  "result": {
    "city": "Berlin",
    "current": { "temp": 18, "condition": "partly cloudy" },
    "forecast": [...]
  }
}
```

Both patterns are handled by the management UI's `TerminalOutput` component — it renders `stdout`/`stderr` with distinct styling, or falls back to pretty-printed JSON.

---

## Agent Implementation

### Registering Custom Capabilities

Agents register custom capabilities the same way as built-in ones — via the `capabilities` array in the registration request. Extended attributes are included in the string.

**Via config file** (`.offload-agent.json`):
```json
{
  "custom_caps": [
    "custom.weather[city;units;days:int]",
    "tool.jira[action;project;summary:text]"
  ]
}
```

**Via web UI:**
1. Open the web UI (`offload-agent webui`)
2. On the **Capabilities** card, click **+ Add custom capability**
3. Enter the full capability string including `[...]` attributes
4. Click **Register**

### Routing to an Executor

The agent's `route_executor()` function in `app/core.py` dispatches tasks based on capability prefix. To handle a custom capability, add a route:

```python
def route_executor(cap: str):
    # ... existing routes ...

    if cap.startswith("custom.weather"):
        return execute_weather_query

    # Fall through to None → "Unknown capability" error
    return {
        "debug.echo": execute_debug_echo,
        # ...
    }.get(cap)
```

### Executor Function Signature

All executors follow the same signature:

```python
def execute_my_custom(http, task_id, capability, payload, data_path):
    """
    Args:
        http:       AuthenticatedHttpClient for server communication
        task_id:    dict with 'cap' and 'id'
        capability: str, the base capability name
        payload:    dict, the task payload (field values from client)
        data_path:  Path, temporary working directory for this task
    """
    # 1. Read fields from payload
    city = payload.get("city", "London")
    units = payload.get("units", "metric")

    # 2. Send progress updates
    http.report_progress(task_id, stage="querying", log="Fetching weather data...")

    # 3. Do the work
    result = fetch_weather(city, units)

    # 4. Report success
    report = make_success_report(task_id, capability, {
        "stdout": f"{city}: {result['temp']}°{units[0].upper()}, {result['condition']}",
        "stderr": ""
    })
    http.resolve_task(task_id, report)
```

### Handling Unknown Custom Capabilities

If an agent registers a custom capability but has no executor for it, `route_executor()` returns `None` and the task fails with `"Unknown capability: ..."`. This is the expected behavior — agents should only register capabilities they can execute.

---

## Client Implementation

### Discovering Custom Capabilities

Clients discover available capabilities through the API:

**Client API** (filtered by API key permissions):
```
POST /api/capabilities/online
{ "apiKey": "..." }
→ ["custom.weather", "ml.predict", ...]  // base capabilities only
```

**Management API** (all capabilities, with extended attributes):
```
GET /management/capabilities/list/online_ext
Authorization: Bearer <mgmt-token>
→ ["custom.weather[city;units;days:int]", "ml.predict[model;input:json]", ...]
```

### Parsing Field Descriptors

To auto-generate input forms, parse extended attributes from the capability string:

```javascript
import { stripCapabilityAttrs, parseCapabilityAttrs } from './utils';

const cap = 'custom.weather[city;units;days:int]';

stripCapabilityAttrs(cap);    // → 'custom.weather'
parseCapabilityAttrs(cap);    // → ['city', 'units', 'days:int']

// Parse each attribute into a field descriptor:
// 'city'       → { name: 'city',  hint: null }
// 'units'      → { name: 'units', hint: null }
// 'days:int'   → { name: 'days',  hint: 'int' }
```

### Building the Payload

Construct a flat JSON object from field values, coercing types:

```javascript
const payload = {};
fields.forEach(field => {
  let value = userInput[field.name];
  if (field.hint === 'int')   value = parseInt(value, 10);
  if (field.hint === 'float') value = parseFloat(value);
  if (field.hint === 'bool')  value = value === 'true';
  if (field.hint === 'json')  value = JSON.parse(value);
  payload[field.name] = value;
});
```

### Submitting the Task

```javascript
const response = await fetch('/api/task/submit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    capability: stripCapabilityAttrs(selectedCapability),  // base only
    payload,
    urgent: false,
    apiKey,
  }),
});
```

### Polling for Results

Use the standard polling mechanism — custom capabilities follow the same task lifecycle as built-in ones. See [tasks-api.md](tasks-api.md#poll-task-status).

---

## Management UI (Custom Sandbox App)

The management frontend includes a **Custom** sandbox app (`CustomApp.jsx`) that implements the full client flow:

1. Fetches all online capabilities (with extended attributes) from `/management/capabilities/list/online_ext`
2. Presents a dropdown of all available capabilities
3. Parses `[...]` attributes into input fields with type-appropriate controls
4. Optionally allows raw JSON payload editing via a toggle
5. Submits non-urgent tasks and polls for logs + results
6. Renders output in a terminal-style box

This app serves as the **reference client implementation** for custom capabilities.

---

## Examples

### Weather Service

**Agent registers:**
```
custom.weather[city;units;days:int]
```

**Client submits:**
```json
{
  "capability": "custom.weather",
  "payload": { "city": "Tokyo", "units": "metric", "days": 3 }
}
```

**Agent responds:**
```json
{
  "stdout": "Tokyo — 22°C, sunny\n3-day forecast:\n  Mon: 23°C\n  Tue: 20°C\n  Wed: 19°C",
  "stderr": ""
}
```

---

### ML Inference

**Agent registers:**
```
ml.classify:bert[text:text;labels:json;multi_label:bool]
```

**Client submits:**
```json
{
  "capability": "ml.classify:bert",
  "payload": {
    "text": "The new iPhone has amazing camera quality",
    "labels": ["technology", "sports", "politics", "entertainment"],
    "multi_label": false
  }
}
```

**Agent responds:**
```json
{
  "result": {
    "label": "technology",
    "confidence": 0.94,
    "scores": {
      "technology": 0.94,
      "entertainment": 0.04,
      "sports": 0.01,
      "politics": 0.01
    }
  }
}
```

---

### Code Execution Sandbox

**Agent registers:**
```
tool.sandbox[language;code:text;timeout:int]
```

**Client submits:**
```json
{
  "capability": "tool.sandbox",
  "payload": {
    "language": "python",
    "code": "import math\nprint(math.pi)",
    "timeout": 10
  }
}
```

**Agent responds:**
```json
{
  "stdout": "3.141592653589793\n",
  "stderr": "",
  "return_code": 0
}
```

---

### Database Query

**Agent registers:**
```
data.query[database;sql:text;format]
```

**Client submits:**
```json
{
  "capability": "data.query",
  "payload": {
    "database": "analytics",
    "sql": "SELECT count(*) AS total FROM events WHERE date > '2026-01-01'",
    "format": "json"
  }
}
```

**Agent responds:**
```json
{
  "result": {
    "columns": ["total"],
    "rows": [[42857]],
    "row_count": 1,
    "duration_ms": 145
  }
}
```
