// GLSL ES 3.00 for the 2.5D scene passes (see scene.ts). All passes work in "t space": the art window with
// x right and y UP in 0..1 (pack textures are uploaded flipped so texel (x, y) = art uv (x, 1 - y)). Scene
// space for lighting: x in -1..1, y in -A..A (A = art height / width), z = (depth - pivot) * uDepthScale with
// +z toward the viewer.
//
//   GEO    grid mesh displaced by depth and sheared by the tilt -> G-buffer (albedo | depth16 + metal/rough |
//          emissive + class). Painted fire is advected along its stroke flow here; far background gets a
//          tilt-driven mip blur (depth of field).
//   LIGHT  full-screen PBR: sphere lights from the pack (+ the pointer), GGX (anisotropic on metal along the
//          blade grain), screen-space shadows, rim from lights behind the figure, skin wrap, water ripples and
//          light columns, fog and smoke -> HDR.
//   RAYS   half-res radial march toward each light over the emissive mask, occluded by nearer geometry, so
//          beams wrap the figure's real silhouette.
//   EMBER  CPU-simulated point sprites, depth-tested against the G-buffer, additive into HDR.
//   POST   heat haze, bloom from the HDR mip chain, rays, ACES tone map -> the card's scene texture.

const COMMON = /* glsl */ `
const float PI = 3.14159265;
float hash1(float n) { return fract(sin(n) * 43758.5453123); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise1(float x) { float i = floor(x); float f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(hash1(i), hash1(i + 1.0), f); }
float vnoise2(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm2(vec2 p) { return 0.5 * vnoise2(p) + 0.3 * vnoise2(p * 2.1 + 3.7) + 0.2 * vnoise2(p * 4.3 + 9.1); }
// 1/f-ish flicker in 0..1 with a slow breath, seeded per light
float flicker(float t, float seed, float amount) {
  float n = 0.5 * vnoise1(t * 1.7 + seed) + 0.3 * vnoise1(t * 4.1 + seed * 3.0) + 0.2 * vnoise1(t * 9.3 + seed * 7.0);
  float breath = 0.06 * sin(t * 0.8 + seed);
  return 1.0 + amount * (n - 0.5) * 1.1 + breath;
}
float decode16(vec3 c) { return (c.r * 255.0 * 256.0 + c.g * 255.0) / 65535.0; }
vec2 encode16(float d) { float v = clamp(d, 0.0, 1.0) * 65535.0; float hi = floor(v / 256.0); float lo = floor(v - hi * 256.0 + 0.5); return vec2(hi, lo) / 255.0; }
`;

export const FS_VERT = /* glsl */ `#version 300 es
precision highp float;
out vec2 vT;
void main() {
  // full-screen triangle
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
  vT = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

// ---- geometry -----------------------------------------------------------------------------------------------

export const GEO_VERT = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
layout(location = 0) in vec2 aPos;          // grid vertex in t space, 0..1
uniform sampler2D uDepth;                    // this layer's depth (RGB8 hi/lo)
uniform float uLayer;                        // 0 background, 1 figure
uniform float uPivot;                        // depth that stays put (figure median)
uniform float uDepthScale;                   // scene z per unit depth
uniform vec2 uShear;                         // camera shear from the tilt (scene x per z)
uniform float uAspect;                       // height / width
uniform float uOverscan;                     // background scale about the centre so shear never shows an edge
uniform vec2 uFigCenter;                     // figure box centre (t space)
uniform float uPop;                          // figure scale-up on hover
out vec2 vUv;
out float vDepth;
void main() {
  vec2 uv = aPos;
  float d = decode16(texture(uDepth, uv).rgb);
  float z = (d - uPivot) * uDepthScale;
  vec2 p = uv * 2.0 - 1.0;
  if (uLayer < 0.5) p *= uOverscan;
  else p = (p - (uFigCenter * 2.0 - 1.0)) * (1.0 + uPop) + (uFigCenter * 2.0 - 1.0);
  p.x += uShear.x * z;
  p.y += uShear.y * z / uAspect;
  vUv = uv;
  vDepth = d;
  gl_Position = vec4(p, -z * 0.8, 1.0);      // nearer = smaller NDC z
}
`;

