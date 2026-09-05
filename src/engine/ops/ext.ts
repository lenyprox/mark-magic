// Typed access to the `ext` bags on GameObject / Player / GameState. Family state lives here so no family ever has to
// add a field to a core type. The contract is JSON-plain: primitives, arrays and plain objects only — no Set, Map,
// Date or class instances — because `clone.ts` deep-copies the bag with `plainCopy` and `serialize.ts` round-trips it
// through JSON. `test/lint-ops.test.ts` forbids Set/Map/Date/class values in an ext write under src/engine/ops, and
// `plainCopy` throws on one that gets there anyway rather than aliasing it into every clone.
import type { Json } from './types.js';

/** Anything carrying an `ext` bag: a GameObject, a Player or the GameState. */
export interface ExtHost { ext?: Record<string, unknown> }

/** Read `host.ext[key]`, or undefined. One property load when the host has no bag (the common case). */
export function extGet<T extends Json>(host: ExtHost, key: string): T | undefined {
  const e = host.ext; return e === undefined ? undefined : e[key] as T | undefined;
}
/** Read `host.ext[key]`, or `fallback` when it is absent. */
export function extGetOr<T extends Json>(host: ExtHost, key: string, fallback: T): T {
  const e = host.ext; if (e === undefined) return fallback;
  const v = e[key]; return v === undefined ? fallback : v as T;
}
/** Is `key` present in the bag? */
export function extHas(host: ExtHost, key: string): boolean { const e = host.ext; return e !== undefined && e[key] !== undefined; }
/** Write `host.ext[key]`, creating the bag. The value must be JSON-plain. */
export function extSet<T extends Json>(host: ExtHost, key: string, value: T): T { (host.ext ??= {})[key] = value; return value; }
/** Remove `host.ext[key]` (and the bag itself once it is empty, so clone and serialize stay on the fast path). */
export function extDel(host: ExtHost, key: string): void {
  const e = host.ext; if (e === undefined) return;
  delete e[key];
  for (const _k in e) { void _k; return; }
  delete host.ext;
}
/** Add `delta` to a numeric ext counter and return the new total (removing it when it reaches zero). */
export function extBump(host: ExtHost, key: string, delta: number): number {
  const n = (extGetOr<number>(host, key, 0)) + delta;
  if (n === 0) extDel(host, key); else extSet(host, key, n);
  return n;
}
/** Push onto a JSON array in the bag (creating it) and return it. */
export function extPush<T extends Json>(host: ExtHost, key: string, value: T): T[] {
  const bag = (host.ext ??= {});
  let a = bag[key] as T[] | undefined;
  if (a === undefined) { a = []; bag[key] = a; }
  a.push(value); return a;
}

/** Whether a value obeys the JSON-plain contract (used by the lints, by `extSet` in the tests and by `plainCopy`). */
export function isJsonPlain(v: unknown): boolean {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'boolean' || t === 'number' || t === 'string') return true;
  if (t !== 'object') return false;
  if (Array.isArray(v)) return (v as unknown[]).every(isJsonPlain);
  const proto = Object.getPrototypeOf(v as object);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const k in v as Record<string, unknown>) if (!isJsonPlain((v as Record<string, unknown>)[k])) return false;
  return true;
}

/** Deep copy of a JSON-plain value: arrays, plain objects and primitives only. Anything else (a Set, a Map, a Date, a
 * class instance, a function) is a contract violation that `clone` would silently alias into every simulated state and
 * `serialize` would drop, so it throws here instead of corrupting an AI search. */
export function plainCopy<T>(v: T): T {
  if (v === null) return v;
  const t = typeof v;
  if (t === 'function') throw new Error('ext must be JSON-plain: a function is not (see src/engine/ops/ext.ts)');
  if (t !== 'object') return v;
  if (Array.isArray(v)) { const out = new Array(v.length); for (let i = 0; i < v.length; i++) out[i] = plainCopy(v[i]); return out as unknown as T; }
  const proto = Object.getPrototypeOf(v as object);
  if (proto !== Object.prototype && proto !== null) throw new Error(`ext must be JSON-plain: ${(v as object).constructor?.name ?? 'this value'} is not (see src/engine/ops/ext.ts)`);
  const out: Record<string, unknown> = {};
  for (const k in v as Record<string, unknown>) out[k] = plainCopy((v as Record<string, unknown>)[k]);
  return out as T;
}

/** Deep copy of an `ext` bag (or undefined when there is none) — what clone.ts calls. */
export function cloneExt(e: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return e === undefined ? undefined : plainCopy(e);
}
