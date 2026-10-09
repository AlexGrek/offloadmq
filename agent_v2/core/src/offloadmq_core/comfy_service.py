"""
ComfyUI / imggen workflow helpers for the agent web UI.

Workflow listing, param-map metadata, and graph validation.  The HTTP routes live in
``ui_server.api``; the param auto-detection engine lives in ``comfy_autowire``.
"""

from __future__ import annotations

import json as json_module
import re
import shutil
from pathlib import Path
from typing import Any

from offloadmq_core.comfy_autowire import guess_params, guess_params_ex, is_wire

__all__ = [
    "STANDARD_TASK_TYPES",
    "guess_params",
    "guess_params_ex",
    "list_workflows",
    "workflows_dir",
    "add_workflow",
    "get_workflow_graph",
    "delete_workflow",
    "rename_workflow",
    "duplicate_workflow",
    "get_param_map",
    "save_param_map",
    "autodetect_param_map",
]

WF_SAFE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

# Namespaced capability prefixes — workflows live in a subdirectory with this name.
_NAMESPACED_PREFIXES: tuple[str, ...] = ("txt2music", "img-utils")

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


def workflows_dir() -> Path:
    from offloadmq_agent.exec.imggen.workflow import _find_workflows_dir

    return _find_workflows_dir()


def list_workflows() -> list[dict[str, Any]]:
    wdir = workflows_dir()
    if not wdir.is_dir():
        return []
    result = []
    for entry in sorted(wdir.iterdir()):
        if not entry.is_dir() or not WF_SAFE_RE.match(entry.name):
            continue
        # Namespace subdirectory — recurse one level.
        if entry.name in _NAMESPACED_PREFIXES:
            for child in sorted(entry.iterdir()):
                if not child.is_dir() or not WF_SAFE_RE.match(child.name):
                    continue
                task_types = sorted(
                    p.stem
                    for p in child.glob("*.json")
                    if not p.name.endswith(".params.json") and WF_SAFE_RE.match(p.stem)
                )
                result.append({"name": child.name, "namespace": entry.name, "task_types": task_types})
            continue
        task_types = sorted(
            p.stem
            for p in entry.glob("*.json")
            if not p.name.endswith(".params.json") and WF_SAFE_RE.match(p.stem)
        )
        result.append({"name": entry.name, "namespace": "", "task_types": task_types})
    return result


def _resolve_workflow_dir(workflow_name: str, namespace: str = "") -> Path:
    """Validated, containment-checked path to one workflow's directory.

    Shared by every operation that touches a workflow directory as a whole
    (delete/rename/duplicate) and by ``_resolve_workflow_graph_path`` below —
    the single place name/namespace validation and the workflows-dir
    containment check happen, so none of those call sites can be fooled by a
    crafted ``workflow_name``/``namespace`` into touching a path outside
    ``workflows_dir()``.
    """
    wf = workflow_name.strip()
    ns = namespace.strip()
    if not wf or not WF_SAFE_RE.match(wf):
        raise ValueError("invalid workflow_name")
    if ns and not WF_SAFE_RE.match(ns):
        raise ValueError("invalid namespace")
    root = workflows_dir().resolve()
    base = (workflows_dir() / ns / wf).resolve() if ns else (workflows_dir() / wf).resolve()
    try:
        base.relative_to(root)
    except ValueError as exc:
        raise ValueError("path escapes workflows directory") from exc
    return base


def _resolve_workflow_graph_path(
    workflow_name: str, task_type: str, namespace: str = ""
) -> Path:
    tt = task_type.strip()
    if not tt or not WF_SAFE_RE.match(tt):
        raise ValueError("invalid task_type")
    base = _resolve_workflow_dir(workflow_name, namespace)
    root = workflows_dir().resolve()
    graph_path = (base / f"{tt}.json").resolve()
    try:
        graph_path.relative_to(root)
    except ValueError as exc:
        raise ValueError("path escapes workflows directory") from exc
    return graph_path


def _is_comfy_wire_ref(value: Any) -> bool:
    return is_wire(value)


def _validate_comfy_api_workflow(graph: Any) -> None:
    if not isinstance(graph, dict) or not graph:
        raise ValueError("workflow graph must be a non-empty JSON object")
    node_ids = set(graph.keys())
    for nid, node in graph.items():
        if not isinstance(node, dict):
            raise ValueError(f"node {nid!r} must be an object")
        if "class_type" not in node or not isinstance(node["class_type"], str):
            raise ValueError(f"node {nid!r} must have a string class_type")
        inputs = node.get("inputs")
        if inputs is not None:
            if not isinstance(inputs, dict):
                raise ValueError(f"node {nid!r} inputs must be an object")
            for in_key, in_val in inputs.items():
                if _is_comfy_wire_ref(in_val):
                    src = str(in_val[0])
                    if src not in node_ids:
                        raise ValueError(
                            f"node {nid!r} input {in_key!r}: wire source {src!r} missing from graph"
                        )


_PARAM_FIELD_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


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


def _validate_param_map(params: Any) -> None:
    """Validate param map structure only. Target existence is not checked — the
    executor silently skips targets whose node_id or input_name are absent from
    the graph at runtime, so unknown targets are valid (workflows evolve)."""
    if not isinstance(params, dict):
        raise ValueError("params must be a JSON object")
    for field, targets in params.items():
        if not _PARAM_FIELD_KEY_RE.match(field):
            raise ValueError(f"invalid param field name: {field!r}")
        if targets is None:
            continue
        if not isinstance(targets, list):
            raise ValueError(f"param {field!r} must be null or a list")
        for pair in targets:
            if not isinstance(pair, (list, tuple)) or len(pair) != 2:
                raise ValueError(
                    f"param {field!r}: each target must be [node_id, input_name]"
                )
            _, inp_name = pair[0], pair[1]
            if not isinstance(inp_name, str):
                raise ValueError(
                    f"param {field!r}: input slot name must be a string"
                )


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
    """Raises ``ValueError`` for an invalid/unsafe workflow_name or namespace."""
    target = _resolve_workflow_dir(workflow_name, namespace)
    if target.is_dir():
        shutil.rmtree(target)


def rename_workflow(
    workflow_name: str, namespace: str, new_workflow_name: str, new_namespace: str
) -> None:
    """Move a workflow directory (all its task-type graphs and param maps) to a
    new name/namespace.

    Raises ``ValueError`` for invalid names or if the destination already
    exists, ``FileNotFoundError`` if the source workflow doesn't exist.
    """
    src = _resolve_workflow_dir(workflow_name, namespace)
    if not src.is_dir():
        raise FileNotFoundError("workflow not found")
    dst = _resolve_workflow_dir(new_workflow_name, new_namespace)
    if dst == src:
        return
    if dst.exists():
        raise ValueError(f"a workflow named {new_workflow_name!r} already exists in that namespace")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))


def duplicate_workflow(
    workflow_name: str, namespace: str, new_workflow_name: str, new_namespace: str
) -> None:
    """Copy a workflow directory (all its task-type graphs and param maps) to a
    new name/namespace.

    Raises ``ValueError`` for invalid names, if source and destination are the
    same, or if the destination already exists; ``FileNotFoundError`` if the
    source workflow doesn't exist.
    """
    src = _resolve_workflow_dir(workflow_name, namespace)
    if not src.is_dir():
        raise FileNotFoundError("workflow not found")
    dst = _resolve_workflow_dir(new_workflow_name, new_namespace)
    if dst == src:
        raise ValueError("duplicate target must differ from the source workflow")
    if dst.exists():
        raise ValueError(f"a workflow named {new_workflow_name!r} already exists in that namespace")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dst)


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