export const GEO_FRAG = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
in vec2 vUv;
in float vDepth;
layout(location = 0) out vec4 oAlbedo;       // rgb albedo, a layer
layout(location = 1) out vec4 oDepth;        // rg depth16, b metallic, a roughness
layout(location = 2) out vec4 oEmissive;     // rgb emissive, a class/255
uniform sampler2D uColor;
uniform sampler2D uMatte;
uniform sampler2D uMaterial;
uniform sampler2D uFx;
uniform sampler2D uFlow;
uniform float uLayer;
uniform float uTime;
uniform float uFlowSpeed;
uniform float uPivot;
uniform float uDof;                          // mip bias per unit |depth - pivot| (tilt-driven)
uniform float uEmissiveGain;

void main() {
  vec2 uv = vUv;
  float matte = texture(uMatte, uv).r;
  if (uLayer > 0.5 && matte < 0.02) discard;
  vec4 fx = texture(uFx, uv);
  vec3 flow = texture(uFlow, uv).rgb;
  vec2 dir = vec2(flow.r * 2.0 - 1.0, -(flow.g * 2.0 - 1.0));   // image y down -> t space y up
  float coh = flow.b;

  // painted fire / magic flows along its own strokes (two phase-offset samples, blended)
  float adv = (fx.r + 0.6 * fx.a) * coh;
  vec3 albedo;
  float lod = uLayer < 0.5 ? abs(vDepth - uPivot) * uDof : 0.0;
  if (adv > 0.01 && uLayer > 0.5 || adv > 0.01 && uLayer < 0.5) {
    float amp = 0.028 * adv;
    float ph = uTime * uFlowSpeed * (0.35 + 0.65 * coh);
    float t1 = fract(ph), t2 = fract(ph + 0.5);
    vec3 c1 = textureLod(uColor, uv - dir * (t1 - 0.5) * amp, lod).rgb;
    vec3 c2 = textureLod(uColor, uv - dir * (t2 - 0.5) * amp, lod).rgb;
    vec3 c = mix(c1, c2, abs(t1 * 2.0 - 1.0));
    // licking brightness: noise scrolled against the flow
    float n = fbm2(uv * 14.0 - dir * uTime * uFlowSpeed * 0.9 + vec2(0.0, uTime * 0.2));
    c *= 1.0 + adv * 0.55 * (n - 0.45);
    albedo = c;
  } else {
    albedo = textureLod(uColor, uv, lod).rgb;
  }
  // smoke drifts: slow transparency ripple
  if (fx.g > 0.02) {
    float n = fbm2(uv * 6.0 + vec2(uTime * 0.05, uTime * 0.11));
    albedo *= 1.0 + fx.g * 0.18 * (n - 0.5) * 2.0;
  }

  vec4 mat = texture(uMaterial, uv);
  float metallic = mat.r, roughness = mat.g, emissive = mat.b;
  if (uLayer < 0.5) metallic *= 1.0 - matte;       // the filled hole is not the figure's metal
  float lum = dot(albedo, vec3(0.299, 0.587, 0.114));
  vec3 em = albedo * emissive * uEmissiveGain * (0.6 + 0.4 * lum);
  if (fx.r > 0.02) {
    float n = fbm2(uv * 9.0 - vec2(0.0, uTime * 0.7));
    em *= 1.0 + fx.r * 0.6 * (n - 0.5);
  }
  if (fx.a > 0.02) em *= 1.0 + fx.a * 0.35 * sin(uTime * 1.3 + uv.x * 6.0 + uv.y * 4.0);

  oAlbedo = vec4(albedo, uLayer);
  oDepth = vec4(encode16(vDepth), metallic, roughness);
  oEmissive = vec4(em, mat.a);
}
`;

// ---- lighting -----------------------------------------------------------------------------------------------

export const MAX_SCENE_LIGHTS = 5;

export const LIGHT_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${COMMON}
in vec2 vT;
out vec4 oHdr;
uniform sampler2D uGAlbedo;
uniform sampler2D uGDepth;
uniform sampler2D uGEmissive;
uniform sampler2D uMatte;
uniform sampler2D uFx;
uniform sampler2D uFlow;
uniform vec2 uTexel;                         // 1 / target size
uniform float uAspect;
uniform float uPivot;
uniform float uDepthScale;
uniform float uTime;
uniform int uLightCount;
uniform vec4 uLightPos[${MAX_SCENE_LIGHTS}];      // scene xyz, radius
uniform vec4 uLightColor[${MAX_SCENE_LIGHTS}];    // rgb, intensity
uniform vec4 uLightMeta[${MAX_SCENE_LIGHTS}];     // flicker, behind, seed, 1 = pointer light
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uKeyDir;
uniform float uMetal;                        // specular gain
uniform float uRim;
uniform float uShadow;                       // 0..1 shadow strength
uniform float uQuality;                      // 1 high, 0 medium
uniform vec2 uTilt;                          // normalised tilt (t space)
uniform float uHover;

float sceneDepth(vec2 t) { return decode16(texture(uGDepth, t).rgb); }
vec3 scenePos(vec2 t, float d) { return vec3(t.x * 2.0 - 1.0, (t.y * 2.0 - 1.0) * uAspect, (d - uPivot) * uDepthScale); }
vec2 sceneToT(vec3 p) { return vec2(p.x * 0.5 + 0.5, p.y / uAspect * 0.5 + 0.5); }

float ggxD(float NdotH, float a) { float a2 = a * a; float d = NdotH * NdotH * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
float ggxDAniso(float NdotH, float TdotH, float BdotH, float at, float ab) {
  float d = TdotH * TdotH / (at * at) + BdotH * BdotH / (ab * ab) + NdotH * NdotH;
  return 1.0 / (PI * at * ab * d * d);
}
float smithG(float NdotV, float NdotL, float a) {
  float k = a * 0.5;
  return (NdotV / (NdotV * (1.0 - k) + k)) * (NdotL / (NdotL * (1.0 - k) + k));
}

// screen-space shadow: march from P toward the light; nearer geometry along the way blocks it
float shadow(vec3 P, vec3 Lpos, float jitter) {
  const int STEPS = 12;
  int steps = uQuality > 0.5 ? STEPS : 6;
  vec3 dir = Lpos - P;
  float len = length(dir.xy);
  if (len < 1e-4) return 1.0;
  float maxT = min(1.0, 0.35 / len);          // march at most 0.35 scene units
  float occ = 0.0;
  for (int i = 1; i <= STEPS; i++) {
    if (i > steps) break;
    float s = (float(i) - 0.5 + jitter * 0.6) / float(steps) * maxT;
    vec3 q = P + dir * s;
    vec2 t = sceneToT(q);
    if (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) break;
    float dz = (sceneDepth(t) - uPivot) * uDepthScale - q.z;
    if (dz > 0.012) occ = max(occ, smoothstep(0.012, 0.06, dz) * (1.0 - s / maxT * 0.5));
  }
  return 1.0 - occ * uShadow;
}

void main() {
  vec2 t = vT;
  vec4 ga = texture(uGAlbedo, t);
  vec4 gd = texture(uGDepth, t);
  vec4 ge = texture(uGEmissive, t);
  vec3 albedo = ga.rgb;
  float layer = ga.a;
  float d = decode16(gd.rgb);
  float metallic = gd.b, roughness = clamp(gd.a, 0.08, 1.0);
  int cls = int(ge.a * 255.0 + 0.5);
  vec4 fx = texture(uFx, t);
  vec3 flow = texture(uFlow, t).rgb;
  float matte = texture(uMatte, t).r;

  vec3 P = scenePos(t, d);
  vec3 V = normalize(vec3(0.0, 0.0, 3.0) - P);
  // normal from the depth buffer (both texel steps are 2/width in scene units)
  float unit = uDepthScale / (2.0 * uTexel.x);
  float dxp = sceneDepth(t + vec2(uTexel.x, 0.0)), dxm = sceneDepth(t - vec2(uTexel.x, 0.0));
  float dyp = sceneDepth(t + vec2(0.0, uTexel.y)), dym = sceneDepth(t - vec2(0.0, uTexel.y));
  vec3 Ng = normalize(vec3(-(dxp - dxm) * unit * 0.5, -(dyp - dym) * unit * 0.5, 1.0));
  // painted surfaces already carry their own shading: use only part of the derived normal, more on metal
  float nstr = mix(0.35, 0.8, metallic);
  vec3 N = normalize(mix(vec3(0.0, 0.0, 1.0), Ng, nstr));

  // water: ripples along the flow and a lower roughness
  vec2 fdir = vec2(flow.r * 2.0 - 1.0, -(flow.g * 2.0 - 1.0));
  if (fx.b > 0.03) {
    float n1 = vnoise2(t * vec2(34.0, 34.0 * uAspect) + fdir * uTime * 0.45);
    float n2 = vnoise2(t * vec2(53.0, 53.0 * uAspect) - fdir * uTime * 0.3 + 7.0);
    N = normalize(N + fx.b * 0.35 * vec3(n1 - 0.5, n2 - 0.5, 0.0));
    roughness = mix(roughness, 0.12, fx.b);
  }

  float NdotV = max(dot(N, V), 1e-3);
  vec3 F0 = mix(vec3(0.04), albedo, metallic);
  float alpha = roughness * roughness;
  // anisotropy on metal along the stroke grain
  float aniso = metallic * flow.b * 0.7;
  vec3 T = normalize(vec3(fdir, 0.0) - N * dot(vec3(fdir, 0.0), N) + vec3(1e-4, 0.0, 0.0));
  vec3 B = cross(N, T);
  float at = max(alpha * (1.0 + aniso), 0.01), ab = max(alpha * (1.0 - aniso), 0.01);

  // matte edge (for rim / backlight) : gradient of the matte
  float mxp = texture(uMatte, t + vec2(uTexel.x * 2.0, 0.0)).r, mxm = texture(uMatte, t - vec2(uTexel.x * 2.0, 0.0)).r;
  float myp = texture(uMatte, t + vec2(0.0, uTexel.y * 2.0)).r, mym = texture(uMatte, t - vec2(0.0, uTexel.y * 2.0)).r;
  vec2 mg = vec2(mxp - mxm, myp - mym);
  float edge = smoothstep(0.05, 0.5, length(mg)) * layer;
  vec2 edgeDir = normalize(-mg + 1e-5);        // points out of the figure

  // base: the painting itself, plus a little topology from the key light
  float keyRelief = dot(N, normalize(uKeyDir)) - dot(vec3(0.0, 0.0, 1.0), normalize(uKeyDir));
  vec3 col = albedo * (1.0 + 0.22 * keyRelief * (1.0 - metallic * 0.5));
  vec3 lighting = vec3(0.0);
  float jitter = hash2(t * 1024.0 + fract(uTime));

  for (int i = 0; i < ${MAX_SCENE_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    vec4 lp = uLightPos[i];
    vec4 lc = uLightColor[i];
    vec4 lm = uLightMeta[i];
    float fl = flicker(uTime, lm.z, lm.x);
    vec3 Lpos = lp.xyz;
    Lpos.xy += lm.x * 0.012 * (vec2(vnoise1(uTime * 3.1 + lm.z), vnoise1(uTime * 3.4 + lm.z + 7.0)) - 0.5);
    float R = lp.w;
    vec3 Lv = Lpos - P;
    float dist = length(Lv);
    vec3 L = Lv / max(dist, 1e-4);
    float range = lm.w > 0.5 ? 0.035 : 0.12 + R * R;
    float atten = 1.0 / (1.0 + (dist * dist) / range);            // windowed: never brighter than the source
    float I = lc.a * fl * atten;
    vec3 lcol = lc.rgb;
    // sphere light: representative point for the specular lobe
    vec3 r = reflect(-V, N);
    vec3 c2r = dot(Lv, r) * r - Lv;
    vec3 Ls = normalize(Lv + c2r * clamp(R / max(length(c2r), 1e-4), 0.0, 1.0));
    float aP = clamp(alpha + R / (2.0 * max(dist, 1e-3)), 0.0, 1.0);
    float energy = (alpha / aP) * (alpha / aP);
    vec3 H = normalize(Ls + V);
    float NdotL = max(dot(N, L), 0.0);
    float NdotH = max(dot(N, H), 0.0);
    float VdotH = max(dot(V, H), 0.0);
    float sh = 1.0;
    if (lm.w < 0.5 && NdotL > 0.0) sh = shadow(P, Lpos, jitter);
    float wrap = cls == 1 ? 0.5 : 0.0;
    float diffW = max((dot(N, L) + wrap) / (1.0 + wrap), 0.0);
    vec3 F = F0 + (1.0 - F0) * pow(1.0 - VdotH, 5.0);
    float D = aniso > 0.01 ? ggxDAniso(NdotH, dot(T, H), dot(B, H), at, ab) : ggxD(NdotH, alpha);
    float G = smithG(NdotV, max(NdotL, 1e-3), alpha);
    vec3 spec = F * D * G / max(4.0 * NdotV * max(NdotL, 1e-3), 1e-3) * energy * uMetal;
    // painted metal is nearly flat to the camera: a broad brushed lobe keeps it reading as metal
    spec += F * ggxD(NdotH, 0.55) * metallic * 0.35 * uMetal;
    vec3 diff = albedo * (1.0 - metallic) * diffW / PI * (lm.w > 0.5 ? 0.35 : 1.0);   // the pointer light is mostly a highlight
    lighting += (diff + spec * NdotL) * lcol * I * sh;
    // skin: a warm transmission at thin edges
    if (cls == 1) lighting += vec3(0.9, 0.35, 0.2) * edge * I * 0.35 * max(dot(edgeDir, normalize(Lv.xy)), 0.0);
    // rim / backlight: a light behind the figure (or farther than this pixel) outlines it
    float behindHere = max(lm.y, smoothstep(0.0, 0.08, P.z - Lpos.z));
    if (lm.w < 0.5 && behindHere > 0.05) {
      float facing = max(dot(edgeDir, normalize(Lpos.xy - P.xy)), 0.0);
      float rim = edge * pow(facing, 1.5) * behindHere * uRim;
      lighting += lcol * rim * lc.a * fl * 0.7 / (1.0 + dist * dist * 0.5);
    }
    // water: the light's column stretched down the surface
    if (fx.b > 0.03 && lm.w < 0.5) {
      vec2 lt = sceneToT(Lpos);
      float below = lt.y - t.y;
      if (below > 0.0) {
        float column = exp(-pow((t.x - lt.x) * 11.0, 2.0)) * exp(-below * 2.2);
        float n = vnoise2(vec2(t.x * 40.0, t.y * 90.0 - uTime * 0.8));
        lighting += lcol * lc.a * fl * fx.b * column * (0.4 + 0.6 * n) * 0.9;
      }
    }
  }

  col += lighting;
  // metal glint: a bright band sweeps along the blade's grain as the card tilts
  if (metallic > 0.2) {
    vec2 grain = flow.b > 0.15 ? fdir : vec2(0.7, 0.7);
    vec2 across = vec2(-grain.y, grain.x);
    float pos = dot(t - 0.5, across) * 2.0;
    float sweep = uTilt.x * 0.9 - uTilt.y * 0.5;
    float band = exp(-pow((pos - sweep) * 3.2, 2.0));
    float edgeGlint = pow(1.0 - NdotV, 3.0);
    col += metallic * (band * (0.25 + 0.35 * uHover) + edgeGlint * 0.15) * uMetal * vec3(1.0, 0.97, 0.9);
  }
  col += ge.rgb;
  col += uAmbient * 0.02 * (1.0 - layer * 0.5);
  // fog and smoke: the far background sinks into the atmosphere
  float far = clamp(1.0 - d, 0.0, 1.0);
  float f = 1.0 - exp(-uFogDensity * 2.5 * far * far);
  float smoke = fx.g * (0.55 + 0.45 * fbm2(t * 5.0 + vec2(uTime * 0.04, uTime * 0.09)));
  f = clamp(f * 0.22 + smoke * 0.35, 0.0, 0.85);
  col = mix(col, uFogColor * 1.1, f);
  oHdr = vec4(col, 1.0);
}
`;

