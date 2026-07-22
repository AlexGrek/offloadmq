"""
ComfyUI / imggen workflow helpers for the agent web UI.

Workflow listing, param-map metadata, and graph validation.  The HTTP routes live in
``ui_server.api``; the param auto-detection engine lives in ``comfy_autowire``.
"""

from __future__ import annotations

import json as json_module
import re
from pathlib import Path
from typing import Any, Dict, List

from offloadmq_core.comfy_autowire import guess_params, guess_params_ex, is_wire

__all__ = [
    "STANDARD_TASK_TYPES",
    "guess_params",
    "guess_params_ex",
    "list_workflows",
    "workflows_dir",
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


def list_workflows() -> List[Dict[str, Any]]:
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


def _resolve_workflow_graph_path(
    workflow_name: str, task_type: str, namespace: str = ""
) -> Path:
    wf = workflow_name.strip()
    tt = task_type.strip()
    ns = namespace.strip()
    if not wf or not WF_SAFE_RE.match(wf):
        raise ValueError("invalid workflow_name")
    if not tt or not WF_SAFE_RE.match(tt):
        raise ValueError("invalid task_type")
    if ns and not WF_SAFE_RE.match(ns):
        raise ValueError("invalid namespace")
    root = workflows_dir().resolve()
    if ns:
        base = (workflows_dir() / ns / wf).resolve()
    else:
        base = (workflows_dir() / wf).resolve()
    if not str(base).startswith(str(root)):
        raise ValueError("path traversal")
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


def _param_ui_txt_base_rows() -> List[Dict[str, str]]:
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


_PARAM_UI_ROWS: Dict[str, List[Dict[str, str]]] = {
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
    # img-utils utilities — input images only, no prompt.
    "depth": [
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


def _param_ui_standard_rows(task_type: str) -> List[Dict[str, str]]:
    rows = _PARAM_UI_ROWS.get(task_type)
    if rows is None:
        return []
    return list(rows)


def _standard_param_field_keys(task_type: str) -> set:
    return {r["key"] for r in _param_ui_standard_rows(task_type)}


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


def _sort_node_id_keys(node_ids: List[str]) -> List[str]:
    def sort_key(n: str) -> tuple:
        s = str(n)
        if s.isdigit():
            return (0, int(s))
        return (1, s)

    return sorted(node_ids, key=sort_key)


def _build_comfy_input_options(graph: Dict[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
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
