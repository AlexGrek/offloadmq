"""
ComfyUI / imggen workflow helpers for the agent web UI.

Workflow listing, param-map metadata, and graph validation.  The HTTP routes live in
``ui_server.api``; the param auto-detection engine lives in ``comfy_autowire``.
"""

from __future__ import annotations

import json as json_module
import shutil
from typing import Any

from offloadmq_agent.comfy_workflows import (
    BUNDLE_FORMAT,
    NAMESPACED_PREFIXES as _NAMESPACED_PREFIXES,
    PARAM_FIELD_KEY_RE as _PARAM_FIELD_KEY_RE,
    WF_SAFE_RE,
    export_workflow,
    import_workflow,
    is_wire,
    list_workflows,
    parse_workflow_ref,
    resolve_graph_path as _resolve_workflow_graph_path,
    validate_graph as _validate_comfy_api_workflow,
    validate_param_map as _validate_param_map,
    workflows_dir,
)
from offloadmq_core.comfy_autowire import guess_params, guess_params_ex

__all__ = [
    "STANDARD_TASK_TYPES",
    "guess_params",
    "guess_params_ex",
    "list_workflows",
    "workflows_dir",
    "add_workflow",
    "get_workflow_graph",
    "delete_workflow",
    "export_workflow",
    "import_workflow",
    "parse_workflow_ref",
    "BUNDLE_FORMAT",
    "get_param_map",
    "save_param_map",
    "autodetect_param_map",
]

STANDARD_TASK_TYPES = [
    "txt2img",
    "img2img",
    "inpaint",
    "outpaint",
    "upscale",
    "face_swap",
    "txt2video",
    "img2video",
    "txt2music",
    "depth",
]


def _is_comfy_wire_ref(value: Any) -> bool:
    return is_wire(value)


def _param_ui_txt_base_rows() -> list[dict[str, str]]:
    return [
        {"key": "prompt", "label": "Main prompt", "help": "payload.prompt"},
        {
            "key": "negative",
            "label": "Negative prompt",
            "help": "payload.secondary_prompts.negative",
        },
        {"key": "width", "label": "Width", "help": "payload.resolution.width"},
        {"key": "height", "label": "Height", "help": "payload.resolution.height"},
        {"key": "seed", "label": "Random seed", "help": "payload.seed"},
    ]


_PARAM_UI_ROWS: dict[str, list[dict[str, str]]] = {
    "txt2img": _param_ui_txt_base_rows(),
    "img2img": _param_ui_txt_base_rows()
    + [
        {
            "key": "input_image",
            "label": "Input image (main)",
            "help": "payload.input_image (bucket file)",
        },
    ],
    "inpaint": _param_ui_txt_base_rows()
    + [
        {
            "key": "input_image",
            "label": "Input image (main)",
            "help": "payload.input_image (bucket file)",
        },
    ],
    "outpaint": _param_ui_txt_base_rows()
    + [
        {
            "key": "input_image",
            "label": "Input image (main)",
            "help": "payload.input_image (bucket file)",
        },
    ],
    "upscale": _param_ui_txt_base_rows()
    + [
        {
            "key": "input_image",
            "label": "Input image (main)",
            "help": "payload.input_image (bucket file)",
        },
        {"key": "upscale", "label": "Upscale factor", "help": "payload.upscale"},
    ],
    "face_swap": _param_ui_txt_base_rows()
    + [
        {
            "key": "input_image",
            "label": "Input image (main)",
            "help": "payload.input_image (bucket file)",
        },
        {
            "key": "face_swap",
            "label": "Face reference image",
            "help": "payload.face_swap (bucket file)",
        },
    ],
    "txt2video": _param_ui_txt_base_rows()
    + [{"key": "length", "label": "Video length (frames)", "help": "payload.length"}],
    "img2video": _param_ui_txt_base_rows()
    + [
        {"key": "length", "label": "Video length (frames)", "help": "payload.length"},
        {
            "key": "input_image",
            "label": "Input image (main)",
            "help": "payload.input_image (bucket file)",
        },
    ],
    "txt2music": [
        {"key": "tags", "label": "Style / genre tags", "help": "payload.tags"},
        {"key": "lyrics", "label": "Lyrics", "help": "payload.lyrics"},
        {"key": "bpm", "label": "BPM", "help": "payload.bpm"},
        {"key": "duration", "label": "Duration (seconds)", "help": "payload.duration"},
        {"key": "timesignature", "label": "Time signature", "help": "payload.timesignature"},
        {"key": "language", "label": "Language", "help": "payload.language"},
        {"key": "keyscale", "label": "Key / scale", "help": "payload.keyscale"},
        {"key": "cfg_scale", "label": "CFG scale", "help": "payload.cfg_scale"},
        {"key": "temperature", "label": "Temperature", "help": "payload.temperature"},
        {"key": "seed", "label": "Random seed", "help": "payload.seed"},
    ],
}