// ---- volumetric rays ----------------------------------------------------------------------------------------

export const RAYS_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${COMMON}
in vec2 vT;
out vec4 oRays;
uniform sampler2D uGDepth;
uniform sampler2D uGEmissive;
uniform sampler2D uGAlbedo;
uniform sampler2D uFx;
uniform sampler2D uNoise;
uniform vec2 uNoiseScale;
uniform int uLightCount;
uniform vec4 uLightPos[${MAX_SCENE_LIGHTS}];
uniform vec4 uLightColor[${MAX_SCENE_LIGHTS}];
uniform vec4 uLightMeta[${MAX_SCENE_LIGHTS}];
uniform float uAspect;
uniform float uPivot;
uniform float uDepthScale;
uniform float uTime;
uniform float uFogDensity;
uniform float uRays;
uniform float uQuality;

void main() {
  vec2 t = vT;
  float jitter = texture(uNoise, t * uNoiseScale + fract(uTime * 0.37) * 0.5).r;
  vec4 fx = texture(uFx, t);
  float scatter = 0.22 + uFogDensity * 0.5 + fx.g * 0.8;
  vec3 acc = vec3(0.0);
  const int STEPS = 24;
  int steps = uQuality > 0.5 ? STEPS : 12;
  for (int li = 0; li < ${MAX_SCENE_LIGHTS}; li++) {
    if (li >= uLightCount) break;
    vec4 lm = uLightMeta[li];
    if (lm.w > 0.5) continue;                    // the pointer light casts no beams
    vec4 lp = uLightPos[li];
    vec4 lc = uLightColor[li];
    float fl = flicker(uTime, lm.z, lm.x);
    vec2 lt = vec2(lp.x * 0.5 + 0.5, lp.y / uAspect * 0.5 + 0.5);
    lt += lm.x * 0.006 * (vec2(vnoise1(uTime * 3.1 + lm.z), vnoise1(uTime * 3.4 + lm.z + 7.0)) - 0.5);
    float lightZ = lp.z;
    vec2 delta = (lt - t) / float(steps);
    float dist = length(lt - t);
    float decay = 1.0;
    float sum = 0.0;
    float wsum = 0.0;
    vec2 s = t + delta * jitter;
    for (int i = 0; i < STEPS; i++) {
      if (i >= steps) break;
      s += delta;
      if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) break;
      float dz = (decode16(texture(uGDepth, s).rgb) - uPivot) * uDepthScale;
      float occluded = smoothstep(0.0, 0.05, dz - lightZ);        // nearer than the light: blocks it
      vec3 e = texture(uGEmissive, s).rgb;
      float src = dot(e, vec3(0.333)) * (1.0 - occluded);
      // near the light's centre the source is the light itself even if the paint is not tagged emissive
      float core = exp(-pow(length(s - lt) / max(lp.w * 0.5, 0.02), 2.0)) * (1.0 - occluded);
      sum += (src + core * 0.6) * decay;
      wsum += decay;
      decay *= 0.975;
    }
    float beams = pow(sum / max(wsum, 1e-3), 1.6);              // contrast: beams, not haze
    float falloff = 1.0 / (1.0 + dist * dist * 1.5);
    acc += lc.rgb * lc.a * fl * beams * falloff * scatter * 1.8;
  }
  oRays = vec4(acc * uRays, 1.0);
}
`;

// ---- embers -------------------------------------------------------------------------------------------------

export const EMBER_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 aP;             // x, y (t space), z (scene), age 0..1
layout(location = 1) in vec2 aQ;             // size, heat
uniform float uPointScale;                   // px per unit size
uniform vec2 uShear;
uniform float uAspect;
out float vAge;
out float vHeat;
out float vZ;
void main() {
  vec2 p = aP.xy * 2.0 - 1.0;
  p.x += uShear.x * aP.z;
  p.y += uShear.y * aP.z / uAspect;
  vAge = aP.w; vHeat = aQ.y; vZ = aP.z;
  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = max(1.5, aQ.x * uPointScale * (1.0 - 0.5 * aP.w));
}
`;

