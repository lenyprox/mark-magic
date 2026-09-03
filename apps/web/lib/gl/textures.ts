// GPU texture management: an LRU per size class for card albedos, a second LRU for normal maps,
// and a procedurally generated blue-noise texture for foil sparkle.

import { imgUrl, type ImageSize } from '@/lib/img';
import { getNormalMap, type NormalMapResult } from './normalmap';

export interface TexEntry {
  tex: WebGLTexture | null;
  width: number;
  height: number;
  lastUse: number;
  status: 'loading' | 'ready' | 'error';
  /** Bumped by the renderer while a live card is bound to this texture, to keep it out of eviction. */
  pinned: number;
}

type Listener = () => void;

class Lru {
  readonly map = new Map<string, TexEntry>();
  constructor(readonly capacity: number) {}
  touch(key: string, now: number) { const e = this.map.get(key); if (e) e.lastUse = now; }
  evict(gl: WebGL2RenderingContext) {
    if (this.map.size <= this.capacity) return;
    const victims = [...this.map.entries()].filter(([, e]) => e.pinned <= 0 && e.status !== 'loading').sort((a, b) => a[1].lastUse - b[1].lastUse);
    let over = this.map.size - this.capacity;
    for (const [k, e] of victims) {
      if (over <= 0) break;
      if (e.tex) gl.deleteTexture(e.tex);
      this.map.delete(k);
      over--;
    }
  }
  clear(gl: WebGL2RenderingContext | null) {
    if (gl) for (const e of this.map.values()) if (e.tex) gl.deleteTexture(e.tex);
    this.map.clear();
  }
}

export class TextureCache {
  private readonly normal = new Lru(96);
  private readonly large = new Lru(8);
  private readonly nmaps = new Lru(96);
  private readonly listeners = new Set<Listener>();
  private anisoExt: EXT_texture_filter_anisotropic | null;
  private maxAniso = 1;
  /** 1x1 flat normal used until a card's map arrives. */
  readonly flatNormal: WebGLTexture;
  readonly noise: WebGLTexture;
  readonly noiseSize = 256;
  private generation = 0;

  constructor(private gl: WebGL2RenderingContext) {
    this.anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
    if (this.anisoExt) this.maxAniso = Math.min(8, gl.getParameter(this.anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number);
    this.flatNormal = this.makeFlatNormal();
    this.noise = this.makeNoise();
  }

  /** Called after a context restore: every entry is stale. */
  reset(gl: WebGL2RenderingContext) {
    this.generation++;
    this.normal.clear(null); this.large.clear(null); this.nmaps.clear(null);
    this.gl = gl;
    this.anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
    (this as { flatNormal: WebGLTexture }).flatNormal = this.makeFlatNormal();
    (this as { noise: WebGLTexture }).noise = this.makeNoise();
  }

  onChange(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  private notify() { for (const l of this.listeners) l(); }

  albedoKey(printingId: string, face: 0 | 1, size: 'normal' | 'large') { return `${printingId}:${face}:${size}`; }

  /** Returns the albedo entry, kicking off a load when missing. */
  albedo(printingId: string, face: 0 | 1, size: 'normal' | 'large', now: number): TexEntry {
    const lru = size === 'large' ? this.large : this.normal;
    const key = this.albedoKey(printingId, face, size);
    let e = lru.map.get(key);
    if (e) { e.lastUse = now; return e; }
    e = { tex: null, width: 0, height: 0, lastUse: now, status: 'loading', pinned: 0 };
    lru.map.set(key, e);
    void this.loadAlbedo(e, printingId, face, size, lru);
    return e;
  }

  /** Returns the normal-map entry for a printing, starting the worker job when missing. */
  normalMap(printingId: string, face: 0 | 1, now: number): TexEntry {
    const key = `${printingId}:${face}`;
    let e = this.nmaps.map.get(key);
    if (e) { e.lastUse = now; return e; }
    e = { tex: null, width: 0, height: 0, lastUse: now, status: 'loading', pinned: 0 };
    this.nmaps.map.set(key, e);
    void this.loadNormalMap(e, printingId, face);
    return e;
  }

  /** Fallback entry when the large variant isn't ready yet: the normal one if present. */
  peekAlbedo(printingId: string, face: 0 | 1, size: 'normal' | 'large'): TexEntry | undefined {
    return (size === 'large' ? this.large : this.normal).map.get(this.albedoKey(printingId, face, size));
  }

  pin(e: TexEntry | undefined, d: 1 | -1) { if (e) e.pinned += d; }

  evict() { this.normal.evict(this.gl); this.large.evict(this.gl); this.nmaps.evict(this.gl); }

  private async loadAlbedo(e: TexEntry, printingId: string, face: 0 | 1, size: ImageSize, lru: Lru) {
    const gen = this.generation;
    try {
      const res = await fetch(imgUrl(printingId, size, face));
      if (!res.ok) throw new Error(`image ${res.status}`);
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'default', premultiplyAlpha: 'none' });
      if (gen !== this.generation || !lru.map.has(this.albedoKey(printingId, face, size as 'normal' | 'large'))) { bmp.close(); return; }
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      if (this.anisoExt) gl.texParameterf(gl.TEXTURE_2D, this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, this.maxAniso);
      e.tex = tex; e.width = bmp.width; e.height = bmp.height; e.status = 'ready';
      bmp.close();
      lru.evict(gl);
    } catch (err) {
      if (gen !== this.generation) return;
      e.status = 'error';
      if (process.env.NODE_ENV !== 'production') console.warn('[CardGL] albedo load failed', printingId, err);
    }
    this.notify();
  }

