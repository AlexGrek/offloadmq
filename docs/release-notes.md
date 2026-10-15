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
