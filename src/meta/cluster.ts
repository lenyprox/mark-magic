// Archetype discovery for unlabeled tournament lists: TF-IDF bag of nonland mainboard cards, cosine similarity,
// average-linkage agglomerative clustering, Goldfish name attachment, per-card distributions and stable ids.
// Pure TypeScript, no I/O; the service feeds it decklists from the store.
import { archetypeKey, slugify } from './normalize.js';
import type { ArchetypeCardStat, ArchetypeProfile, GoldfishArchetype, MetaBoard } from './types.js';

export interface ClusterDeck { id: string; cards: { name: string; count: number; board: MetaBoard; oracleId?: string | null }[]; wins: number | null; losses: number | null; draws: number | null; deckSize: number }
export interface ClusterOptions {
  format: string;
  /** Land test; lands are excluded from the similarity space (they say little about the archetype). */
  isLand: (name: string) => boolean;
  /** Merge clusters while their average-linkage cosine similarity is at least this. */
  threshold?: number;
  /** Clusters smaller than this collapse into "Other". */
  minCluster?: number;
  /** Archetypes of the previous run (id + signature) for id stability. */
  previous?: { id: string; signature: string[] }[];
  /** MTGGoldfish names/shares/sample lists to attach one-to-one. */
  goldfish?: GoldfishArchetype[];
  /** Cap on decks considered (the caller should pass the most recent first). */
  maxDecks?: number;
}
export interface ComputedArchetype {
  id: string; name: string; signature: string[]; share: number; deckCount: number; wins: number; losses: number; winRate: number | null;
  deckSize: 60 | 100; goldfishName: string | null; goldfishShare: number | null; url: string | null; cards: ArchetypeCardStat[]; memberIds: string[]; isOther: boolean;
}
export interface ClusterResult { archetypes: ComputedArchetype[]; assignment: Map<string, string>; vocabulary: number; merges: number }

export const DEFAULT_THRESHOLD = 0.55;
export const DEFAULT_MIN_CLUSTER = 3;
export const GOLDFISH_MATCH_THRESHOLD = 0.5;

type Sparse = Map<number, number>;

interface Space { vocab: string[]; index: Map<string, number>; idf: Float64Array }

function buildSpace(docs: Map<string, number>[]): Space {
  const df = new Map<string, number>();
  for (const d of docs) for (const name of d.keys()) df.set(name, (df.get(name) ?? 0) + 1);
  const vocab = [...df.keys()].sort();
  const index = new Map(vocab.map((v, i) => [v, i]));
  const n = docs.length;
  const idf = new Float64Array(vocab.length);
  vocab.forEach((v, i) => { idf[i] = Math.log((n + 1) / ((df.get(v) ?? 0) + 1)) + 1; });
  return { vocab, index, idf };
}

function vectorize(space: Space, counts: Map<string, number>): Sparse {
  const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
  const v: Sparse = new Map();
  let norm = 0;
  for (const [name, c] of counts) {
    const i = space.index.get(name); if (i == null) continue;
    const w = (c / total) * space.idf[i]; v.set(i, w); norm += w * w;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [i, w] of v) v.set(i, w / norm);
  return v;
}

function dot(a: Sparse, b: Sparse): number {
  if (a.size > b.size) [a, b] = [b, a];
  let s = 0; for (const [i, w] of a) { const x = b.get(i); if (x) s += w * x; }
  return s;
}

function normalize(v: Sparse): Sparse {
  let n = 0; for (const w of v.values()) n += w * w; n = Math.sqrt(n) || 1;
  return new Map([...v].map(([i, w]) => [i, w / n]));
}

function centroid(vectors: Sparse[]): Sparse {
  const c: Sparse = new Map();
  for (const v of vectors) for (const [i, w] of v) c.set(i, (c.get(i) ?? 0) + w / vectors.length);
  return c;
}

