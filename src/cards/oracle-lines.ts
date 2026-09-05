// Oracle-line normalisation shared by the parser (src/cards/parse.ts) and the script layer (src/cards/scripts.ts):
// the transformation `parseCard` applies before it splits a card into lines (card name -> `~`, reminder text dropped,
// ability words and flavour heads stripped), and the second face of a split / adventure / flip card as a list of such
// lines. One module so the two can never drift: a `covers` / `ignore` entry in a script is compared to exactly what
// the parser saw, and the parser records the second face's lines in `unparsed` in exactly the form the script
// accounting (`secondFaceUnclaimed`) expects. Nothing here imports parse.ts or scripts.ts.

/** Ability words carry no rules meaning (CR 207.2c); the parser strips them. */
export const ABILITY_WORD_RE = /^(Revolt|Converge|Delirium|Metalcraft|Threshold|Landfall|Domain|Morbid|Raid|Ferocious|Formidable|Hellbent|Spell mastery|Flurry|Imprint|Constellation|Coven|Magecraft|Pack tactics|Alliance|Celebration|Valiant|Eerie|Survival|Paradox|Corrupted|Fateful hour|Lieutenant|Undergrowth|Enrage|Adamant|Addendum|Kinship|Chroma|Grandeur|Radiance|Parley|Descend \d+|Fathomless descent|Max speed|Heist|Mayhem|Job select|Renew|Endure|Exhaust|Mobilize|Harmonize|Behold|Channel|Battalion|Heroic|Inspired|Bloodrush|Strive|Tempting offer|Will of the council|Council's dilemma|Secret council|Cohort|Rally|Sweep|Join forces|Hero's reward|Undaunted|Legacy|Eminence|Start your engines!) — /i;

/** A flavour head ("Cure Wounds — You gain 2 life."): the name before the em dash is not rules text. */
export const FLAVOUR_PREFIX_RE = /^(?![IVX]+ — )[A-Z0-9][^—.]{0,30} — (?=When\b|Whenever\b|At |\{|[A-Z])/;

/** Normalise a whole oracle text the way `parseCard` does: card name -> `~`, reminder text dropped, `−` -> `-`. */
export function normalizeOracleText(text: string, cardName: string): string {
  const shortName = cardName.split(' // ')[0];
  const nick = shortName.includes(',') ? shortName.split(',')[0] : null;
  const escaped = shortName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let norm = text.replace(new RegExp(escaped, 'g'), '~');
  if (nick) norm = norm.replace(new RegExp(nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w])', 'g'), '~');
  norm = norm.replace(/\bthis (creature|permanent|artifact|enchantment|land|spell|planeswalker|saga|vehicle|aura|equipment|card)\b/gi, '~').replace(/\(([^)]*)\)/g, '').replace(/−/g, '-');
  const cut = norm.split('\n');
  const back = cut.findIndex(l => l.trim().startsWith('//'));
  return back >= 0 ? cut.slice(0, back).join('\n') : norm;
}

/** Strip the per-line prefixes the parser removes before it matches a line (ability words, "Foo — " flavour heads). */
export function normalizeOracleLine(line: string): string {
  return line.trim().replace(ABILITY_WORD_RE, '').replace(FLAVOUR_PREFIX_RE, '').trim();
}

/** Layouts whose `faces[1]` carries castable / playable text that the parser does not simulate (it parses `faces[0]` only). */
export const SECOND_FACE_LAYOUTS: readonly string[] = ['split', 'adventure', 'flip'];

/**
 * The second face's oracle lines, normalised against the SECOND face's own name ("Stomp deals 2 damage to any
 * target." reads as "~ deals 2 damage to any target."), deduplicated, bullets dropped. Empty for every other layout.
 * `parseCard` records these in `def.unparsed` (the engine cannot cast that half) and `secondFaceLines` in scripts.ts
 * is the same list, so the two accountings agree line for line.
 */
export function secondFaceLinesOf(layout: string, face: { name: string; oracleText: string | null | undefined } | undefined): string[] {
  if (!SECOND_FACE_LAYOUTS.includes(layout) || !face || !(face.oracleText ?? '').trim()) return [];
  const out: string[] = [];
  for (const raw of normalizeOracleText(face.oracleText!, face.name).split('\n')) {
    const l = normalizeOracleLine(raw);
    if (l && !l.startsWith('• ') && !out.includes(l)) out.push(l);
  }
  return out;
}