export const EMBER_FRAG = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
in float vAge;
in float vHeat;
in float vZ;
out vec4 oHdr;
uniform sampler2D uGDepth;
uniform vec2 uTexel;
uniform float uPivot;
uniform float uDepthScale;
uniform vec3 uHot;
uniform vec3 uCool;
uniform float uGain;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  vec2 t = gl_FragCoord.xy * uTexel;
  float sz = (decode16(texture(uGDepth, t).rgb) - uPivot) * uDepthScale;
  if (sz > vZ + 0.01) discard;               // behind the figure
  float a = pow(1.0 - r2, 1.8) * (1.0 - vAge * vAge);
  vec3 col = mix(uCool, uHot, vHeat * (1.0 - vAge * 0.7));
  oHdr = vec4(col * a * uGain * (0.6 + vHeat), 0.0);
}
`;

// ---- post ---------------------------------------------------------------------------------------------------

export const POST_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${COMMON}
in vec2 vT;
out vec4 oColor;
uniform sampler2D uHdr;                      // mipmapped
uniform sampler2D uRaysTex;
uniform sampler2D uFx;
uniform sampler2D uGAlbedo;
uniform sampler2D uGDepth;
uniform sampler2D uGEmissive;
uniform sampler2D uMatte;
uniform sampler2D uMaterial;
uniform sampler2D uFlow;
uniform sampler2D uBg;
uniform float uTime;
uniform float uHaze;
uniform float uGlow;
uniform float uExposure;
uniform int uDebug;
uniform vec2 uTexel;

// Print-preserving tone curve: identity up to the knee, then a soft exponential shoulder for the added light.
vec3 shoulder(vec3 x) {
  const float knee = 0.72, room = 0.28;
  vec3 over = max(x - knee, 0.0);
  return x - over + room * (1.0 - exp(-over / room));
}

void main() {
  vec2 t = vT;
  if (uDebug != 0) {
    vec3 c;
    if (uDebug == 1) c = vec3(decode16(texture(uGDepth, t).rgb));
    else if (uDebug == 2) c = vec3(texture(uMatte, t).r);
    else if (uDebug == 3) c = texture(uBg, t).rgb;
    else if (uDebug == 4) c = texture(uMaterial, t).rgb;
    else if (uDebug == 5) c = texture(uFx, t).rgb + texture(uFx, t).a * vec3(1.0, 0.0, 1.0);
    else if (uDebug == 6) c = texture(uFlow, t).rgb;
    else if (uDebug == 7) c = texture(uRaysTex, t).rgb + texture(uGEmissive, t).rgb;
    else if (uDebug == 9) c = vec3(1.0, 0.0, 1.0);
    else c = texture(uGAlbedo, t).rgb;
    oColor = vec4(c, 1.0);
    return;
  }
  // heat haze: air above painted fire shimmers
  float heat = max(texture(uFx, t - vec2(0.0, 0.03)).r, texture(uFx, t - vec2(0.0, 0.08)).r * 0.7);
  heat = max(heat, texture(uFx, t).r * 0.5) * uHaze;
  vec2 ts = t;
  if (heat > 0.002) {
    vec2 n = vec2(fbm2(t * 22.0 + vec2(0.0, -uTime * 1.6)), fbm2(t * 22.0 + vec2(5.3, -uTime * 1.4) + 3.0)) - 0.5;
    ts += n * 0.012 * heat;
  }
  vec3 hdr = texture(uHdr, ts).rgb;
  vec3 bloom = vec3(0.0);
  float wsum = 0.0;
  for (int i = 1; i <= 4; i++) {
    float lod = float(i);
    float w = 1.0 / (1.0 + lod * 0.6);
    vec2 o = uTexel * exp2(lod) * 0.75;
    vec3 b = textureLod(uHdr, ts + vec2(o.x, o.y), lod).rgb + textureLod(uHdr, ts + vec2(-o.x, o.y), lod).rgb
           + textureLod(uHdr, ts + vec2(o.x, -o.y), lod).rgb + textureLod(uHdr, ts + vec2(-o.x, -o.y), lod).rgb;
    bloom += b * 0.25 * w;
    wsum += w;
  }
  bloom /= wsum;
  // only what is brighter than the paper glows
  bloom = max(bloom - 0.8, 0.0);
  vec3 rays = texture(uRaysTex, ts).rgb;
  vec3 col = hdr + rays + bloom * uGlow;
  col = shoulder(col * uExposure);
  oColor = vec4(col, 1.0);
}
`;
