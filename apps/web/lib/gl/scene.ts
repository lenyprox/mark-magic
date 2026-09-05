// 2.5D scene: pack loading (the textures tools/scene/analyze.py writes, served by /api/scene), per-card render
// targets, and the pass sequence that turns a pack into the card's lit `scene` texture every frame:
//
//   geometry (background + figure meshes displaced by depth, sheared by the tilt) -> G-buffer
//   lighting (PBR with the pack's lights, shadows, rim, water, fog)                -> HDR
//   rays (half res, occluded by the figure's silhouette)                            -> rays
//   embers (CPU-simulated, depth-tested)                                            -> HDR (additive)
//   post (heat haze, bloom from the HDR mips, tone map, debug views)               -> scene texture
//
// Everything is in "t space" (art window, y up); see scene-shaders.ts. The card shader samples the result
// inside its art rect.

import { createProgram, type GLProgram } from './program';
import { GEO_VERT, GEO_FRAG, FS_VERT, LIGHT_FRAG, RAYS_FRAG, EMBER_VERT, EMBER_FRAG, POST_FRAG, MAX_SCENE_LIGHTS } from './scene-shaders';

export interface SceneLight {
  u: number; v: number; depth: number; radius: number;
  color: [number, number, number]; power: number; area: number;
  kind: 'fire' | 'orb' | 'sun' | 'magic'; flicker: number; behind: number;
}
export interface SceneJson {
  version: number;
  printingId: string; face: number; name: string;
  art: [number, number, number, number];
  size: [number, number];
  lights: SceneLight[];
  atmosphere: { ambient: [number, number, number]; fog: { color: [number, number, number]; density: number }; keyDir: [number, number, number]; horizon: number | null; warmth: number };
  phenomena: { fire: number; smoke: number; water: number; magic: number };
  embers: [number, number, number][];
  figureBox: [number, number, number, number] | null;
  figureDepth: number;
}

export const SCENE_PACK_VERSION = 2;
const PACK_TEXTURES = ['color', 'bg', 'depth', 'bgdepth', 'figdepth', 'matte', 'material', 'fx', 'flow'] as const;
type PackTex = typeof PACK_TEXTURES[number];

export interface ScenePack {
  status: 'loading' | 'ready' | 'none' | 'error';
  json: SceneJson | null;
  tex: Record<PackTex, WebGLTexture> | null;
  lastUse: number;
  pinned: number;
}

export function sceneUrl(printingId: string, face: 0 | 1, file: string) { return `/api/scene/${printingId}/${face}/${file}`; }

/** Scene packs on the GPU: an LRU of 8, a negative cache for cards without a pack, one request per miss. */
export class ScenePackCache {
  private readonly map = new Map<string, ScenePack>();
  private readonly negative = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  readonly capacity = 8;

  constructor(private gl: WebGL2RenderingContext) {}

