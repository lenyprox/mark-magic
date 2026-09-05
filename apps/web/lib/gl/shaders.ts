// GLSL ES 3.00 sources for the card renderer, kept as template strings so no bundler loader is needed.
//
// Vertex: a unit quad scaled to the card's world size, rotated by the pose (tilt / flip / tap) and projected
// with a mild perspective. Fragment: rounded-corner SDF mask, normal-map relief + parallax, frame-aware
// masks, white gloss (Blinn-Phong + GGX + Fresnel rim) for every finish, iridescent foil / etched grating,
// screen-blend composition so the print stays readable, and silhouette darkening at the card's edge.

export const CARD_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;          // unit quad, -0.5..0.5
uniform mat4 uProj;
uniform mat4 uModel;
uniform vec2 uSize;                          // card size in world units (width = 1)
uniform float uMirror;                       // -1 while the back face is showing (flip past 90 deg)
out vec2 vUv;
out vec3 vWorldPos;
out vec3 vNormal;
out vec3 vTangent;
out vec3 vBitangent;
void main() {
  vec4 wp = uModel * vec4(aPos * uSize, 0.0, 1.0);
  vWorldPos = wp.xyz;
  mat3 R = mat3(uModel);
  vNormal = R * vec3(0.0, 0.0, uMirror);
  vTangent = R * vec3(uMirror, 0.0, 0.0);
  vBitangent = R * vec3(0.0, -1.0, 0.0);      // v runs down the card
  vec2 uv = aPos + 0.5;
  uv.y = 1.0 - uv.y;
  if (uMirror < 0.0) uv.x = 1.0 - uv.x;
  vUv = uv;
  gl_Position = uProj * wp;
}
`;

export const CARD_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
in vec3 vWorldPos;
in vec3 vNormal;
in vec3 vTangent;
in vec3 vBitangent;
out vec4 fragColor;

uniform sampler2D uAlbedo;
uniform sampler2D uNormalMap;
uniform sampler2D uNoise;
uniform sampler2D uScene;      // the card's lit 2.5D scene (t space: y up), see scene.ts
uniform float uSceneMix;    // 0..1 how much of the art window shows the scene
uniform vec4 uSceneRect;    // the scene pack's art window in card uv

// per frame
uniform vec3 uLightPos;     // world-space point light (card width = 1 unit)
uniform vec3 uCamPos;
uniform vec2 uPointer;      // pointer in card uv (top-left origin); off-card values are fine
uniform vec2 uTiltVec;      // normalised tilt (-1..1) used to slide bands / sparkle
uniform float uHover;       // 0..1 hover / focus amount
uniform float uFoil;        // foil strength (0 for nonfoil)
uniform float uGlare;       // broad glare amount
uniform float uRelief;      // relief strength multiplier
uniform float uHasNormal;   // 0..1 fade-in of the normal map
uniform float uOpacity;     // crossfade opacity (reduced-motion flips)
uniform float uQuality;     // 1 high, 0 medium (skips parallax + sparkle)
uniform float uNoiseScale;  // noise repeats across the card width

// per bind
uniform int uFinish;        // 0 nonfoil, 1 foil, 2 etched
uniform int uMaskMode;      // 0 whole card, 1 framed (art / text rects apply)
uniform vec4 uArtRect;      // x0 y0 x1 y1 in uv
uniform vec4 uTextRect;
uniform float uRadius;      // corner radius as a fraction of the card width
uniform float uAspect;      // height / width

const float PI = 3.14159265;

float rectMask(vec2 uv, vec4 r, float soft) {
  vec2 a = smoothstep(r.xy - soft, r.xy + soft, uv);
  vec2 b = 1.0 - smoothstep(r.zw - soft, r.zw + soft, uv);
  return a.x * a.y * b.x * b.y;
}
// Cosine iridescence ramp (soft pastel rainbow rather than a hard spectrum).
vec3 palette(float t) {
  return 0.5 + 0.5 * cos(2.0 * PI * (t + vec3(0.0, 0.33, 0.67)));
}
float ggx(float NdotH, float a) {
  float a2 = a * a;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

void main() {
  vec2 uv = vUv;

  // ---- rounded-corner SDF (in card-width units) ----
  vec2 p = (uv - 0.5) * vec2(1.0, uAspect);
  vec2 b = vec2(0.5, 0.5 * uAspect) - uRadius;
  vec2 q = abs(p) - b;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
  float aa = max(fwidth(d), 1e-4);
  float alpha = 1.0 - smoothstep(-aa, aa, d);
  if (alpha <= 0.002) discard;

  vec3 Np = normalize(vNormal);
  vec3 T = normalize(vTangent);
  vec3 B = normalize(vBitangent);
  vec3 V = normalize(uCamPos - vWorldPos);
  vec3 L = normalize(uLightPos - vWorldPos);

  // ---- relief from the normal map (RG normal.xy, B height, A edge in 0.5..1) ----
  vec4 nm = texture(uNormalMap, uv);
  float height = nm.b;
  float edge = max(0.0, nm.a * 2.0 - 1.0) * uHasNormal;
  vec3 nts = vec3((nm.rg * 2.0 - 1.0) * uRelief * uHasNormal, 1.0);
  nts = normalize(nts);
  vec3 N = normalize(T * nts.x + B * nts.y + Np * nts.z);

  // ---- tiny height parallax on the print ----
  vec3 Vts = vec3(dot(V, T), dot(V, B), dot(V, Np));
  vec2 par = Vts.xy / max(Vts.z, 0.35) * (height - 0.5) * 0.0022 * uQuality * uHasNormal;
  vec3 albedo = texture(uAlbedo, uv + par).rgb;
  if (uSceneMix > 0.001) {
    vec2 auv = uv + par;
    vec2 su = (auv - uSceneRect.xy) / (uSceneRect.zw - uSceneRect.xy);
    float inside = rectMask(auv, uSceneRect, 0.0025);
    vec3 sc = texture(uScene, vec2(su.x, 1.0 - su.y)).rgb;
    albedo = mix(albedo, sc, uSceneMix * inside);
  }

  // ---- frame-aware region weights ----
  float wArt = 1.0;
  float wText = 0.0;
  if (uMaskMode == 1) {
    wArt = rectMask(uv, uArtRect, 0.004);
    wText = rectMask(uv, uTextRect, 0.004);
  }

  // ---- lighting terms ----
  vec3 H = normalize(L + V);
  float NdotL = max(dot(N, L), 0.0);
  float NdotH = max(dot(N, H), 0.0);
  float NdotV = max(dot(N, V), 0.0);
  float NpL = max(dot(Np, L), 0.0);
  float NpH = max(dot(Np, H), 0.0);
  float NpV = max(dot(Np, V), 0.0);

  // Relief-only diffuse modulation (normalised against the flat plane so the print keeps its colour).
  vec3 col = albedo * (1.0 + 0.36 * (NdotL - NpL));

  // White gloss for every finish: a broad Blinn-Phong lobe, a tighter GGX lobe, and a Fresnel rim.
  float fres = 0.04 + 0.96 * pow(1.0 - NdotV, 5.0);
  float gloss = 0.20 * pow(NdotH, 40.0) + 0.035 * pow(NdotH, 6.0) + 0.03 * ggx(NdotH, 0.30) * (0.25 + 0.75 * fres * 8.0);
  gloss *= (1.0 + 1.2 * edge);
  gloss *= mix(0.9, 1.0, wArt);                          // the art window is the glossiest print
  gloss *= mix(1.0, 0.75, wText);                        // the text box is matte-ish so rules stay readable
  gloss *= 0.55 + 0.45 * uHover;
  float glare = uGlare * 0.09 * pow(NpH, 12.0) * mix(1.0, 0.7, wText);
  float rim = 0.10 * pow(1.0 - NpV, 4.0);

  vec3 sheen = vec3(0.0);
  if (uFinish == 1) {
    // ---- foil: iridescent sheen from N.H, diagonal bands and height, boosted on ridges ----
    float band = sin((uv.x * 1.3 - uv.y * uAspect * 0.9) * 5.5 + (uTiltVec.x - uTiltVec.y) * 1.8);
    float t = NdotH * 1.1 + band * 0.22 + height * 0.25 + uv.y * 0.30 + uTiltVec.y * 0.12;
    vec3 iri = mix(palette(t), vec3(1.0), 0.22);
    float lobe = 0.48 * pow(NdotH, 7.0) + 0.07 * pow(NdotH, 2.0) + 0.05 * ggx(NdotH, 0.40);
    lobe *= 0.75 + 0.7 * edge;
    // blue-noise sparkle under the pointer, twinkling with the tilt
    vec2 nuv = uv * vec2(uNoiseScale, uNoiseScale * uAspect) + uTiltVec * 0.31;
    float n = texture(uNoise, nuv).r;
    vec2 dp = (uv - uPointer) * vec2(1.0, uAspect);
    float near = exp(-dot(dp, dp) * 22.0);
    float spark = smoothstep(0.96, 1.0, n) * pow(NdotH, 12.0) * near * 1.2 * uQuality;
    sheen = iri * lobe + vec3(spark) * mix(vec3(1.0), iri, 0.5);
    sheen *= uFoil * (0.5 + 0.5 * uHover);
    sheen *= mix(1.0, 0.5, wText);                       // keep rules text readable
  } else if (uFinish == 2) {
    // ---- etched: fine cross-hatch grating (full outside the art window, 30% inside) ----
    vec2 cp = uv * vec2(1.0, uAspect);
    vec2 d1 = normalize(vec2(1.0, 0.62));
    vec2 d2 = normalize(vec2(-1.0, 0.62));
    float shift = dot(H, T) * 26.0 + dot(H, B) * 14.0;   // lines glint as the light passes over them
    float ph1 = dot(cp, d1) * 72.0 * 2.0 * PI + shift;
    float ph2 = dot(cp, d2) * 72.0 * 2.0 * PI - shift;
    float fw = max(fwidth(ph1), fwidth(ph2));
    float atten = 1.0 - smoothstep(2.2, 4.8, fw);        // fade the grating instead of aliasing
    float g = 0.5 + (0.25 * sin(ph1) + 0.25 * sin(ph2)) * atten;
    float amp = mix(1.0, 0.3, wArt);
    float grating = mix(0.5, g, amp);
    float lobe = 0.30 * pow(NdotH, 6.0) + 0.06 * pow(NdotH, 2.0) + 0.04 * ggx(NdotH, 0.45);
    vec3 tint = mix(vec3(1.0, 0.96, 0.88), palette(NdotH * 0.9 + height * 0.3 + uv.y * 0.2 + uTiltVec.x * 0.1), 0.22);
    sheen = tint * lobe * (0.3 + 1.4 * grating) * (0.8 + 0.6 * edge);
    sheen *= uFoil * (0.5 + 0.5 * uHover);
    sheen *= mix(1.0, 0.6, wText);
  }

  // ---- compose: screen-blend the light on top of the print ----
  vec3 add = vec3(gloss + glare + rim) + sheen;
  add = min(add, vec3(0.78));
  col = 1.0 - (1.0 - col) * (1.0 - add);

  // ---- silhouette darkening: receding faces dim, plus a dark physical rim at the border ----
  col *= 0.86 + 0.14 * NpL;
  float rimDark = smoothstep(-0.012, 0.0, d);
  col *= 1.0 - 0.32 * rimDark;

  float a = alpha * uOpacity;
  fragColor = vec4(col * a, a);
}
`;
