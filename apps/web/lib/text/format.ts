export function formatPrice(usd: number | null | undefined): string {
  if (usd == null) return '—';
  return usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`;
}
export function formatCount(n: number): string { return n.toLocaleString('en-US'); }
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
export function yearOf(iso: string | null | undefined): string { return iso ? iso.slice(0, 4) : 'Undated'; }
export const SET_TYPE_LABEL: Record<string, string> = {
  core: 'Core', expansion: 'Expansion', masters: 'Masters', alchemy: 'Alchemy', masterpiece: 'Masterpiece', arsenal: 'Arsenal', from_the_vault: 'From the Vault',
  spellbook: 'Spellbook', premium_deck: 'Premium deck', duel_deck: 'Duel deck', draft_innovation: 'Draft innovation', treasure_chest: 'Treasure chest', commander: 'Commander',
  planechase: 'Planechase', archenemy: 'Archenemy', vanguard: 'Vanguard', funny: 'Un-set', starter: 'Starter', box: 'Box', promo: 'Promo', token: 'Tokens', memorabilia: 'Memorabilia', minigame: 'Minigame', eternal: 'Eternal',
};
export const setTypeLabel = (t: string) => SET_TYPE_LABEL[t] ?? t.replace(/_/g, ' ');
export const FRAME_EFFECT_LABEL: Record<string, string> = {
  legendary: 'Legendary', miracle: 'Miracle', nyxtouched: 'Nyxtouched', draft: 'Draft', devoid: 'Devoid', tombstone: 'Tombstone', colorshifted: 'Colorshifted', inverted: 'Inverted',
  sunmoondfc: 'Sun/moon', compasslanddfc: 'Compass', originpwdfc: 'Origins', mooneldrazidfc: 'Moon/Eldrazi', waxingandwaningmoondfc: 'Moon', showcase: 'Showcase', extendedart: 'Extended art',
  companion: 'Companion', etched: 'Etched', snow: 'Snow', lesson: 'Lesson', shatteredglass: 'Shattered glass', convertdfc: 'Convert', fandfc: 'Fan', upsidedowndfc: 'Upside down', spree: 'Spree',
  fullart: 'Full art', textless: 'Textless', borderless: 'Borderless',
};
