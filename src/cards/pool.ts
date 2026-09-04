// Pool tiers (plan 1.5). The 100% coverage target is the *paper* pool; the other tiers stay visible in every report
// but are not part of the denominator.
//
//   un      — "funny" sets (Un-sets, Unfinity, Mystery Booster playtest) and the physical-world card types
//             (Attraction / Contraption / Stickers / Hero). Their mechanics are partly outside the game.
//   ante    — cards that play for ante (CR "ante" cards are banned everywhere and are never simulated).
//   digital — Arena-only / Alchemy cards: never printed on paper and never on MTGO.
//   paper   — everything else: the headline pool.
//
// Precedence is un -> ante -> digital -> paper, so a funny ante card counts as `un`.
//
// The classification reads the *representative printing* fields that `master.db`'s `oracle_cards.json` blob already
// carries (`set_type`, `games`, `type_line`, `oracle_text`, `security_stamp`); no schema change to master.db.

export type PoolTier = 'paper' | 'digital' | 'un' | 'ante';

/** Every tier, in report order (headline first). */
export const POOL_TIERS: readonly PoolTier[] = ['paper', 'digital', 'un', 'ante'];

/** The subset of an `oracle_cards` row that `tierOf` looks at. Every field is optional: a caller may pass a whole row. */
export interface PoolRow {
  set_type?: string | null;
  games?: string[] | null;
  type_line?: string | null;
  oracle_text?: string | null;
  /** Scryfall's stamp ('acorn' marks un-cards). Not part of the rule today; accepted so callers can pass whole rows. */
  security_stamp?: string | null;
}

/** Card types that only exist in un-sets / the physical world. Matched against the *card type* half of the type line. */
const UN_CARD_TYPES = new Set(['Attraction', 'Contraption', 'Stickers', 'Sticker', 'Hero']);

const ANTE_RE = /playing for ante/i;

/** The card-type words of a type line: everything left of the em dash (supertypes included). */
export function cardTypeWords(typeLine: string): string[] {
  return (typeLine.split(/\s+[—–]\s+/)[0] ?? '').split(/\s+/).filter(Boolean);
}

/** Classify one oracle row into a pool tier. */
export function tierOf(row: PoolRow): PoolTier {
  if (row.set_type === 'funny' || cardTypeWords(row.type_line ?? '').some(w => UN_CARD_TYPES.has(w))) return 'un';
  if (ANTE_RE.test(row.oracle_text ?? '')) return 'ante';
  const games = row.games ?? [];
  if (!games.includes('paper') && !games.includes('mtgo')) return 'digital';
  return 'paper';
}

/** The headline pool the 100% target is measured against. */
export function isHeadlinePool(tier: PoolTier): boolean { return tier === 'paper'; }

/** Normalise a `--tier` option to a set, or null for "every tier". */
export function tierFilter(tier: PoolTier | PoolTier[] | undefined): Set<PoolTier> | null {
  if (!tier) return null;
  return new Set(Array.isArray(tier) ? tier : [tier]);
}