  private async loadNormalMap(e: TexEntry, printingId: string, face: 0 | 1) {
    const gen = this.generation;
    let result: NormalMapResult | null = null;
    try {
      result = await getNormalMap(printingId, face, 'interactive');
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') console.warn('[CardGL] normal map failed', printingId, err);
    }
    if (gen !== this.generation) { result?.bitmap.close(); return; }
    if (!result) { e.status = 'error'; this.notify(); return; }
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, result.bitmap);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    e.tex = tex; e.width = result.bitmap.width; e.height = result.bitmap.height; e.status = 'ready';
    result.bitmap.close();
    this.nmaps.evict(gl);
    this.notify();
  }

  private makeFlatNormal(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 128]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private makeNoise(): WebGLTexture {
    const gl = this.gl;
    const n = this.noiseSize;
    const data = makeBlueNoise(n);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, n, n, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return tex;
  }
}

/**
 * Procedural tileable blue-noise (high-pass filtered white noise, rank-ordered to a uniform histogram).
 * Deterministic (seeded), ~10 ms for 256x256, so no PNG needs shipping.
 */
export function makeBlueNoise(n: number, seed = 0x9e3779b9): Uint8Array {
  let s = seed >>> 0;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const white = new Float32Array(n * n);
  for (let i = 0; i < white.length; i++) white[i] = rnd();
  // separable gaussian blur (sigma ~1.6) with wrap-around, then subtract to keep only high frequencies
  const k = [0.0045, 0.0540, 0.2420, 0.3990, 0.2420, 0.0540, 0.0045];
  const tmp = new Float32Array(n * n);
  const blur = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let acc = 0; for (let j = -3; j <= 3; j++) acc += white[y * n + ((x + j + n) % n)] * k[j + 3]; tmp[y * n + x] = acc;
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let acc = 0; for (let j = -3; j <= 3; j++) acc += tmp[((y + j + n) % n) * n + x] * k[j + 3]; blur[y * n + x] = acc;
  }
  const hp = new Float32Array(n * n);
  for (let i = 0; i < hp.length; i++) hp[i] = white[i] - blur[i];
  const order = Array.from(hp.keys()).sort((a, b) => hp[a] - hp[b]);
  const out = new Uint8Array(n * n);
  for (let rank = 0; rank < order.length; rank++) out[order[rank]] = Math.floor((rank / order.length) * 256);
  return out;
}
