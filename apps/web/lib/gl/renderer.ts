// CardGL: one WebGL2 context per layer drawing every live card into a full-viewport, pointer-events:none
// canvas. Each card registers a DOM anchor; per frame the anchor rects are read in one batch and each card
// is drawn with its own viewport + scissor. The rAF loop is demand-driven: it runs only while a spring is
// settling, a pointer moved, a texture arrived or the page scrolled / resized.

import { CARD_VERT, CARD_FRAG } from './shaders';
import { createProgram, createQuad, type GLProgram } from './program';
import { TextureCache, type TexEntry } from './textures';
import { CardInteraction, CAMERA_DISTANCE, enableDeviceOrientation, disableDeviceOrientation } from './interaction';
import { type FrameMask, WHOLE_CARD } from './frames';
import { QualityProbe, type Quality, type QualitySetting, dprFor, prefersReducedMotion, onReducedMotionChange } from './support';

export type Finish = 0 | 1 | 2;

export interface CardSpec {
  printingId: string;
  face: 0 | 1;
  finish: Finish;
  mask: FrameMask;
  size: 'normal' | 'large';
  hasBack: boolean;
  /** Max tilt in degrees. */
  maxTilt: number;
  tapped?: boolean;
  /** Per-card override of the reduced-motion preference. */
  reducedMotion?: boolean;
  /** Foil strength multiplier for this card (default 1). */
  foilStrength?: number;
}

export interface Tuning {
  relief: number;      // normal-map strength multiplier
  foil: number;        // foil sheen strength multiplier
  glare: number;       // broad glare amount
  tiltScale: number;   // multiplies every card's max tilt
  radius: number;      // corner radius as a fraction of the width (4.6%)
}

export interface RendererStats {
  fps: number;
  frameMs: number;     // CPU time spent in the last frame (ms)
  avgFrameMs: number;
  draws: number;
  live: number;
  running: boolean;
  quality: Quality;
  dpr: number;
  contextLost: boolean;
}

export interface CardHandle {
  readonly id: number;
  /** Pointer in card uv (0..1, top-left origin). */
  pointer(u: number, v: number): void;
  leave(): void;
  focus(on: boolean): void;
  nudge(dx: number, dy: number): void;
  reset(): void;
  setFace(face: 0 | 1): void;
  setFinish(finish: Finish): void;
  setSpec(patch: Partial<CardSpec>): void;
  /** Pause / resume drawing without releasing the registration. */
  setLive(on: boolean): void;
  /** True once the front texture is on the GPU and the DOM image can be hidden. */
  readonly ready: boolean;
  onReady(cb: (ready: boolean) => void): () => void;
  /** True while any spring is still moving. */
  readonly settling: boolean;
  onSettle(cb: () => void): () => void;
  destroy(): void;
}

interface CardInstance {
  id: number;
  anchor: HTMLElement;
  spec: CardSpec;
  ctrl: CardInteraction;
  live: boolean;
  ready: boolean;
  readyCbs: Set<(ready: boolean) => void>;
  settleCbs: Set<() => void>;
  wasMoving: boolean;
  baseFace: 0 | 1;
  rect: { left: number; top: number; width: number; height: number };
  pins: TexEntry[];
  destroyed: boolean;
}

const PAD = 0.14;              // viewport padding around the anchor so tilt / lift can overflow
const HOVER_LIFT = 0.055;      // world units toward the camera on hover (~2% larger)

export class CardGL {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private prog: GLProgram | null = null;
  private quad: { vao: WebGLVertexArrayObject; count: number } | null = null;
  private textures: TextureCache | null = null;
  private cards = new Map<number, CardInstance>();
  private nextId = 1;
  private rafId = 0;
  private lastTime = 0;
  private dirty = true;
  private lost = false;
  private destroyed = false;
  private reduced = prefersReducedMotion();
  private probe: QualityProbe | null = null;
  private ro: ResizeObserver | null = null;
  private unsubs: (() => void)[] = [];
  private orientationListener: ((rx: number, ry: number) => void) | null = null;
  private statsCb: ((s: RendererStats) => void) | null;
  private lastStatsAt = 0;
  private frameAvg = 0;
  private fpsAvg = 60;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private readonly model = new Float32Array(16);
  private readonly proj = new Float32Array(16);
  private readonly light = new Float32Array(3);

