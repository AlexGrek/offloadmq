"""Auto-detect payload field → Comfy node input mappings from an API-format graph.

The output of this module is the ``<task_type>.params.json`` file consumed by
``offloadmq_agent.exec.imggen.workflow.inject_params``, which writes payload values
straight into ``graph[node_id]["inputs"][input_name]``.

Two invariants drive the design:

1. **Never target a wired input.**  ``inject_params`` writes a literal; if the slot
   currently holds a wire ref (``["109", 0]``) the write silently severs the link and
   the graph misbehaves.  Every candidate target therefore goes through
   :func:`resolve_literal`, which walks upstream to the literal that actually drives
   the slot (e.g. ``KSampler.seed`` → ``PrimitiveInt("109").value``).

2. **Prefer an honest gap over a wrong guess.**  When a value is *derived* — width
   from ``GetImageSize``, prompt text from an Ollama node — there is no literal to
   write and the field resolves to ``[]`` plus a note explaining why.  The param-map
   editor surfaces the note so the user can wire it by hand.
"""

from __future__ import annotations

from collections import deque
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

Graph = Dict[str, Any]
Target = Tuple[str, str]
Notes = Dict[str, str]
SkipFn = Callable[[Graph, str, str], bool]

_MAX_DEPTH = 16

# --------------------------------------------------------------------------
# Class tables.  Tuples where order encodes priority; frozensets for membership.
# --------------------------------------------------------------------------

# Terminal nodes that persist a result.  Preview* nodes are deliberately absent:
# they anchor dead branches (LLM captioning, debug previews) we must not wire into.
_OUTPUT_CLASSES: frozenset[str] = frozenset(
    {
        "SaveImage",
        "ImageSave",
        "SaveVideo",
        "SaveWEBM",
        "SaveAnimatedWEBP",
        "SaveAnimatedPNG",
        "VHS_VideoCombine",
        "SaveAudio",
        "SaveAudioMP3",
        "SaveAudioOpus",
    }
)

# value-carrying primitives: a wire into one of these resolves to its `value` input.
_PRIMITIVE_CLASSES: frozenset[str] = frozenset(
    {
        "PrimitiveInt",
        "PrimitiveFloat",
        "PrimitiveString",
        "PrimitiveStringMultiline",
        "PrimitiveBoolean",
        "Int",
        "Float",
        "String",
    }
)

# Nodes whose numeric outputs are computed from an image / preset — not writable.
_DERIVED_VALUE_CLASSES: frozenset[str] = frozenset(
    {
        "GetImageSize",
        "GetImageSizeAndCount",
        "ResolutionSelector",
        "ImageScale",
        "ImageScaleBy",
    }
)

# Nodes that *generate* text at runtime.  A prompt slot fed from one of these has no
# meaningful literal to overwrite.
_GENERATIVE_TEXT_CLASSES: frozenset[str] = frozenset(
    {
        "OllamaGenerate",
        "OllamaGenerateV2",
        "OllamaGenerateAdvance",
        "OllamaVision",
        "PreviewAny",
        "LLMChat",
        "Searge_LLM_Node",
    }
)

# Pure string plumbing — a literal string input on one of these is a legitimate target.
_PURE_STRING_CLASSES: frozenset[str] = frozenset(
    {
        "StringConcatenate",
        "Concatenate",
        "StringReplace",
        "Text Multiline",
        "CR Text",
        "ShowText",
    }
)

_TEXT_ENCODE_CLASSES: frozenset[str] = frozenset(
    {
        "CLIPTextEncode",
        "CLIPTextEncodeFlux",
        "CLIPTextEncodeSD3",
        "CLIPTextEncodeSDXL",
        "CLIPTextEncodeSDXLRefiner",
    }
)

# Which input(s) on a text-encode node hold the prompt string.
_TEXT_ENCODE_INPUTS: Dict[str, Tuple[str, ...]] = {
    "CLIPTextEncodeFlux": ("clip_l", "t5xxl"),
    "CLIPTextEncodeSDXL": ("text_g", "text_l"),
    "CLIPTextEncodeSDXLRefiner": ("text",),
}
_DEFAULT_TEXT_INPUT: Tuple[str, ...] = ("text",)

