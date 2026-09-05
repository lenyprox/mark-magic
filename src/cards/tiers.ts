// CLI-facing pool tiers: the pool tiers of src/cards/pool.ts plus 'all'. The gates that scan the pool (verify:pool,
// fuzz) take `--tier`; the project's denominator is 'paper'. Tier membership itself is decided by pool.ts on the
// parsed row (CardDB.all / allWithTier / tierOf) — there is no SQL half any more.
import { POOL_TIERS as BASE_TIERS, type PoolTier as BasePoolTier } from './pool.js';

export type PoolTier = BasePoolTier | 'all';
export const POOL_TIERS: PoolTier[] = ['all', ...BASE_TIERS];

/** Parse a `--tier` argument; returns null when it names no tier. */
export function parseTier(value: string | undefined): PoolTier | null {
  if (value === undefined) return 'all';
  return (POOL_TIERS as string[]).includes(value) ? (value as PoolTier) : null;
}
