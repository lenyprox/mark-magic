"""Card art -> 2.5D scene pack (version 2).

For each printing face this reconstructs the painting as a lit scene the web renderer can move a camera through
and simulate: layered depth, the figure's true silhouette, an inpainted background, per-pixel materials, the
light sources, the atmosphere, and the "phenomena" (fire, smoke, water, magic) with the direction their paint
strokes flow in, so painted flames can lick along their own strokes and embers know where to spawn.

  color.jpg      the art window itself (figure-layer texture)
  bg.jpg         the art with the figure removed and filled in                          LaMa inpainting
  depth.png      relative depth of the whole art window, 16-bit as RGB8 (R hi, G lo)    Depth Anything V2
  bgdepth.png    depth of the background with the figure's hole filled                  Telea inpainting
  figdepth.png   figure depth extended ~24 px past the matte (crisp mesh edges)
  matte.png      8-bit alpha of the foreground figure                                   rembg (ISNet)
  material.png   R metallic, G roughness, B emissive, A material class id               CLIPSeg open-vocabulary
  fx.png         R fire, G smoke, B water, A magic densities
  flow.png       RG stroke-flow direction (x0.5+0.5), B coherence                        structure tensor + priors
  scene.json     art window, size, lights, atmosphere, phenomena coverage, ember spawns, materials, timings
  sheet.jpg      (--sheet) contact sheet of the above for eyeballing

16-bit values are stored as two 8-bit channels because browsers decode 16-bit PNGs to 8 bits: the shader
reconstructs v = (R * 256 + G) / 65535. 65535 = nearest.

Packs live under data/scene/<id[:2]>/<id>-<face>/ and are served by /api/scene. Run:

  tools/scene/.venv/Scripts/python tools/scene/analyze.py <printing-id>[:face] ... [--sheet]
  tools/scene/.venv/Scripts/python tools/scene/analyze.py --ids-file ids.txt --force
  tools/scene/.venv/Scripts/python tools/scene/analyze.py --watch      # drain data/scene/queue.txt forever
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import requests
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get('MTG_DATA_DIR') or ROOT / 'data')
SCENE_DIR = DATA / 'scene'
IMAGE_DIR = DATA / 'images'
MASTER_DB = DATA / 'master' / 'master.db'
QUEUE_FILE = SCENE_DIR / 'queue.txt'
USER_AGENT = 'mtg-master-sim/0.1 (local desktop tool; github.com/kyan12/mark-magic)'
PACK_VERSION = 2
MAX_LIGHTS = 4
MAX_EMBERS = 256

# ---- frame geometry (mirrors apps/web/lib/gl/frames.ts) --------------------------------------------------

FRAME_ART = {
    '2015': (0.075, 0.104, 0.925, 0.562),
    '2003': (0.075, 0.100, 0.925, 0.568),
    '1997': (0.10, 0.096, 0.90, 0.556),
    '1993': (0.105, 0.100, 0.895, 0.545),
    'future': (0.075, 0.100, 0.925, 0.585),
}
WHOLE_LAYOUTS = {'split', 'saga', 'planeswalker', 'adventure', 'battle', 'class', 'leveler', 'flip', 'mutate', 'case',
                 'prototype', 'art_series', 'emblem', 'scheme', 'planar', 'vanguard', 'reversible_card'}
WHOLE_EFFECTS = {'showcase', 'extendedart', 'borderless', 'inverted', 'shatteredglass', 'fullart'}
WHOLE_ART = (0.04, 0.04, 0.96, 0.60)


def art_rect(p: dict) -> tuple[float, float, float, float]:
    if p.get('full_art') or p.get('textless') or p.get('border_color') == 'borderless':
        return WHOLE_ART
    if p.get('layout') in WHOLE_LAYOUTS:
        return WHOLE_ART
    effects = set(p.get('frame_effects') or [])
    if effects & (WHOLE_EFFECTS - {'extendedart'}):
        return WHOLE_ART
    if 'extendedart' in effects:
        # extended art keeps the normal title / text layout; only the art runs out to the card edge
        y0, y1 = FRAME_ART.get(p.get('frame') or '2015', FRAME_ART['2015'])[1::2]
        return (0.03, y0, 0.97, y1)
    return FRAME_ART.get(p.get('frame') or '2015', FRAME_ART['2015'])


# ---- materials ---------------------------------------------------------------------------------------------
# (class, prompts, metallic, roughness, emissive). The class id written to material.png is the row index.
MATERIALS = [
    ('metal',   ['polished steel metal', 'metal sword blade', 'metal armor plate', 'chrome machinery'], 1.0, 0.28, 0.0),
    ('weapon',  ['a sword', 'a giant sword', 'a weapon', 'metal armor'], 0.9, 0.35, 0.0),
    ('skin',    ['human skin', 'a face'], 0.0, 0.55, 0.0),
    ('hair',    ['hair'], 0.0, 0.45, 0.0),
    ('cloth',   ['cloth fabric clothing', 'a cape'], 0.0, 0.85, 0.0),
    ('leather', ['leather straps and belts', 'leather boots'], 0.0, 0.6, 0.0),
    ('fire',    ['fire and flames', 'burning embers and sparks'], 0.0, 1.0, 1.0),
    ('glow',    ['a glowing light source', 'the moon', 'the sun'], 0.0, 1.0, 1.0),
    ('sky',     ['sky and clouds'], 0.0, 0.95, 0.0),
    ('stone',   ['rock and stone', 'ground and dirt', 'a brick wall'], 0.0, 0.92, 0.0),
    ('wood',    ['wood'], 0.0, 0.8, 0.0),
    ('water',   ['water', 'ice'], 0.05, 0.12, 0.0),
    ('glass',   ['glass and crystal', 'gemstones'], 0.1, 0.1, 0.0),
    ('plant',   ['plants and leaves', 'grass'], 0.0, 0.7, 0.0),
    ('scales',  ['scales and dragon hide', 'chitin and shell'], 0.15, 0.5, 0.0),
    ('smoke',   ['smoke', 'mist and fog'], 0.0, 1.0, 0.0),
    ('magic',   ['glowing magic energy', 'lightning', 'glowing arcane runes'], 0.0, 1.0, 1.0),
]
CLASS = {name: i for i, (name, *_) in enumerate(MATERIALS)}
NAMES = [name for name, *_ in MATERIALS]

# light kind -> flicker profile the renderer animates with (1 = full 1/f fire flicker, 0 = steady)
FLICKER = {'fire': 1.0, 'magic': 0.5, 'orb': 0.15, 'sun': 0.0}


class Models:
    """Lazy-loaded model bundle (one process handles many cards)."""

    def __init__(self, device: str | None = None):
        import torch
        self.torch = torch
        self.device = device or ('cuda' if torch.cuda.is_available() else 'cpu')
        self._depth = None
        self._clipseg = None
        self._rembg = None
        self._lama = None

    def depth(self, img: Image.Image) -> np.ndarray:
        """Relative depth, float32 0..1, 1 = nearest (Depth Anything V2 predicts affine-invariant inverse depth)."""
        if self._depth is None:
            from transformers import pipeline
            self._depth = pipeline('depth-estimation', model='depth-anything/Depth-Anything-V2-Base-hf', device=0 if self.device == 'cuda' else -1)
        out = self._depth(img)
        d = np.asarray(out['predicted_depth'], dtype=np.float32)
        if d.ndim == 3:
            d = d[0]
        d = cv2.resize(d, img.size, interpolation=cv2.INTER_CUBIC)
        lo, hi = np.percentile(d, 0.5), np.percentile(d, 99.5)
        return np.clip((d - lo) / max(hi - lo, 1e-6), 0, 1).astype(np.float32)

    def matte(self, img: Image.Image) -> np.ndarray:
        """Foreground alpha 0..1 (ISNet general-use through rembg), lightly cleaned."""
        if self._rembg is None:
            from rembg import new_session
            self._rembg = new_session('isnet-general-use')
        from rembg import remove
        out = remove(img, session=self._rembg, only_mask=True, post_process_mask=True)
        a = np.asarray(out, dtype=np.float32) / 255.0
        a = cv2.GaussianBlur(a, (0, 0), 0.8)
        return np.clip(a, 0, 1)

    def inpaint(self, img: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """LaMa inpainting; `mask` 0..255 uint8 where 255 = fill."""
        if self._lama is None:
            from simple_lama_inpainting import SimpleLama
            self._lama = SimpleLama(device=self.torch.device(self.device))
        out = self._lama(Image.fromarray(img), Image.fromarray(mask))
        return np.asarray(out.convert('RGB'))[: img.shape[0], : img.shape[1]]

    def materials(self, img: Image.Image) -> tuple[np.ndarray, np.ndarray]:
        """Per-class probability maps (C, H, W) from CLIPSeg over the material prompt table, plus the raw
        per-class logits (max over the class's prompts) for relative tests."""
        if self._clipseg is None:
            from transformers import CLIPSegForImageSegmentation, CLIPSegProcessor
            self._clipseg = (CLIPSegProcessor.from_pretrained('CIDAS/clipseg-rd64-refined'),
                             CLIPSegForImageSegmentation.from_pretrained('CIDAS/clipseg-rd64-refined').to(self.device).eval())
        proc, model = self._clipseg
        prompts = [p for _, ps, *_ in MATERIALS for p in ps]
        owner = [ci for ci, (_, ps, *_) in enumerate(MATERIALS) for _ in ps]
        with self.torch.no_grad():
            inputs = proc(text=prompts, images=[img] * len(prompts), padding=True, return_tensors='pt').to(self.device)
            logits = model(**inputs).logits            # (P, 352, 352)
            if logits.ndim == 2:
                logits = logits[None]
            logits = logits.float().cpu().numpy()
        w, h = img.size
        per_class = np.full((len(MATERIALS), h, w), -1e9, dtype=np.float32)
        for pi, ci in enumerate(owner):
            up = cv2.resize(logits[pi], (w, h), interpolation=cv2.INTER_LINEAR)
            per_class[ci] = np.maximum(per_class[ci], up)   # a class is as present as its best prompt
        z = per_class - per_class.max(axis=0, keepdims=True)
        p = np.exp(z / 0.35)                               # temperature: sharpen but keep soft edges
        p /= p.sum(axis=0, keepdims=True)
        # the weapon prompts alone (armour responds on the whole body) for the figure-relative weapon test
        wp = [pi for pi, ci in enumerate(owner) if ci == CLASS['weapon'] and 'armor' not in prompts[pi]]
        weapon = np.max([cv2.resize(logits[pi], (w, h), interpolation=cv2.INTER_LINEAR) for pi in wp], axis=0)
        return p, weapon


# ---- inputs -------------------------------------------------------------------------------------------------

def printing_row(db: sqlite3.Connection, pid: str) -> dict:
    row = db.execute('SELECT json, name FROM printings WHERE id = ?', (pid,)).fetchone()
    if not row:
        raise RuntimeError(f'unknown printing {pid}')
    d = json.loads(row[0])
    d['_name'] = row[1]
    return d


def image_source(db: sqlite3.Connection, pid: str, face: int) -> str | None:
    row = db.execute('SELECT url FROM printing_images WHERE printing_id = ? AND face = ?', (pid, face)).fetchone()
    return row[0] if row else None


def large_image(db: sqlite3.Connection, pid: str, face: int) -> Image.Image:
    """The `large` (672x936) card image from the app's cache, downloaded into it on a miss."""
    path = IMAGE_DIR / 'large' / pid[:2] / f'{pid}-{face}.jpg'
    if not path.exists():
        src = image_source(db, pid, face)
        if not src:
            raise RuntimeError(f'no image source for {pid} face {face}')
        url = src.replace('/normal/', '/large/')
        r = requests.get(url, headers={'User-Agent': USER_AGENT, 'Accept': 'image/*'}, timeout=60)
        r.raise_for_status()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(r.content)
        time.sleep(0.15)   # Scryfall etiquette
    return Image.open(path).convert('RGB')


# ---- helpers ------------------------------------------------------------------------------------------------

def luminance(color: np.ndarray) -> np.ndarray:
    return (0.299 * color[..., 0] + 0.587 * color[..., 1] + 0.114 * color[..., 2]).astype(np.float32) / 255.0


def saturation(color: np.ndarray) -> np.ndarray:
    mx = color.max(axis=2).astype(np.float32)
    mn = color.min(axis=2).astype(np.float32)
    return (mx - mn) / np.maximum(mx, 1)


def write16(path: Path, v01: np.ndarray) -> None:
    v = np.round(np.clip(v01, 0, 1) * 65535).astype(np.uint16)
    rgb = np.dstack([(v >> 8).astype(np.uint8), (v & 255).astype(np.uint8), np.zeros_like(v, dtype=np.uint8)])
    Image.fromarray(rgb, 'RGB').save(path, compress_level=6)


def read16(path: Path) -> np.ndarray:
    rgb = np.asarray(Image.open(path).convert('RGB'), dtype=np.float32)
    return (rgb[..., 0] * 256 + rgb[..., 1]) / 65535.0


def extend_depth(depth: np.ndarray, inside: np.ndarray, iterations: int = 8, k: int = 7) -> np.ndarray:
    """Push the figure's own depth outward past its matte so mesh edges never blend toward the background."""
    d = np.where(inside, depth, 0).astype(np.float32)
    have = inside.astype(np.uint8)
    kernel = np.ones((k, k), np.uint8)
    for _ in range(iterations):
        grown = cv2.dilate(d, kernel)
        havep = cv2.dilate(have, kernel)
        new = (havep > 0) & (have == 0)
        d = np.where(new, grown, d)
        have = havep
    return np.where(have > 0, d, depth)


def grow_matte(matte: np.ndarray, depth: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Add near-depth regions that touch the figure (a held sword, a cape) which the matting model left out.
    Tries progressively looser depth thresholds and keeps the loosest one that does not balloon the figure
    (a sword behind the back sits a little farther than the body). Returns the grown matte and the added
    ("held object") mask."""
    core = matte > 0.5
    none = np.zeros_like(matte)
    if core.sum() < 200:
        return matte, none
    fd = float(np.percentile(depth[core], 25))
    best = None
    for slack in (0.08, 0.15, 0.22, 0.3):
        near = (depth >= fd - slack).astype(np.uint8)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(near, connectivity=8)
        add = np.zeros_like(core)
        for i in range(1, n):
            comp = labels == i
            overlap = (comp & core).sum()
            if overlap > 0.03 * comp.sum() and stats[i, cv2.CC_STAT_AREA] < 0.6 * core.size:
                add |= comp
        add &= ~core
        # drop the thin ring the soft matte edge produces; keep solid attached parts
        add = cv2.morphologyEx(add.astype(np.uint8), cv2.MORPH_OPEN, np.ones((7, 7), np.uint8)) > 0
        if add.sum() > 0.6 * core.sum():
            break
        best = add
    if best is None or not best.any():
        return matte, none
    grown = cv2.GaussianBlur(best.astype(np.float32), (0, 0), 1.2)
    return np.clip(np.maximum(matte, grown), 0, 1), grown


def depth_normals(depth: np.ndarray, scale: float) -> np.ndarray:
    """Unit normals (H, W, 3) of the depth field as a height map; x right, y up, z toward the viewer."""
    gx = cv2.Sobel(depth, cv2.CV_32F, 1, 0, ksize=3) / 8.0 * scale
    gy = cv2.Sobel(depth, cv2.CV_32F, 0, 1, ksize=3) / 8.0 * scale
    n = np.dstack([-gx, gy, np.ones_like(depth)])
    return n / np.linalg.norm(n, axis=2, keepdims=True)


# ---- analysis pieces ----------------------------------------------------------------------------------------

def phenomena_maps(color: np.ndarray, probs: np.ndarray, lum: np.ndarray) -> np.ndarray:
    """fx densities (H, W, 4): fire, smoke, water, magic in 0..1, soft-edged."""
    hsv = cv2.cvtColor(color, cv2.COLOR_RGB2HSV).astype(np.float32)
    hue = hsv[..., 0] * 2.0                                    # 0..360
    sat = hsv[..., 1] / 255.0
    warm = np.clip(1.0 - np.minimum(np.abs(hue - 25.0), np.abs(hue - 25.0 + 360.0)) / 45.0, 0, 1) * np.clip(sat * 1.5, 0, 1)
    # a phenomenon only exists where its class actually wins (soft probabilities alone paint water over
    # every green scene); the winning region is feathered so the effect still fades out gently
    top = probs.argmax(axis=0)
    def dominant(*names: str) -> np.ndarray:
        m = np.isin(top, [CLASS[n] for n in names]).astype(np.float32)
        return np.clip(cv2.GaussianBlur(m, (0, 0), 4.0) * 1.3, 0, 1)
    energy = (probs[CLASS['fire']] + probs[CLASS['magic']]) * dominant('fire', 'magic', 'glow')
    bright = np.clip((lum - 0.2) / 0.5, 0, 1)
    fire = energy * np.clip(0.15 + 0.85 * warm, 0, 1) * bright            # warm glowing energy burns like fire
    magic = energy * (1.0 - np.clip(warm * 1.3, 0, 1)) * bright             # cool energy pulses like magic
    smoke = probs[CLASS['smoke']] * dominant('smoke') * np.clip(1.0 - sat * 1.2, 0.2, 1)
    water = probs[CLASS['water']] * dominant('water')
    fx = np.dstack([fire, smoke, water, magic]).astype(np.float32)
    fx = cv2.GaussianBlur(fx, (0, 0), 2.0)
    return np.clip(fx, 0, 1)


def flow_field(lum: np.ndarray, fx: np.ndarray, lights: list[dict]) -> np.ndarray:
    """Stroke-flow direction per pixel (H, W, 3): RG direction x0.5+0.5, B coherence. Structure tensor of the
    paint plus a per-phenomenon prior that fixes the sign (fire and smoke rise, water runs, magic radiates)."""
    h, w = lum.shape
    gx = cv2.Sobel(lum, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(lum, cv2.CV_32F, 0, 1, ksize=3)
    jxx = cv2.GaussianBlur(gx * gx, (0, 0), 3.0)
    jyy = cv2.GaussianBlur(gy * gy, (0, 0), 3.0)
    jxy = cv2.GaussianBlur(gx * gy, (0, 0), 3.0)
    theta = 0.5 * np.arctan2(2 * jxy, jxx - jyy)               # dominant gradient orientation
    tr = jxx + jyy
    disc = np.sqrt((jxx - jyy) ** 2 + 4 * jxy ** 2)
    coherence = np.clip(disc / (tr + 1e-6), 0, 1)
    # strokes run along the flame, perpendicular to the luminance gradient
    dx = np.cos(theta + np.pi / 2)
    dy = np.sin(theta + np.pi / 2)

    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    prior = np.zeros((h, w, 2), np.float32)
    dom = fx.argmax(axis=2)
    any_fx = fx.max(axis=2) > 0.15
    up = np.array([0.0, -1.0], np.float32)
    prior[dom == 0] = up                                        # fire
    prior[dom == 1] = up                                        # smoke
    prior[dom == 2] = np.array([0.94, 0.33], np.float32)        # water: along and slightly down
    magic = dom == 3
    if magic.any():
        ml = [l for l in lights if l['kind'] == 'magic']
        if ml:
            cx, cy = ml[0]['u'] * w, ml[0]['v'] * h
        else:
            cx, cy = xs[magic].mean(), ys[magic].mean()
        rx, ry = xs - cx, ys - cy
        rn = np.sqrt(rx * rx + ry * ry) + 1e-3
        prior[magic] = np.dstack([rx / rn, ry / rn])[magic]
    # fire also leans away from its own base (the bottom of the flame region) so tongues fan out
    fire = dom == 0
    if fire.any():
        fy = ys[fire]
        base_y = np.percentile(fy, 90)
        base_x = xs[fire][fy >= np.percentile(fy, 75)].mean()
        rx, ry = xs - base_x, ys - base_y
        rn = np.sqrt(rx * rx + ry * ry) + 1e-3
        away = np.dstack([rx / rn, ry / rn])
        prior[fire] = (0.7 * prior + 0.3 * away)[fire]

    d = np.dstack([dx, dy])
    flip = (d * prior).sum(axis=2) < 0
    d[flip] *= -1
    # low-coherence paint follows the prior instead of noise
    wgt = (coherence ** 2 * 0.8)[..., None]
    d = d * wgt + prior * (1 - wgt)
    n = np.linalg.norm(d, axis=2, keepdims=True) + 1e-6
    d = d / n
    out = np.zeros((h, w, 3), np.float32)
    out[..., 0] = 0.5
    out[..., 1] = 0.5
    out[any_fx, 0] = d[any_fx, 0] * 0.5 + 0.5
    out[any_fx, 1] = d[any_fx, 1] * 0.5 + 0.5
    out[any_fx, 2] = np.clip(coherence[any_fx] * 1.4, 0, 1)
    return cv2.GaussianBlur(out, (0, 0), 1.5)


def find_lights(color: np.ndarray, emissive: np.ndarray, depth: np.ndarray, matte: np.ndarray, class_id: np.ndarray) -> list[dict]:
    """Emissive, bright, compact regions -> lights with a position, depth, colour, power, kind and how much of
    them sits behind the figure."""
    h, w = emissive.shape
    lum = luminance(color)
    # a light is emissive paint that is actually bright; white-hot paint counts even if the labeller was unsure
    score = np.maximum(emissive * np.clip((lum - 0.35) / 0.5, 0, 1), np.clip((lum - 0.85) / 0.12, 0, 1) * 0.9)
    score = cv2.GaussianBlur(score.astype(np.float32), (0, 0), 3)
    mask = (score > 0.35).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    lights = []
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < (w * h) * 0.0008:
            continue
        m = labels == i
        wts = score[m] * lum[m]
        if wts.sum() <= 0:
            continue
        ys, xs = np.nonzero(m)
        cx = float((xs * wts).sum() / wts.sum())
        cy = float((ys * wts).sum() / wts.sum())
        col = color[m].astype(np.float32)
        c = (col * wts[:, None]).sum(axis=0) / wts.sum() / 255.0
        c = c / max(c.max(), 1e-3)
        c = 0.3 + 0.7 * c                                   # lift toward white: painted light is never pure hue
        power = float(np.sqrt(area / (w * h)) * (lum[m] * score[m]).mean() * 4.0)
        compact = float(area / max(stats[i, cv2.CC_STAT_WIDTH] * stats[i, cv2.CC_STAT_HEIGHT], 1))
        power *= 0.6 + 0.8 * compact
        # kind from the majority material class inside the blob
        counts = np.bincount(class_id[m], minlength=len(MATERIALS))
        top = NAMES[int(counts.argmax())]
        touches = stats[i, cv2.CC_STAT_LEFT] == 0 or stats[i, cv2.CC_STAT_TOP] == 0 or \
            stats[i, cv2.CC_STAT_LEFT] + stats[i, cv2.CC_STAT_WIDTH] >= w or stats[i, cv2.CC_STAT_TOP] + stats[i, cv2.CC_STAT_HEIGHT] >= h
        warm_blob = c[0] > c[2] * 1.25                       # red over blue: fire-coloured energy
        if top == 'fire' or (top == 'magic' and warm_blob):
            kind = 'fire'
        elif top == 'magic':
            kind = 'magic'
        elif touches and area > 0.08 * w * h:
            kind = 'sun'
        else:
            kind = 'orb'
        # behind the figure: the matte covers the blob's surroundings (or eats into the blob itself)
        ring = cv2.dilate(m.astype(np.uint8), np.ones((25, 25), np.uint8)) > 0
        ring &= ~m
        behind = max(float(matte[ring].mean()) if ring.any() else 0.0, float(matte[m].mean()))
        lights.append({
            'u': round(cx / w, 4), 'v': round(cy / h, 4),
            'depth': round(float(np.median(depth[m])), 4),
            'radius': round(float(np.sqrt(area / np.pi) / w), 4),
            'color': [round(float(x), 4) for x in c],
            'power': round(power, 4),
            'area': round(float(area / (w * h)), 5),
            'kind': kind,
            'flicker': FLICKER[kind],
            'behind': round(behind, 3),
        })
    lights.sort(key=lambda l: -l['power'])
    return lights[:MAX_LIGHTS]


def atmosphere(color: np.ndarray, depth: np.ndarray, matte: np.ndarray, emissive: np.ndarray, class_id: np.ndarray, lum: np.ndarray) -> dict:
    h, w = lum.shape
    bg = matte < 0.5
    # ambient: the darkest fifth of the background
    if bg.sum() > 100:
        bl = lum[bg]
        dark = bg & (lum <= np.percentile(bl, 20))
    else:
        dark = lum <= np.percentile(lum, 20)
    ambient = color[dark].mean(axis=0) / 255.0 if dark.any() else np.array([0.1, 0.1, 0.12])
    # fog: colour of the farthest tenth, density from how saturation falls off with distance
    far = depth <= np.percentile(depth, 10)
    fog_color = color[far].mean(axis=0) / 255.0 if far.any() else ambient
    sat = saturation(color)
    sel = bg if bg.sum() > 500 else np.ones_like(bg)
    a = np.vstack([np.ones(sel.sum()), depth[sel]]).T
    coef, *_ = np.linalg.lstsq(a, sat[sel], rcond=None)
    fog_density = float(np.clip(coef[1] * 1.5, 0, 1))
    # key light: fit luminance ~ a + b*(N.L) over non-emissive figure pixels
    key = [0.35, 0.5, 0.8]
    fig = (matte > 0.6) & (emissive < 0.2)
    if fig.sum() > 400:
        n = depth_normals(cv2.GaussianBlur(depth, (0, 0), 2.0), scale=0.35 * w)
        feats = np.hstack([np.ones((fig.sum(), 1)), n[fig]])
        coef, *_ = np.linalg.lstsq(feats, lum[fig], rcond=None)
        v = coef[1:]
        if np.linalg.norm(v) > 1e-4:
            v = v / np.linalg.norm(v)
            if v[2] < 0:
                v = -v
            key = [round(float(x), 4) for x in v]
    sky = class_id == CLASS['sky']
    horizon = round(float(np.nonzero(sky)[0].mean() / h), 4) if sky.mean() > 0.05 else None
    em = emissive > 0.3
    if em.any():
        hsv = cv2.cvtColor(color, cv2.COLOR_RGB2HSV)
        hue = hsv[..., 0][em].astype(np.float32) * 2.0
        # 1 = warm (reds/oranges), 0 = cool (blues)
        warmth = float(np.clip(1.0 - np.minimum(np.abs(hue - 20.0), 360.0 - np.abs(hue - 20.0)) / 180.0, 0, 1).mean())
    else:
        warmth = 0.6
    return {
        'ambient': [round(float(x), 4) for x in ambient],
        'fog': {'color': [round(float(x), 4) for x in fog_color], 'density': round(fog_density, 4)},
        'keyDir': key,
        'horizon': horizon,
        'warmth': round(warmth, 3),
    }


def ember_spawns(fire: np.ndarray, depth: np.ndarray, seed: int) -> list[list[float]]:
    h, w = fire.shape
    ys, xs = np.nonzero(fire > 0.08)
    if len(xs) == 0:
        return []
    p = fire[ys, xs] ** 1.5
    p /= p.sum()
    rng = np.random.default_rng(seed)
    n = min(MAX_EMBERS, len(xs))
    idx = rng.choice(len(xs), size=n, replace=False, p=p)
    return [[round(float(xs[i] / w), 4), round(float(ys[i] / h), 4), round(float(depth[ys[i], xs[i]]), 3)] for i in idx]


def contact_sheet(out_dir: Path, color: np.ndarray, depth: np.ndarray, matte: np.ndarray, bg: np.ndarray, material: np.ndarray,
                  fx: np.ndarray, flow: np.ndarray, lights: list[dict], figdepth: np.ndarray) -> None:
    h, w = depth.shape
    tw = 260
    th = int(round(h * tw / w))

    def tile(img: np.ndarray, label: str) -> np.ndarray:
        if img.ndim == 2:
            img = np.dstack([img] * 3)
        t = cv2.resize(img.astype(np.uint8), (tw, th), interpolation=cv2.INTER_AREA)
        cv2.putText(t, label, (6, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(t, label, (6, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
        return t

    lit = color.copy()
    for i, l in enumerate(lights):
        c = tuple(int(x * 255) for x in l['color'])
        cx, cy, r = int(l['u'] * w), int(l['v'] * h), max(3, int(l['radius'] * w))
        cv2.circle(lit, (cx, cy), r, c, 2)
        cv2.putText(lit, f"{i}:{l['kind']} p{l['power']:.2f} b{l['behind']:.1f}", (cx + 6, cy - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(lit, f"{i}:{l['kind']} p{l['power']:.2f} b{l['behind']:.1f}", (cx + 6, cy - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    mat = np.dstack([material[..., 0], material[..., 1], material[..., 2]])
    fxv = np.dstack([np.maximum(fx[..., 0], fx[..., 3]), np.maximum(fx[..., 1], fx[..., 3] * 0.3), np.maximum(fx[..., 2], fx[..., 3])])
    ang = (np.arctan2(flow[..., 1] * 2 - 1, flow[..., 0] * 2 - 1) / (2 * np.pi) + 0.5) * 179
    hsv = np.dstack([ang.astype(np.uint8), np.full_like(ang, 255, dtype=np.uint8), (flow[..., 2] * 255).astype(np.uint8)])
    flowv = cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB)
    # sample arrows on top of the flow tile so the direction is readable
    step = max(12, w // 24)
    for y in range(step // 2, h, step):
        for x in range(step // 2, w, step):
            if flow[y, x, 2] < 0.05 and abs(flow[y, x, 0] - 0.5) < 0.02 and abs(flow[y, x, 1] - 0.5) < 0.02:
                continue
            ddx, ddy = (flow[y, x, 0] * 2 - 1) * step * 0.45, (flow[y, x, 1] * 2 - 1) * step * 0.45
            cv2.arrowedLine(flowv, (x, y), (int(x + ddx), int(y + ddy)), (255, 255, 255), 1, cv2.LINE_AA, tipLength=0.4)
    row1 = np.hstack([tile(lit, 'color + lights'), tile(depth * 255, 'depth'), tile(matte * 255, 'matte'), tile(bg, 'bg (inpainted)')])
    row2 = np.hstack([tile(mat, 'material m/r/e'), tile((fxv * 255), 'fx fire/smoke/water +magic'), tile(flowv, 'flow (hue=dir, v=coherence)'), tile(figdepth * 255, 'figdepth')])
    sheet = np.vstack([row1, row2])
    Image.fromarray(sheet).save(out_dir / 'sheet.jpg', quality=88)


# ---- analysis -----------------------------------------------------------------------------------------------

def analyze(models: Models, db: sqlite3.Connection, pid: str, face: int, force: bool = False, sheet: bool = False) -> Path:
    out_dir = SCENE_DIR / pid[:2] / f'{pid}-{face}'
    meta_path = out_dir / 'scene.json'
    if meta_path.exists() and not force:
        try:
            if json.loads(meta_path.read_text()).get('version') == PACK_VERSION:
                print(f'  {pid}:{face} up to date')
                return out_dir
        except json.JSONDecodeError:
            pass
    t0 = time.time()
    p = printing_row(db, pid)
    card = large_image(db, pid, face)
    W, H = card.size
    x0, y0, x1, y1 = art_rect(p)
    box = (int(round(x0 * W)), int(round(y0 * H)), int(round(x1 * W)), int(round(y1 * H)))
    art = card.crop(box)
    w, h = art.size
    color = np.asarray(art)
    lum = luminance(color)
    timings = {}

    t = time.time(); depth = models.depth(art); timings['depth'] = round(time.time() - t, 2)
    t = time.time(); matte = models.matte(art); timings['matte'] = round(time.time() - t, 2)
    matte, held = grow_matte(matte, depth)

    # The figure layer keeps the painted pixels; the background layer needs the hole filled (colour and depth).
    inside = matte > 0.35
    hole = (cv2.dilate(inside.astype(np.uint8), np.ones((9, 9), np.uint8), iterations=2) * 255).astype(np.uint8)
    t = time.time(); bg = models.inpaint(color, hole); timings['inpaint'] = round(time.time() - t, 2)
    bgdepth = cv2.inpaint((depth * 255).astype(np.uint8), hole, 7, cv2.INPAINT_TELEA).astype(np.float32) / 255.0
    bgdepth = cv2.GaussianBlur(bgdepth, (0, 0), 2.0)
    ring = cv2.dilate(hole, np.ones((15, 15), np.uint8)) > 0
    ring &= hole == 0
    if ring.any():
        cap = float(np.percentile(depth[ring], 60))          # the fill must sit behind the figure
        bgdepth = np.where(hole > 0, np.minimum(bgdepth, cap), bgdepth)
    figdepth = extend_depth(depth, inside)

    t = time.time(); probs, weapon_logit = models.materials(art); timings['materials'] = round(time.time() - t, 2)
    metallic = sum(probs[i] * m for i, (_, _, m, _, _) in enumerate(MATERIALS))
    roughness = sum(probs[i] * r for i, (_, _, _, r, _) in enumerate(MATERIALS))
    emissive = sum(probs[i] * e for i, (_, _, _, _, e) in enumerate(MATERIALS))
    emissive = emissive * np.clip((lum - 0.25) / 0.45, 0, 1)      # only bright paint actually emits
    sat = saturation(color)
    metallic = metallic * np.clip(1.15 - sat * 1.3, 0.25, 1.0)     # painted metal is bright and desaturated
    class_id = probs.argmax(axis=0).astype(np.uint8)
    # What the matting model leaves out of a figure but depth attaches to it is a held object (a sword, a
    # staff, a shield): rigid, and almost always metal. Skin and burning paint keep their own label.
    not_skin = 1.0 - np.clip((probs[CLASS['skin']] - 0.55) / 0.3, 0, 1)   # CLIPSeg calls a blade next to a body half 'skin'
    heldm = held * not_skin
    # A weapon rarely wins the absolute label (CLIPSeg calls a painted blade "cloth"), but its weapon logit
    # stands well above the rest of the figure: label the figure-relative outliers.
    fig = matte > 0.5
    if fig.sum() > 400:
        wl = weapon_logit
        thr = float(np.median(wl[fig])) + 0.7
        weaponm = np.clip((wl - thr) / 0.5, 0, 1) * fig * not_skin
        weaponm = cv2.GaussianBlur(weaponm.astype(np.float32), (0, 0), 1.5)
        heldm = np.maximum(heldm, weaponm)
    metallic = np.maximum(metallic, heldm * 0.9)          # fire reflected in a blade is saturated but still metal
    roughness = np.where(heldm > 0.5, np.minimum(roughness, 0.38), roughness)
    class_id = np.where((heldm > 0.5) & (class_id != CLASS['skin']), CLASS['weapon'], class_id).astype(np.uint8)
    material = np.dstack([
        (np.clip(metallic, 0, 1) * 255).astype(np.uint8),
        (np.clip(roughness, 0, 1) * 255).astype(np.uint8),
        (np.clip(emissive, 0, 1) * 255).astype(np.uint8),
        class_id,
    ])
    lights = find_lights(color, emissive, depth, matte, class_id)
    fx = phenomena_maps(color, probs, lum)
    flow = flow_field(lum, fx, lights)
    atmo = atmosphere(color, depth, matte, emissive, class_id, lum)
    embers = ember_spawns(fx[..., 0], depth, seed=int(pid[:8], 16))
    ys, xs = np.nonzero(matte > 0.5)
    figure_box = [round(float(xs.min() / w), 4), round(float(ys.min() / h), 4), round(float(xs.max() / w), 4), round(float(ys.max() / h), 4)] if len(xs) else None
    figure_depth = round(float(np.median(depth[matte > 0.5])), 4) if len(xs) else 0.5

    out_dir.mkdir(parents=True, exist_ok=True)
    Image.fromarray(color).save(out_dir / 'color.jpg', quality=92)
    Image.fromarray(bg).save(out_dir / 'bg.jpg', quality=90)
    write16(out_dir / 'depth.png', depth)
    write16(out_dir / 'bgdepth.png', bgdepth)
    write16(out_dir / 'figdepth.png', figdepth)
    Image.fromarray((matte * 255).astype(np.uint8)).save(out_dir / 'matte.png')
    Image.fromarray(material, 'RGBA').save(out_dir / 'material.png')
    Image.fromarray((fx * 255).astype(np.uint8), 'RGBA').save(out_dir / 'fx.png')
    Image.fromarray((np.clip(flow, 0, 1) * 255).astype(np.uint8), 'RGB').save(out_dir / 'flow.png')
    coverage = {name: round(float((class_id == i).mean()), 4) for i, name in enumerate(NAMES)}
    phen = {k: round(float((fx[..., i] > 0.2).mean()), 4) for i, k in enumerate(['fire', 'smoke', 'water', 'magic'])}
    meta = {
        'version': PACK_VERSION,
        'printingId': pid, 'face': face, 'name': p.get('_name'),
        'art': [x0, y0, x1, y1], 'size': [w, h], 'cardSize': [W, H],
        'lights': lights,
        'atmosphere': atmo,
        'phenomena': phen,
        'embers': embers,
        'figureBox': figure_box,
        'figureDepth': figure_depth,
        'figureCoverage': round(float((matte > 0.5).mean()), 4),
        'metalCoverage': round(float((metallic > 0.5).mean()), 4),
        'materials': NAMES,
        'coverage': coverage,
        'depthRange': [round(float(depth.min()), 4), round(float(depth.max()), 4)],
        'timings': timings, 'seconds': round(time.time() - t0, 2),
        'models': {'depth': 'depth-anything/Depth-Anything-V2-Base-hf', 'matte': 'rembg isnet-general-use', 'inpaint': 'LaMa', 'materials': 'CIDAS/clipseg-rd64-refined'},
    }
    meta_path.write_text(json.dumps(meta, indent=1))
    if sheet:
        contact_sheet(out_dir, color, depth, matte, bg, material, fx, flow, lights, figdepth)
    print(f'  {pid}:{face} {p.get("_name")} {w}x{h} lights={[l["kind"] for l in lights]} figure={meta["figureCoverage"]:.2f} fx={phen} {meta["seconds"]}s {timings}')
    return out_dir


def run_batch(models: Models, db: sqlite3.Connection, ids: list[str], force: bool, sheet: bool) -> int:
    failures = 0
    for spec in ids:
        pid, _, face = spec.partition(':')
        try:
            analyze(models, db, pid.lower(), int(face or 0), force=force, sheet=sheet)
        except Exception as e:  # keep the batch going; report at the end
            failures += 1
            print(f'  {spec} FAILED: {type(e).__name__}: {e}', file=sys.stderr)
        finally:
            # long batches must not creep: drop per-card tensors and the CUDA cache between cards
            import gc
            gc.collect()
            if models.device == 'cuda':
                models.torch.cuda.empty_cache()
    return failures


def watch(models: Models, db: sqlite3.Connection, sheet: bool) -> None:
    """Drain data/scene/queue.txt (one id[:face] per line, appended by the web app) until interrupted."""
    print(f'watching {QUEUE_FILE}')
    seen: set[str] = set()
    while True:
        try:
            lines = QUEUE_FILE.read_text().splitlines() if QUEUE_FILE.exists() else []
        except OSError:
            lines = []
        todo = [l.strip().lower() for l in lines if l.strip() and l.strip().lower() not in seen]
        if todo:
            for spec in todo:
                seen.add(spec)
            run_batch(models, db, todo, force=False, sheet=sheet)
        else:
            time.sleep(2.0)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('ids', nargs='*', help='printing id, optionally :face')
    ap.add_argument('--ids-file', help='file with one printing id[:face] per line')
    ap.add_argument('--force', action='store_true', help='recompute existing packs')
    ap.add_argument('--sheet', action='store_true', help='also write sheet.jpg (contact sheet) into each pack')
    ap.add_argument('--watch', action='store_true', help='drain data/scene/queue.txt forever after the given ids')
    ap.add_argument('--device', default=None, help='cuda or cpu (default: auto)')
    args = ap.parse_args()
    ids = list(args.ids)
    if args.ids_file:
        ids += [l.strip() for l in Path(args.ids_file).read_text().splitlines() if l.strip() and not l.startswith('#')]
    if not ids and not args.watch:
        ap.error('no printing ids')
    models = Models(args.device)
    print(f'device {models.device}; {len(ids)} printings; packs -> {SCENE_DIR}')
    db = sqlite3.connect(f'file:{MASTER_DB.as_posix()}?mode=ro', uri=True)
    failures = run_batch(models, db, ids, args.force, args.sheet)
    if args.watch:
        watch(models, db, args.sheet)
    if failures:
        sys.exit(1)


if __name__ == '__main__':
    main()
