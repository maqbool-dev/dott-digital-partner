#!/usr/bin/env python3
"""
One-time art prep: strip the flat studio backdrop from a render, leaving a
transparent cutout suitable for the overlay window.

This is NOT part of the build. Run it when new renders arrive, then commit the
resulting PNGs to characters/<name>/src/. The build (tools/pack-sprites.ts)
consumes those cutouts and never re-runs this.

Algorithm, in three passes:

1. Gradient-following flood fill seeded from the image border. Each step
   compares a pixel to the neighbour it expanded from rather than to a single
   seed colour, so a smooth backdrop gradient is followed all the way while a
   hard silhouette edge stops the fill. Tolerance must sit above JPEG noise
   (~3) and below the subject's edge contrast (~20) -- 5 is the sweet spot.
   A saturation ceiling is deliberately NOT used as a subject guard: Dott's
   keycaps, gloves and hoodie are all grey, so any such ceiling makes them
   eligible for removal and the fill eats them.

2. Component filter. A hard contrast step (the wall/desk horizon) stops the
   fill and strands a thin stripe of backdrop. Only opaque components large
   enough to be real subject matter survive.

3. Group-aligned crop. Frames belonging to one animation state MUST share a
   canvas, or the character jitters as the sprite cycles. Cropping each frame
   to its own alpha bbox is the bug that causes this; instead the union bbox
   across the whole group is applied to every frame identically.

Usage:
    # single image
    python3 tools/cutout.py in.jpeg out.png [--tol=5]

    # aligned group -- crops all frames to one shared canvas
    python3 tools/cutout.py --group a.jpeg=out-a.png b.jpeg=out-b.png
"""
import sys
from collections import deque
from PIL import Image, ImageFilter


def compute_alpha(im, tol=5, min_frac=0.004):
    """Return an L-mode alpha mask for im: 255 = subject, 0 = backdrop."""
    W, H = im.size
    px = im.load()
    bg = bytearray(W * H)
    q = deque()

    def push(x, y):
        i = y * W + x
        if not bg[i]:
            bg[i] = 1
            q.append((x, y, px[x, y]))

    for x in range(W):
        push(x, 0)
        push(x, H - 1)
    for y in range(H):
        push(0, y)
        push(W - 1, y)

    tol2 = tol * tol
    while q:
        x, y, pc = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if nx < 0 or ny < 0 or nx >= W or ny >= H:
                continue
            i = ny * W + nx
            if bg[i]:
                continue
            c = px[nx, ny]
            dr = c[0] - pc[0]
            dg = c[1] - pc[1]
            db = c[2] - pc[2]
            if dr * dr + dg * dg + db * db <= tol2:
                bg[i] = 1
                q.append((nx, ny, c))

    # Pass 2: drop stranded backdrop slivers and speckles.
    min_area = max(64, int(min_frac * W * H))
    for sy in range(H):
        row = sy * W
        for sx in range(W):
            si = row + sx
            if bg[si]:
                continue
            comp = []
            stack = [si]
            bg[si] = 2  # visited-opaque marker
            while stack:
                i = stack.pop()
                comp.append(i)
                cy, cx = divmod(i, W)
                if cx > 0 and bg[i - 1] == 0:
                    bg[i - 1] = 2
                    stack.append(i - 1)
                if cx < W - 1 and bg[i + 1] == 0:
                    bg[i + 1] = 2
                    stack.append(i + 1)
                if cy > 0 and bg[i - W] == 0:
                    bg[i - W] = 2
                    stack.append(i - W)
                if cy < H - 1 and bg[i + W] == 0:
                    bg[i + W] = 2
                    stack.append(i + W)
            if len(comp) < min_area:
                for i in comp:
                    bg[i] = 1  # too small -> backdrop

    return Image.frombytes(
        "L", (W, H), bytes(0 if b == 1 else 255 for b in bg)
    )


def _union(a, b):
    if a is None:
        return b
    if b is None:
        return a
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def cutout_group(pairs, tol=5, feather=0.8, pad=6, min_frac=0.004):
    """pairs: list of (src_path, out_path). All outputs share one canvas."""
    frames = []
    box = None
    for src, out in pairs:
        im = Image.open(src).convert("RGB")
        alpha = compute_alpha(im, tol=tol, min_frac=min_frac)
        bb = alpha.point(lambda v: 255 if v > 8 else 0).getbbox()
        box = _union(box, bb)
        frames.append((src, out, im, alpha))

    if box is None:
        raise SystemExit("no subject found in any frame")

    # Every frame in the group must be the same size for the union crop to be
    # meaningful; differently-framed renders belong to different groups.
    sizes = {f[2].size for f in frames}
    if len(sizes) > 1:
        raise SystemExit(f"group frames must share dimensions, got {sizes}")

    W, H = frames[0][2].size
    l, t, r, b = box
    box = (max(0, l - pad), max(0, t - pad), min(W, r + pad), min(H, b + pad))

    for src, out, im, alpha in frames:
        if feather:
            alpha = alpha.filter(ImageFilter.GaussianBlur(feather))
        rgba = im.convert("RGBA")
        rgba.putalpha(alpha)
        rgba = rgba.crop(box)
        rgba.save(out)
        print(f"  {src} -> {out}  {rgba.width}x{rgba.height}")
    print(f"group canvas {box[2]-box[0]}x{box[3]-box[1]} from {W}x{H}")


if __name__ == "__main__":
    opts = {}
    rest = []
    group = False
    for a in sys.argv[1:]:
        if a == "--group":
            group = True
        elif a.startswith("--"):
            k, _, v = a[2:].partition("=")
            opts[k] = float(v) if v else True
        else:
            rest.append(a)

    kw = dict(
        tol=opts.get("tol", 5),
        min_frac=opts.get("minfrac", 0.004),
        pad=int(opts.get("pad", 6)),
    )

    if group:
        pairs = []
        for spec in rest:
            src, _, out = spec.partition("=")
            if not out:
                raise SystemExit(f"group args must be src=out, got {spec!r}")
            pairs.append((src, out))
        cutout_group(pairs, **kw)
    elif len(rest) == 2:
        cutout_group([(rest[0], rest[1])], **kw)
    else:
        print(__doc__)
        sys.exit(1)
