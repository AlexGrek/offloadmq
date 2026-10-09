"""ComfyUI workflow files on disk: listing, validation and portable bundles.

Lives in the agent package (not core) so both the web-UI service layer
(``offloadmq_core.comfy_service``) and the ``slavemode.comfy-*`` executors can use it.

A *bundle* is one JSON document holding every task type of a workflow — graph plus
configured node mapping (``.params.json``) — so a workflow can be moved between agents
intact (see :func:`export_workflow` / :func:`import_workflow`).
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

BUNDLE_FORMAT = "offloadmq-comfy-workflow"
BUNDLE_VERSION = 1

WF_SAFE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
PARAM_FIELD_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")

# Namespaced capability prefixes — workflows live in a subdirectory with this name.
NAMESPACED_PREFIXES: tuple[str, ...] = ("txt2music", "img-utils")


def workflows_dir() -> Path:
    from offloadmq_agent.exec.imggen.workflow import _find_workflows_dir

    return _find_workflows_dir()


def _task_types_in(directory: Path) -> list[str]:
    return sorted(
        p.stem
        for p in directory.glob("*.json")
        if not p.name.endswith(".params.json") and WF_SAFE_RE.match(p.stem)
    )


def list_workflows() -> list[dict[str, Any]]:
    wdir = workflows_dir()
    if not wdir.is_dir():
        return []
    result: list[dict[str, Any]] = []
    for entry in sorted(wdir.iterdir()):
        if not entry.is_dir() or not WF_SAFE_RE.match(entry.name):
            continue
        # Namespace subdirectory — recurse one level.
        if entry.name in NAMESPACED_PREFIXES:
            for child in sorted(entry.iterdir()):
                if not child.is_dir() or not WF_SAFE_RE.match(child.name):
                    continue
                result.append(
                    {"name": child.name, "namespace": entry.name, "task_types": _task_types_in(child)}
                )
            continue
        result.append({"name": entry.name, "namespace": "", "task_types": _task_types_in(entry)})
    return result


def resolve_graph_path(workflow_name: str, task_type: str, namespace: str = "") -> Path:
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


def is_wire(value: Any) -> bool:
    """True when ``value`` is a Comfy wire ref: ``[source_node_id, output_slot]``."""
    return (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[1], int)
        and isinstance(value[0], (str, int))
        and not isinstance(value[0], bool)
    )


def validate_graph(graph: Any) -> None:
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
                if is_wire(in_val):
                    src = str(in_val[0])
                    if src not in node_ids:
                        raise ValueError(
                            f"node {nid!r} input {in_key!r}: wire source {src!r} missing from graph"
                        )


def validate_param_map(params: Any) -> None:
    """Validate param map structure only. Target existence is not checked — the
    executor silently skips targets whose node_id or input_name are absent from
    the graph at runtime, so unknown targets are valid (workflows evolve)."""
    if not isinstance(params, dict):
        raise ValueError("params must be a JSON object")
    for field, targets in params.items():
        if not PARAM_FIELD_KEY_RE.match(field):
            raise ValueError(f"invalid param field name: {field!r}")
        if targets is None:
            continue
        if not isinstance(targets, list):
            raise ValueError(f"param {field!r} must be null or a list")
        for pair in targets:
            if not isinstance(pair, (list, tuple)) or len(pair) != 2:
                raise ValueError(f"param {field!r}: each target must be [node_id, input_name]")
            if not isinstance(pair[1], str):
                raise ValueError(f"param {field!r}: input slot name must be a string")


def parse_workflow_ref(ref: str) -> tuple[str, str]:
    """``img-utils.depth`` -> ``("depth", "img-utils")``; ``imggen.x`` / ``x`` -> ``("x", "")``."""
    prefix, dot, rest = ref.strip().partition(".")
    if dot and prefix in ("imggen", *NAMESPACED_PREFIXES):
        return rest, "" if prefix == "imggen" else prefix
    return ref.strip(), ""


def _workflow_task_types(workflow_name: str, namespace: str) -> list[str]:
    for w in list_workflows():
        if w["name"] == workflow_name.strip() and w["namespace"] == namespace.strip():
            return list(w["task_types"])
    return []


def export_workflow(workflow_name: str, namespace: str = "") -> dict[str, Any]:
    """Bundle every task type of one workflow — graph plus configured param map.

    A task type without a ``.params.json`` exports ``"params": None``.

    Raises ``ValueError`` for invalid names or an unreadable graph,
    ``FileNotFoundError`` if the workflow has no task types.
    """
    task_types: dict[str, Any] = {}
    for tt in _workflow_task_types(workflow_name, namespace):
        graph_path = resolve_graph_path(workflow_name, tt, namespace)
        try:
            graph = json.loads(graph_path.read_text())
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid graph JSON in {tt}.json: {exc}") from exc
        params: Any = None
        params_path = graph_path.with_suffix(".params.json")
        if params_path.exists():
            try:
                params = json.loads(params_path.read_text())
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid param map JSON in {tt}.params.json: {exc}") from exc
        task_types[tt] = {"graph": graph, "params": params}
    if not task_types:
        raise FileNotFoundError("workflow not found or has no task types")
    return {
        "format": BUNDLE_FORMAT,
        "version": BUNDLE_VERSION,
        "name": workflow_name.strip(),
        "namespace": namespace.strip(),
        "task_types": task_types,
    }


def import_workflow(
    bundle: Any,
    name: str = "",
    namespace: str | None = None,
    overwrite: bool = False,
) -> dict[str, Any]:
    """Install a bundle produced by :func:`export_workflow`.

    ``name`` / ``namespace`` override the ones recorded in the bundle (``namespace=None``
    keeps the bundle's; ``""`` forces the flat imggen space). Everything is validated
    before anything is written, so a bad bundle leaves the workflows directory untouched.
    Existing task types are only replaced with ``overwrite=True``; task types the bundle
    doesn't mention are left alone.

    Returns ``{"name", "namespace", "task_types"}``. Raises ``ValueError`` for a malformed
    bundle or invalid names, ``FileExistsError`` if a target exists and ``overwrite`` is off.
    """
    if not isinstance(bundle, dict) or bundle.get("format") != BUNDLE_FORMAT:
        raise ValueError(f"not an OffloadMQ ComfyUI workflow bundle (format != {BUNDLE_FORMAT!r})")
    version = bundle.get("version")
    if not isinstance(version, int) or version > BUNDLE_VERSION:
        raise ValueError(f"unsupported bundle version {version!r} (this agent supports {BUNDLE_VERSION})")

    wf_name = (name or str(bundle.get("name") or "")).strip()
    ns = (str(bundle.get("namespace") or "") if namespace is None else namespace).strip()
    if ns and ns not in NAMESPACED_PREFIXES:
        raise ValueError(f"namespace must be blank or one of {', '.join(NAMESPACED_PREFIXES)}")
    entries = bundle.get("task_types")
    if not isinstance(entries, dict) or not entries:
        raise ValueError("bundle has no task_types")

    writes: list[tuple[Path, Any, Any]] = []
    for tt, entry in entries.items():
        if not isinstance(entry, dict):
            raise ValueError(f"task type {tt!r} must be an object")
        if tt.endswith(".params"):
            raise ValueError(f"invalid task type {tt!r}")
        graph = entry.get("graph")
        validate_graph(graph)
        params = entry.get("params")
        if params is not None:
            validate_param_map(params)
        path = resolve_graph_path(wf_name, tt, ns)
        if not overwrite and path.exists():
            raise FileExistsError(f"{(ns + '.') if ns else 'imggen.'}{wf_name} / {tt} already exists")
        writes.append((path, graph, params))

    for path, graph, params in writes:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(graph, indent=2))
        params_path = path.with_suffix(".params.json")
        if params is not None:
            params_path.write_text(json.dumps(params, indent=2))
        elif params_path.exists():
            # Replacing a graph with an unmapped one: a stale map would wire the wrong nodes.
            params_path.unlink()
    return {"name": wf_name, "namespace": ns, "task_types": sorted(entries)}


def export_all_workflows() -> tuple[list[dict[str, Any]], list[str]]:
    """One bundle per installed workflow that has at least one task type.

    A workflow that cannot be exported (corrupt JSON, unreadable file) is skipped and
    reported as ``"<ns>.<name>: <reason>"`` instead of failing the whole backup.
    """
    bundles: list[dict[str, Any]] = []
    skipped: list[str] = []
    for w in list_workflows():
        if not w["task_types"]:
            continue
        try:
            bundles.append(export_workflow(w["name"], w["namespace"]))
        except (ValueError, OSError) as exc:
            skipped.append(f"{w['namespace'] or 'imggen'}.{w['name']}: {exc}")
    return bundles, skipped
