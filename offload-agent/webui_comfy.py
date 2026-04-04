"""
ComfyUI / imggen workflow helpers and FastAPI routes for the agent web UI.

Loaded by webui.py. Keeps workflow listing, param maps, and graph validation
out of the main webui module.
"""

from __future__ import annotations

import json as json_module
import re
import shutil
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Union

from fastapi import FastAPI, File, Form, Query, Request, UploadFile
from fastapi.responses import JSONResponse, RedirectResponse

from app.config import load_config, save_config

WF_SAFE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

STANDARD_TASK_TYPES = [
    "txt2img",
    "img2img",
    "inpaint",
    "outpaint",
    "upscale",
    "face_swap",
    "txt2video",
    "img2video",
]


def workflows_dir() -> Path:
    from app.exec.imggen.workflow import _find_workflows_dir

    return _find_workflows_dir()


def list_workflows() -> List[Dict[str, Any]]:
    wdir = workflows_dir()
    if not wdir.is_dir():
        return []
    result = []
    for entry in sorted(wdir.iterdir()):
        if not entry.is_dir() or not WF_SAFE_RE.match(entry.name):
            continue
        task_types = sorted(
            p.stem
            for p in entry.glob("*.json")
            if not p.name.endswith(".params.json") and WF_SAFE_RE.match(p.stem)
        )
        result.append({"name": entry.name, "task_types": task_types})
    return result


def _resolve_workflow_graph_path(workflow_name: str, task_type: str) -> Path:
    wf = workflow_name.strip()
    tt = task_type.strip()
    if not wf or not WF_SAFE_RE.match(wf):
        raise ValueError("invalid workflow_name")
    if not tt or not WF_SAFE_RE.match(tt):
        raise ValueError("invalid task_type")
    root = workflows_dir().resolve()
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
    return (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[1], int)
        and (isinstance(value[0], str) or isinstance(value[0], int))
    )


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


def _validate_param_map(params: Any, graph: Dict[str, Any]) -> None:
    if not isinstance(params, dict):
        raise ValueError("params must be a JSON object")
    node_ids = set(str(k) for k in graph.keys())
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
            nid_raw, inp_name = pair[0], pair[1]
            if not isinstance(inp_name, str):
                raise ValueError(
                    f"param {field!r}: input slot name must be a string"
                )
            nid = str(nid_raw)
            if nid not in node_ids:
                raise ValueError(
                    f"param {field!r}: node id {nid!r} not found in workflow graph"
                )
            node = graph[nid]
            inps = node.get("inputs") or {}
            if inp_name not in inps:
                ct = node.get("class_type", "?")
                raise ValueError(
                    f"param {field!r}: node {nid} ({ct}) has no input {inp_name!r}"
                )


