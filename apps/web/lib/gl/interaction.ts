// Pointer / keyboard / device-orientation → pose targets, and the springs that chase them.
//
// Tilt: ±maxTilt degrees (8 on the table, 14 default, 18 on the hero). The light sits behind the cursor so
// the highlight lands under it; at rest it comes from the upper right so the relief still reads.
// Springs are semi-implicit Euler with stiffness 170 / damping 22 (ratio ≈ 0.84 → a soft overshoot).

export const TILT_PRESETS = { table: 8, default: 14, hero: 18 } as const;
export type TiltPreset = keyof typeof TILT_PRESETS;

export class Spring {
  v = 0;
  target: number;
  constructor(public x: number, public k = 170, public c = 22, public eps = 0.002) { this.target = x; }
  set(x: number) { this.x = x; this.target = x; this.v = 0; }
  /** Advance by dt seconds; returns true while still moving. */
  step(dt: number): boolean {
    const dx = this.target - this.x;
    if (Math.abs(dx) < this.eps && Math.abs(this.v) < this.eps * 10) { this.x = this.target; this.v = 0; return false; }
    this.v += (this.k * dx - this.c * this.v) * dt;
    this.x += this.v * dt;
    return true;
  }
}

/** Linear tween towards a target at a fixed rate (units per second). */
export class Tween {
  target: number;
  constructor(public x: number, public rate: number) { this.target = x; }
  set(x: number) { this.x = x; this.target = x; }
  step(dt: number): boolean {
    if (this.x === this.target) return false;
    const d = this.target - this.x;
    const s = Math.min(Math.abs(d), this.rate * dt);
    this.x += Math.sign(d) * s;
    if (Math.abs(this.target - this.x) < 1e-4) this.x = this.target;
    return this.x !== this.target;
  }
}

export interface InteractionOptions {
  maxTilt: number;
  reducedMotion: boolean;
}

export const CAMERA_DISTANCE = 3.2;
/** Resting point light: upper right, far enough for a broad soft highlight. */
const REST_LIGHT: [number, number, number] = [0.45, 0.7, 1.4];
/** Pointer light: just above the card so the highlight stays local to the cursor. */
const POINTER_LIGHT_Z = 0.5;
const POINTER_LIGHT_GAIN = 1.15;

export class CardInteraction {
  readonly rotX = new Spring(0);
  readonly rotY = new Spring(0);
  readonly hover = new Spring(0, 200, 26);
  readonly px = new Spring(0.5, 320, 32);
  readonly py = new Spring(0.5, 320, 32);
  readonly glare = new Spring(0, 200, 24);
  /** 0 front .. 1 back. A spring when animating a physical flip, a tween under reduced motion. */
  readonly flip = new Spring(0, 110, 19);
  readonly flipFade = new Tween(0, 1 / 0.32);
  readonly foilMix = new Tween(0, 1 / 0.18);
  readonly reliefMix = new Tween(0, 1 / 0.24);
  /** 0..1 crossfade of the 2.5D scene into the art window once its pack is on the GPU. */
  readonly sceneMix = new Tween(0, 1 / 0.4);

  maxTilt: number;
  reducedMotion: boolean;
  pointerInside = false;
  focused = false;
  private keyX = 0;
  private keyY = 0;
  private extX = 0;
  private extY = 0;
  /** True when the pointer moved since the last frame (used by the renderer's demand loop). */
  pointerDirty = false;

  constructor(opts: InteractionOptions) {
    this.maxTilt = opts.maxTilt;
    this.reducedMotion = opts.reducedMotion;
  }

  /** Pointer position in card uv (0..1, top-left origin). */
  pointer(u: number, v: number) {
    this.pointerInside = true;
    this.pointerDirty = true;
    this.px.target = clamp(u, -0.2, 1.2);
    this.py.target = clamp(v, -0.2, 1.2);
    this.keyX = 0; this.keyY = 0;
    this.retarget();
  }

  leave() {
    this.pointerInside = false;
    this.pointerDirty = true;
    this.retarget();
  }

  focus(on: boolean) {
    this.focused = on;
    this.pointerDirty = true;
    if (!on) { this.keyX = 0; this.keyY = 0; }
    this.retarget();
  }

  /** Keyboard nudge in degrees (arrow keys). */
  nudge(dx: number, dy: number) {
    this.keyX = clamp(this.keyX + dx, -this.maxTilt, this.maxTilt);
    this.keyY = clamp(this.keyY + dy, -this.maxTilt, this.maxTilt);
    this.pointerDirty = true;
    this.retarget();
  }

  reset() { this.keyX = 0; this.keyY = 0; this.pointerDirty = true; this.retarget(); }

  /** Device-orientation tilt (degrees) applied while nothing else drives the card. */
  setExternal(rx: number, ry: number) {
    this.extX = clamp(rx, -this.maxTilt, this.maxTilt);
    this.extY = clamp(ry, -this.maxTilt, this.maxTilt);
    this.pointerDirty = true;
    this.retarget();
  }