  onChange(l: () => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  private notify() { for (const l of this.listeners) l(); }

  reset(gl: WebGL2RenderingContext) {
    this.generation++;
    this.map.clear();
    this.gl = gl;
  }

  /** The pack entry for a face; starts the load on a miss. `none` means the card has no pack (cached). */
  get(printingId: string, face: 0 | 1, now: number): ScenePack {
    const key = `${printingId}:${face}`;
    let e = this.map.get(key);
    if (e) { e.lastUse = now; return e; }
    e = { status: this.negative.has(key) ? 'none' : 'loading', json: null, tex: null, lastUse: now, pinned: 0 };
    this.map.set(key, e);
    if (e.status === 'loading') void this.load(e, key, printingId, face);
    return e;
  }

  peek(printingId: string, face: 0 | 1): ScenePack | undefined { return this.map.get(`${printingId}:${face}`); }
  pin(e: ScenePack | undefined, d: 1 | -1) { if (e) e.pinned += d; }

  evict() {
    if (this.map.size <= this.capacity) return;
    const victims = [...this.map.entries()].filter(([, e]) => e.pinned <= 0 && e.status !== 'loading').sort((a, b) => a[1].lastUse - b[1].lastUse);
    let over = this.map.size - this.capacity;
    for (const [k, e] of victims) {
      if (over <= 0) break;
      if (e.tex) for (const t of Object.values(e.tex)) this.gl.deleteTexture(t);
      this.map.delete(k);
      over--;
    }
  }

  private async load(e: ScenePack, key: string, printingId: string, face: 0 | 1) {
    const gen = this.generation;
    try {
      const res = await fetch(sceneUrl(printingId, face, 'scene.json'));
      if (res.status === 404) {
        this.negative.add(key); e.status = 'none'; this.notify();
        // ask for an on-demand analysis (drained by `analyze.py --watch` when it runs); fire and forget
        fetch('/api/scene/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ printingId, face }) }).catch(() => {});
        return;
      }
      if (!res.ok) throw new Error(`scene ${res.status}`);
      const json = (await res.json()) as SceneJson;
      if (json.version !== SCENE_PACK_VERSION) { this.negative.add(key); e.status = 'none'; this.notify(); return; }
      const bitmaps = await Promise.all(PACK_TEXTURES.map(async name => {
        const ext = name === 'color' || name === 'bg' ? 'jpg' : 'png';
        const r = await fetch(sceneUrl(printingId, face, `${name}.${ext}`));
        if (!r.ok) throw new Error(`${name} ${r.status}`);
        // flipped so texel row 0 is the art's bottom (t space, y up); UNPACK_FLIP_Y is not reliable for bitmaps
        return createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'flipY' });
      }));
      if (gen !== this.generation || !this.map.has(key)) { for (const b of bitmaps) b.close(); return; }
      const gl = this.gl;
      const tex = {} as Record<PackTex, WebGLTexture>;
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      PACK_TEXTURES.forEach((name, i) => {
        const t = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmaps[i]);
        const exact = name === 'depth' || name === 'bgdepth' || name === 'figdepth';
        const mips = name === 'color' || name === 'bg';
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, exact ? gl.NEAREST : gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, exact ? gl.NEAREST : mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
        if (mips) gl.generateMipmap(gl.TEXTURE_2D);
        tex[name] = t;
        bitmaps[i].close();
      });
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
      e.json = json; e.tex = tex; e.status = 'ready';
      this.evict();
    } catch (err) {
      if (gen !== this.generation) return;
      e.status = 'error';
      if (process.env.NODE_ENV !== 'production') console.warn('[CardGL] scene pack failed', printingId, err);
    }
    this.notify();
  }
}

// ---- embers (CPU) --------------------------------------------------------------------------------------------

const EMBER_STRIDE = 6;   // x y z age | size heat
const MAX_EMBERS = 512;

class Embers {
  readonly data = new Float32Array(MAX_EMBERS * EMBER_STRIDE);
  private readonly vel = new Float32Array(MAX_EMBERS * 2);
  private readonly life = new Float32Array(MAX_EMBERS);
  count = 0;
  private seed = 1;
  constructor(private spawns: [number, number, number][], private pivot: number, private depthScale: number, private aspect: number) {}
  private rnd() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296; }
  private respawn(i: number, first: boolean) {
    const s = this.spawns[Math.floor(this.rnd() * this.spawns.length)];
    const o = i * EMBER_STRIDE;
    this.data[o] = s[0] + (this.rnd() - 0.5) * 0.02;
    this.data[o + 1] = 1 - s[1] + (this.rnd() - 0.5) * 0.02;
    this.data[o + 2] = (s[2] - this.pivot) * this.depthScale + 0.03;
    this.data[o + 3] = first ? this.rnd() : 0;
    this.data[o + 4] = 0.45 + this.rnd() * 0.9;
    this.data[o + 5] = 0.4 + this.rnd() * 0.6;
    this.vel[i * 2] = (this.rnd() - 0.5) * 0.04;
    this.vel[i * 2 + 1] = 0.03 + this.rnd() * 0.08;
    this.life[i] = 1.6 + this.rnd() * 2.6;
  }
  setCount(n: number) {
    n = Math.min(MAX_EMBERS, Math.max(0, Math.round(n)));
    if (!this.spawns.length) n = 0;
    for (let i = this.count; i < n; i++) this.respawn(i, true);
    this.count = n;
  }
  /** Buoyancy, drag, turbulence, the card's tilt as gravity and its angular velocity as an inertial kick. */
  step(dt: number, time: number, tilt: [number, number], tiltVel: [number, number], boost: number) {
    const d = this.data, v = this.vel;
    for (let i = 0; i < this.count; i++) {
      const o = i * EMBER_STRIDE, vo = i * 2;
      const heat = d[o + 5];
      const px = d[o], py = d[o + 1];
      const n1 = noise2(px * 5.0 + time * 0.25, py * 5.0 * this.aspect + 3.1) - 0.5;
      const n2 = noise2(px * 5.0 + 7.7, py * 5.0 * this.aspect - time * 0.2) - 0.5;
      let ax = n1 * 0.22 + tilt[0] * 0.16 - tiltVel[0] * 0.06;
      let ay = 0.09 + 0.12 * heat + n2 * 0.16 + tilt[1] * 0.16 - tiltVel[1] * 0.06;
      ax *= 1 + boost; ay *= 1 + boost;
      v[vo] = (v[vo] + ax * dt) * Math.exp(-1.1 * dt);
      v[vo + 1] = (v[vo + 1] + ay * dt) * Math.exp(-1.1 * dt);
      d[o] += v[vo] * dt;
      d[o + 1] += v[vo + 1] * dt;
      d[o + 3] += dt / this.life[i];
      if (d[o + 3] >= 1 || d[o] < -0.05 || d[o] > 1.05 || d[o + 1] > 1.05 || d[o + 1] < -0.05) this.respawn(i, false);
    }
  }
}