def guess_params(workflow: Dict[str, Any], task_type: str) -> Dict[str, Any]:
    """Auto-detect param to node mappings from the Comfy API-format graph."""
    _SAMPLER_TYPES = {"KSampler", "KSamplerAdvanced", "KSamplerSelect"}
    _LATENT_TYPES = {
        "EmptyLatentImage",
        "EmptySD3LatentImage",
        "EmptyHunyuanLatentVideo",
        "EmptyMochiLatentVideo",
        "EmptyLTXVLatentVideo",
        "EmptyFluxLatentImage",
    }
    _TEXT_ENCODE_TYPES = {"CLIPTextEncode", "CLIPTextEncodeFlux", "CLIPTextEncodeSD3"}
    _LOAD_IMAGE_TYPES = {"LoadImage", "ETN_LoadImageBase64", "LoadImageMask"}

    by_class: Dict[str, List[str]] = {}
    for nid, node in workflow.items():
        by_class.setdefault(node.get("class_type", ""), []).append(nid)

    def resolve(ref: Any) -> Optional[str]:
        if isinstance(ref, list) and len(ref) >= 1:
            return str(ref[0])
        return None

    def trace_to_class(
        ref: Any, target_classes: set, visited: Optional[set] = None
    ) -> Optional[str]:
        if visited is None:
            visited = set()
        nid = resolve(ref)
        if not nid or nid in visited or nid not in workflow:
            return None
        visited.add(nid)
        node = workflow[nid]
        if node.get("class_type", "") in target_classes:
            return nid
        for val in node.get("inputs", {}).values():
            if isinstance(val, list):
                result = trace_to_class(val, target_classes, visited)
                if result:
                    return result
        return None

    params: Dict[str, Any] = {}

    sampler_id: Optional[str] = None
    for ct in _SAMPLER_TYPES:
        if ct in by_class:
            sampler_id = by_class[ct][0]
            break
    if sampler_id:
        params["seed"] = [[sampler_id, "seed"]]

    for ct in _LATENT_TYPES:
        if ct in by_class:
            lid = by_class[ct][0]
            node_inputs = workflow[lid].get("inputs", {})
            if "width" in node_inputs:
                params["width"] = [[lid, "width"]]
            if "height" in node_inputs:
                params["height"] = [[lid, "height"]]
            break

    if sampler_id:
        sinputs = workflow[sampler_id].get("inputs", {})
        pos_ref = sinputs.get("positive")
        neg_ref = sinputs.get("negative")

        pos_id = trace_to_class(pos_ref, _TEXT_ENCODE_TYPES)
        neg_id = trace_to_class(neg_ref, _TEXT_ENCODE_TYPES)

        if pos_id:
            params["prompt"] = [[pos_id, "text"]]
        if neg_id and neg_id != pos_id:
            params["negative"] = [[neg_id, "text"]]

    if "prompt" not in params:
        for ct in _TEXT_ENCODE_TYPES:
            if ct in by_class:
                params["prompt"] = [[by_class[ct][0], "text"]]
                break

    if task_type in (
        "img2img",
        "inpaint",
        "outpaint",
        "face_swap",
        "upscale",
        "img2video",
    ):
        load_nodes = []
        for ct in _LOAD_IMAGE_TYPES:
            load_nodes.extend(by_class.get(ct, []))
        if load_nodes:
            params["input_image"] = [[load_nodes[0], "image"]]
        if task_type == "face_swap" and len(load_nodes) > 1:
            params["face_swap"] = [[load_nodes[1], "image"]]

    if task_type == "upscale":
        for nid, node in workflow.items():
            for key in ("upscale_factor", "scale_by", "scale"):
                if key in node.get("inputs", {}):
                    params["upscale"] = [[nid, key]]
                    break
            if "upscale" in params:
                break

    if task_type in ("txt2video", "img2video"):
        for nid, node in workflow.items():
            for key in ("frame_count", "frames", "length", "video_frames"):
                if key in node.get("inputs", {}):
                    params["length"] = [[nid, key]]
                    break
            if "length" in params:
                break

    return params


def default_params(task_type: str) -> Dict[str, Any]:
    """Stub fallback for keys graph analysis could not resolve."""
    params: Dict[str, Any] = {
        "prompt": [["FIXME_prompt_node", "text"]],
        "negative": [["FIXME_negative_node", "text"]],
        "width": [["FIXME_latent_node", "width"]],
        "height": [["FIXME_latent_node", "height"]],
        "seed": [["FIXME_sampler_node", "seed"]],
    }
    if task_type in ("img2img", "inpaint", "outpaint", "face_swap", "upscale"):
        params["input_image"] = [["FIXME_load_image_node", "image"]]
    if task_type == "face_swap":
        params["face_swap"] = [["FIXME_face_image_node", "image"]]
    if task_type == "upscale":
        params["upscale"] = [["FIXME_upscale_node", "upscale_factor"]]
    if task_type in ("txt2video", "img2video"):
        params["length"] = [["FIXME_latent_node", "frame_count"]]
        if task_type == "img2video":
            params["input_image"] = [["FIXME_load_image_node", "image"]]
    return params


DoneFn = Callable[[Request], Union[JSONResponse, RedirectResponse]]
LogFn = Callable[[str], None]
StartScanFn = Callable[[], None]


