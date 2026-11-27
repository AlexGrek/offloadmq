"""Self-check of torch_splat on two flat planes at known depths (small and quick).

  E:/offload-agent/sharp/.venv/Scripts/python.exe torch_splat_check.py
"""

from __future__ import annotations

from gpu_guard import require_memory

require_memory()  # before torch: loading it with CUDA takes several GiB of commit

import torch  # noqa: E402

import torch_splat as ts  # noqa: E402

F, SIZE = 500.0, 512
RED, BLUE = [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]


def plane(z: float, half_w: float, color: list[float], dev: torch.device, n: int = 400) -> ts.Gaussians:
    xs, ys = torch.linspace(-half_w, half_w, n), torch.linspace(-1, 1, n)
    X, Y = torch.meshgrid(xs, ys, indexing="xy")
    count = X.numel()
    means = torch.stack([X.flatten(), Y.flatten(), torch.full((count,), z)], 1)
    scales = torch.tensor([2 * half_w / n * 0.8, 2 / n * 0.8, 1e-3]).repeat(count, 1)
    quats = torch.tensor([1.0, 0, 0, 0]).repeat(count, 1)
    return ts.Gaussians(means.to(dev), scales.to(dev), quats.to(dev), torch.tensor(color).repeat(count, 1).to(dev),
                        torch.full((count,), 0.95, device=dev))


def main() -> None:
    dev = torch.device("cuda")
    g = ts.Gaussians.cat([plane(4.0, 2.0, BLUE, dev), plane(2.0, 0.5, RED, dev)])
    failed: list[str] = []

    def view(pos: tuple[float, float, float] = (0, 0, 0), yaw: float = 0, pitch: float = 0, **kw: int) -> ts.Render:
        return ts.render(g, ts.Camera.pose(pos, yaw, pitch, F, F, SIZE, SIZE, dev), **kw)

    def check(what: str, ok: bool, value: object) -> None:
        print(f"{'ok  ' if ok else 'FAIL'} {what}: {value}")
        if not ok:
            failed.append(what)

    def color_is(what: str, r: ts.Render, u: int, want: list[float], v: int = 256) -> None:
        got = [round(float(c), 3) for c in r.color[v, u]]
        check(what, all(abs(a - b) < 0.1 for a, b in zip(got, want)), got)

    r = view()
    color_is("near plane hides the far one", r, 256, RED)
    check("near depth 2 m", abs(float(r.median_depth[256, 256]) - 2) < 0.01, float(r.median_depth[256, 256]))
    color_is("far plane beside it", r, 60, BLUE)
    check("far depth 4 m", abs(float(r.median_depth[256, 60]) - 4) < 0.01, float(r.median_depth[256, 60]))
    check("surface is opaque", float(r.alpha[256, 256]) > 0.95, float(r.alpha[256, 256]))
    # Row 20 beside the near plane: the far plane only starts at row 131.
    check("nothing above the far plane", float(r.alpha[20, 60]) == 0, float(r.alpha[20, 60]))
    # The near plane's left edge sits at u = 256 - 500 * 0.5 / 2 = 131.
    color_is("just outside the near edge", r, 124, BLUE)
    color_is("just inside the near edge", r, 138, RED)

    moved = view((0.5, 0, 0))
    color_is("move right: near plane shifts left", moved, 100, RED)
    color_is("move right: far plane appears", moved, 300, BLUE)
    left = view(yaw=30)
    check("turn left: empty on the left", float(left.alpha[256, 5]) < 0.01, float(left.alpha[256, 5]))
    check("turn left: scene on the right", float(left.alpha[256, 506]) > 0.9, float(left.alpha[256, 506]))
    up = view(pitch=15)
    check("look up: empty above", float(up.alpha[100, 60]) < 0.01, float(up.alpha[100, 60]))
    check("look up: scene moved down", float(up.alpha[420, 60]) > 0.9, float(up.alpha[420, 60]))

    behind = ts.render(plane(2.0, 0.5, RED, dev), ts.Camera.pose((0, 0, 0), 89, 0, F, F, SIZE, SIZE, dev))
    check("splats beside the camera are culled", float(behind.alpha.max()) == 0, float(behind.alpha.max()))

    diff = float((view(pairs_per_band=200_000).color - r.color).abs().max())
    check("same image when split into many bands", diff < 1e-4,
          f"max difference {diff:.1e} over {r.candidates / 1e6:.1f} M candidate pairs")
    print(f"peak GPU memory {torch.cuda.max_memory_allocated() / 2**30:.2f} GiB")
    if failed:
        raise SystemExit(f"{len(failed)} check(s) failed")


if __name__ == "__main__":
    with torch.no_grad():
        main()
