"""Pure-PyTorch 3D Gaussian splat renderer (no compiled extension).

gsplat 1.5.3 JIT-compiles CUDA kernels on first use, which needs a CUDA toolkit and
MSVC on the agent. This renders the same image model with plain tensor ops:

* EWA projection: 2D covariance = J W Σ Wᵀ Jᵀ + 0.3 px² (the 3DGS low-pass term);
* every (Gaussian, pixel) pair inside 3σ with alpha ≥ 1/255;
* **per-pixel** depth sort (3DGS sorts per tile) and front-to-back compositing through a
  segmented cumulative sum of log(1 − α);
* the image is composited in horizontal bands, so peak GPU memory does not grow with the
  resolution or with Gaussians that come close to the camera.

Outputs colour, alpha, expected depth and the median depth (where transmittance falls
below 0.5). Frame: OpenCV (x right, y down, z forward), pixel centres at i + 0.5.
Self-check: ``torch_splat_check.py``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import torch

ALPHA_MIN = 1.0 / 255.0
ALPHA_MAX = 0.99
LOW_PASS = 0.3
#: As in Spark, the headset viewer: splats centred further out than this multiple of the
#: half-view are not drawn, and no footprint reaches further than this many pixels. Without
#: it, splats nearly beside the camera smear across the whole image on large turns.
CLIP_XY = 1.4
MAX_RADIUS_PX = 512
#: Candidate (Gaussian, pixel) pairs composited at once; bounds peak memory.
PAIRS_PER_BAND = 32_000_000
#: Candidates evaluated per step inside a band.
PAIRS_PER_CHUNK = 12_000_000


@dataclass
class Gaussians:
    means: torch.Tensor  # (N, 3) world frame
    scales: torch.Tensor  # (N, 3) standard deviations (not log)
    quats: torch.Tensor  # (N, 4) wxyz
    colors: torch.Tensor  # (N, 3) display RGB 0..1
    opacities: torch.Tensor  # (N,) 0..1

    def __len__(self) -> int:
        return int(self.means.shape[0])

    def subset(self, mask: torch.Tensor) -> Gaussians:
        return Gaussians(self.means[mask], self.scales[mask], self.quats[mask], self.colors[mask],
                         self.opacities[mask])

    @staticmethod
    def cat(parts: list[Gaussians]) -> Gaussians:
        return Gaussians(*(torch.cat([getattr(p, f) for p in parts]) for f in
                           ("means", "scales", "quats", "colors", "opacities")))


@dataclass
class Camera:
    """Pinhole camera: world→camera rotation ``R`` (3×3) and translation ``t`` (3)."""

    R: torch.Tensor
    t: torch.Tensor
    fx: float
    fy: float
    cx: float
    cy: float
    width: int
    height: int

    @staticmethod
    def pose(position: tuple[float, float, float], yaw_deg: float, pitch_deg: float, fx: float, fy: float,
             width: int, height: int, device: torch.device) -> Camera:
        """A camera at ``position`` in the base frame, turned left by ``yaw`` and up by ``pitch``."""
        a, b = math.radians(yaw_deg), math.radians(pitch_deg)
        yaw = torch.tensor([[math.cos(a), 0, -math.sin(a)], [0, 1, 0], [math.sin(a), 0, math.cos(a)]])
        pitch = torch.tensor([[1, 0, 0], [0, math.cos(b), -math.sin(b)], [0, math.sin(b), math.cos(b)]])
        c2w = (yaw @ pitch).to(device, torch.float32)  # columns: right, down, forward
        c = torch.tensor(position, dtype=torch.float32, device=device)
        R = c2w.T
        return Camera(R, -R @ c, fx, fy, width / 2, height / 2, width, height)


@dataclass
class Render:
    color: torch.Tensor  # (H, W, 3)
    alpha: torch.Tensor  # (H, W)
    depth: torch.Tensor  # (H, W) expected depth of what was drawn (0 where alpha = 0)
    median_depth: torch.Tensor  # (H, W) depth where transmittance drops below 0.5 (NaN if never)
    candidates: int  # (Gaussian, pixel) pairs evaluated


def quat_to_rotmat(q: torch.Tensor) -> torch.Tensor:
    q = q / q.norm(dim=-1, keepdim=True).clamp_min(1e-12)
    w, x, y, z = q.unbind(-1)
    return torch.stack([
        1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
        2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
        2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ], -1).reshape(-1, 3, 3)


def _project(g: Gaussians, cam: Camera, near: float) -> dict[str, torch.Tensor]:
    p = g.means @ cam.R.T + cam.t
    z = p[:, 2]
    keep = z > near
    idx = keep.nonzero().squeeze(1)
    p, z = p[idx], z[idx]
    rot = cam.R @ quat_to_rotmat(g.quats[idx])  # Gaussian axes in camera frame
    m = rot * g.scales[idx, None, :]
    cov = m @ m.transpose(1, 2)
    x, y = p[:, 0], p[:, 1]
    zero = torch.zeros_like(z)
    J = torch.stack([cam.fx / z, zero, -cam.fx * x / z**2, zero, cam.fy / z, -cam.fy * y / z**2], -1).reshape(-1, 2, 3)
    cov2 = J @ cov @ J.transpose(1, 2)
    a = cov2[:, 0, 0] + LOW_PASS
    b = cov2[:, 0, 1]
    c = cov2[:, 1, 1] + LOW_PASS
    det = (a * c - b * b).clamp_min(1e-12)
    u = cam.fx * x / z + cam.cx
    v = cam.fy * y / z + cam.cy
    mid = 0.5 * (a + c)
    lam = mid + torch.sqrt((mid * mid - det).clamp_min(0))
    r = torch.ceil(3 * torch.sqrt(lam)).clamp_max(MAX_RADIUS_PX)
    x0 = torch.floor(u - r).clamp(0, cam.width).long()
    x1 = torch.ceil(u + r).clamp(0, cam.width).long()
    y0 = torch.floor(v - r).clamp(0, cam.height).long()
    y1 = torch.ceil(v + r).clamp(0, cam.height).long()
    centred = ((u - cam.cx).abs() <= CLIP_XY * cam.width / 2) & ((v - cam.cy).abs() <= CLIP_XY * cam.height / 2)
    on = centred & (x1 > x0) & (y1 > y0)
    sel = on.nonzero().squeeze(1)
    return {
        "gid": idx[sel], "z": z[sel], "u": u[sel], "v": v[sel],
        # inverse covariance (conic)
        "ia": (c / det)[sel], "ib": (-b / det)[sel], "ic": (a / det)[sel],
        "x0": x0[sel], "y0": y0[sel], "y1": y1[sel], "bw": (x1 - x0)[sel],
    }


def _bands(pr: dict[str, torch.Tensor], height: int, budget: int) -> tuple[list[tuple[int, int]], int]:
    """Row ranges holding at most ``budget`` candidate pairs each (at least one row), and the total."""
    diff = torch.zeros(height + 1, dtype=torch.int64, device=pr["y0"].device)
    diff.index_add_(0, pr["y0"], pr["bw"])
    diff.index_add_(0, pr["y1"], -pr["bw"])
    rows = torch.cumsum(diff[:height], 0).tolist()
    out: list[tuple[int, int]] = []
    start = held = 0
    for y, n in enumerate(rows):
        if y > start and held + n > budget:
            out.append((start, y))
            start, held = y, 0
        held += n
    out.append((start, height))
    return out, sum(rows)


def _pairs(opacities: torch.Tensor, band: dict[str, torch.Tensor], width: int) -> list[torch.Tensor]:
    """Every visible (pixel, depth, alpha, Gaussian id) pair of the band's boxes."""
    dev = opacities.device
    counts = band["bw"] * band["bh"]
    csum = torch.cumsum(counts, 0)
    n = len(counts)
    start = 0
    parts: list[tuple[torch.Tensor, ...]] = []
    while start < n:
        base = int(csum[start - 1]) if start else 0
        end = int(torch.searchsorted(csum, torch.tensor(base + PAIRS_PER_CHUNK, device=dev), right=True))
        end = max(end, start + 1)
        sl = slice(start, end)
        cnt = counts[sl]
        local = torch.repeat_interleave(torch.arange(end - start, device=dev), cnt)
        offs = torch.arange(int(cnt.sum()), device=dev) - torch.repeat_interleave(torch.cumsum(cnt, 0) - cnt, cnt)
        bw = band["bw"][sl][local]
        px = band["x0"][sl][local] + offs % bw
        py = band["y0"][sl][local] + offs // bw
        dx = px.float() + 0.5 - band["u"][sl][local]
        dy = py.float() + 0.5 - band["v"][sl][local]
        power = (-0.5 * (band["ia"][sl][local] * dx * dx + band["ic"][sl][local] * dy * dy)
                 - band["ib"][sl][local] * dx * dy)
        gid = band["gid"][sl][local]
        alpha = (opacities[gid] * torch.exp(power)).clamp_max(ALPHA_MAX)
        ok = alpha >= ALPHA_MIN
        parts.append(((py * width + px)[ok], band["z"][sl][local][ok], alpha[ok], gid[ok]))
        start = end
    return [torch.cat(column) for column in zip(*parts)]