/** Average-linkage agglomerative clustering on a similarity matrix; returns member index lists. */
export function agglomerate(n: number, sim: (i: number, j: number) => number, threshold: number): { clusters: number[][]; merges: number } {
  if (n === 0) return { clusters: [], merges: 0 };
  const S = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const s = sim(i, j); S[i * n + j] = s; S[j * n + i] = s; }
  const active = new Array<boolean>(n).fill(true);
  const size = new Array<number>(n).fill(1);
  const members: number[][] = Array.from({ length: n }, (_, i) => [i]);
  const bestJ = new Int32Array(n).fill(-1); const bestS = new Float32Array(n).fill(-1);
  const rescan = (i: number) => {
    let bj = -1, bs = -1;
    for (let k = 0; k < n; k++) if (k !== i && active[k]) { const s = S[i * n + k]; if (s > bs) { bs = s; bj = k; } }
    bestJ[i] = bj; bestS[i] = bs;
  };
  for (let i = 0; i < n; i++) rescan(i);
  let merges = 0;
  for (;;) {
    let bi = -1, bs = -1;
    for (let i = 0; i < n; i++) if (active[i] && bestJ[i] >= 0 && bestS[i] > bs) { bs = bestS[i]; bi = i; }
    if (bi < 0 || bs < threshold) break;
    const bj = bestJ[bi];
    const si = size[bi], sj = size[bj];
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === bi || k === bj) continue;
      const s = (si * S[bi * n + k] + sj * S[bj * n + k]) / (si + sj);
      S[bi * n + k] = s; S[k * n + bi] = s;
    }
    size[bi] = si + sj; active[bj] = false; members[bi].push(...members[bj]); members[bj] = [];
    merges++;
    rescan(bi);
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === bi) continue;
      if (bestJ[k] === bj || bestJ[k] === bi) rescan(k);
      else if (S[bi * n + k] > bestS[k]) { bestS[k] = S[bi * n + k]; bestJ[k] = bi; }
    }
  }
  return { clusters: members.filter((m, i) => active[i] && m.length), merges };
}

const STOP = new Set(['mono', 'deck', 'decks', 'white', 'blue', 'black', 'red', 'green', 'the', 'and', 'with', 'combo', 'control', 'aggro', 'midrange', 'tempo', 'ramp', 'storm', 'burn', 'tribal', 'lands', 'stompy', 'good', 'stuff']);
const nameTokens = (s: string) => new Set(archetypeKey(s).split(' ').filter(t => t.length >= 4 && !STOP.has(t)));