function hashf(x: number, y: number) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function noise2(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hashf(ix, iy), b = hashf(ix + 1, iy), c = hashf(ix, iy + 1), dd = hashf(ix + 1, iy + 1);
  return (a + (b - a) * fx) + ((c + (dd - c) * fx) - (a + (b - a) * fx)) * fy;
}

// ---- render targets ------------------------------------------------------------------------------------------

interface Target {
  width: number; height: number;
  gFbo: WebGLFramebuffer; gTex: WebGLTexture[]; gDepth: WebGLRenderbuffer;
  hdrFbo: WebGLFramebuffer; hdrTex: WebGLTexture;
  raysFbo: WebGLFramebuffer; raysTex: WebGLTexture;
  outFbo: WebGLFramebuffer; outTex: WebGLTexture;
  embers: Embers | null;
  emberVbo: WebGLBuffer; emberVao: WebGLVertexArrayObject;
  lastKey: string;
  packKey: string;
}

export interface SceneTuning {
  parallax: number; rays: number; glow: number; metal: number; ambient: number;
  flowSpeed: number; embers: number; haze: number; exposure: number; sceneDebug: number;
}

export interface SceneDraw {
  id: number;
  pack: ScenePack;                 // status 'ready'
  /** Target width in device pixels (the art window on screen). */
  widthPx: number;
  tilt: [number, number];          // normalised tilt (-1..1), x = rotY / maxTilt, y = rotX / maxTilt
  tiltVel: [number, number];       // degrees per second / maxTilt
  hover: number;
  /** Pointer in art uv (top-left origin) or null. */
  pointer: [number, number] | null;
  time: number;                    // this card's scene clock (seconds; frozen when not animating)
  dt: number;
  animate: boolean;
  quality: 'high' | 'medium';
  tuning: SceneTuning;
}

const GRID_W = 96, GRID_H = 128;
const DEPTH_SCALE = 0.6;

export class SceneRenderer {
  private gl: WebGL2RenderingContext;
  private geo!: GLProgram; private light!: GLProgram; private rays!: GLProgram; private ember!: GLProgram; private post!: GLProgram;
  private gridVao!: WebGLVertexArrayObject; private gridCount = 0;
  private fsVao!: WebGLVertexArrayObject;
  private targets = new Map<number, Target>();
  private hdrFloat = false;
  private readonly lightPos = new Float32Array(MAX_SCENE_LIGHTS * 4);
  private readonly lightColor = new Float32Array(MAX_SCENE_LIGHTS * 4);
  private readonly lightMeta = new Float32Array(MAX_SCENE_LIGHTS * 4);
  /** CPU ms spent in the last `render` call. */
  lastMs = 0;

  constructor(gl: WebGL2RenderingContext, private noise: WebGLTexture, private noiseSize: number) {
    this.gl = gl;
    this.init();
  }

