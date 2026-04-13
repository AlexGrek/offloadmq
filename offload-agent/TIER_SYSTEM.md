# 3-Tier Capability System

## Overview

The agent now uses a 3-tier capability system that eliminates conflicts between config and scan results while providing appropriate security controls for different capability types.

## The Three Tiers

### Tier 1: Slavemode (Control Operations)
- **Security Model:** Opt-in only
- **Config Key:** `slavemode-allowed-caps`
- **Examples:** `slavemode.force-rescan`, `slavemode.special-caps-ctrl`
- **Purpose:** Server-initiated control operations on the agent
- **UI Location:** Separate "Slavemode" tab
- **Default:** All disabled, must be explicitly enabled
- **Unchanged:** This tier was already implemented separately

### Tier 2: Sensitive Capabilities
- **Security Model:** Opt-in (must be explicitly allowed)
- **Config Key:** `sensitive-allowed-caps`
- **Examples:** `docker.*`, `shell.*`, `shellcmd.*`
- **Purpose:** Security-sensitive operations that can execute arbitrary code
- **UI Location:** "Sensitive Capabilities" section in Capabilities tab
- **Default:** All disabled even if detected, must be explicitly enabled
- **Rationale:** These capabilities can be used to execute arbitrary commands, so they require explicit user permission

### Tier 3: Regular Capabilities
- **Security Model:** Opt-out (enabled by default if detected)
- **Config Key:** `regular-disabled-caps`
- **Examples:** `llm.*`, `imggen.*`, `tts.*`, `debug.*`, `custom.*`
- **Purpose:** Standard task processing capabilities
- **UI Location:** "Regular Capabilities" section in Capabilities tab
- **Default:** All enabled if detected, user can disable specific ones
- **Rationale:** These are the primary task-processing capabilities that users typically want enabled

## How It Works

### Detection → Registration Flow

1. **Capability Scan** (`detect_capabilities()`)
   - Detects all available capabilities on the system
   - Returns raw list with extended attributes

2. **Classification** (`classify_capabilities()`)
   - Splits detected capabilities into: regular, sensitive, unknown
   - Unknown capabilities are treated as regular (opt-out)

3. **Registration** (`compute_registration_caps()`)
   - **Regular:** Enabled by default, exclude those in `regular-disabled-caps`
   - **Sensitive:** Disabled by default, include only those in `sensitive-allowed-caps`
   - **Slavemode:** Include only those in `slavemode-allowed-caps`

### Config Schema

#### New Format (Post-Migration)
```json
{
  "sensitive-allowed-caps": ["docker.any"],
  "regular-disabled-caps": ["debug.echo"],
  "slavemode-allowed-caps": ["slavemode.force-rescan"]
}
```

#### Legacy Format (Auto-Migrated)
```json
{
  "capabilities": ["debug.echo", "docker.any", "llm.qwen3:8b"]
}
```

When the old `capabilities` key is detected, it's automatically migrated:
- Sensitive caps that were selected → added to `sensitive-allowed-caps`
- Regular caps that were NOT selected → added to `regular-disabled-caps`
- Legacy key is preserved for backwards compatibility but ignored going forward

## UI Changes

### Capabilities Tab (Tiers 2-3)
Now displays two sections:

1. **Regular Capabilities** (green accent)
   - Checkboxes default to CHECKED (opt-out)
   - Unchecking a capability disables it
   - Label: "Enabled by default (uncheck to disable)"

2. **Sensitive Capabilities** (amber accent)
   - Checkboxes default to UNCHECKED (opt-in)
   - Checking a capability enables it
   - Label: "Disabled by default (check to enable)"

### Slavemode Tab (Tier 1)
Unchanged, but clarified:
- Title updated to "Slavemode (Tier 1: Control Operations)"
- Description emphasizes opt-in security model

## Migration Behavior

### First Run After Upgrade
If a user has the old `capabilities` config key:

1. On first call to `compute_registration_caps()`:
   - System detects legacy format
   - Migrates to tier-based format
   - Logs migration message
   - Saves config automatically