def render(g: Gaussians, cam: Camera, near: float = 0.05, background: float = 0.0,
           pairs_per_band: int = PAIRS_PER_BAND) -> Render:
    dev = g.means.device
    W, H = cam.width, cam.height
    pr = _project(g, cam, near)
    npx = W * H
    color = torch.zeros(npx, 3, device=dev)
    acc = torch.zeros(npx, device=dev)
    dsum = torch.zeros(npx, device=dev)
    med = torch.full((npx,), float("inf"), device=dev)
    bands, candidates = _bands(pr, H, pairs_per_band)
    for top, bottom in bands:
        sel = ((pr["y1"] > top) & (pr["y0"] < bottom)).nonzero().squeeze(1)
        if not len(sel):
            continue
        band = {k: v[sel] for k, v in pr.items()}
        band["y0"] = band["y0"].clamp_min(top)
        band["bh"] = band["y1"].clamp_max(bottom) - band["y0"]
        pix, z, alpha, gid = _pairs(g.opacities, band, W)
        if not len(pix):
            continue
        order = torch.argsort(z)
        order = order[torch.argsort(pix[order], stable=True)]
        pix, z, alpha, gid = pix[order], z[order], alpha[order], gid[order]
        del order
        la = torch.log1p(-alpha).double()
        excl = torch.cumsum(la, 0) - la  # sum of log(1-a) over all earlier pairs of the band
        del la
        first = torch.ones_like(pix, dtype=torch.bool)
        first[1:] = pix[1:] != pix[:-1]
        seg_start = torch.cummax(torch.where(first, torch.arange(len(pix), device=dev), 0), 0).values
        T = torch.exp(excl - excl[seg_start]).float()  # transmittance in front of each pair
        del excl, seg_start, first
        w = alpha * T
        color.index_add_(0, pix, w[:, None] * g.colors[gid])
        acc.index_add_(0, pix, w)
        dsum.index_add_(0, pix, w * z)
        crossed = (T * (1 - alpha)) < 0.5
        med.scatter_reduce_(0, pix[crossed], z[crossed], reduce="amin")
    med = torch.where(torch.isinf(med), torch.full_like(med, float("nan")), med)
    color = color + background * (1 - acc)[:, None]
    depth = torch.where(acc > 1e-6, dsum / acc.clamp_min(1e-6), torch.zeros_like(acc))
    return Render(color.reshape(H, W, 3).clamp(0, 1), acc.reshape(H, W), depth.reshape(H, W), med.reshape(H, W),
                  candidates)
