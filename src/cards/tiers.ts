// Pool tiers: which slice of the oracle pool a gate is measured against. The project's denominator is the **paper**
// pool — cards you can hold in your hand in a sanctioned game. Un-sets and other `funny` products, Arena-only
// (digital) cards and the nine ante cards are real cards but separate tiers, so they never count towards "100%".
import type { CardDef } from './types.js';

export type PoolTier = 'all' | 'paper';
export const POOL_TIERS: PoolTier[] = ['all', 'paper'];

/** Ante cards (CR 407, removed from tournament play) are only recognisable from the text. */
const ANTE = /\bante\b/i;

/**
 * The part of a tier that SQL can decide, as a `WHERE` fragment over `oracle_cards` (empty for `all`).
 * `games` is Scryfall's list of the media a card was released on, so "paper" excludes Arena/MTGO-only cards.
 */
export function tierSql(tier: PoolTier): string {
  if (tier !== 'paper') return '';
  return `json_extract(json,'$.set_type') <> 'funny' AND EXISTS (SELECT 1 FROM json_each(oracle_cards.json,'$.games') WHERE value = 'paper')`;
}

/** The rest of the tier, decided once the card is parsed. Must be applied together with `tierSql`. */
export function inTier(def: CardDef, tier: PoolTier): boolean {
  if (tier !== 'paper') return true;
  return !ANTE.test(def.oracleText);
}

/** Parse a `--tier` argument; returns null when it names no tier. */
export function parseTier(value: string | undefined): PoolTier | null {
  if (value === undefined) return 'all';
  return (POOL_TIERS as string[]).includes(value) ? (value as PoolTier) : null;
}