  quality: Quality;
  qualitySetting: QualitySetting;
  tuning: Tuning = { relief: 1, foil: 1, glare: 1, tiltScale: 1, radius: 0.046 };
  stats: RendererStats;

  constructor(canvas: HTMLCanvasElement, opts: { quality?: QualitySetting; onStats?: (s: RendererStats) => void } = {}) {
    this.canvas = canvas;
    this.qualitySetting = opts.quality ?? 'auto';
    this.quality = this.qualitySetting === 'medium' ? 'medium' : 'high';
    if (this.qualitySetting === 'auto') this.probe = new QualityProbe();
    this.statsCb = opts.onStats ?? null;
    this.stats = { fps: 0, frameMs: 0, avgFrameMs: 0, draws: 0, live: 0, running: false, quality: this.quality, dpr: 1, contextLost: false };
    this.initContext();
    this.attachEvents();
    this.resize();
  }

  get supported() { return !!this.gl; }

  // ---- lifecycle --------------------------------------------------------------------------------

  private initContext() {
    const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) return;
    this.gl = gl;
    this.prog = createProgram(gl, CARD_VERT, CARD_FRAG);
    this.quad = createQuad(gl);
    if (!this.textures) this.textures = new TextureCache(gl); else this.textures.reset(gl);
    this.unsubs.push(this.textures.onChange(() => this.requestFrame()));
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.SCISSOR_TEST);
  }

  private attachEvents() {
    const c = this.canvas;
    const onLost = (e: Event) => {
      e.preventDefault();
      this.lost = true;
      this.stats.contextLost = true;
      this.stopLoop();
      for (const inst of this.cards.values()) this.setReady(inst, false);
    };
    const onRestored = () => {
      this.lost = false;
      this.stats.contextLost = false;
      this.initContext();
      for (const inst of this.cards.values()) { inst.pins = []; this.refreshPins(inst); }
      this.dirty = true;
      this.requestFrame();
    };
    c.addEventListener('webglcontextlost', onLost);
    c.addEventListener('webglcontextrestored', onRestored);
    this.unsubs.push(() => { c.removeEventListener('webglcontextlost', onLost); c.removeEventListener('webglcontextrestored', onRestored); });

    const mark = () => { this.dirty = true; this.requestFrame(); };
    const onResize = () => { this.resize(); mark(); };
    window.addEventListener('scroll', mark, { capture: true, passive: true });
    window.addEventListener('resize', onResize);
    const onVis = () => { if (document.hidden) this.stopLoop(); else mark(); };
    document.addEventListener('visibilitychange', onVis);
    this.unsubs.push(() => { window.removeEventListener('scroll', mark, { capture: true }); window.removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', onVis); });
    this.unsubs.push(onReducedMotionChange(r => { this.reduced = r; for (const inst of this.cards.values()) this.applyMotion(inst); mark(); }));
    if (typeof ResizeObserver !== 'undefined') this.ro = new ResizeObserver(mark);
  }

  private resize() {
    this.dpr = dprFor(this.quality);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    const w = Math.round(this.width * this.dpr), h = Math.round(this.height * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.stats.dpr = this.dpr;
  }

  setQuality(q: QualitySetting) {
    this.qualitySetting = q;
    if (q === 'auto') { this.probe = new QualityProbe(); this.quality = 'high'; }
    else { this.probe = null; this.quality = q; }
    this.stats.quality = this.quality;
    this.resize();
    this.dirty = true;
    this.requestFrame();
  }

  setTuning(patch: Partial<Tuning>) {
    Object.assign(this.tuning, patch);
    this.dirty = true;
    this.requestFrame();
  }

  onStats(cb: ((s: RendererStats) => void) | null) { this.statsCb = cb; }

  async enableDeviceOrientation(): Promise<boolean> {
    if (this.orientationListener) return true;
    const l = (rx: number, ry: number) => { for (const inst of this.cards.values()) if (!inst.ctrl.pointerInside) inst.ctrl.setExternal(rx, ry); this.requestFrame(); };
    const ok = await enableDeviceOrientation(l);
    if (ok) this.orientationListener = l;
    return ok;
  }

  disableDeviceOrientation() {
    if (this.orientationListener) { disableDeviceOrientation(this.orientationListener); this.orientationListener = null; }
  }

  destroy() {
    this.destroyed = true;
    this.stopLoop();
    this.disableDeviceOrientation();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.ro?.disconnect();
    for (const inst of this.cards.values()) inst.destroyed = true;
    this.cards.clear();
    const ext = this.gl?.getExtension('WEBGL_lose_context');
    ext?.loseContext();
    this.gl = null;
  }

  // ---- registration -----------------------------------------------------------------------------

  register(anchor: HTMLElement, spec: CardSpec): CardHandle {
    const id = this.nextId++;
    const inst: CardInstance = {
      id, anchor, spec: { ...spec }, live: true, ready: false, readyCbs: new Set(), settleCbs: new Set(), wasMoving: false,
      baseFace: spec.face, rect: { left: 0, top: 0, width: 0, height: 0 }, pins: [], destroyed: false,
      ctrl: new CardInteraction({ maxTilt: spec.maxTilt * this.tuning.tiltScale, reducedMotion: spec.reducedMotion ?? this.reduced }),
    };
    this.cards.set(id, inst);
    this.ro?.observe(anchor);
    this.refreshPins(inst);
    this.dirty = true;
    this.requestFrame();
    const self = this;
    const handle: CardHandle = {
      id,
      pointer: (u, v) => { inst.ctrl.pointer(u, v); self.requestFrame(); },
      leave: () => { inst.ctrl.leave(); self.requestFrame(); },
      focus: (on) => { inst.ctrl.focus(on); self.requestFrame(); },
      nudge: (dx, dy) => { inst.ctrl.nudge(dx, dy); self.requestFrame(); },
      reset: () => { inst.ctrl.reset(); self.requestFrame(); },
      setFace: (face) => {
        if (inst.spec.face === face) return;
        inst.spec.face = face;
        inst.ctrl.setFlipped(face !== inst.baseFace);
        self.refreshPins(inst);
        self.requestFrame();
      },
      setFinish: (finish) => { if (inst.spec.finish !== finish) { inst.spec.finish = finish; self.dirty = true; self.requestFrame(); } },
      setSpec: (patch) => {
        Object.assign(inst.spec, patch);
        if (patch.maxTilt != null) inst.ctrl.maxTilt = patch.maxTilt * self.tuning.tiltScale;
        if (patch.reducedMotion != null) self.applyMotion(inst);
        if (patch.printingId || patch.size) self.setReady(inst, false);
        self.refreshPins(inst);
        self.dirty = true;
        self.requestFrame();
      },
      setLive: (on) => { if (inst.live !== on) { inst.live = on; self.dirty = true; self.requestFrame(); } },
      get ready() { return inst.ready; },
      onReady: (cb) => { inst.readyCbs.add(cb); return () => inst.readyCbs.delete(cb); },
      get settling() { return inst.wasMoving; },
      onSettle: (cb) => { inst.settleCbs.add(cb); return () => inst.settleCbs.delete(cb); },
      destroy: () => {
        if (inst.destroyed) return;
        inst.destroyed = true;
        self.cards.delete(id);
        self.ro?.unobserve(anchor);
        for (const p of inst.pins) self.textures?.pin(p, -1);
        inst.pins = [];
        self.dirty = true;
        self.requestFrame();
      },
    };
    return handle;
  }

  get liveCount() { return this.cards.size; }

  private applyMotion(inst: CardInstance) {
    inst.ctrl.reducedMotion = inst.spec.reducedMotion ?? this.reduced;
    inst.ctrl.reset();
  }

  private setReady(inst: CardInstance, ready: boolean) {
    if (inst.ready === ready) return;
    inst.ready = ready;
    for (const cb of inst.readyCbs) cb(ready);
  }

  /** Pin the textures a card needs (front face; both faces mid-flip) so the LRU won't evict them. */
  private refreshPins(inst: CardInstance) {
    const tx = this.textures;
    if (!tx) return;
    for (const p of inst.pins) tx.pin(p, -1);
    inst.pins = [];
    const now = performance.now();
    const faces: (0 | 1)[] = inst.spec.hasBack && inst.spec.face !== inst.baseFace ? [inst.baseFace, inst.spec.face] : [inst.spec.face];
    for (const f of faces) {
      const a = tx.albedo(inst.spec.printingId, f, inst.spec.size, now);
      const n = tx.normalMap(inst.spec.printingId, f, now);
      tx.pin(a, 1); tx.pin(n, 1);
      inst.pins.push(a, n);
    }
  }

  // ---- frame loop -------------------------------------------------------------------------------

  requestFrame() {
    if (this.rafId || this.destroyed || this.lost || !this.gl) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    this.rafId = requestAnimationFrame(this.tick);
    this.stats.running = true;
  }

  private stopLoop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.lastTime = 0;
    this.stats.running = false;
    this.emitStats(performance.now(), true);
  }

  private tick = (now: number) => {
    this.rafId = 0;
    const gl = this.gl, prog = this.prog, quad = this.quad, tx = this.textures;
    if (!gl || !prog || !quad || !tx || this.lost) return;
    const t0 = performance.now();
    const dt = this.lastTime ? Math.min(0.05, (now - this.lastTime) / 1000) : 1 / 60;
    this.lastTime = now;
    this.dirty = false;

    // 1. batch the layout reads
    const vw = this.width, vh = this.height;
    const visible: CardInstance[] = [];
    let anyMoving = false;
    for (const inst of this.cards.values()) {
      const moving = inst.ctrl.step(dt);
      if (!moving && inst.wasMoving) for (const cb of inst.settleCbs) cb();
      inst.wasMoving = moving;
      anyMoving = anyMoving || moving;
      if (!inst.live) continue;
      const r = inst.anchor.getBoundingClientRect();
      inst.rect.left = r.left; inst.rect.top = r.top; inst.rect.width = r.width; inst.rect.height = r.height;
      if (r.width < 2 || r.height < 2) continue;
      const m = PAD + 0.05;
      if (r.right + r.width * m < 0 || r.left - r.width * m > vw || r.bottom + r.height * m < 0 || r.top - r.height * m > vh) continue;
      visible.push(inst);
    }

    // 2. draw
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.useProgram(prog.program);
    gl.bindVertexArray(quad.vao);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, tx.noise);
    gl.uniform1i(prog.u('uAlbedo'), 0);
    gl.uniform1i(prog.u('uNormalMap'), 1);
    gl.uniform1i(prog.u('uNoise'), 2);
    gl.uniform3f(prog.u('uCamPos'), 0, 0, CAMERA_DISTANCE);
    gl.uniform1f(prog.u('uQuality'), this.quality === 'high' ? 1 : 0);
    gl.uniform1f(prog.u('uRelief'), this.tuning.relief);
    gl.uniform1f(prog.u('uRadius'), this.tuning.radius);
    let draws = 0;
    let pendingTextures = false;
    for (const inst of visible) {
      const res = this.drawCard(gl, prog, tx, inst, now);
      if (res === 'pending') pendingTextures = true; else if (res === 'drawn') draws++;
    }
    gl.bindVertexArray(null);
    tx.evict();

    // 3. stats + demand-driven continuation
    const frameMs = performance.now() - t0;
    this.stats.frameMs = frameMs;
    this.frameAvg = this.frameAvg ? this.frameAvg * 0.9 + frameMs * 0.1 : frameMs;
    this.stats.avgFrameMs = this.frameAvg;
    const inst = dt > 0 ? 1 / dt : 60;
    this.fpsAvg = this.fpsAvg * 0.9 + inst * 0.1;
    this.stats.fps = this.fpsAvg;
    this.stats.draws = draws;
    this.stats.live = this.cards.size;
    if (this.probe && draws > 0) {
      const decided = this.probe.sample(frameMs, now);
      if (decided && decided !== this.quality) { this.quality = decided; this.stats.quality = decided; this.resize(); this.dirty = true; }
    }
    this.emitStats(now, false);

    if (anyMoving || this.dirty || pendingTextures) this.requestFrame();
    else { this.stats.running = false; this.lastTime = 0; this.emitStats(now, true); }
  };

  private emitStats(now: number, force: boolean) {
    if (!this.statsCb) return;
    if (!force && now - this.lastStatsAt < 250) return;
    this.lastStatsAt = now;
    this.statsCb({ ...this.stats });
  }

  private drawCard(gl: WebGL2RenderingContext, prog: GLProgram, tx: TextureCache, inst: CardInstance, now: number): 'drawn' | 'pending' | 'skipped' {
    const spec = inst.spec, ctrl = inst.ctrl;
    const flip = ctrl.reducedMotion ? 0 : ctrl.flip.x;
    const showBack = ctrl.reducedMotion ? ctrl.flipFade.x >= 0.5 : flip >= 0.5;
    const otherFace: 0 | 1 = inst.baseFace === 0 ? 1 : 0;
    const face: 0 | 1 = showBack ? otherFace : inst.baseFace;

    // textures (fall back to the normal-size albedo while a large one is still downloading)
    let albedo = tx.albedo(spec.printingId, face, spec.size, now);
    if (albedo.status !== 'ready' && spec.size === 'large') {
      const fb = tx.peekAlbedo(spec.printingId, face, 'normal');
      if (fb?.status === 'ready') albedo = fb;
    }
    const nmap = tx.normalMap(spec.printingId, face, now);
    if (albedo.status === 'error') return 'skipped';
    if (albedo.status !== 'ready') return 'pending';
    if (face === spec.face) this.setReady(inst, true);
    if (nmap.status === 'ready') { if (ctrl.reliefMix.target !== 1) { ctrl.reliefMix.target = 1; } }
    if (inst.ready && ctrl.foilMix.target !== 1) ctrl.foilMix.target = 1;
    const hasNormal = nmap.status === 'ready';

    // viewport / scissor around the anchor rect (device pixels, GL origin bottom-left)
    const r = inst.rect, dpr = this.dpr;
    const padW = r.width * PAD, padH = r.height * PAD;
    const vx = Math.floor((r.left - padW) * dpr);
    const vy = Math.floor((this.height - (r.top + r.height) - padH) * dpr);
    const vw = Math.ceil((r.width + 2 * padW) * dpr);
    const vh = Math.ceil((r.height + 2 * padH) * dpr);
    gl.viewport(vx, vy, vw, vh);
    gl.scissor(vx, vy, vw, vh);

    // geometry: card width = 1 world unit; a tapped card is drawn rotated into a landscape anchor
    const rectAspect = r.height / r.width;
    const tapped = !!spec.tapped;
    const cardW = tapped ? rectAspect : 1;
    const cardH = tapped ? 1 : rectAspect;
    const sx = 2 / (1 + 2 * PAD);
    const sy = 2 / ((1 + 2 * PAD) * rectAspect);
    this.setProjection(sx, sy);
    const rotX = ctrl.rotX.x * (Math.PI / 180);
    const rotY = (ctrl.rotY.x + flip * 180) * (Math.PI / 180);
    const lift = HOVER_LIFT * ctrl.hover.x;
    this.setModel(rotX, rotY, tapped ? -Math.PI / 2 : 0, lift);
    const aspect = cardH / cardW;
    ctrl.light(aspect, this.light);

    // per-frame uniforms
    gl.uniformMatrix4fv(prog.u('uProj'), false, this.proj);
    gl.uniformMatrix4fv(prog.u('uModel'), false, this.model);
    gl.uniform2f(prog.u('uSize'), cardW, cardH);
    gl.uniform1f(prog.u('uMirror'), showBack ? -1 : 1);
    gl.uniform3fv(prog.u('uLightPos'), this.light);
    gl.uniform2f(prog.u('uPointer'), ctrl.px.x, ctrl.py.x);
    const mt = Math.max(1, ctrl.maxTilt);
    gl.uniform2f(prog.u('uTiltVec'), ctrl.rotY.x / mt, ctrl.rotX.x / mt);
    gl.uniform1f(prog.u('uHover'), ctrl.hover.x);
    const foilBase = spec.finish === 0 ? 0 : this.tuning.foil * (spec.foilStrength ?? 1) * ctrl.foilMix.x;
    gl.uniform1f(prog.u('uFoil'), ctrl.reducedMotion ? foilBase * 0.6 : foilBase);
    gl.uniform1f(prog.u('uGlare'), this.tuning.glare * ctrl.glare.x);
    gl.uniform1f(prog.u('uHasNormal'), hasNormal ? ctrl.reliefMix.x : 0);
    gl.uniform1f(prog.u('uNoiseScale'), Math.max(0.5, (r.width * dpr) / tx.noiseSize / 1.5));
    // per-bind uniforms
    gl.uniform1i(prog.u('uFinish'), spec.finish);
    const mask = spec.mask ?? WHOLE_CARD;
    gl.uniform1i(prog.u('uMaskMode'), mask.mode);
    gl.uniform4f(prog.u('uArtRect'), mask.art.x0, mask.art.y0, mask.art.x1, mask.art.y1);
    gl.uniform4f(prog.u('uTextRect'), mask.text.x0, mask.text.y0, mask.text.x1, mask.text.y1);
    gl.uniform1f(prog.u('uAspect'), aspect);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, albedo.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, hasNormal ? nmap.tex : tx.flatNormal);

    if (ctrl.reducedMotion && spec.hasBack && ctrl.flipFade.x > 0 && ctrl.flipFade.x < 1) {
      // crossfade flip: draw both faces with complementary opacity
      const other = tx.albedo(spec.printingId, otherFace, spec.size, now);
      const fade = ctrl.flipFade.x;
      gl.uniform1f(prog.u('uOpacity'), showBack ? fade : 1 - fade);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (other.status === 'ready') {
        const onm = tx.normalMap(spec.printingId, otherFace, now);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, other.tex);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, onm.status === 'ready' ? onm.tex : tx.flatNormal);
        gl.uniform1f(prog.u('uMirror'), showBack ? 1 : -1);
        gl.uniform1f(prog.u('uOpacity'), showBack ? 1 - fade : fade);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      return 'drawn';
    }
    gl.uniform1f(prog.u('uOpacity'), 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return 'drawn';
  }

  // ---- matrices (column-major) -------------------------------------------------------------------

  private setProjection(sx: number, sy: number) {
    const p = this.proj;
    p.fill(0);
    const D = CAMERA_DISTANCE;
    p[0] = D * sx;
    p[5] = D * sy;
    p[11] = -1;   // clip.w = D - z
    p[15] = D;
  }

  /** model = T(0,0,lift) · Ry(ry) · Rx(rx) · Rz(rz) */
  private setModel(rx: number, ry: number, rz: number, lift: number) {
    const cx = Math.cos(rx), sxn = Math.sin(rx);
    const cy = Math.cos(ry), syn = Math.sin(ry);
    const cz = Math.cos(rz), szn = Math.sin(rz);
    // Rx·Rz
    const a00 = cz, a01 = -szn, a02 = 0;
    const a10 = cx * szn, a11 = cx * cz, a12 = -sxn;
    const a20 = sxn * szn, a21 = sxn * cz, a22 = cx;
    // Ry·(Rx·Rz)
    const m = this.model;
    m[0] = cy * a00 + syn * a20; m[1] = a10; m[2] = -syn * a00 + cy * a20; m[3] = 0;
    m[4] = cy * a01 + syn * a21; m[5] = a11; m[6] = -syn * a01 + cy * a21; m[7] = 0;
    m[8] = cy * a02 + syn * a22; m[9] = a12; m[10] = -syn * a02 + cy * a22; m[11] = 0;
    m[12] = 0; m[13] = 0; m[14] = lift; m[15] = 1;
  }
}
