// Manual mana payment helpers for the table's pay tray. The engine already suggests what it will tap for a cast
// (`LegalAction.pay`); these pure functions decide whether the player should be asked to override it, which of
// their permanents count as mana sources, and how a chosen set of sources starts out. No DOM, no engine calls.
import type { ManaSymbol } from '../cards/types.js';
import type { LegalAction } from '../engine/state.js';
import type { CardView, PermanentView, PlayerView } from './view.js';

/** When the pay tray opens for a cast that has a payment suggestion. */
export type AskToPay = 'never' | 'when-ambiguous' | 'always';
export type PaySuggestion = NonNullable<LegalAction['pay']>;

const BASIC_TYPES: Record<string, ManaSymbol> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
const ALL_COLORS: ManaSymbol[] = ['W', 'U', 'B', 'R', 'G'];

/** Colours (and {C}) a card can add, from its basic land types and "Add {X}" text. Empty when it is not a mana source. */
export function manaColorsOf(card: CardView): ManaSymbol[] {
  const out = new Set<ManaSymbol>();
  const typeLine = card.typeLine ?? '';
  for (const [sub, sym] of Object.entries(BASIC_TYPES)) if (new RegExp(`\\b${sub}\\b`).test(typeLine)) out.add(sym);
  const text = card.text ?? '';
  if (/\bAdd\b[^.\n]*\bany (one )?colou?r/i.test(text)) for (const c of ALL_COLORS) out.add(c);
  const re = /\bAdd\b([^.\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) { for (const sym of m[1].matchAll(/\{([WUBRGC])\}/g)) out.add(sym[1] as ManaSymbol); }
  return [...out];
}

/** Whether a permanent can produce mana (a land with basic types, or anything with an "Add" ability). */
export function isManaSource(card: CardView): boolean {
  return manaColorsOf(card).length > 0 || /\bAdd\b/.test(card.text ?? '');
}

/** The `{..}` symbols of a mana cost string, in order (`{1}{G}{G}` → ['1', 'G', 'G']). */
export function costPips(cost: string): string[] {
  return [...(cost ?? '').matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
}

/** The viewer's untapped permanents that can produce mana. */
export function untappedManaSources(p: PlayerView): PermanentView[] {
  return p.battlefield.filter(o => !o.tapped && isManaSource(o));
}

const signature = (c: CardView) => [...manaColorsOf(c)].sort().join('') || '?';

/**
 * Whether the choice of sources matters: some untapped source is left over after the suggested taps and the untapped
 * sources do not all produce the same colours (so an alternative payment would leave different mana available).
 */
export function isAmbiguousPayment(pay: PaySuggestion, p: PlayerView): boolean {
  const sources = untappedManaSources(p);
  const tapped = new Set(pay.taps.map(t => t.id));
  const leftover = sources.filter(o => !tapped.has(o.id));
  if (!leftover.length) return false;
  return new Set(sources.map(signature)).size > 1;
}

/** Whether to open the pay tray before sending a cast with this suggestion. */
export function shouldAskToPay(setting: AskToPay, pay: PaySuggestion | undefined, p: PlayerView): boolean {
  if (!pay || !pay.taps.length) return false;
  if (setting === 'never') return false;
  if (setting === 'always') return true;
  return isAmbiguousPayment(pay, p);
}

/**
 * The sources the tray starts with: the engine's suggestion, with `forced` (the land a card was dropped on) swapped
 * in for a suggested tap that produces something it produces too, or simply added when nothing overlaps.
 */
export function initialSources(pay: PaySuggestion, p: PlayerView, forced?: number): number[] {
  const ids = pay.taps.map(t => t.id);
  if (forced === undefined || ids.includes(forced)) return ids;
  const f = p.battlefield.find(o => o.id === forced);
  if (!f) return ids;
  const fc = new Set(manaColorsOf(f));
  const swap = pay.taps.findIndex(t => t.mana.some(m => fc.has(m)));
  if (swap >= 0) { const out = [...ids]; out[swap] = forced; return out; }
  return [...ids, forced];
}

/** Mana the chosen sources produce at most (one symbol per source, its first colour), for the tray's readout. */
export function producedBy(sources: number[], p: PlayerView): ManaSymbol[] {
  const out: ManaSymbol[] = [];
  for (const id of sources) { const o = p.battlefield.find(x => x.id === id); if (!o) continue; const c = manaColorsOf(o); out.push(c[0] ?? 'C'); }
  return out;
}