_INPUT_IMAGE_ROW = {
    "key": "input_image",
    "label": "Input image (main)",
    "help": "payload.input_image (bucket file)",
}
_FACE_REF_ROW = {
    "key": "face_swap",
    "label": "Face reference image",
    "help": "payload.face_swap (bucket file)",
}
_SCALE_MULTIPLIER_ROW = {
    "key": "scale_multiplier",
    "label": "Scale multiplier",
    "help": "payload.secondary_prompts.scale_multiplier",
}

# img-utils operations take images (plus, for upscale, one scalar) and nothing
# else — no prompt, no resolution, no seed. Keyed separately from _PARAM_UI_ROWS
# because a task type alone is ambiguous: `face_swap`/`upscale` under img-utils
# have no prompt, while the flat imggen models of the same name do.
_IMG_UTILS_PARAM_UI_ROWS: dict[str, list[dict[str, str]]] = {
    "depth": [_INPUT_IMAGE_ROW],
    "face_swap": [_INPUT_IMAGE_ROW, _FACE_REF_ROW],
    "upscale": [_INPUT_IMAGE_ROW, _SCALE_MULTIPLIER_ROW],
}

IMG_UTILS_NAMESPACE = "img-utils"


def _param_ui_standard_rows(task_type: str, namespace: str = "") -> list[dict[str, str]]:
    if namespace == IMG_UTILS_NAMESPACE:
        return list(_IMG_UTILS_PARAM_UI_ROWS.get(task_type, [_INPUT_IMAGE_ROW]))
    rows = _PARAM_UI_ROWS.get(task_type)
    if rows is None:
        return []
    return list(rows)


def _standard_param_field_keys(task_type: str, namespace: str = "") -> set:
    return {r["key"] for r in _param_ui_standard_rows(task_type, namespace)}


def _preview_comfy_slot_value(val: Any) -> str:
    if _is_comfy_wire_ref(val):
        return f"wire [{val[0]},{val[1]}]"
    if val is None:
        return "null"
    if isinstance(val, bool):
        return "true" if val else "false"
    if isinstance(val, (int, float)):
        return str(val)
    if isinstance(val, str):
        t = val.replace("\n", " ")
        if len(t) > 56:
            return t[:53] + "..."
        return t
    text = json_module.dumps(val, separators=(",", ":"))
    if len(text) > 64:
        return text[:61] + "..."
    return text


def _sort_node_id_keys(node_ids: list[str]) -> list[str]:
    def sort_key(n: str) -> tuple:
        s = str(n)
        if s.isdigit():
            return (0, int(s))
        return (1, s)

    return sorted(node_ids, key=sort_key)


def _build_comfy_input_options(graph: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for nid in _sort_node_id_keys(list(graph.keys())):
        node = graph[nid]
        ct = node.get("class_type", "")
        inputs = node.get("inputs") or {}
        if not isinstance(inputs, dict):
            continue
        for in_name in sorted(inputs.keys()):
            val = inputs[in_name]
            out.append(
                {
                    "node_id": str(nid),
                    "input_name": str(in_name),
                    "class_type": str(ct),
                    "kind": "wire" if _is_comfy_wire_ref(val) else "literal",
                    "preview": _preview_comfy_slot_value(val),
                }
            )
    return out


# ----------------------------------------------------------------------
# Public workflow/param-map operations
#
# These own the validate → resolve-path → read/write sequence that the UI
# routes need, so ``ui_server.api`` never has to reach into the
# underscore-prefixed helpers above directly (see SKILL.md: ui-server never
# imports core — these are the OrchestratorAPI-facing entry points core
# exposes instead).
# ----------------------------------------------------------------------


def add_workflow(workflow_name: str, task_type: str, namespace: str, graph_json: str) -> None:
    """Validate and persist a new ComfyUI workflow graph JSON.

    Raises ``ValueError`` (also covers ``json.JSONDecodeError``, a ``ValueError``
    subclass) for invalid names or malformed/invalid graph shape.
    """
    graph = json_module.loads(graph_json)
    _validate_comfy_api_workflow(graph)
    path = _resolve_workflow_graph_path(workflow_name, task_type, namespace)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json_module.dumps(graph, indent=2))


