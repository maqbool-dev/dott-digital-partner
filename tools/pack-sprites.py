#!/usr/bin/env python3
"""
Build step: pack a character's source cutouts into per-state sprite atlases and
generate the runtime manifest.json.

    python3 tools/pack-sprites.py characters/dott

Why a generated manifest: fps/sequence/motion are authored intent and live in
character.json, but frame dimensions and atlas geometry are facts about the art
on disk. Deriving the second set at build time means the manifest can never
drift from the actual pixels -- the failure mode where a designer adds a frame
and the app silently keeps playing the old count.

Two things this does that matter for animation quality:

* One global canvas across ALL states. Every frame in every atlas ends up the
  same size, bottom-centre anchored. The overlay window therefore has a single
  aspect ratio and switching states never resizes or shifts the sprite. Without
  this, Dott's feet would slide as he moved between standing and desk poses.

* Frame de-duplication. A ping-pong loop like rest->left->rest->both stores
  three unique frames, not four, and the sequence indexes into them.

This needs Python + Pillow, which CI does NOT: atlases are committed, so the
release pipeline only ever consumes them.
"""
import json
import sys
from pathlib import Path
from PIL import Image

MOTIONS = {"none", "breathe", "bob", "shake"}


def _union_box(a, b):
    if a is None:
        return b
    if b is None:
        return a
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def pack(char_dir: Path):
    cfg = json.loads((char_dir / "character.json").read_text())
    states_cfg = cfg["states"]
    target_h = int(cfg.get("targetCanvasHeight", 640))

    # ---- Pass 1: load every unique frame, find the global canvas -------------
    cache: dict[str, Image.Image] = {}
    for state, sc in states_cfg.items():
        for rel in sc["frames"]:
            if rel not in cache:
                p = char_dir / rel
                if not p.exists():
                    raise SystemExit(f"{state}: missing frame {p}")
                cache[rel] = Image.open(p).convert("RGBA")

    src_w = max(im.width for im in cache.values())
    src_h = max(im.height for im in cache.values())
    scale = target_h / src_h
    canvas_w = round(src_w * scale)
    canvas_h = target_h

    print(f"{cfg['name']}: source canvas {src_w}x{src_h} -> {canvas_w}x{canvas_h} (x{scale:.3f})")

    # ---- Pass 2: normalise each frame onto the global canvas -----------------
    def normalise(im: Image.Image) -> Image.Image:
        w = max(1, round(im.width * scale))
        h = max(1, round(im.height * scale))
        r = im.resize((w, h), Image.LANCZOS)
        out = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
        # bottom-centre anchor: Dott's contact point stays put across states
        out.paste(r, ((canvas_w - w) // 2, canvas_h - h), r)
        return out

    atlas_dir = char_dir / "atlas"
    atlas_dir.mkdir(exist_ok=True)
    for stale in atlas_dir.glob("*.png"):
        stale.unlink()

    manifest_states = {}
    for state, sc in states_cfg.items():
        frames = sc["frames"]
        sequence = sc.get("sequence", list(range(len(frames))))
        for i in sequence:
            if not 0 <= i < len(frames):
                raise SystemExit(f"{state}: sequence index {i} out of range")
        motion = sc.get("motion", "none")
        if motion not in MOTIONS:
            raise SystemExit(f"{state}: unknown motion {motion!r}, expected one of {sorted(MOTIONS)}")
        fps = float(sc["fps"])
        if fps <= 0:
            raise SystemExit(f"{state}: fps must be positive")

        atlas = Image.new("RGBA", (canvas_w * len(frames), canvas_h), (0, 0, 0, 0))
        hit = None
        for i, rel in enumerate(frames):
            norm = normalise(cache[rel])
            atlas.paste(norm, (i * canvas_w, 0))
            # Union of visible pixels across the state's frames, in canvas space.
            # The renderer uses this as the click-through hit region, so the
            # window only swallows clicks where Dott actually is.
            bb = norm.getchannel("A").point(lambda v: 255 if v > 24 else 0).getbbox()
            hit = _union_box(hit, bb)
        rel_out = f"atlas/{state}.png"
        atlas.save(char_dir / rel_out, optimize=True)

        hl, ht, hr, hb = hit if hit else (0, 0, canvas_w, canvas_h)
        manifest_states[state] = {
            "atlas": rel_out,
            "frameCount": len(frames),
            "sequence": sequence,
            "fps": fps,
            "motion": motion,
            "hitBox": {
                "x": round(hl / canvas_w, 5),
                "y": round(ht / canvas_h, 5),
                "w": round((hr - hl) / canvas_w, 5),
                "h": round((hb - ht) / canvas_h, 5),
            },
        }
        kb = (char_dir / rel_out).stat().st_size / 1024
        print(f"  {state:<15} {len(frames)} frame(s), seq {sequence}, {fps:g}fps, {motion:<8} {kb:6.0f}KB")

    manifest = {
        "name": cfg["name"],
        "displayName": cfg.get("displayName", cfg["name"]),
        "author": cfg.get("author"),
        "version": 1,
        "generated": True,
        "canvas": {"width": canvas_w, "height": canvas_h},
        "anchor": "bottom-center",
        "states": manifest_states,
    }
    out = char_dir / "manifest.json"
    out.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"  -> {out}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    for d in sys.argv[1:]:
        pack(Path(d))