# Conditioning passthroughs with a single `conditioning` input.
_CONDITIONING_PASSTHROUGH: frozenset[str] = frozenset(
    {
        "FluxGuidance",
        "ConditioningZeroOut",
        "ConditioningSetArea",
        "ConditioningSetAreaPercentage",
        "ConditioningSetTimestepRange",
        "ConditioningConcat",
    }
)

# Samplers that own positive/negative directly.
_DIRECT_SAMPLER_CLASSES: Tuple[str, ...] = ("KSampler", "KSamplerAdvanced", "SamplerCustom")
# NOTE: KSamplerSelect is *not* a sampler — it only carries `sampler_name`.

_SEED_INPUTS: Tuple[str, ...] = ("seed", "noise_seed")
_STEPS_INPUTS: Tuple[str, ...] = ("steps",)
_CFG_INPUTS: Tuple[str, ...] = ("cfg",)
_LENGTH_INPUTS: Tuple[str, ...] = ("length", "frame_count", "num_frames", "video_frames")
_FPS_INPUTS: Tuple[str, ...] = ("fps", "frame_rate")
_UPSCALE_INPUTS: Tuple[str, ...] = ("upscale_factor", "scale_by", "rescale_factor", "scale")

_SEED_OWNER_CLASSES: frozenset[str] = frozenset(
    {
        "KSampler",
        "KSamplerAdvanced",
        "SamplerCustom",
        "RandomNoise",
        "TextEncodeAceStepAudio1.5",
        "TextEncodeAceStep",
        "AceStepTextEncode",
    }
)
_STEPS_OWNER_CLASSES: frozenset[str] = frozenset(
    {"KSampler", "KSamplerAdvanced", "SamplerCustom", "BasicScheduler"}
)
_CFG_OWNER_CLASSES: frozenset[str] = frozenset(
    {"KSampler", "KSamplerAdvanced", "SamplerCustom", "CFGGuider"}
)
_FPS_OWNER_CLASSES: frozenset[str] = frozenset({"CreateVideo", "VHS_VideoCombine"})

_LOAD_IMAGE_CLASSES: frozenset[str] = frozenset(
    {"LoadImage", "LoadImageOutput", "LoadImageMask", "ETN_LoadImageBase64"}
)

# Where the *main* input image is consumed, most-specific first.  A LoadImage node is
# scored by the earliest role it reaches; lowest score wins.
_IMAGE_ROLE_PRIORITY: Tuple[Tuple[str, str], ...] = (
    ("*ImageToVideo", "start_image"),
    ("VAEEncode", "pixels"),
    ("VAEEncodeForInpaint", "pixels"),
    ("InpaintModelConditioning", "pixels"),
    ("ReActorFaceSwap", "input_image"),
    ("*", "image"),
    ("*", "input"),
)

_FACE_REF_ROLES: Tuple[Tuple[str, str], ...] = (("ReActorFaceSwap", "source_image"),)

_AUDIO_ENCODE_CLASSES: Tuple[str, ...] = (
    "TextEncodeAceStepAudio1.5",
    "TextEncodeAceStep",
    "AceStepTextEncode",
)
_AUDIO_LATENT_CLASSES: Tuple[str, ...] = (
    "EmptyAceStep1.5LatentAudio",
    "EmptyAceStepLatentAudio",
)
_AUDIO_ENCODE_FIELDS: Tuple[str, ...] = (
    "tags",
    "lyrics",
    "bpm",
    "duration",
    "timesignature",
    "language",
    "keyscale",
    "cfg_scale",
    "temperature",
    "top_p",
    "top_k",
    "min_p",
)

# Standard payload keys per task type.  Every key listed here appears in the emitted
# params.json, even when unresolved (as `[]`), so the editor always shows a row.
_TXT_BASE: Tuple[str, ...] = ("prompt", "negative", "width", "height", "seed")
_STANDARD_KEYS: Dict[str, Tuple[str, ...]] = {
    "txt2img": _TXT_BASE,
    "img2img": _TXT_BASE + ("input_image",),
    "inpaint": _TXT_BASE + ("input_image",),
    "outpaint": _TXT_BASE + ("input_image",),
    "upscale": _TXT_BASE + ("input_image", "upscale"),
    "face_swap": _TXT_BASE + ("input_image", "face_swap"),
    "txt2video": _TXT_BASE + ("length",),
    "img2video": _TXT_BASE + ("length", "input_image"),
}