def get_workflow_graph(workflow_name: str, task_type: str, namespace: str = "") -> str:
    """Raw graph JSON text for one workflow/task-type, for the UI's JSON editor.

    Raises ``ValueError`` for invalid names, ``FileNotFoundError`` if the workflow
    graph doesn't exist.
    """
    graph_path = _resolve_workflow_graph_path(workflow_name, task_type, namespace)
    if not graph_path.exists():
        raise FileNotFoundError("workflow graph JSON not found")
    return graph_path.read_text()


def delete_workflow(workflow_name: str, namespace: str = "") -> None:
    wdir = workflows_dir()
    ns = namespace.strip()
    name = workflow_name.strip()
    target = (wdir / ns / name) if ns else (wdir / name)
    if target.is_dir():
        shutil.rmtree(target)


def get_param_map(workflow_name: str, task_type: str, namespace: str = "") -> dict[str, Any]:
    """Full param-map editor payload for one workflow/task-type.

    Raises ``ValueError`` for invalid names/malformed graph JSON, ``FileNotFoundError``
    if the workflow graph itself doesn't exist.
    """
    graph_path = _resolve_workflow_graph_path(workflow_name, task_type, namespace)
    if not graph_path.exists():
        raise FileNotFoundError("workflow graph JSON not found")
    try:
        graph = json_module.loads(graph_path.read_text())
    except json_module.JSONDecodeError as exc:
        raise ValueError(f"invalid graph JSON: {exc}") from exc

    params_path = graph_path.with_suffix(".params.json")
    params: dict[str, Any] = {}
    if params_path.exists():
        try:
            loaded = json_module.loads(params_path.read_text())
            if isinstance(loaded, dict):
                params = loaded
        except json_module.JSONDecodeError:
            pass

    std_keys = _standard_param_field_keys(task_type, namespace)
    extra_keys = sorted(k for k in params if k not in std_keys and _PARAM_FIELD_KEY_RE.match(k))

    return {
        "ok": True,
        "params": params,
        "standard_fields": _param_ui_standard_rows(task_type, namespace),
        "extra_keys": extra_keys,
        "input_options": _build_comfy_input_options(graph),
        # Notes explain why a field is left unwired. Only autodetect produces
        # them; they are not persisted. Present here so both responses share
        # one shape.
        "notes": {},
    }


def save_param_map(workflow_name: str, task_type: str, namespace: str, params: Any) -> None:
    """Raises ``ValueError`` for an invalid param map, ``FileNotFoundError`` if the
    workflow graph doesn't exist."""
    graph_path = _resolve_workflow_graph_path(workflow_name, task_type, namespace)
    if not graph_path.exists():
        raise FileNotFoundError("workflow graph JSON not found")
    _validate_param_map(params)
    pmap = graph_path.with_suffix(".params.json")
    pmap.write_text(json_module.dumps(params, indent=2))


def autodetect_param_map(
    workflow_name: str, task_type: str, namespace: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Guess a param map from the graph shape. Returns ``(param_map, notes)``.

    Raises ``ValueError`` for invalid names/malformed or invalid graph JSON,
    ``FileNotFoundError`` if the workflow graph doesn't exist.
    """
    graph_path = _resolve_workflow_graph_path(workflow_name, task_type, namespace)
    if not graph_path.exists():
        raise FileNotFoundError("workflow graph JSON not found")
    try:
        graph = json_module.loads(graph_path.read_text())
    except json_module.JSONDecodeError as exc:
        raise ValueError(f"invalid graph JSON: {exc}") from exc
    _validate_comfy_api_workflow(graph)
    params, notes = guess_params_ex(graph, task_type, namespace)
    pmap = graph_path.with_suffix(".params.json")
    pmap.write_text(json_module.dumps(params, indent=2))
    return params, notes
