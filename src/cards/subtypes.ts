// The subtype vocabulary: which printed words are subtypes, how their plurals read, and which card type each belongs
// to. `SUBTYPE_KIND` is generated from the pool (scripts/gen-subtypes.mjs → ./subtype-vocab.ts); this file is the
// hand-written lookup on top of it.
//
// A filter parser that treats every word it does not know as a subtype produces filters no object ever matches
// ("creature you control" → You / Control, "Zombies" → Zomby, "Target Elf" → Target / Elf; docs/HANDOFF.md item 22),
// and the card carrying one is then reported as simulated while the ability never fires. Every place a printed word
// becomes a `Filter.subtypes` entry goes through `subtypeWord` instead, and declines the word it cannot place.
import { SUBTYPE_KIND, type SubtypeKind } from './subtype-vocab.js';

export type { SubtypeKind };

const BY_LOWER = new Map<string, string>();
for (const k of Object.keys(SUBTYPE_KIND)) BY_LOWER.set(k.toLowerCase(), k);

/** Plurals English does not form with a suffix. */
const IRREGULAR: Record<string, string> = { mice: 'mouse', oxen: 'ox', geese: 'goose', children: 'child', people: 'human' };

/**
 * The vocabulary form of a printed subtype word, singular or plural, in any case — "Zombies" → "Zombie", "Elves" →
 * "Elf", "Heroes" → "Hero", "Plains" → "Plains", "Loci" → "Locus", "goblin" → "Goblin" — or null when no subtype
 * spells that way ("Target", "Tokens", "You", "Snow", "Legendary").
 */
export function subtypeWord(word: string): string | null {
  const l = word.trim().toLowerCase();
  if (!l) return null;
  const candidates = [IRREGULAR[l] ?? l];
  if (l.endsWith('ies')) candidates.push(l.slice(0, -3) + 'y', l.slice(0, -1));       // Harpies → Harpy, Zombies → Zombie
  if (l.endsWith('ves')) candidates.push(l.slice(0, -3) + 'f', l.slice(0, -3) + 'fe');  // Elves → Elf, Wolves → Wolf
  if (l.endsWith('es')) candidates.push(l.slice(0, -2));                              // Heroes → Hero, Foxes → Fox
  if (l.endsWith('s')) candidates.push(l.slice(0, -1));                               // Goblins → Goblin
  if (l.endsWith('i')) candidates.push(l.slice(0, -1) + 'us');                        // Loci → Locus, Fungi → Fungus
  candidates.push(l + 's');                                                            // "Homunculu", "Locu": a template's `s?` took a real trailing s
  for (const c of candidates) { const hit = BY_LOWER.get(c); if (hit) return hit; }
  return null;
}

/** True when `word` (any case, singular or plural) names a subtype of the pool. */
export function isSubtypeWord(word: string): boolean { return subtypeWord(word) !== null; }

/** The card type a subtype belongs to ("Elf" → Creature, "Aura" → Enchantment, "Forest" → Land), or null for a non-subtype. */
export function subtypeKind(word: string): SubtypeKind | null {
  const w = subtypeWord(word);
  return w ? SUBTYPE_KIND[w] : null;
}