_IMAGE_TASK_TYPES: frozenset[str] = frozenset(
    {"img2img", "inpaint", "outpaint", "upscale", "face_swap", "img2video"}
)
_VIDEO_TASK_TYPES: frozenset[str] = frozenset({"txt2video", "img2video"})

IMG_UTILS_NAMESPACE = "img-utils"

# img-utils operations transform an input image with no prompt, no latent sizing
# and no seed — autowiring only has to find the LoadImage node(s), and emitting
# prompt/width/height keys would make the editor warn about fields the workflow
# genuinely does not have.
_IMG_UTILS_KEYS: Dict[str, Tuple[str, ...]] = {
    "depth": ("input_image",),
    "face_swap": ("input_image", "face_swap"),
}

# Task types that mean img-utils even without a namespace. `face_swap` is
# deliberately absent — it is also a legitimate imggen task type, where the
# prompt/resolution keys *are* wanted.
_IMG_UTILS_TASK_TYPES: frozenset[str] = frozenset({"depth"})


# --------------------------------------------------------------------------
# Graph primitives
# --------------------------------------------------------------------------


def is_wire(value: Any) -> bool:
    """True when ``value`` is a Comfy wire ref: ``[source_node_id, output_slot]``."""
    return (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[1], int)
        and isinstance(value[0], (str, int))
        and not isinstance(value[0], bool)
    )


def _inputs(graph: Graph, node_id: str) -> Dict[str, Any]:
    node = graph.get(node_id)
    if not isinstance(node, dict):
        return {}
    inputs = node.get("inputs")
    return inputs if isinstance(inputs, dict) else {}


def _class_of(graph: Graph, node_id: str) -> str:
    node = graph.get(node_id)
    if not isinstance(node, dict):
        return ""
    ct = node.get("class_type")
    return ct if isinstance(ct, str) else ""


def _wire_source(value: Any) -> Optional[str]:
    return str(value[0]) if is_wire(value) else None


def _wire_slot(value: Any) -> int:
    return int(value[1]) if is_wire(value) else 0


def node_order(node_ids: Iterable[str]) -> List[str]:
    """Deterministic id ordering: plain integers numerically, composites lexically.

    Comfy subgraph exports use ids like ``"103:17"``; a plain ``sorted()`` would
    interleave them with ``"9"`` and ``"114"`` unpredictably.
    """

    def key(nid: str) -> Tuple[int, int, str]:
        s = str(nid)
        if s.isdigit():
            return (0, int(s), "")
        return (1, 0, s)

    return sorted((str(n) for n in node_ids), key=key)


def _class_matches(pattern: str, class_type: str) -> bool:
    """Match a role pattern: ``"*"`` any, ``"*Suffix"`` suffix, else exact."""
    if pattern == "*":
        return True
    if pattern.startswith("*"):
        return class_type.endswith(pattern[1:])
    return class_type == pattern


def live_subgraph(graph: Graph) -> set[str]:
    """Node ids that contribute to a persisted output, via reverse BFS from Save* nodes.

    Falls back to the entire graph when no output node exists (e.g. a preview-only
    export), so autowiring degrades rather than returning nothing.
    """
    outputs = [nid for nid in node_order(graph) if _class_of(graph, nid) in _OUTPUT_CLASSES]
    if not outputs:
        return set(graph.keys())

    live: set[str] = set()
    queue: deque[str] = deque(outputs)
    while queue:
        nid = queue.popleft()
        if nid in live or nid not in graph:
            continue
        live.add(nid)
        for value in _inputs(graph, nid).values():
            src = _wire_source(value)
            if src is not None and src not in live:
                queue.append(src)
    return live


def _consumers(graph: Graph) -> Dict[str, List[Tuple[str, str]]]:
    """source_node_id → [(consumer_node_id, consumer_input_name), ...]"""
    out: Dict[str, List[Tuple[str, str]]] = {}
    for nid in node_order(graph):
        for in_name, value in _inputs(graph, nid).items():
            src = _wire_source(value)
            if src is not None:
                out.setdefault(src, []).append((nid, str(in_name)))
    return out


