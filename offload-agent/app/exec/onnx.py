"""ONNX model executors.

Currently supports:
    onnx.nudenet — NudeNet v3 NSFW detector (image region detection via YOLO)

Requires ``onnxruntime``, ``numpy``, and ``Pillow`` (all optional deps).
The executor is only routed to when the model file is already downloaded;
use ``slavemode.onnx-models-prepare`` or the CLI to fetch models.
"""

import logging
from pathlib import Path
from typing import Any

from ..models import TaskId
from ..transport import AgentTransport
from ..onnx_models import model_path
from .helpers import make_failure_report, make_success_report, report_result

logger = logging.getLogger("agent")

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff", ".tif"}

NUDENET_LABELS = [
    "FEMALE_GENITALIA_COVERED",
    "FACE_FEMALE",
    "BUTTOCKS_EXPOSED",
    "FEMALE_BREAST_EXPOSED",
    "FEMALE_GENITALIA_EXPOSED",
    "MALE_BREAST_EXPOSED",
    "ANUS_EXPOSED",
    "FEET_EXPOSED",
    "BELLY_COVERED",
    "FEET_COVERED",
    "ARMPITS_COVERED",
    "ARMPITS_EXPOSED",
    "FACE_MALE",
    "BELLY_EXPOSED",
    "MALE_GENITALIA_EXPOSED",
    "ANUS_COVERED",
    "FEMALE_BREAST_COVERED",
    "BUTTOCKS_COVERED",
]


def _find_images(data_path: Path) -> list[Path]:
    if not data_path.exists():
        return []
    return sorted(
        f for f in data_path.iterdir()
        if f.is_file() and f.suffix.lower() in _IMAGE_EXTENSIONS
    )


# ---------------------------------------------------------------------------
# NudeNet inference
# ---------------------------------------------------------------------------

def _iou(a: dict[str, float], b: dict[str, float]) -> float:
    x1 = max(a["x1"], b["x1"])
    y1 = max(a["y1"], b["y1"])
    x2 = min(a["x2"], b["x2"])
    y2 = min(a["y2"], b["y2"])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    area_a = (a["x2"] - a["x1"]) * (a["y2"] - a["y1"])
    area_b = (b["x2"] - b["x1"]) * (b["y2"] - b["y1"])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _nms(detections: list[dict[str, Any]], iou_threshold: float = 0.45) -> list[dict[str, Any]]:
    """Per-class non-maximum suppression."""
    by_label: dict[str, list[dict[str, Any]]] = {}
    for d in detections:
        by_label.setdefault(d["label"], []).append(d)

    kept: list[dict[str, Any]] = []
    for dets in by_label.values():
        dets.sort(key=lambda d: d["confidence"], reverse=True)
        selected: list[dict[str, Any]] = []
        for d in dets:
            if all(_iou(d["box"], s["box"]) < iou_threshold for s in selected):
                selected.append(d)
        kept.extend(selected)
    return kept


def _run_nudenet(
    model_file: Path,
    image_path: Path,
    threshold: float = 0.25,
) -> list[dict[str, Any]]:
    """Run NudeNet 320n ONNX model on a single image. Returns list of detections."""
    import numpy as np
    from PIL import Image
    import onnxruntime as ort  # type: ignore[import-untyped]

    img = Image.open(image_path).convert("RGB")
    orig_w, orig_h = img.size

    resized = img.resize((320, 320))
    arr = np.array(resized, dtype=np.float32) / 255.0
    arr = arr.transpose(2, 0, 1)  # HWC → CHW
    arr = np.expand_dims(arr, axis=0)  # [1, 3, 320, 320]

    session = ort.InferenceSession(str(model_file))
    input_name = session.get_inputs()[0].name
    outputs = session.run(None, {input_name: arr})

    preds = outputs[0]
    if preds.ndim == 3:
        # [1, 22, 8400] → transpose to [1, 8400, 22] if needed
        if preds.shape[1] < preds.shape[2]:
            preds = preds.transpose(0, 2, 1)
        preds = preds[0]  # [8400, 22]

    detections: list[dict[str, Any]] = []
    for pred in preds:
        cx, cy, w, h = float(pred[0]), float(pred[1]), float(pred[2]), float(pred[3])
        class_scores = pred[4:]
        max_idx = int(np.argmax(class_scores))
        confidence = float(class_scores[max_idx])
        if confidence < threshold:
            continue

        x1 = max(0.0, (cx - w / 2) / 320 * orig_w)
        y1 = max(0.0, (cy - h / 2) / 320 * orig_h)
        x2 = min(float(orig_w), (cx + w / 2) / 320 * orig_w)
        y2 = min(float(orig_h), (cy + h / 2) / 320 * orig_h)

        label = NUDENET_LABELS[max_idx] if max_idx < len(NUDENET_LABELS) else f"class_{max_idx}"
        detections.append({
            "label": label,
            "confidence": round(confidence, 4),
            "box": {
                "x1": round(x1, 1),
                "y1": round(y1, 1),
                "x2": round(x2, 1),
                "y2": round(y2, 1),
            },
        })

    detections = _nms(detections, iou_threshold=0.45)
    detections.sort(key=lambda d: d["confidence"], reverse=True)
    return detections


# ---------------------------------------------------------------------------
# Executor entry point
# ---------------------------------------------------------------------------

def execute_onnx(
    transport: AgentTransport,
    task_id: TaskId,
    capability: str,
    payload: dict[str, Any],
    data: Path,
) -> bool:
    """Dispatch to the appropriate ONNX executor based on capability name."""
    if capability == "onnx.nudenet":
        return _execute_nudenet(transport, task_id, capability, payload, data)

    msg = f"Unknown ONNX capability: {capability}"
    logger.error(msg)
    report = make_failure_report(task_id, capability, msg)
    return report_result(transport, report)


def _execute_nudenet(
    transport: AgentTransport,
    task_id: TaskId,
    capability: str,
    payload: dict[str, Any],
    data: Path,
) -> bool:
    """Run NudeNet detection on images in the task data directory."""
    mpath = model_path("nudenet")
    if not mpath:
        msg = "NudeNet model not installed. Use slavemode.onnx-models-prepare or CLI 'onnx prepare nudenet'"
        report = make_failure_report(task_id, capability, msg)
        return report_result(transport, report)

    threshold = 0.25
    if isinstance(payload, dict):
        threshold = float(payload.get("threshold", 0.25))

    images = _find_images(data)
    if not images:
        msg = "No image files found in task data. Attach images via file_bucket or fetchFiles."
        report = make_failure_report(task_id, capability, msg)
        return report_result(transport, report)

    results: list[dict[str, Any]] = []
    for img_path in images:
        logger.info(f"[onnx.nudenet] Processing {img_path.name}")
        try:
            detections = _run_nudenet(mpath, img_path, threshold=threshold)
            results.append({
                "file": img_path.name,
                "detections": detections,
                "detection_count": len(detections),
            })
        except Exception as e:
            logger.error(f"[onnx.nudenet] Failed on {img_path.name}: {e}")
            results.append({
                "file": img_path.name,
                "error": str(e),
                "detections": [],
                "detection_count": 0,
            })

    output: dict[str, Any] = {
        "model": "nudenet",
        "threshold": threshold,
        "images_processed": len(results),
        "results": results,
    }
    report = make_success_report(task_id, capability, output)
    return report_result(transport, report)