2. Migration logic:
   - Previously selected sensitive caps → `sensitive-allowed-caps`
   - Previously NOT selected regular caps → `regular-disabled-caps`
   - Legacy key preserved (for potential downgrade)

3. Example:
   ```
   Old: capabilities = ["debug.echo", "docker.any", "llm.qwen3:8b"]
   Detected: ["debug.echo", "shell.bash", "docker.any", "llm.qwen3:8b", "imggen.workflow1[txt2img]"]

   New:
     sensitive-allowed-caps = ["docker.any"]  # Was selected, is sensitive
     regular-disabled-caps = ["imggen.workflow1[txt2img]"]  # Was NOT selected, is regular
   ```

### Subsequent Runs
- Uses tier-based keys exclusively
- Legacy `capabilities` key is ignored if tier keys exist

## Benefits

### 1. Eliminates Config/Scan Conflicts
**Before:** User selected caps in config, but scan might find different caps → conflict
**After:**
- Regular caps: Scan finds them, config only tracks DISABLED ones
- Sensitive caps: Scan finds them, config only tracks ALLOWED ones
- No more conflicts!

### 2. Better Security Defaults
**Before:** All detected caps enabled by default (including docker/shell)
**After:**
- Dangerous capabilities (docker, shell) disabled by default
- Must be explicitly enabled by user
- Regular capabilities (llm, imggen) enabled by default for convenience

### 3. Clearer User Intent
**Before:** Long list of checkboxes, unclear what happens when you add new hardware
**After:**
- Regular: "I want to disable these specific ones"
- Sensitive: "I want to enable these specific ones"
- Slavemode: "I want to allow these control operations"

### 4. Future-Proof
When new capabilities are added:
- **Regular caps:** Automatically enabled (opt-out)
- **Sensitive caps:** Automatically disabled (opt-in)
- No config changes needed for regular expansion

## Testing

Run the test suite to verify the system works correctly:

```bash
cd offload-agent
venv/bin/python test_tier_system.py
```

Tests cover:
- Capability classification
- Fresh config with tier system
- Legacy config migration
- Empty config defaults

## Code Changes

### Files Modified

1. **`app/capabilities.py`**
   - Added `is_sensitive_capability()`, `is_regular_capability()`
   - Added `classify_capabilities()`
   - Rewrote `compute_registration_caps()` for tier system
   - Added `_migrate_legacy_config()` for automatic migration

2. **`webui.py`**
   - Added `_get_tier_caps()` for tier-separated data
   - Updated `_build_api_state()` to include `tier_caps` field
   - Updated `POST /capabilities` to handle tier-based saves
   - Maintains backwards compatibility with legacy format

3. **`frontend/src/components/CapabilitiesTab.jsx`**
   - Complete rewrite for 2-section display
   - Separate state management for regular (disabled) and sensitive (allowed)
   - Visual distinction with color coding
   - Clear labels for opt-in vs opt-out models

4. **`frontend/src/components/SlavemodeTab.jsx`**
   - Updated title to clarify tier position
   - Enhanced description to emphasize opt-in model

### Files Created

1. **`test_tier_system.py`** - Comprehensive test suite
2. **`TIER_SYSTEM.md`** - This documentation

## API Response Changes

The `/api/state` endpoint now includes:

```json
{
  "tier_caps": {
    "regular": {
      "all": ["llm.qwen3:8b", "imggen.workflow1[txt2img]", ...],
      "disabled": ["debug.echo"]
    },
    "sensitive": {
      "all": ["docker.any", "shell.bash", ...],
      "allowed": ["docker.any"]
    },
    "detected_raw": ["debug.echo", "shell.bash", "docker.any", ...]
  },
  // Legacy fields preserved for backwards compatibility
  "all_caps": [...],
  "selected_caps": [...],
  "capabilities": [...]
}
```

## Backwards Compatibility

- Old `capabilities` config key still works (auto-migrated on first use)
- API response includes legacy fields (`all_caps`, `selected_caps`)
- Legacy POST format (`caps` form field) still accepted
- Config downgrade: legacy key is preserved during migration
