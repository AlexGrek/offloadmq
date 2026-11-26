"""WorldMirror's raw output → a viewer scene: camera frame, scale and 3DGS encoding.

WorldMirror's world is not metric (5–15× off on the A1 test pictures) and its PLY
stores opacity as a probability instead of the 3DGS logit. Pure numpy, no torch.
See docs/worlds-quality-plan.md (A1).
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import numpy as np

from .splat import Arr

FIELDS = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
          "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
#: Without a metric reference the median surface is placed this far away.
FALLBACK_MEDIAN_M = 5.0
GRID = 96
#: Fewer overlapping grid cells than this and a depth comparison means nothing.
MIN_CELLS = 200


@dataclass(frozen=True)
class Camera:
    """Pinhole intrinsics in pixels of a ``width`` × ``height`` image."""

    fx: float
    fy: float
    cx: float
    cy: float
    width: float
    height: float

    @property
    def hfov(self) -> float:
        return math.degrees(2 * math.atan(0.5 * self.width / self.fx))

    @property
    def vfov(self) -> float:
        return math.degrees(2 * math.atan(0.5 * self.height / self.fy))


@dataclass(frozen=True)
class Splats:
    xyz: Arr  # (N, 3), OpenCV camera frame
    sh: Arr  # (N, 3) degree-0 spherical harmonics
    opacity: Arr  # (N,) probability
    log_scale: Arr  # (N, 3)
    quats: Arr  # (N, 4) wxyz

    def __len__(self) -> int:
        return int(len(self.xyz))


def quat_mul(a: Arr, b: Arr) -> Arr:
    aw, ax, ay, az = np.moveaxis(a, -1, 0)
    bw, bx, by, bz = np.moveaxis(b, -1, 0)
    return np.stack([aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by,
                     aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw], -1)


def mat_to_quat(m: Arr) -> Arr:
    """wxyz quaternion of a proper rotation matrix."""
    w = math.sqrt(max(0.0, 1 + m[0, 0] + m[1, 1] + m[2, 2])) / 2
    x = math.copysign(math.sqrt(max(0.0, 1 + m[0, 0] - m[1, 1] - m[2, 2])) / 2, m[2, 1] - m[1, 2])
    y = math.copysign(math.sqrt(max(0.0, 1 - m[0, 0] + m[1, 1] - m[2, 2])) / 2, m[0, 2] - m[2, 0])
    z = math.copysign(math.sqrt(max(0.0, 1 - m[0, 0] - m[1, 1] + m[2, 2])) / 2, m[1, 0] - m[0, 1])
    return np.array([w, x, y, z])


def camera_from_intrinsics(k: Any) -> Camera:
    """WorldMirror's K is in processed-image pixels with the principal point centred."""
    m = np.asarray(k, np.float64)
    cx, cy = float(m[0, 2]), float(m[1, 2])
    return Camera(float(m[0, 0]), float(m[1, 1]), cx, cy, 2 * cx, 2 * cy)


def from_official(cols: Mapping[str, Any], camera_to_world: Any) -> Splats:
    """The official ``gaussians.ply`` columns, moved into the input camera's frame."""
    opacity = np.asarray(cols["opacity"], np.float32)
    if len(opacity) == 0:
        raise ValueError("WorldMirror kept no Gaussians for this picture")
    if float(opacity.min()) < 0 or float(opacity.max()) > 1:
        raise ValueError("unexpected WorldMirror PLY: opacity is not a probability")
    w2c = np.linalg.inv(np.asarray(camera_to_world, np.float64))
    xyz = np.stack([cols["x"], cols["y"], cols["z"]], 1).astype(np.float32)
    xyz = xyz @ w2c[:3, :3].T.astype(np.float32) + w2c[:3, 3].astype(np.float32)
    quats = np.stack([cols[f"rot_{i}"] for i in range(4)], 1).astype(np.float32)
    rotation = mat_to_quat(w2c[:3, :3]).astype(np.float32)
    quats = quat_mul(np.broadcast_to(rotation, quats.shape), quats)
    return Splats(
        xyz=xyz,
        sh=np.stack([cols[f"f_dc_{i}"] for i in range(3)], 1).astype(np.float32),
        opacity=opacity,
        log_scale=np.stack([cols[f"scale_{i}"] for i in range(3)], 1).astype(np.float32),
        quats=quats.astype(np.float32),
    )


def front_depth(xyz: Arr, opacity: Arr, camera: Camera, grid: int = GRID) -> Arr:
    """Near-surface depth per image cell (20th percentile of opaque splats), NaN if empty.

    Cells are in normalised image coordinates, so two resolutions compare directly."""
    z = xyz[:, 2]
    ok = (z > 0.05) & (opacity > 0.5)
    x, y, z = xyz[ok, 0], xyz[ok, 1], z[ok]
    u = ((camera.fx * x / z + camera.cx) / camera.width * grid).astype(np.int64)
    v = ((camera.fy * y / z + camera.cy) / camera.height * grid).astype(np.int64)
    inside = (u >= 0) & (u < grid) & (v >= 0) & (v < grid)
    cell, z = (v * grid + u)[inside], z[inside]
    order = np.lexsort((z, cell))
    cell, z = cell[order], z[order]
    ids, start, count = np.unique(cell, return_index=True, return_counts=True)
    out = np.full(grid * grid, np.nan)
    out[ids] = z[start + (count - 1) // 5]
    return out.reshape(grid, grid)


def compare_depth(reference: Arr, test: Arr) -> dict[str, float] | None:
    """The scale that maps ``test`` onto ``reference`` and how well they agree after it."""
    both = np.isfinite(reference) & np.isfinite(test)
    if int(both.sum()) < MIN_CELLS:
        return None
    ratio = reference[both] / test[both]
    scale = float(np.median(ratio))
    err = np.abs(np.log(ratio / scale))
    return {
        "scale": scale,
        "cells_compared": int(both.sum()),
        "median_rel_error": float(np.expm1(np.median(err))),
        "p90_rel_error": float(np.expm1(np.percentile(err, 90))),
    }


def fallback_scale(splats: Splats) -> float:
    z = splats.xyz[(splats.opacity > 0.5) & (splats.xyz[:, 2] > 0), 2]
    if len(z) == 0:
        return 1.0
    return FALLBACK_MEDIAN_M / float(np.median(z))


def scaled(splats: Splats, factor: float) -> Splats:
    return Splats(
        xyz=(splats.xyz * factor).astype(np.float32),
        sh=splats.sh,
        opacity=splats.opacity,
        log_scale=(splats.log_scale + math.log(factor)).astype(np.float32),
        quats=splats.quats,
    )


def write_ply(splats: Splats) -> bytes:
    """Standard 3DGS ``vertex`` PLY: logit opacity, log scales, wxyz quaternions."""
    op = np.clip(splats.opacity.astype(np.float64), 1e-6, 1 - 1e-6)
    cols = np.concatenate(
        [splats.xyz, splats.sh, np.log(op / (1 - op))[:, None], splats.log_scale, splats.quats], 1,
    )
    data = np.ascontiguousarray(cols.astype("<f4"))
    header = "\n".join(["ply", "format binary_little_endian 1.0", f"element vertex {len(data)}"]
                       + [f"property float {f}" for f in FIELDS] + ["end_header", ""])
    return header.encode("ascii") + data.tobytes()