  setFlipped(back: boolean) {
    if (this.reducedMotion) { this.flip.set(back ? 1 : 0); this.flipFade.target = back ? 1 : 0; }
    else { this.flip.target = back ? 1 : 0; this.flipFade.set(back ? 1 : 0); }
  }

  private retarget() {
    const active = this.pointerInside || this.focused;
    if (this.reducedMotion) {
      this.rotX.target = 0; this.rotY.target = 0;
      this.px.target = 0.5; this.py.target = 0.5;
    } else if (this.pointerInside) {
      // press: the side under the pointer recedes
      const u = this.px.target, v = this.py.target;
      this.rotY.target = -(u - 0.5) * 2 * this.maxTilt;
      this.rotX.target = (v - 0.5) * 2 * this.maxTilt;
    } else if (this.keyX || this.keyY) {
      this.rotX.target = this.keyX; this.rotY.target = this.keyY;
      this.px.target = 0.5 - this.keyY / (2 * this.maxTilt);
      this.py.target = 0.5 + this.keyX / (2 * this.maxTilt);
    } else {
      this.rotX.target = this.extX; this.rotY.target = this.extY;
      this.px.target = 0.5; this.py.target = 0.5;
    }
    this.hover.target = this.pointerInside ? 1 : this.focused ? 0.7 : 0;
    this.glare.target = active ? 1 : 0;
  }

  /** Advance all motion; returns true while anything is still settling. */
  step(dt: number): boolean {
    let moving = false;
    moving = this.rotX.step(dt) || moving;
    moving = this.rotY.step(dt) || moving;
    moving = this.hover.step(dt) || moving;
    moving = this.px.step(dt) || moving;
    moving = this.py.step(dt) || moving;
    moving = this.glare.step(dt) || moving;
    moving = this.flip.step(dt) || moving;
    moving = this.flipFade.step(dt) || moving;
    moving = this.foilMix.step(dt) || moving;
    moving = this.reliefMix.step(dt) || moving;
    moving = this.sceneMix.step(dt) || moving;
    const dirty = this.pointerDirty;
    this.pointerDirty = false;
    return moving || dirty;
  }

  /** World-space point-light position for the current state (card width = 1 unit, height = aspect). */
  light(aspect: number, out: Float32Array) {
    const qx = (this.px.x - 0.5) * POINTER_LIGHT_GAIN;
    const qy = -(this.py.x - 0.5) * aspect * POINTER_LIGHT_GAIN;
    const h = this.reducedMotion ? Math.min(this.hover.x, 0.5) : this.hover.x;
    out[0] = REST_LIGHT[0] + (qx - REST_LIGHT[0]) * h;
    out[1] = REST_LIGHT[1] + (qy - REST_LIGHT[1]) * h;
    out[2] = REST_LIGHT[2] + (POINTER_LIGHT_Z - REST_LIGHT[2]) * h;
  }
}

function clamp(x: number, lo: number, hi: number) { return x < lo ? lo : x > hi ? hi : x; }

// ---- device orientation ---------------------------------------------------------------------------

type OrientationListener = (rx: number, ry: number) => void;
let orientationHandler: ((e: DeviceOrientationEvent) => void) | null = null;
const orientationListeners = new Set<OrientationListener>();

/** Whether this platform needs an explicit permission tap (iOS 13+). */
export function deviceOrientationNeedsPermission(): boolean {
  if (typeof window === 'undefined') return false;
  const D = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<'granted' | 'denied'> } | undefined;
  return typeof D?.requestPermission === 'function';
}

/** Request permission (iOS) and start listening; resolves false if unavailable or denied. */
export async function enableDeviceOrientation(listener: OrientationListener): Promise<boolean> {
  if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return false;
  const D = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<'granted' | 'denied'> };
  if (typeof D.requestPermission === 'function') {
    try { if ((await D.requestPermission()) !== 'granted') return false; } catch { return false; }
  }
  orientationListeners.add(listener);
  if (!orientationHandler) {
    let baseBeta: number | null = null;
    orientationHandler = (e) => {
      if (e.beta == null || e.gamma == null) return;
      if (baseBeta == null) baseBeta = e.beta;
      // beta: front/back tilt (-180..180), gamma: left/right (-90..90). Recentre beta on the first reading.
      const rx = clamp((e.beta - baseBeta) * 0.5, -25, 25);
      const ry = clamp(e.gamma * 0.5, -25, 25);
      for (const l of orientationListeners) l(rx, ry);
    };
    window.addEventListener('deviceorientation', orientationHandler);
  }
  return true;
}

export function disableDeviceOrientation(listener: OrientationListener) {
  orientationListeners.delete(listener);
  if (!orientationListeners.size && orientationHandler) {
    window.removeEventListener('deviceorientation', orientationHandler);
    orientationHandler = null;
  }
}
