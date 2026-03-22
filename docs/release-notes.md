# Release Notes

## v0.2.236

### Custom capabilities directory renamed to `~/.offload-agent/custom/`

The default directory for custom capability (skill) YAML files has been renamed from
`~/.offload-agent/skills/` to `~/.offload-agent/custom/`.

**Backward compatibility is preserved** — the agent checks for `~/.offload-agent/custom/`
first, then falls back to `~/.offload-agent/skills/` if it exists. No immediate action is
required; existing setups continue to work without changes.

To migrate manually:

```bash
mv ~/.offload-agent/skills ~/.offload-agent/custom
```

The `OFFLOAD_CUSTOM_CAPS_DIR` environment variable override is unchanged.

### Ansible: native custom skills support

The `offload_agent` Ansible role now has first-class support for deploying custom skills
to agent nodes:

- `offload_agent_skills` — list of YAML skill file paths on the Ansible controller
- `offload_agent_skills_dir` — deploy all `*.yaml`/`*.yml` files from a local directory
- `offload_agent_skills_path` — remote destination (default: `~/.offload-agent/custom/`)

Capability strings (including typed parameter attributes) are derived automatically from
the YAML files and merged into the registration payload — no need to repeat them in
`offload_agent_capabilities`. See [ansible/README.md](../ansible/README.md) for usage examples.