  private init() {
    const gl = this.gl;
    this.hdrFloat = !!gl.getExtension('EXT_color_buffer_float');
    this.geo = createProgram(gl, GEO_VERT, GEO_FRAG);
    this.light = createProgram(gl, FS_VERT, LIGHT_FRAG);
    this.rays = createProgram(gl, FS_VERT, RAYS_FRAG);
    this.ember = createProgram(gl, EMBER_VERT, EMBER_FRAG);
    this.post = createProgram(gl, FS_VERT, POST_FRAG);
    // grid mesh in t space
    const pos = new Float32Array(GRID_W * GRID_H * 2);
    for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) { const i = (y * GRID_W + x) * 2; pos[i] = x / (GRID_W - 1); pos[i + 1] = y / (GRID_H - 1); }
    const idx = new Uint16Array((GRID_W - 1) * (GRID_H - 1) * 6);
    let k = 0;
    for (let y = 0; y < GRID_H - 1; y++) for (let x = 0; x < GRID_W - 1; x++) {
      const a = y * GRID_W + x, b = a + 1, c = a + GRID_W, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
    this.gridCount = idx.length;
    this.gridVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.gridVao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.fsVao = gl.createVertexArray()!;
  }

  /** After a context restore. */
  reset(gl: WebGL2RenderingContext, noise: WebGLTexture) {
    this.gl = gl;
    this.noise = noise;
    this.targets.clear();
    this.init();
  }

  release(id: number) {
    const t = this.targets.get(id);
    if (!t) return;
    const gl = this.gl;
    gl.deleteFramebuffer(t.gFbo); gl.deleteFramebuffer(t.hdrFbo); gl.deleteFramebuffer(t.raysFbo); gl.deleteFramebuffer(t.outFbo);
    for (const x of t.gTex) gl.deleteTexture(x);
    gl.deleteTexture(t.hdrTex); gl.deleteTexture(t.raysTex); gl.deleteTexture(t.outTex);
    gl.deleteRenderbuffer(t.gDepth); gl.deleteBuffer(t.emberVbo); gl.deleteVertexArray(t.emberVao);
    this.targets.delete(id);
  }

  destroy() { for (const id of [...this.targets.keys()]) this.release(id); }

  get targetCount() { return this.targets.size; }

  private colorTex(w: number, h: number, hdr: boolean, mips: boolean): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (hdr && this.hdrFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    return t;
  }