def register_comfy_routes(
    app: FastAPI,
    *,
    log: LogFn,
    start_scan: StartScanFn,
    done: DoneFn,
) -> None:
    """Register ComfyUI URL, workflow, and param-map HTTP routes on ``app``."""

    @app.post("/config/comfyui-url")
    async def save_comfyui_url(request: Request, comfyui_url: str = Form("")):
        cfg = load_config()
        cfg["comfyui_url"] = comfyui_url.strip()
        save_config(cfg)
        log(f"[imggen] ComfyUI URL saved: {comfyui_url.strip() or '(cleared)'}")
        return done(request)

    @app.get("/workflows/param-map")
    async def get_workflow_param_map(
        workflow_name: str = Query(""),
        task_type: str = Query(""),
    ):
        wf = workflow_name.strip()
        tt = task_type.strip()
        try:
            graph_path = _resolve_workflow_graph_path(wf, tt)
        except ValueError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
        params_path = graph_path.with_suffix(".params.json")
        if not graph_path.is_file():
            return JSONResponse(
                {"ok": False, "error": "workflow graph JSON not found"},
                status_code=404,
            )
        if not params_path.is_file():
            return JSONResponse(
                {"ok": False, "error": "params JSON not found"},
                status_code=404,
            )
        try:
            with open(graph_path, encoding="utf-8") as f:
                graph = json_module.load(f)
            with open(params_path, encoding="utf-8") as f:
                params = json_module.load(f)
        except json_module.JSONDecodeError as exc:
            return JSONResponse(
                {"ok": False, "error": f"invalid JSON: {exc}"},
                status_code=400,
            )
        try:
            _validate_comfy_api_workflow(graph)
        except ValueError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
        if not isinstance(params, dict):
            return JSONResponse(
                {"ok": False, "error": "params file must contain a JSON object"},
                status_code=400,
            )

        std_keys = _standard_param_field_keys(tt)
        extra_keys = sorted(
            k for k in params if k not in std_keys and _PARAM_FIELD_KEY_RE.match(k)
        )

        return JSONResponse(
            {
                "ok": True,
                "workflow_name": wf,
                "task_type": tt,
                "params": params,
                "standard_fields": _param_ui_standard_rows(tt),
                "extra_keys": extra_keys,
                "input_options": _build_comfy_input_options(graph),
            }
        )

    @app.post("/workflows/param-map")
    async def save_workflow_param_map(request: Request):
        data = await request.json()
        wf = str(data.get("workflow_name", "")).strip()
        tt = str(data.get("task_type", "")).strip()
        params = data.get("params")
        try:
            graph_path = _resolve_workflow_graph_path(wf, tt)
        except ValueError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
        if not graph_path.is_file():
            return JSONResponse(
                {"ok": False, "error": "workflow graph JSON not found"},
                status_code=404,
            )
        try:
            with open(graph_path, encoding="utf-8") as f:
                graph = json_module.load(f)
            _validate_comfy_api_workflow(graph)
            _validate_param_map(params, graph)
        except ValueError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
        except json_module.JSONDecodeError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

        params_path = graph_path.with_suffix(".params.json")
        with open(params_path, "w", encoding="utf-8") as f:
            json_module.dump(params, f, indent=2)
        log(f"[imggen] Saved param map: {params_path}")
        start_scan()
        return JSONResponse({"ok": True})

    @app.post("/workflows/param-map/autodetect")
    async def autodetect_workflow_param_map(request: Request):
        data = await request.json()
        wf = str(data.get("workflow_name", "")).strip()
        tt = str(data.get("task_type", "")).strip()
        try:
            graph_path = _resolve_workflow_graph_path(wf, tt)
        except ValueError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
        if not graph_path.is_file():
            return JSONResponse(
                {"ok": False, "error": "workflow graph JSON not found"},
                status_code=404,
            )
        try:
            with open(graph_path, encoding="utf-8") as f:
                graph = json_module.load(f)
            if not isinstance(graph, dict) or not graph:
                return JSONResponse(
                    {"ok": False, "error": "workflow graph is empty"},
                    status_code=400,
                )
            _validate_comfy_api_workflow(graph)
        except ValueError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
        except json_module.JSONDecodeError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

        guessed = guess_params(graph, tt)
        stubs = default_params(tt)
        merged = {**stubs, **guessed}
        params_path = graph_path.with_suffix(".params.json")
        with open(params_path, "w", encoding="utf-8") as f:
            json_module.dump(merged, f, indent=2)
        log(f"[imggen] Overwrote param map with auto-detect: {params_path}")
        start_scan()
        return JSONResponse({"ok": True, "params": merged})

    @app.post("/workflows/add")
    async def route_add_workflow(
        request: Request,
        workflow_name: str = Form(""),
        task_type: str = Form(""),
        workflow_file: UploadFile = File(None),
    ):
        workflow_name = workflow_name.strip()
        task_type = task_type.strip()

        if not workflow_name or not WF_SAFE_RE.match(workflow_name):
            log(
                "[imggen] ERROR: invalid workflow name -- use only letters, digits, hyphens, dots"
            )
            return done(request)
        if not task_type or not WF_SAFE_RE.match(task_type):
            log(f"[imggen] ERROR: invalid task type '{task_type}'")
            return done(request)

        wf_dir = (workflows_dir() / workflow_name).resolve()
        if not str(wf_dir).startswith(str(workflows_dir().resolve())):
            log("[imggen] ERROR: path traversal detected in workflow name")
            return done(request)

        wf_dir.mkdir(parents=True, exist_ok=True)

        json_path = wf_dir / f"{task_type}.json"
        if workflow_file and workflow_file.filename:
            raw = await workflow_file.read()
            try:
                parsed = json_module.loads(raw)
            except json_module.JSONDecodeError as exc:
                log(f"[imggen] ERROR: uploaded file is not valid JSON -- {exc}")
                return done(request)
            with open(json_path, "w", encoding="utf-8") as f:
                json_module.dump(parsed, f, indent=2)
            log(f"[imggen] Saved workflow JSON: {json_path}")
        else:
            if not json_path.exists():
                with open(json_path, "w", encoding="utf-8") as f:
                    json_module.dump({}, f)
                log(
                    f"[imggen] Created empty workflow placeholder: {json_path} -- "
                    "replace with ComfyUI API-format export"
                )

        params_path = wf_dir / f"{task_type}.params.json"
        if not params_path.exists():
            guessed: Dict[str, Any] = {}
            try:
                with open(json_path, encoding="utf-8") as f:
                    wf_graph = json_module.load(f)
                if isinstance(wf_graph, dict) and wf_graph:
                    guessed = guess_params(wf_graph, task_type)
            except Exception as e:
                log(f"[imggen] Warning: could not auto-detect params ({e}), using stubs")
            stubs = default_params(task_type)
            merged = {**stubs, **guessed}
            with open(params_path, "w", encoding="utf-8") as f:
                json_module.dump(merged, f, indent=2)
            detected = sorted(guessed.keys())
            stub_keys = sorted(k for k in merged if k not in guessed)
            log(
                f"[imggen] Generated params mapping: {params_path} -- "
                f"auto-detected: {detected or 'none'}, stubs: {stub_keys or 'none'}"
            )

        log(
            f"[imggen] Workflow '{workflow_name}/{task_type}' added -- "
            "rescan to register capability"
        )
        start_scan()
        return done(request)

    @app.post("/workflows/delete")
    async def route_delete_workflow(request: Request, workflow_name: str = Form("")):
        workflow_name = workflow_name.strip()

        if not workflow_name or not WF_SAFE_RE.match(workflow_name):
            log("[imggen] ERROR: invalid workflow name in delete request")
            return done(request)

        wf_dir = (workflows_dir() / workflow_name).resolve()
        if not str(wf_dir).startswith(str(workflows_dir().resolve())):
            log("[imggen] ERROR: path traversal detected in delete request")
            return done(request)

        if wf_dir.is_dir():
            shutil.rmtree(wf_dir)
            log(f"[imggen] Deleted workflow '{workflow_name}'")
            start_scan()
        else:
            log(f"[imggen] Workflow '{workflow_name}' not found -- nothing deleted")

        return done(request)
