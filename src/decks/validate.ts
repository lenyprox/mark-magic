// Commander deck validation (CR 903): commander legality (legendary creature or "can be your commander", partner
// pairs, backgrounds, friends forever, Doctor's companion), colour identity, singleton, deck size. Pure: takes the
// deck entries and a def lookup so it runs in Node scripts and in the browser alike.
import type { CardDef, Color } from '../cards/types.js';

export interface DeckEntry { name: string; count: number; board: string }
export interface ValidationIssue { kind: 'commander' | 'identity' | 'singleton' | 'size' | 'missing'; message: string; cards: string[] }

const COLOR_ORDER: Color[] = ['W', 'U', 'B', 'R', 'G'];

/** Whether a card may be a commander on its own (CR 903.3). */
export function canBeCommander(def: Pick<CardDef, 'typeLine' | 'oracleText' | 'supertypes' | 'types'>): boolean {
  const t = def.typeLine.toLowerCase();
  if (/can be your commander/i.test(def.oracleText)) return true;
  return def.supertypes.includes('Legendary') && def.types.includes('Creature') && !/\bbackground\b/.test(t);
}

/** How two cards may share the command zone (CR 702.124, 702.164, 702.175). */
export function partnerKind(def: Pick<CardDef, 'typeLine' | 'oracleText'>): 'partner' | 'partner-with' | 'friends-forever' | 'choose-background' | 'background' | 'doctors-companion' | 'time-lord-doctor' | null {
  const o = def.oracleText;
  if (/\bPartner with\b/i.test(o)) return 'partner-with';
  if (/\bFriends forever\b/i.test(o)) return 'friends-forever';
  if (/\bChoose a Background\b/i.test(o)) return 'choose-background';
  if (/\bBackground\b/.test(def.typeLine) && /Enchantment/.test(def.typeLine)) return 'background';
  if (/\bDoctor's companion\b/i.test(o)) return 'doctors-companion';
  if (/Time Lord Doctor/.test(def.typeLine)) return 'time-lord-doctor';
  if (/(^|\n)Partner(\s*\(|\n|$)/m.test(o)) return 'partner';
  return null;
}

export function colorIdentityOf(defs: CardDef[]): Color[] {
  const set = new Set<Color>();
  for (const d of defs) for (const c of d.colorIdentity ?? d.colors) set.add(c);
  return COLOR_ORDER.filter(c => set.has(c));
}

/** A two-card command zone is legal when the pair is allowed by a partner-style ability. */
export function commanderPairLegal(a: CardDef, b: CardDef): boolean {
  const ka = partnerKind(a), kb = partnerKind(b);
  if (ka === 'partner' && kb === 'partner') return true;
  if (ka === 'friends-forever' && kb === 'friends-forever') return true;
  if (ka === 'partner-with' && kb === 'partner-with') { const named = (d: CardDef) => /Partner with ([^\n(]+)/i.exec(d.oracleText)?.[1]?.trim(); return named(a) === b.name || named(b) === a.name; }
  if ((ka === 'choose-background' && kb === 'background') || (kb === 'choose-background' && ka === 'background')) return true;
  if ((ka === 'time-lord-doctor' && kb === 'doctors-companion') || (kb === 'time-lord-doctor' && ka === 'doctors-companion')) return true;
  return false;
}

export interface ValidateOptions { size?: number; /** allow a missing commander (deck under construction) */ allowNoCommander?: boolean }

/** Issues with a Commander deck. Basic lands and "any number" cards are exempt from singleton. */
export function validateCommanderDeck(entries: DeckEntry[], lookup: (name: string) => CardDef | undefined, opts: ValidateOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const size = opts.size ?? 100;
  const cmdEntries = entries.filter(e => e.board === 'commander');
  const mainEntries = entries.filter(e => e.board === 'main');
  const missing = entries.filter(e => !lookup(e.name)).map(e => e.name);
  if (missing.length) issues.push({ kind: 'missing', message: `${missing.length} card${missing.length === 1 ? '' : 's'} not found`, cards: missing });
  const cmdDefs = cmdEntries.map(e => lookup(e.name)).filter((d): d is CardDef => !!d);
  // commander legality
  if (!cmdDefs.length) { if (!opts.allowNoCommander) issues.push({ kind: 'commander', message: 'No commander chosen', cards: [] }); }
  else {
    const bad = cmdDefs.filter(d => !canBeCommander(d) && partnerKind(d) !== 'background');
    if (bad.length) issues.push({ kind: 'commander', message: `${bad.map(d => d.name).join(' and ')} can't be a commander (legendary creature or "can be your commander" required)`, cards: bad.map(d => d.name) });
    if (cmdDefs.length === 2 && !commanderPairLegal(cmdDefs[0], cmdDefs[1])) issues.push({ kind: 'commander', message: `${cmdDefs[0].name} and ${cmdDefs[1].name} can't share the command zone (partner, partner with, friends forever, background or Doctor's companion needed)`, cards: cmdDefs.map(d => d.name) });
    if (cmdDefs.length > 2) issues.push({ kind: 'commander', message: 'At most two commanders', cards: cmdDefs.map(d => d.name) });
  }
  // colour identity
  const identity = new Set(colorIdentityOf(cmdDefs));
  if (cmdDefs.length) {
    const off = mainEntries.filter(e => { const d = lookup(e.name); return d && (d.colorIdentity ?? d.colors).some(c => !identity.has(c)); }).map(e => e.name);
    if (off.length) issues.push({ kind: 'identity', message: `${off.length} card${off.length === 1 ? '' : 's'} outside the commander's colour identity (${[...identity].join('') || 'colourless'})`, cards: off });
  }
  // singleton
  const totals = new Map<string, number>();
  for (const e of [...mainEntries, ...cmdEntries]) totals.set(e.name, (totals.get(e.name) ?? 0) + e.count);
  const dupes = [...totals].filter(([n, c]) => { const d = lookup(n); if (!d) return false; if (d.supertypes.includes('Basic')) return false; if (/any number of cards named/i.test(d.oracleText)) return false; return c > 1; }).map(([n]) => n);
  if (dupes.length) issues.push({ kind: 'singleton', message: `${dupes.length} card${dupes.length === 1 ? '' : 's'} with more than one copy`, cards: dupes });
  // size
  const total = [...mainEntries, ...cmdEntries].reduce((a, e) => a + e.count, 0);
  if (total !== size) issues.push({ kind: 'size', message: `Commander decks are exactly ${size} cards including the commander (this one has ${total})`, cards: [] });
  return issues;
}