export function clusterDecks(input: ClusterDeck[], opts: ClusterOptions): ClusterResult {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const minCluster = opts.minCluster ?? DEFAULT_MIN_CLUSTER;
  const decks = input.slice(0, opts.maxDecks ?? 2500);
  const docs = decks.map(d => {
    const m = new Map<string, number>();
    for (const c of d.cards) if (c.board !== 'side' && c.count > 0 && !opts.isLand(c.name)) m.set(c.name, (m.get(c.name) ?? 0) + c.count);
    return m;
  });
  const space = buildSpace(docs);
  const vectors = docs.map(d => vectorize(space, d));
  const { clusters, merges } = agglomerate(decks.length, (i, j) => dot(vectors[i], vectors[j]), threshold);

  const big = clusters.filter(c => c.length >= minCluster).sort((a, b) => b.length - a.length);
  const other = clusters.filter(c => c.length < minCluster).flat();
  const groups: { members: number[]; isOther: boolean }[] = big.map(m => ({ members: m, isOther: false }));
  if (other.length) groups.push({ members: other, isOther: true });

  const total = decks.length || 1;
  const drafts = groups.map(g => {
    const cen = centroid(g.members.map(i => vectors[i]));
    const signature = g.isOther ? [] : [...cen].sort((a, b) => b[1] - a[1] || space.vocab[a[0]].localeCompare(space.vocab[b[0]])).slice(0, 3).map(([i]) => space.vocab[i]);
    return { ...g, centroid: normalize(cen), signature, goldfish: null as GoldfishArchetype | null };
  });

  // Goldfish attachment: sample-list similarity first, then name-token overlap; one-to-one either way.
  const gf = (opts.goldfish ?? []).filter(g => g.name);
  const usedGf = new Set<number>();
  const pairs: { c: number; g: number; s: number }[] = [];
  gf.forEach((g, gi) => {
    if (!g.sampleList?.length) return;
    const m = new Map<string, number>();
    for (const c of g.sampleList) if (c.board !== 'side' && !opts.isLand(c.name)) m.set(c.name, (m.get(c.name) ?? 0) + c.count);
    const v = vectorize(space, m);
    drafts.forEach((d, ci) => { if (d.isOther) return; const s = dot(v, d.centroid); if (s >= GOLDFISH_MATCH_THRESHOLD) pairs.push({ c: ci, g: gi, s }); });
  });
  pairs.sort((a, b) => b.s - a.s);
  for (const p of pairs) if (!drafts[p.c].goldfish && !usedGf.has(p.g)) { drafts[p.c].goldfish = gf[p.g]; usedGf.add(p.g); }
  const namePairs: { c: number; g: number; s: number }[] = [];
  gf.forEach((g, gi) => {
    if (usedGf.has(gi)) return;
    const toks = nameTokens(g.name); if (!toks.size) return;
    drafts.forEach((d, ci) => {
      if (d.isOther || d.goldfish) return;
      const hits = d.signature.filter(card => { const ct = nameTokens(card); for (const t of toks) if (ct.has(t)) return true; return false; }).length;
      if (hits) namePairs.push({ c: ci, g: gi, s: hits + (g.share ?? 0) });
    });
  });
  namePairs.sort((a, b) => b.s - a.s);
  for (const p of namePairs) if (!drafts[p.c].goldfish && !usedGf.has(p.g)) { drafts[p.c].goldfish = gf[p.g]; usedGf.add(p.g); }

  // Stable ids: inherit a previous id when >= 2 signature cards overlap (greedy, one-to-one).
  const prev = opts.previous ?? [];
  const taken = new Set<string>();
  const ids = new Array<string | null>(drafts.length).fill(null);
  const overlaps: { c: number; p: number; n: number }[] = [];
  drafts.forEach((d, ci) => { if (d.isOther) return; prev.forEach((p, pi) => { const n = d.signature.filter(s => p.signature.includes(s)).length; if (n >= 2) overlaps.push({ c: ci, p: pi, n }); }); });
  overlaps.sort((a, b) => b.n - a.n);
  const usedPrev = new Set<number>();
  for (const o of overlaps) if (!ids[o.c] && !usedPrev.has(o.p) && !taken.has(prev[o.p].id)) { ids[o.c] = prev[o.p].id; taken.add(prev[o.p].id); usedPrev.add(o.p); }
  const fmt = slugify(opts.format) || 'format';
  drafts.forEach((d, ci) => {
    if (ids[ci]) return;
    let base = d.isOther ? `${fmt}:other` : `${fmt}:${slugify(d.signature.join(' ')) || 'unnamed'}`;
    let id = base; for (let k = 2; taken.has(id); k++) id = `${base}-${k}`;
    ids[ci] = id; taken.add(id); base = id;
  });

  const assignment = new Map<string, string>();
  const archetypes: ComputedArchetype[] = drafts.map((d, ci) => {
    const members = d.members.map(i => decks[i]);
    const id = ids[ci]!;
    for (const m of members) assignment.set(m.id, id);
    const wins = members.reduce((a, m) => a + (m.wins ?? 0), 0);
    const losses = members.reduce((a, m) => a + (m.losses ?? 0), 0);
    const sizes = new Map<number, number>(); for (const m of members) sizes.set(m.deckSize, (sizes.get(m.deckSize) ?? 0) + 1);
    const modeSize = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 60;
    return {
      id, name: d.goldfish?.name ?? (d.isOther ? 'Other' : d.signature.join(' / ')), signature: d.signature,
      share: members.length / total, deckCount: members.length, wins, losses, winRate: wins + losses > 0 ? wins / (wins + losses) : null,
      deckSize: modeSize >= 90 ? 100 : 60, goldfishName: d.goldfish?.name ?? null, goldfishShare: d.goldfish?.share ?? null, url: d.goldfish?.url ?? null,
      cards: cardStats(members), memberIds: members.map(m => m.id), isOther: d.isOther,
    };
  });
  return { archetypes, assignment, vocabulary: space.vocab.length, merges };
}