# --------------------------------------------------------------------------
# Literal resolution
# --------------------------------------------------------------------------


class _Unresolved(Exception):
    """Carries the reason a slot has no writable literal behind it."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _first_literal_string_input(graph: Graph, node_id: str) -> Optional[str]:
    for in_name, value in _inputs(graph, node_id).items():
        if isinstance(value, str) and value:
            return str(in_name)
    return None


def _resolve(graph: Graph, node_id: str, input_name: str, depth: int, seen: set[Tuple[str, str]]) -> Target:
    if depth > _MAX_DEPTH or (node_id, input_name) in seen:
        raise _Unresolved(f"wire chain from {node_id}.{input_name} is cyclic or too deep")
    seen.add((node_id, input_name))

    inputs = _inputs(graph, node_id)
    if input_name not in inputs:
        raise _Unresolved(f"node {node_id} has no input {input_name!r}")

    value = inputs[input_name]
    if not is_wire(value):
        return (node_id, input_name)

    src = _wire_source(value)
    assert src is not None
    if src not in graph:
        raise _Unresolved(f"wire from {node_id}.{input_name} points at missing node {src}")

    src_class = _class_of(graph, src)

    if src_class in _PRIMITIVE_CLASSES:
        if "value" in _inputs(graph, src):
            return (src, "value")
        raise _Unresolved(f"node {src} ({src_class}) has no 'value' input")

    if src_class in _DERIVED_VALUE_CLASSES:
        raise _Unresolved(f"derived from node {src} ({src_class}) — no literal to write")

    if src_class in _GENERATIVE_TEXT_CLASSES:
        raise _Unresolved(f"generated at runtime by node {src} ({src_class})")

    if src_class in _PURE_STRING_CLASSES:
        src_inputs = _inputs(graph, src)
        for value_in in src_inputs.values():
            up = _wire_source(value_in)
            if up is not None and _class_of(graph, up) in _GENERATIVE_TEXT_CLASSES:
                raise _Unresolved(
                    f"node {src} ({src_class}) concatenates output of node {up} "
                    f"({_class_of(graph, up)})"
                )
        literal_in = _first_literal_string_input(graph, src)
        if literal_in is not None:
            return (src, literal_in)
        raise _Unresolved(f"node {src} ({src_class}) has no literal string input")

    # Generic passthrough: the upstream node exposes an input of the same name.
    if input_name in _inputs(graph, src):
        return _resolve(graph, src, input_name, depth + 1, seen)

    raise _Unresolved(f"wired from node {src} ({src_class}) — no writable literal upstream")


def resolve_literal(graph: Graph, node_id: str, input_name: str) -> Target:
    """Return the ``(node_id, input_name)`` literal slot that drives the given input.

    Raises :class:`_Unresolved` when the value is computed rather than stored.
    """
    return _resolve(graph, node_id, input_name, 0, set())


def _try_resolve(graph: Graph, node_id: str, input_name: str) -> Tuple[Optional[Target], str]:
    try:
        return resolve_literal(graph, node_id, input_name), ""
    except _Unresolved as exc:
        return None, exc.reason


def _dedupe(targets: Sequence[Target]) -> List[Target]:
    seen: set[Target] = set()
    out: List[Target] = []
    for t in targets:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


# --------------------------------------------------------------------------
# Conditioning tracing
# --------------------------------------------------------------------------


def trace_conditioning(graph: Graph, ref: Any, depth: int = 0, seen: Optional[set[str]] = None) -> Optional[str]:
    """Walk a CONDITIONING wire back to the text-encode node that produced it.

    Slot-aware: a node exposing both ``positive`` and ``negative`` inputs (the
    ``*ImageToVideo`` family, ``InpaintModelConditioning``, ``ControlNetApplyAdvanced``)
    emits positive on output slot 0 and negative on slot 1, so the incoming slot index
    selects which input to follow.  Following inputs in dict order — as the previous
    implementation did — returns the positive encoder for a negative wire.
    """
    if seen is None:
        seen = set()
    if depth > _MAX_DEPTH:
        return None
    nid = _wire_source(ref)
    if nid is None or nid in seen or nid not in graph:
        return None
    seen.add(nid)

    slot = _wire_slot(ref)
    ct = _class_of(graph, nid)
    if ct in _TEXT_ENCODE_CLASSES:
        return nid

    inputs = _inputs(graph, nid)

    if "positive" in inputs and "negative" in inputs:
        follow = "negative" if slot == 1 else "positive"
        return trace_conditioning(graph, inputs[follow], depth + 1, seen)

    if ct in _CONDITIONING_PASSTHROUGH and "conditioning" in inputs:
        return trace_conditioning(graph, inputs["conditioning"], depth + 1, seen)

    if "conditioning" in inputs:
        return trace_conditioning(graph, inputs["conditioning"], depth + 1, seen)

    wires = [v for v in inputs.values() if is_wire(v)]
    if len(wires) == 1:
        return trace_conditioning(graph, wires[0], depth + 1, seen)

    return None


def _text_targets(graph: Graph, encode_nid: str) -> Tuple[List[Target], str]:
    ct = _class_of(graph, encode_nid)
    names = _TEXT_ENCODE_INPUTS.get(ct, _DEFAULT_TEXT_INPUT)
    targets: List[Target] = []
    reason = ""
    for name in names:
        if name not in _inputs(graph, encode_nid):
            continue
        target, why = _try_resolve(graph, encode_nid, name)
        if target is not None:
            targets.append(target)
        elif not reason:
            reason = why
    return _dedupe(targets), reason


# --------------------------------------------------------------------------
# Guider discovery
# --------------------------------------------------------------------------


def find_guider(graph: Graph, live: set[str]) -> Optional[str]:
    """The live node that owns ``positive``/``negative``.

    ``SamplerCustomAdvanced`` delegates to a ``CFGGuider`` via its ``guider`` input;
    resolve through it.
    """
    ordered = [nid for nid in node_order(live)]

    for nid in ordered:
        if _class_of(graph, nid) == "SamplerCustomAdvanced":
            guider_ref = _inputs(graph, nid).get("guider")
            src = _wire_source(guider_ref)
            if src is not None and "positive" in _inputs(graph, src):
                return src

    for ct in _DIRECT_SAMPLER_CLASSES:
        for nid in ordered:
            if _class_of(graph, nid) == ct and "positive" in _inputs(graph, nid):
                return nid

    for nid in ordered:
        inputs = _inputs(graph, nid)
        if "positive" in inputs and "negative" in inputs and "model" in inputs:
            return nid

    return None


# --------------------------------------------------------------------------
# Field resolvers
# --------------------------------------------------------------------------


def _collect_by_inputs(
    graph: Graph,
    live: set[str],
    owner_classes: frozenset[str],
    input_names: Sequence[str],
    skip: Optional[SkipFn] = None,
) -> Tuple[List[Target], str]:
    """Resolve every ``input_names`` slot on every live node in ``owner_classes``."""
    targets: List[Target] = []
    reason = ""
    for nid in node_order(live):
        if _class_of(graph, nid) not in owner_classes:
            continue
        inputs = _inputs(graph, nid)
        for name in input_names:
            if name not in inputs:
                continue
            if skip is not None and skip(graph, nid, name):
                continue
            target, why = _try_resolve(graph, nid, name)
            if target is not None:
                targets.append(target)
            elif not reason:
                reason = why
    return _dedupe(targets), reason


def _seed_disabled(graph: Graph, node_id: str, input_name: str) -> bool:
    """A ``noise_seed`` on a stage with ``add_noise: "disable"`` never affects output."""
    if input_name != "noise_seed":
        return False
    add_noise = _inputs(graph, node_id).get("add_noise")
    return add_noise in ("disable", False)


def _resolve_dimensions(graph: Graph, live: set[str]) -> Tuple[Dict[str, List[Target]], Notes]:
    """Find the node that sizes the generation, in priority order."""

    def has_pair(nid: str, a: str, b: str) -> bool:
        inputs = _inputs(graph, nid)
        return a in inputs and b in inputs

    ordered = node_order(live)

    tiers: List[List[Tuple[str, str, str]]] = [[], [], []]  # (nid, width_in, height_in)
    for nid in ordered:
        ct = _class_of(graph, nid)
        for w_in, h_in in (("width", "height"), ("target_width", "target_height")):
            if not has_pair(nid, w_in, h_in):
                continue
            if ct.startswith("Empty") and "Latent" in ct:
                tiers[0].append((nid, w_in, h_in))
            elif ct.endswith("ImageToVideo") or ct.endswith("ImageToImage"):
                tiers[1].append((nid, w_in, h_in))
            else:
                tiers[2].append((nid, w_in, h_in))
            break

    params: Dict[str, List[Target]] = {"width": [], "height": []}
    notes: Notes = {}
    for tier in tiers:
        if not tier:
            continue
        nid, w_in, h_in = tier[0]
        w_target, w_why = _try_resolve(graph, nid, w_in)
        h_target, h_why = _try_resolve(graph, nid, h_in)
        if w_target is not None:
            params["width"] = [w_target]
        else:
            notes["width"] = w_why
        if h_target is not None:
            params["height"] = [h_target]
        else:
            notes["height"] = h_why
        return params, notes

    notes["width"] = "no node with width/height inputs found"
    notes["height"] = notes["width"]
    return params, notes


def _role_score(graph: Graph, load_nid: str, roles: Sequence[Tuple[str, str]], consumers: Dict[str, List[Tuple[str, str]]]) -> Optional[int]:
    """Lowest role-priority index reachable downstream of ``load_nid``, or None."""
    best: Optional[int] = None
    queue: deque[Tuple[str, int]] = deque([(load_nid, 0)])
    visited: set[str] = set()
    while queue:
        nid, depth = queue.popleft()
        if nid in visited or depth > _MAX_DEPTH:
            continue
        visited.add(nid)
        for consumer_nid, in_name in consumers.get(nid, []):
            consumer_class = _class_of(graph, consumer_nid)
            for idx, (pattern, role_input) in enumerate(roles):
                if in_name == role_input and _class_matches(pattern, consumer_class):
                    if best is None or idx < best:
                        best = idx
                    break
            queue.append((consumer_nid, depth + 1))
    return best


def _resolve_images(graph: Graph, live: set[str], task_type: str) -> Tuple[Dict[str, List[Target]], Notes]:
    consumers = _consumers(graph)
    load_nodes = [nid for nid in node_order(live) if _class_of(graph, nid) in _LOAD_IMAGE_CLASSES]

    params: Dict[str, List[Target]] = {}
    notes: Notes = {}

    if not load_nodes:
        notes["input_image"] = "no LoadImage node in the live subgraph"
        params["input_image"] = []
        if task_type == "face_swap":
            params["face_swap"] = []
            notes["face_swap"] = notes["input_image"]
        return params, notes

    face_nodes = [
        nid for nid in load_nodes if _role_score(graph, nid, _FACE_REF_ROLES, consumers) is not None
    ]

    main_candidates = [nid for nid in load_nodes if nid not in face_nodes] or load_nodes
    ranked = node_order(main_candidates)  # ties break on id order, not string order
    scored = [
        (score, rank, nid)
        for rank, nid in enumerate(ranked)
        if (score := _role_score(graph, nid, _IMAGE_ROLE_PRIORITY, consumers)) is not None
    ]
    main_nid = min(scored)[2] if scored else ranked[0]

    params["input_image"] = [(main_nid, "image")]

    if task_type == "face_swap":
        ref = face_nodes[0] if face_nodes else next((n for n in load_nodes if n != main_nid), None)
        if ref is not None:
            params["face_swap"] = [(ref, "image")]
        else:
            params["face_swap"] = []
            notes["face_swap"] = "no second LoadImage node to use as the face reference"
    elif face_nodes:
        # Not a face_swap task type, but the graph has a ReActor reference image —
        # expose it so the client can override it.
        params["face_swap"] = [(face_nodes[0], "image")]

    return params, notes


def _resolve_upscale(graph: Graph, live: set[str]) -> Tuple[List[Target], str]:
    for nid in node_order(live):
        inputs = _inputs(graph, nid)
        for name in _UPSCALE_INPUTS:
            if name in inputs:
                target, why = _try_resolve(graph, nid, name)
                return ([target] if target else [], why)
    return [], "no node with an upscale factor input found"


def _resolve_length(graph: Graph, live: set[str]) -> Tuple[List[Target], str]:
    for nid in node_order(live):
        inputs = _inputs(graph, nid)
        for name in _LENGTH_INPUTS:
            if name in inputs:
                target, why = _try_resolve(graph, nid, name)
                return ([target] if target else [], why)
    return [], "no node with a frame-count input found"


# --------------------------------------------------------------------------
# txt2music
# --------------------------------------------------------------------------


def _guess_txt2music(graph: Graph, live: set[str]) -> Tuple[Dict[str, Any], Notes]:
    params: Dict[str, Any] = {}
    notes: Notes = {}

    seed_targets, seed_why = _collect_by_inputs(
        graph, live, _SEED_OWNER_CLASSES, _SEED_INPUTS, skip=_seed_disabled
    )
    params["seed"] = [list(t) for t in seed_targets]
    if not seed_targets and seed_why:
        notes["seed"] = seed_why

    encode_nid: Optional[str] = None
    for ct in _AUDIO_ENCODE_CLASSES:
        for nid in node_order(live):
            if _class_of(graph, nid) == ct:
                encode_nid = nid
                break
        if encode_nid:
            break

    if encode_nid:
        inputs = _inputs(graph, encode_nid)
        for field in _AUDIO_ENCODE_FIELDS:
            if field == "duration" or field not in inputs:
                continue
            target, why = _try_resolve(graph, encode_nid, field)
            if target is not None:
                params[field] = [list(target)]
            else:
                params[field] = []
                notes[field] = why

    duration_targets: List[Target] = []
    if encode_nid and "duration" in _inputs(graph, encode_nid):
        target, why = _try_resolve(graph, encode_nid, "duration")
        if target is not None:
            duration_targets.append(target)
        elif why:
            notes["duration"] = why
    for ct in _AUDIO_LATENT_CLASSES:
        latent_nid = next((n for n in node_order(live) if _class_of(graph, n) == ct), None)
        if latent_nid and "seconds" in _inputs(graph, latent_nid):
            target, _ = _try_resolve(graph, latent_nid, "seconds")
            if target is not None:
                duration_targets.append(target)
            break
    if duration_targets or "duration" in notes:
        params["duration"] = [list(t) for t in _dedupe(duration_targets)]

    steps_targets, steps_why = _collect_by_inputs(graph, live, _STEPS_OWNER_CLASSES, _STEPS_INPUTS)
    params["steps"] = [list(t) for t in steps_targets]
    if not steps_targets and steps_why:
        notes["steps"] = steps_why

    return params, notes


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------


def _guess_img_utils(graph: Graph, live: set[str], task_type: str) -> Tuple[Dict[str, Any], Notes]:
    """Param map for an ``img-utils.*`` operation: input images and nothing else."""
    params: Dict[str, Any] = {}
    img_params, notes = _resolve_images(graph, live, task_type)
    for key, targets in img_params.items():
        params[key] = [list(t) for t in targets]
    for key in _IMG_UTILS_KEYS.get(task_type, ("input_image",)):
        params.setdefault(key, [])
    return params, notes


def guess_params_ex(
    graph: Graph, task_type: str, namespace: str = ""
) -> Tuple[Dict[str, Any], Notes]:
    """Auto-detect the param map plus per-field explanations for unresolved fields.

    Returns ``(params, notes)``.  ``params`` maps each payload key to a list of
    ``[node_id, input_name]`` targets — empty when the value cannot be written, in
    which case ``notes[key]`` says why.

    ``namespace`` is the workflows sub-directory the graph lives in. It matters
    because a task type alone is ambiguous: ``face_swap`` under ``img-utils`` has
    no prompt, while a flat (imggen) ``face_swap`` model does.
    """
    if not isinstance(graph, dict) or not graph:
        return {}, {}

    graph = {str(k): v for k, v in graph.items()}
    live = live_subgraph(graph)

    if task_type == "txt2music":
        return _guess_txt2music(graph, live)

    if namespace == IMG_UTILS_NAMESPACE or task_type in _IMG_UTILS_TASK_TYPES:
        return _guess_img_utils(graph, live, task_type)

    params: Dict[str, Any] = {}
    notes: Notes = {}

    # prompt / negative
    guider = find_guider(graph, live)
    pos_nid: Optional[str] = None
    neg_nid: Optional[str] = None
    if guider is not None:
        ginputs = _inputs(graph, guider)
        pos_nid = trace_conditioning(graph, ginputs.get("positive"))
        neg_nid = trace_conditioning(graph, ginputs.get("negative"))
    if pos_nid is None:
        encoders = [nid for nid in node_order(live) if _class_of(graph, nid) in _TEXT_ENCODE_CLASSES]
        if len(encoders) == 1:
            pos_nid = encoders[0]

    if pos_nid is not None:
        targets, why = _text_targets(graph, pos_nid)
        params["prompt"] = [list(t) for t in targets]
        if not targets:
            notes["prompt"] = why or f"node {pos_nid} has no writable text input"
    else:
        params["prompt"] = []
        notes["prompt"] = "could not trace the positive conditioning to a text encoder"

    # A negative that traces to the same encoder is a derived conditioning
    # (ConditioningZeroOut) — there is nothing separate to write.
    if neg_nid is not None and neg_nid != pos_nid:
        targets, why = _text_targets(graph, neg_nid)
        params["negative"] = [list(t) for t in targets]
        if not targets:
            notes["negative"] = why or f"node {neg_nid} has no writable text input"
    else:
        params["negative"] = []
        if neg_nid is not None and neg_nid == pos_nid:
            notes["negative"] = (
                f"negative conditioning is derived from the positive encoder (node {pos_nid})"
            )
        else:
            notes["negative"] = "could not trace the negative conditioning to a text encoder"

    # width / height
    dims, dim_notes = _resolve_dimensions(graph, live)
    params["width"] = [list(t) for t in dims["width"]]
    params["height"] = [list(t) for t in dims["height"]]
    notes.update(dim_notes)

    # seed
    seed_targets, seed_why = _collect_by_inputs(
        graph, live, _SEED_OWNER_CLASSES, _SEED_INPUTS, skip=_seed_disabled
    )
    params["seed"] = [list(t) for t in seed_targets]
    if not seed_targets:
        notes["seed"] = seed_why or "no sampler with a seed input found"

    # input_image / face_swap
    if task_type in _IMAGE_TASK_TYPES:
        img_params, img_notes = _resolve_images(graph, live, task_type)
        for key, targets in img_params.items():
            params[key] = [list(t) for t in targets]
        notes.update(img_notes)

    if task_type == "upscale":
        targets, why = _resolve_upscale(graph, live)
        params["upscale"] = [list(t) for t in targets]
        if not targets:
            notes["upscale"] = why

    if task_type in _VIDEO_TASK_TYPES:
        targets, why = _resolve_length(graph, live)
        params["length"] = [list(t) for t in targets]
        if not targets:
            notes["length"] = why

    # Extra (non-standard) keys — reach the graph via payload.secondary_prompts.*
    steps_targets, _ = _collect_by_inputs(graph, live, _STEPS_OWNER_CLASSES, _STEPS_INPUTS)
    if steps_targets:
        params["steps"] = [list(t) for t in steps_targets]

    cfg_targets, _ = _collect_by_inputs(graph, live, _CFG_OWNER_CLASSES, _CFG_INPUTS)
    if cfg_targets:
        params["cfg"] = [list(t) for t in cfg_targets]

    fps_targets, _ = _collect_by_inputs(graph, live, _FPS_OWNER_CLASSES, _FPS_INPUTS)
    if fps_targets:
        params["fps"] = [list(t) for t in fps_targets]

    # Every standard key for the task type must be present, even when empty.
    for key in _STANDARD_KEYS.get(task_type, _TXT_BASE):
        params.setdefault(key, [])

    return params, notes


def guess_params(graph: Graph, task_type: str, namespace: str = "") -> Dict[str, Any]:
    """Auto-detect param → node-input mappings from a Comfy API-format graph."""
    params, _ = guess_params_ex(graph, task_type, namespace)
    return params
