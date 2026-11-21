"""Image + depth map → 3D Gaussian splat (pure numpy, no I/O).

One camera-facing disc per pixel is back-projected through a pinhole
(``perspective``) or a sphere (``pano``, equirectangular input). A hidden
background layer — "layered depth image lite" — is grown behind every depth
edge so that leaning a few centimetres reveals stretched background instead of
a hole. Output is a standard binary 3DGS PLY in the OpenCV camera frame
(x right, y down, z forward); viewers flip it to their own convention.

Ported from ``examples/vr-world-poc/pipeline.py``; see docs/agent-capabilities.md
(``world.splat``) and VR-WORLD.md for the experiment it came from.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Any

import numpy as np
import numpy.typing as npt
from PIL import Image, ImageDraw

Arr = npt.NDArray[Any]

SH_C0 = 0.28209479177387814
MODES = ("perspective", "pano")
PLY_FIELDS = (
    "x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
    "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
)
# An equirectangular panorama is 2:1; allow a little slack for odd encoders.
_PANO_ASPECT = (1.9, 2.1)


@dataclass(frozen=True)
class SplatSettings:
    mode: str = "perspective"      # resolved: "perspective" | "pano"
    hfov: float = 70.0             # horizontal FOV assumed for perspective art (degrees)
    near: float = 1.2              # metres mapped to the nearest depth value
    far: float = 50.0              # metres mapped to the farthest depth value
    fill_lean: float = 0.25        # head movement (m) the hidden background must cover; 0 = off
    fill_jump: float = 1.5         # a surface this many times farther counts as background
    depth_smooth: int = 3          # 3x3 box-blur passes (8-bit depth terraces otherwise)
    splat_scale: float = 0.65      # disc radius relative to the pixel footprint
    max_width: int = 1024          # splat grid width: 1 splat per pixel


@dataclass(frozen=True)
class SplatWorld:
    ply: bytes
    preview_png: bytes
    splats_fg: int
    splats_bg: int
    depth_min: float
    depth_max: float
    grid_width: int
    grid_height: int

    @property
    def splat_count(self) -> int:
        return self.splats_fg + self.splats_bg


def resolve_mode(width: int, height: int, requested: str | None) -> str:
    """``auto``/``None`` picks ``pano`` for a ~2:1 image, else ``perspective``."""
    if requested in MODES:
        return str(requested)
    if requested not in (None, "", "auto"):
        raise ValueError(f"mode must be one of auto, {', '.join(MODES)} — got {requested!r}")
    aspect = width / max(height, 1)
    return "pano" if _PANO_ASPECT[0] <= aspect <= _PANO_ASPECT[1] else "perspective"


# --------------------------------------------------------------------------- geometry


def shift(a: Arr, dy: int, dx: int, fill: float) -> Arr:
    """Translate an image-shaped array by (dy, dx), filling the uncovered border."""
    out = np.empty_like(a)
    out[...] = fill
    h, w = a.shape[:2]
    ys, yd = (slice(0, h - dy), slice(dy, h)) if dy >= 0 else (slice(-dy, h), slice(0, h + dy))
    xs, xd = (slice(0, w - dx), slice(dx, w)) if dx >= 0 else (slice(-dx, w), slice(0, w + dx))
    out[yd, xd] = a[ys, xs]
    return out


def smooth(v: Arr, passes: int) -> Arr:
    """3x3 box blur, edge-replicated. Removes 8-bit depth terracing."""
    for _ in range(max(0, passes)):
        acc = np.zeros_like(v)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                acc += shift(v, dy, dx, 0.0)
        v = acc / 9.0
        v[[0, -1], :] = v[[1, -2], :]
        v[:, [0, -1]] = v[:, [1, -2]]
    return v


def depth_from_map(v: Arr, near: float, far: float) -> Arr:
    """Lotus-D predicts affine depth with near = white: map linearly to metres."""
    return near + (1.0 - np.clip(v, 0.0, 1.0)) * (far - near)


def background_layer(rgb: Arr, z: Arr, iters: int, jump: float) -> tuple[Arr, Arr, Arr]:
    """Grow the far side of every depth edge in behind the near side.

    Returns ``(mask, colour, depth)`` of pixels needing a hidden background splat.
    A neighbour feeds pixel p only if it lies ``jump``× farther than p's own
    surface, so foreground interiors never leak into the layer behind themselves.
    """
    fz = z.copy()
    fc = rgb.copy()
    filled = np.zeros(z.shape, bool)
    for _ in range(iters):
        acc_c = np.zeros_like(rgb)
        acc_z = np.zeros_like(z)
        n = np.zeros_like(z)
        src_z = np.where(filled, fz, z)
        src_c = np.where(filled[..., None], fc, rgb)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            nz = shift(src_z, dy, dx, 0.0)
            nc = shift(src_c, dy, dx, 0.0)
            ok = (nz > z * jump) & ~filled
            acc_c += nc * ok[..., None]
            acc_z += nz * ok
            n += ok
        new = n > 0
        if not new.any():
            break
        fc[new] = acc_c[new] / n[new, None]
        fz[new] = acc_z[new] / n[new]
        filled |= new
    return filled, fc, fz


def backproject(z: Arr, mode: str, hfov_deg: float) -> tuple[Arr, Arr, Arr]:
    """Per-pixel ``(xyz, footprint[w,h], ray_dir)`` in the OpenCV camera frame."""
    h, w = z.shape
    u, v = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    if mode == "pano":
        lon = (u / w - 0.5) * 2 * np.pi
        lat = (0.5 - v / h) * np.pi
        dirs = np.stack([np.cos(lat) * np.sin(lon), -np.sin(lat), np.cos(lat) * np.cos(lon)], -1)
        foot_u = z * (2 * np.pi / w) * np.maximum(np.cos(lat), 0.05)
        foot_v = z * (np.pi / h)
        return dirs * z[..., None], np.stack([foot_u, foot_v], -1), dirs
    f = 0.5 * w / np.tan(np.radians(hfov_deg) / 2)
    x = (u - w / 2) / f
    y = (v - h / 2) / f
    dirs = np.stack([x, y, np.ones_like(x)], -1)
    foot = z / f * np.sqrt(1 + x * x + y * y)
    return dirs * z[..., None], np.stack([foot, foot], -1), dirs


def quat_look(dirs: Arr) -> Arr:
    """Quaternion (w,x,y,z) rotating +Z onto each direction — discs face the eye."""
    d = dirs / np.linalg.norm(dirs, axis=1, keepdims=True)
    zaxis = np.broadcast_to(np.array([0.0, 0.0, 1.0]), d.shape)
    w = 1.0 + d[:, 2]
    q = np.concatenate([w[:, None], np.cross(zaxis, d)], axis=1)
    q[w < 1e-6] = [0.0, 1.0, 0.0, 0.0]
    out: Arr = q / np.linalg.norm(q, axis=1, keepdims=True)
    return out


def _disc_scales(foot: Arr, splat_scale: float) -> Arr:
    thin = np.minimum(foot[:, 0], foot[:, 1]) * 0.15
    return np.maximum(np.stack([foot[:, 0] * splat_scale, foot[:, 1] * splat_scale, thin], 1), 1e-5)


def write_ply(xyz: Arr, rgb: Arr, scales: Arr, quats: Arr, opacity: Arr) -> bytes:
    """Standard 3DGS binary PLY (degree-0 SH, logit opacity, log scales)."""
    n = xyz.shape[0]
    data = np.zeros((n, len(PLY_FIELDS)), dtype=np.float32)
    data[:, 0:3] = xyz
    data[:, 6:9] = (rgb - 0.5) / SH_C0
    data[:, 9] = np.log(opacity / (1 - opacity))
    data[:, 10:13] = np.log(scales)
    data[:, 13:17] = quats
    header = f"ply\nformat binary_little_endian 1.0\nelement vertex {n}\n"
    header += "".join(f"property float {f}\n" for f in PLY_FIELDS) + "end_header\n"
    return header.encode("ascii") + data.tobytes()


# --------------------------------------------------------------------------- build


def _fit_width(img: Image.Image, max_width: int, resample: Image.Resampling) -> Image.Image:
    if max_width and img.width > max_width:
        return img.resize((max_width, round(img.height * max_width / img.width)), resample)
    return img


def build_world(rgb_img: Image.Image, depth_img: Image.Image, s: SplatSettings) -> SplatWorld:
    rgb_img = _fit_width(rgb_img.convert("RGB"), s.max_width, Image.Resampling.LANCZOS)
    rgb = np.asarray(rgb_img, dtype=np.float32) / 255.0
    dmap = depth_img.convert("L").resize(rgb_img.size, Image.Resampling.BICUBIC)
    v = smooth(np.asarray(dmap, dtype=np.float32) / 255.0, s.depth_smooth)
    z = depth_from_map(v, s.near, s.far).astype(np.float32)

    xyz, foot, dirs = backproject(z, s.mode, s.hfov)
    xyz_f, rgb_f = xyz.reshape(-1, 3), rgb.reshape(-1, 3)
    scales = _disc_scales(foot.reshape(-1, 2), s.splat_scale)
    quats = quat_look(dirs.reshape(-1, 3))
    n_fg = len(xyz_f)

    n_bg = 0
    if s.fill_lean > 0:
        # Half resolution is plenty for a blurred background and 4× cheaper.
        h, w = z.shape
        hw, hh = max(w // 2, 1), max(h // 2, 1)
        hz = np.asarray(Image.fromarray(z).resize((hw, hh), Image.Resampling.NEAREST))
        hrgb = np.asarray(
            Image.fromarray((rgb * 255).astype(np.uint8)).resize((hw, hh), Image.Resampling.BOX),
            dtype=np.float32,
        ) / 255.0
        if s.mode == "pano":
            px_per_rad = hw / (2 * np.pi)
        else:
            px_per_rad = 0.5 * hw / np.tan(np.radians(s.hfov) / 2)
        # Pixel shift a lean of fill_lean metres causes between nearest and farthest surface.
        band = int(np.ceil(px_per_rad * s.fill_lean * (1 / float(z.min()) - 1 / float(z.max()))))
        band = min(band, max(hh, hw) // 4)
        mask, bc, bz = background_layer(hrgb, hz, band, s.fill_jump)
        m = mask.reshape(-1)
        if m.any():
            bxyz, bfoot, bdirs = backproject(bz, s.mode, s.hfov)
            xyz_f = np.concatenate([xyz_f, bxyz.reshape(-1, 3)[m]])
            rgb_f = np.concatenate([rgb_f, bc.reshape(-1, 3)[m]])
            scales = np.concatenate([scales, _disc_scales(bfoot.reshape(-1, 2)[m], s.splat_scale)])
            quats = np.concatenate([quats, quat_look(bdirs.reshape(-1, 3)[m])])
            n_bg = int(m.sum())

    opacity = np.full(len(xyz_f), 0.97, dtype=np.float32)
    ply = write_ply(xyz_f, rgb_f, scales, quats, opacity)
    preview = render_preview_sheet(xyz_f, rgb_f, s)
    return SplatWorld(
        ply=ply, preview_png=preview, splats_fg=n_fg, splats_bg=n_bg,
        depth_min=float(z.min()), depth_max=float(z.max()),
        grid_width=int(z.shape[1]), grid_height=int(z.shape[0]),
    )


# --------------------------------------------------------------------------- previews


def render_view(xyz: Arr, rgb: Arr, eye: tuple[float, float, float], size: tuple[int, int],
                hfov_deg: float, yaw_deg: float = 0.0) -> Image.Image:
    """Z-buffered 2×2-px point render from ``eye``. Magenta marks disoccluded holes."""
    w, h = size
    p = xyz - np.asarray(eye, dtype=np.float32)
    if yaw_deg:
        a = np.radians(yaw_deg)
        c, s = np.cos(a), np.sin(a)
        p = np.stack([c * p[:, 0] - s * p[:, 2], p[:, 1], s * p[:, 0] + c * p[:, 2]], 1)
    front = p[:, 2] > 0.05
    p, col = p[front], rgb[front]
    f = 0.5 * w / np.tan(np.radians(hfov_deg) / 2)
    u0 = (p[:, 0] / p[:, 2] * f + w / 2).astype(np.int64)
    v0 = (p[:, 1] / p[:, 2] * f + h / 2).astype(np.int64)
    u = np.concatenate([u0, u0 + 1, u0, u0 + 1])
    v = np.concatenate([v0, v0, v0 + 1, v0 + 1])
    zz, col = np.tile(p[:, 2], 4), np.tile(col, (4, 1))
    ok = (u >= 0) & (u < w) & (v >= 0) & (v < h)
    u, v, zz, col = u[ok], v[ok], zz[ok], col[ok]
    order = np.argsort(zz)
    idx = (v * w + u)[order]
    _, first = np.unique(idx, return_index=True)
    img = np.zeros((h * w, 3), dtype=np.float32)
    img[:] = (1.0, 0.0, 1.0)
    img[idx[first]] = col[order][first]
    return Image.fromarray((img.reshape(h, w, 3) * 255).astype(np.uint8))


def render_preview_sheet(xyz: Arr, rgb: Arr, s: SplatSettings, tile: tuple[int, int] = (512, 288)) -> bytes:
    """2×2 contact sheet: centre, ±20 cm leans, and a turn (pano) or step forward."""
    hfov = s.hfov if s.mode == "perspective" else 90.0
    views: list[tuple[str, tuple[float, float, float], float]] = [
        ("centre", (0.0, 0.0, 0.0), 0.0),
        ("lean left 20 cm", (-0.2, 0.0, 0.0), 0.0),
        ("lean right 20 cm", (0.2, 0.0, 0.0), 0.0),
        ("turn 180°", (0.0, 0.0, 0.0), 180.0) if s.mode == "pano" else ("step forward 30 cm", (0.0, 0.0, 0.3), 0.0),
    ]
    tw, th = tile
    label_h = 20
    sheet = Image.new("RGB", (tw * 2, (th + label_h) * 2), (20, 20, 20))
    draw = ImageDraw.Draw(sheet)
    for i, (label, eye, yaw) in enumerate(views):
        x, y = (i % 2) * tw, (i // 2) * (th + label_h)
        sheet.paste(render_view(xyz, rgb, eye, tile, hfov, yaw), (x, y + label_h))
        draw.text((x + 6, y + 4), label, fill=(235, 235, 235))
    buf = io.BytesIO()
    sheet.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