/** Per board+card: probability of inclusion, expected count and the count histogram (index = copies, values sum to 1). */
export function cardStats(members: ClusterDeck[]): ArchetypeCardStat[] {
  const n = members.length || 1;
  const counts = new Map<string, { name: string; board: MetaBoard; oracleId: string | null; per: number[] }>();
  members.forEach((m, mi) => {
    for (const c of m.cards) {
      const key = `${c.board} ${c.name}`;
      let e = counts.get(key);
      if (!e) { e = { name: c.name, board: c.board, oracleId: c.oracleId ?? null, per: new Array<number>(members.length).fill(0) }; counts.set(key, e); }
      e.per[mi] += c.count; if (!e.oracleId && c.oracleId) e.oracleId = c.oracleId;
    }
  });
  const out: ArchetypeCardStat[] = [];
  for (const e of counts.values()) {
    const max = Math.max(0, ...e.per);
    const hist = new Array<number>(max + 1).fill(0);
    for (const c of e.per) hist[c] += 1 / n;
    const pIn = 1 - hist[0];
    const expectedCount = hist.reduce((a, p, k) => a + p * k, 0);
    out.push({ name: e.name, board: e.board, oracleId: e.oracleId, pIn, expectedCount, countDist: hist.map(p => Math.round(p * 1e6) / 1e6) });
  }
  return out.sort((a, b) => (a.board === b.board ? b.pIn - a.pIn || b.expectedCount - a.expectedCount || a.name.localeCompare(b.name) : a.board < b.board ? -1 : 1));
}

// --- sampling a concrete list from a profile ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function pickWeighted(rng: () => number, weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return Math.floor(rng() * weights.length);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
  return weights.length - 1;
}

function sampleCount(rng: () => number, dist: number[]): number {
  let r = rng(); for (let k = 0; k < dist.length; k++) { r -= dist[k]; if (r <= 0) return k; }
  return dist.length - 1;
}

/**
 * A concrete mainboard for an archetype: a member list (weighted by `weights`, e.g. wins + 1) or, without sample lists, a draw
 * from each card's count distribution. `seen` (name -> copies already observed) is always honoured; the result has exactly
 * profile.deckSize cards.
 */
export function sampleDeckFromProfile(profile: ArchetypeProfile, seen: Record<string, number>, rng: () => number, weights?: number[]): { name: string; count: number }[] {
  const main = profile.cards.filter(c => c.board === 'main');
  const pInOf = new Map(main.map(c => [c.name, c.pIn]));
  const counts = new Map<string, number>();
  const lists = profile.sampleLists ?? [];
  if (lists.length) {
    const w = weights && weights.length === lists.length ? weights : lists.map(() => 1);
    for (const c of lists[pickWeighted(rng, w)]) counts.set(c.name, (counts.get(c.name) ?? 0) + c.count);
  } else {
    for (const c of main) { const k = sampleCount(rng, c.countDist); if (k > 0) counts.set(c.name, k); }
  }
  for (const [name, k] of Object.entries(seen)) if (k > (counts.get(name) ?? 0)) counts.set(name, k);
  const size = () => [...counts.values()].reduce((a, b) => a + b, 0);
  const target = profile.deckSize;
  // Trim: drop copies from cards with the lowest inclusion probability, never below the seen count.
  const trimOrder = () => [...counts.keys()].filter(n => (counts.get(n) ?? 0) > (seen[n] ?? 0)).sort((a, b) => (pInOf.get(a) ?? 0) - (pInOf.get(b) ?? 0));
  let guard = 0;
  while (size() > target && guard++ < 1000) {
    const order = trimOrder(); if (!order.length) break;
    const n = order[0]; const k = counts.get(n)! - 1; if (k > 0) counts.set(n, k); else counts.delete(n);
  }
  // Pad: add copies of the most expected cards (lands and four-ofs first) until the size is reached.
  const padOrder = main.slice().sort((a, b) => b.expectedCount - a.expectedCount || b.pIn - a.pIn);
  guard = 0;
  while (size() < target && guard++ < 1000) {
    const c = padOrder.find(x => (counts.get(x.name) ?? 0) < Math.max(4, Math.ceil(x.expectedCount))) ?? padOrder[0];
    if (!c) break;
    counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  }
  return [...counts].filter(([, k]) => k > 0).map(([name, count]) => ({ name, count }));
}
