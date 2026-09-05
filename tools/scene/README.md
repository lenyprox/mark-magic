# Scene packs: card art → 2.5D lit scene

`analyze.py` turns a card's art window into a **scene pack** the web renderer (`apps/web/lib/gl/scene.ts`)
rebuilds as a layered-depth scene under the print: real silhouette, inpainted background, per-pixel
materials, detected light sources, atmosphere, and the "phenomena" (fire, smoke, water, magic) with the
direction their brush strokes flow in. The renderer then simulates on top of that: tilt parallax around the
figure, PBR lighting from the painted lights (flicker, shadows, rim light from lights behind the figure),
volumetric rays that wrap the silhouette, painted fire advected along its strokes, heat haze, embers that
obey the card's tilt, water ripples, smoke drift, bloom.

Packs are optional: a card without one renders exactly as before.

## Setup (once)

```
python -m venv tools/scene/.venv
tools/scene/.venv/Scripts/pip install torch --index-url https://download.pytorch.org/whl/cu121
tools/scene/.venv/Scripts/pip install transformers rembg[gpu] simple-lama-inpainting opencv-python-headless pillow requests
```

Model weights download on first use (Depth Anything V2 Base, CLIPSeg rd64-refined, ISNet general-use via
rembg, LaMa). A GTX 1060 does a card in ~20 s; CPU works but is several times slower.

## Running

```
# one card (id[:face]); --sheet writes sheet.jpg, a contact sheet for eyeballing the analysis
tools/scene/.venv/Scripts/python tools/scene/analyze.py 07b4e4f8-6a31-4533-be51-668ce3ddc84f --force --sheet

# the owner's cards (collection + decks, resolved to the printings the app shows)
tools/scene/.venv/Scripts/python tools/scene/owned_ids.py > tools/scene/ids-owned.txt
tools/scene/.venv/Scripts/python tools/scene/analyze.py --ids-file tools/scene/ids-owned.txt --sheet

# on demand: the web app POSTs cards without a pack to /api/scene/queue -> data/scene/queue.txt;
# this drains it while it runs (after finishing any ids given on the command line)
tools/scene/.venv/Scripts/python tools/scene/analyze.py --watch
```

Existing packs are skipped unless `--force` or the pack version changed.

## Pack format (version 2), `data/scene/<id[:2]>/<id>-<face>/`

| file | content |
| --- | --- |
| `color.jpg` | the art window (figure-layer texture) |
| `bg.jpg` | the art with the figure removed and inpainted (background layer) |
| `depth.png` | relative depth, 16-bit as RGB8 (R high byte, G low byte), 65535 = nearest |
| `bgdepth.png` | depth with the figure's hole filled |
| `figdepth.png` | figure depth extended past the matte so mesh edges stay crisp |
| `matte.png` | figure alpha (matting model, grown along depth to include held objects) |
| `material.png` | R metallic, G roughness, B emissive, A material class id (`scene.json.materials`) |
| `fx.png` | R fire, G smoke, B water, A magic densities |
| `flow.png` | RG stroke-flow direction (×0.5+0.5, image y down), B coherence |
| `scene.json` | art rect, size, `lights` (u v depth radius color power kind flicker behind), `atmosphere` (ambient, fog, keyDir, horizon, warmth), `phenomena` coverage, `embers` spawn points `[u, v, depth]`, figure box / depth, coverage, timings |
| `sheet.jpg` | (`--sheet`) contact sheet |

16-bit depth is split into two bytes because browsers decode 16-bit PNGs to 8 bits.

## How the analysis works

- **Depth**: Depth Anything V2 (relative, percentile-normalised).
- **Figure**: rembg ISNet matte, then grown along near depth so a held sword or staff joins the figure
  (staged thresholds, capped so the ground never joins). What the growth adds is labelled a held object
  (metal) unless it is skin.
- **Background**: LaMa inpaints the colour under the figure; Telea inpaints its depth, capped behind the ring.
- **Materials**: CLIPSeg over a prompt table (`MATERIALS`): metallic / roughness / emissive per class; a
  figure-relative weapon test on the weapon prompts catches blades CLIPSeg would call cloth.
- **Lights**: emissive-and-bright blobs → position, depth, colour, power, `kind` (fire / magic / orb / sun
  from the majority class and colour), flicker profile, and `behind` (how much of its surround the figure
  covers, so the renderer rims the figure from it).
- **Phenomena**: warm glowing energy is fire (embers, haze, flow), cool energy is magic, plus smoke and
  water classes. Flow direction from the structure tensor of the paint, sign fixed by priors (fire and smoke
  rise, water runs, magic radiates).
- **Atmosphere**: ambient from the darkest background, fog colour from the farthest pixels, fog density
  from saturation-vs-depth, key light direction fitted from the figure's shading, warmth of the emissive paint.

## Judging a pack

Open `sheet.jpg`. Check the matte follows the figure and what it holds, the lights sit on the painted sources
with sensible kinds, the material tile shows red (metal) on blades and armour, the fx tile marks fire /
smoke / water / magic where they are painted, and the flow arrows follow the strokes. Then look at the card
on `/dev/card` (scene sliders and debug views: depth, matte, bg, material, fx, flow, rays, albedo).
