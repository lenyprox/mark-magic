// Pure normal-map synthesis from a card image, shared by the worker and the main-thread fallback.
//
// luminance → two-scale height (0.65·blur σ=1 + 0.35·blur σ=4) → + 0.5·Sobel edge magnitude (frame lines,
// text-box edges become ridges) → normals by central differences (k = 2.5) → pack RG = normal.xy,
// B = height, A = 0.5 + 0.5·edge (kept ≥ 0.5 so premultiplied canvas round-trips don't destroy RGB).

function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + radius] = v; sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

function blur(src: Float32Array, w: number, h: number, sigma: number, tmp: Float32Array, out: Float32Array) {
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) >> 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let j = -r; j <= r; j++) { let xx = x + j; if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1; acc += src[row + xx] * k[j + r]; }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let j = -r; j <= r; j++) { let yy = y + j; if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1; acc += tmp[yy * w + x] * k[j + r]; }
      out[y * w + x] = acc;
    }
  }
}

export interface NormalMapOptions {
  /** Normal steepness multiplier (plan: 2.5). */
  k?: number;
  edgeWeight?: number;
}

/** `rgba` is a W×H RGBA8 buffer (any alpha); returns a W×H RGBA8 packed normal map. */
export function computeNormalMap(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, opts: NormalMapOptions = {}): Uint8ClampedArray<ArrayBuffer> {
  const k = opts.k ?? 2.5;
  const edgeWeight = opts.edgeWeight ?? 0.5;
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) lum[i] = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) / 255;

  const tmp = new Float32Array(n);
  const b1 = new Float32Array(n);
  const b4 = new Float32Array(n);
  blur(lum, w, h, 1, tmp, b1);
  blur(lum, w, h, 4, tmp, b4);

  // Sobel on the lightly blurred luminance (JPEG noise would otherwise become grit).
  const edge = new Float32Array(n);
  const at = (x: number, y: number) => b1[(y < 0 ? 0 : y >= h ? h - 1 : y) * w + (x < 0 ? 0 : x >= w ? w - 1 : x)];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
    const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
    const mag = Math.sqrt(gx * gx + gy * gy) / 4; // ~0..1.4 for a hard step
    edge[y * w + x] = Math.min(1, Math.max(0, mag - 0.05) * 1.8); // soft threshold: JPEG ringing on flat borders stays out
  }

  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) height[i] = Math.min(1, Math.max(0, 0.65 * b1[i] + 0.35 * b4[i] + edgeWeight * edge[i]));

  const out = new Uint8ClampedArray(n * 4);
  const hAt = (x: number, y: number) => height[(y < 0 ? 0 : y >= h ? h - 1 : y) * w + (x < 0 ? 0 : x >= w ? w - 1 : x)];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (hAt(x + 1, y) - hAt(x - 1, y)) * k;
    const dy = (hAt(x, y + 1) - hAt(x, y - 1)) * k;
    const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
    const nx = -dx * inv, ny = -dy * inv;
    const i = y * w + x, p = i * 4;
    out[p] = Math.round((nx * 0.5 + 0.5) * 255);
    out[p + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    out[p + 2] = Math.round(height[i] * 255);
    out[p + 3] = 128 + Math.round(edge[i] * 127);
  }
  return out;
}