  private target(id: number, width: number, height: number, pack: ScenePack, packKey: string): Target {
    let t = this.targets.get(id);
    const resize = t && (Math.abs(t.width - width) / t.width > 0.25 || Math.abs(t.height - height) / t.height > 0.25);
    if (t && (resize || t.packKey !== packKey)) { this.release(id); t = undefined; }
    if (t) return t;
    const gl = this.gl;
    const gTex = [this.colorTex(width, height, false, false), this.colorTex(width, height, false, false), this.colorTex(width, height, false, false)];
    for (const x of gTex) { gl.bindTexture(gl.TEXTURE_2D, x); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); }
    const gFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, gFbo);
    gTex.forEach((x, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, x, 0));
    const gDepth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, gDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, gDepth);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    const hdrTex = this.colorTex(width, height, true, true);
    const hdrFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, hdrFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, hdrTex, 0);
    const rw = Math.max(1, width >> 1), rh = Math.max(1, height >> 1);
    const raysTex = this.colorTex(rw, rh, true, false);
    const raysFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, raysFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, raysTex, 0);
    const outTex = this.colorTex(width, height, false, false);
    const outFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const emberVao = gl.createVertexArray()!;
    const emberVbo = gl.createBuffer()!;
    gl.bindVertexArray(emberVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, emberVbo);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_EMBERS * EMBER_STRIDE * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, EMBER_STRIDE * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, EMBER_STRIDE * 4, 16);
    gl.bindVertexArray(null);
    const json = pack.json!;
    const aspect = json.size[1] / json.size[0];
    const embers = json.embers.length ? new Embers(json.embers, json.figureDepth, DEPTH_SCALE, aspect) : null;
    t = { width, height, gFbo, gTex, gDepth, hdrFbo, hdrTex, raysFbo, raysTex, outFbo, outTex, embers, emberVbo, emberVao, lastKey: '', packKey };
    this.targets.set(id, t);
    return t;
  }

  /** Render one card's scene; returns its texture (or the previous one when nothing changed). */
  render(p: SceneDraw): WebGLTexture | null {
    const gl = this.gl;
    const json = p.pack.json, tex = p.pack.tex;
    if (!json || !tex) return null;
    const t0 = performance.now();
    const lo = p.quality === 'high' ? 192 : 160, hi = p.quality === 'high' ? 640 : 448;
    const width = Math.max(lo, Math.min(hi, Math.round(p.widthPx)));
    const aspect = json.size[1] / json.size[0];
    const height = Math.max(8, Math.round(width * aspect));
    const packKey = `${json.printingId}:${json.face}`;
    const T = this.target(p.id, width, height, p.pack, packKey);
    const tn = p.tuning;
    const key = p.animate ? '' : `${p.tilt[0].toFixed(3)},${p.tilt[1].toFixed(3)},${p.hover.toFixed(2)},${p.pointer?.map(x => x.toFixed(3)).join(',')},${p.time.toFixed(2)},${p.quality},${JSON.stringify(tn)}`;
    if (!p.animate && key === T.lastKey) { this.lastMs = 0; return T.outTex; }
    T.lastKey = key;

    const pivot = json.figureDepth;
    const tiltMag = Math.min(1, Math.hypot(p.tilt[0], p.tilt[1]));
    const drift = p.animate ? tn.ambient * 0.05 : 0;
    const shearX = p.tilt[0] * tn.parallax * 0.34 * (0.7 + 0.3 * p.hover) + drift * Math.sin(p.time * 0.37);
    const shearY = p.tilt[1] * tn.parallax * 0.34 * (0.7 + 0.3 * p.hover) + drift * Math.cos(p.time * 0.29);
    const fig = json.figureBox ?? [0.25, 0, 0.75, 1];
    const figCx = (fig[0] + fig[2]) / 2, figCy = 1 - (fig[1] + fig[3]) / 2;
    const high = p.quality === 'high';

    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);

    // ---- geometry ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.gFbo);
    gl.viewport(0, 0, T.width, T.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const g = this.geo;
    gl.useProgram(g.program);
    gl.bindVertexArray(this.gridVao);
    this.bind(2, tex.matte); this.bind(3, tex.material); this.bind(4, tex.fx); this.bind(5, tex.flow);
    gl.uniform1i(g.u('uDepth'), 0); gl.uniform1i(g.u('uColor'), 1); gl.uniform1i(g.u('uMatte'), 2);
    gl.uniform1i(g.u('uMaterial'), 3); gl.uniform1i(g.u('uFx'), 4); gl.uniform1i(g.u('uFlow'), 5);
    gl.uniform1f(g.u('uPivot'), pivot);
    gl.uniform1f(g.u('uDepthScale'), DEPTH_SCALE);
    gl.uniform2f(g.u('uShear'), shearX, shearY);
    gl.uniform1f(g.u('uAspect'), aspect);
    gl.uniform1f(g.u('uOverscan'), 1.14);
    gl.uniform2f(g.u('uFigCenter'), figCx, figCy);
    gl.uniform1f(g.u('uTime'), p.time);
    gl.uniform1f(g.u('uFlowSpeed'), tn.flowSpeed * (0.35 + 0.65 * p.hover) * 0.6);
    gl.uniform1f(g.u('uDof'), high ? tiltMag * tn.parallax * 3.5 : 0);
    gl.uniform1f(g.u('uEmissiveGain'), 0.5);
    // background
    this.bind(0, tex.bgdepth); this.bind(1, tex.bg);
    gl.uniform1f(g.u('uLayer'), 0);
    gl.uniform1f(g.u('uPop'), 0);
    gl.drawElements(gl.TRIANGLES, this.gridCount, gl.UNSIGNED_SHORT, 0);
    // figure
    this.bind(0, tex.figdepth); this.bind(1, tex.color);
    gl.uniform1f(g.u('uLayer'), 1);
    gl.uniform1f(g.u('uPop'), 0.035 * p.hover);
    gl.drawElements(gl.TRIANGLES, this.gridCount, gl.UNSIGNED_SHORT, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.fsVao);

    // ---- lights ----
    const n = this.packLights(json, p, aspect, pivot);

    // ---- lighting ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.hdrFbo);
    gl.viewport(0, 0, T.width, T.height);
    const L = this.light;
    gl.useProgram(L.program);
    this.bind(0, T.gTex[0]); this.bind(1, T.gTex[1]); this.bind(2, T.gTex[2]); this.bind(3, tex.matte); this.bind(4, tex.fx); this.bind(5, tex.flow);
    gl.uniform1i(L.u('uGAlbedo'), 0); gl.uniform1i(L.u('uGDepth'), 1); gl.uniform1i(L.u('uGEmissive'), 2);
    gl.uniform1i(L.u('uMatte'), 3); gl.uniform1i(L.u('uFx'), 4); gl.uniform1i(L.u('uFlow'), 5);
    gl.uniform2f(L.u('uTexel'), 1 / T.width, 1 / T.height);
    gl.uniform1f(L.u('uAspect'), aspect);
    gl.uniform1f(L.u('uPivot'), pivot);
    gl.uniform1f(L.u('uDepthScale'), DEPTH_SCALE);
    gl.uniform1f(L.u('uTime'), p.time);
    gl.uniform1i(L.u('uLightCount'), n);
    gl.uniform4fv(L.u('uLightPos'), this.lightPos);
    gl.uniform4fv(L.u('uLightColor'), this.lightColor);
    gl.uniform4fv(L.u('uLightMeta'), this.lightMeta);
    const at = json.atmosphere;
    gl.uniform3fv(L.u('uAmbient'), at.ambient);
    gl.uniform3fv(L.u('uFogColor'), at.fog.color);
    gl.uniform1f(L.u('uFogDensity'), at.fog.density);
    gl.uniform3fv(L.u('uKeyDir'), at.keyDir);
    gl.uniform1f(L.u('uMetal'), tn.metal);
    gl.uniform1f(L.u('uRim'), 1.5);
    gl.uniform1f(L.u('uShadow'), 0.85);
    gl.uniform1f(L.u('uQuality'), high ? 1 : 0);
    gl.uniform2f(L.u('uTilt'), p.tilt[0], p.tilt[1]);
    gl.uniform1f(L.u('uHover'), p.hover);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ---- rays (half res) ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.raysFbo);
    gl.viewport(0, 0, Math.max(1, T.width >> 1), Math.max(1, T.height >> 1));
    const R = this.rays;
    gl.useProgram(R.program);
    this.bind(0, T.gTex[1]); this.bind(1, T.gTex[2]); this.bind(2, T.gTex[0]); this.bind(3, tex.fx); this.bind(4, this.noise);
    gl.uniform1i(R.u('uGDepth'), 0); gl.uniform1i(R.u('uGEmissive'), 1); gl.uniform1i(R.u('uGAlbedo'), 2); gl.uniform1i(R.u('uFx'), 3); gl.uniform1i(R.u('uNoise'), 4);
    gl.uniform2f(R.u('uNoiseScale'), (T.width >> 1) / this.noiseSize, (T.height >> 1) / this.noiseSize);
    gl.uniform1i(R.u('uLightCount'), n);
    gl.uniform4fv(R.u('uLightPos'), this.lightPos);
    gl.uniform4fv(R.u('uLightColor'), this.lightColor);
    gl.uniform4fv(R.u('uLightMeta'), this.lightMeta);
    gl.uniform1f(R.u('uAspect'), aspect);
    gl.uniform1f(R.u('uPivot'), pivot);
    gl.uniform1f(R.u('uDepthScale'), DEPTH_SCALE);
    gl.uniform1f(R.u('uTime'), p.time);
    gl.uniform1f(R.u('uFogDensity'), at.fog.density);
    gl.uniform1f(R.u('uRays'), tn.rays * 1.1 * (0.75 + 0.35 * p.hover));
    gl.uniform1f(R.u('uQuality'), high ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ---- embers (additive into HDR) ----
    if (T.embers && tn.embers > 0) {
      const base = high ? 256 : 96;
      T.embers.setCount(base * Math.min(2, tn.embers) * Math.min(1, 0.4 + json.phenomena.fire * 3));
      if (p.animate) T.embers.step(p.dt, p.time, p.tilt, p.tiltVel, p.hover * 0.6);
      if (T.embers.count > 0) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.hdrFbo);
        gl.viewport(0, 0, T.width, T.height);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        const E = this.ember;
        gl.useProgram(E.program);
        gl.bindVertexArray(T.emberVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, T.emberVbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, T.embers.data, 0, T.embers.count * EMBER_STRIDE);
        this.bind(0, T.gTex[1]);
        gl.uniform1i(E.u('uGDepth'), 0);
        gl.uniform2f(E.u('uTexel'), 1 / T.width, 1 / T.height);
        gl.uniform1f(E.u('uPointScale'), T.height * 0.014);
        gl.uniform2f(E.u('uShear'), shearX, shearY);
        gl.uniform1f(E.u('uAspect'), aspect);
        gl.uniform1f(E.u('uPivot'), pivot);
        gl.uniform1f(E.u('uDepthScale'), DEPTH_SCALE);
        const warm = at.warmth;
        gl.uniform3f(E.u('uHot'), 1.0, 0.75 + 0.2 * (1 - warm), 0.35 + 0.5 * (1 - warm));
        gl.uniform3f(E.u('uCool'), 0.9 * warm + 0.2, 0.25 + 0.3 * (1 - warm), 0.08 + 0.7 * (1 - warm));
        gl.uniform1f(E.u('uGain'), 1.6 * tn.embers);
        gl.drawArrays(gl.POINTS, 0, T.embers.count);
        gl.disable(gl.BLEND);
        gl.bindVertexArray(this.fsVao);
      }
    }

    // ---- bloom mips + post ----
    gl.bindTexture(gl.TEXTURE_2D, T.hdrTex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.outFbo);
    gl.viewport(0, 0, T.width, T.height);
    const P = this.post;
    gl.useProgram(P.program);
    this.bind(0, T.hdrTex); this.bind(1, T.raysTex); this.bind(2, tex.fx); this.bind(3, T.gTex[0]); this.bind(4, T.gTex[1]);
    this.bind(5, T.gTex[2]); this.bind(6, tex.matte); this.bind(7, tex.material); this.bind(8, tex.flow); this.bind(9, tex.bg);
    gl.uniform1i(P.u('uHdr'), 0); gl.uniform1i(P.u('uRaysTex'), 1); gl.uniform1i(P.u('uFx'), 2); gl.uniform1i(P.u('uGAlbedo'), 3); gl.uniform1i(P.u('uGDepth'), 4);
    gl.uniform1i(P.u('uGEmissive'), 5); gl.uniform1i(P.u('uMatte'), 6); gl.uniform1i(P.u('uMaterial'), 7); gl.uniform1i(P.u('uFlow'), 8); gl.uniform1i(P.u('uBg'), 9);
    gl.uniform1f(P.u('uTime'), p.time);
    gl.uniform1f(P.u('uHaze'), tn.haze * (0.6 + 0.4 * p.hover));
    gl.uniform1f(P.u('uGlow'), tn.glow * (this.hdrFloat ? 1 : 1.6));
    gl.uniform1f(P.u('uExposure'), tn.exposure);
    gl.uniform1i(P.u('uDebug'), Math.round(tn.sceneDebug));
    gl.uniform2f(P.u('uTexel'), 1 / T.width, 1 / T.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ---- restore the card renderer's state ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.SCISSOR_TEST);
    this.lastMs = performance.now() - t0;
    return T.outTex;
  }

  private bind(unit: number, tex: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  /** Fill the light uniform arrays: the pack's lights, then the pointer light. Returns the count. */
  private packLights(json: SceneJson, p: SceneDraw, aspect: number, pivot: number): number {
    const lp = this.lightPos, lc = this.lightColor, lm = this.lightMeta;
    lp.fill(0); lc.fill(0); lm.fill(0);
    let n = 0;
    for (const l of json.lights) {
      if (n >= MAX_SCENE_LIGHTS - 1) break;
      const o = n * 4;
      lp[o] = l.u * 2 - 1;
      lp[o + 1] = ((1 - l.v) * 2 - 1) * aspect;
      lp[o + 2] = (l.depth - pivot) * DEPTH_SCALE + 0.06;
      lp[o + 3] = l.radius * 2;
      lc[o] = l.color[0]; lc[o + 1] = l.color[1]; lc[o + 2] = l.color[2];
      lc[o + 3] = l.power * 1.2 * (0.85 + 0.35 * p.hover);
      lm[o] = l.flicker; lm[o + 1] = l.behind; lm[o + 2] = (n + 1) * 17.31; lm[o + 3] = 0;
      n++;
    }
    if (p.pointer && p.hover > 0.01) {
      const o = n * 4;
      lp[o] = p.pointer[0] * 2 - 1;
      lp[o + 1] = ((1 - p.pointer[1]) * 2 - 1) * aspect;
      lp[o + 2] = 0.55;
      lp[o + 3] = 0.12;
      lc[o] = 1; lc[o + 1] = 0.97; lc[o + 2] = 0.92; lc[o + 3] = 0.38 * p.hover;
      lm[o] = 0; lm[o + 1] = 0; lm[o + 2] = 99; lm[o + 3] = 1;
      n++;
    }
    return n;
  }
}
