// Formats the builder knows about: label, the Scryfall legality key, deck-size rule and copy limit.
export interface FormatInfo { value: string; label: string; legality: string | null; minSize: number; exactSize?: number; copies: number; meta?: string }

export const FORMATS: FormatInfo[] = [
  { value: 'standard', label: 'Standard', legality: 'standard', minSize: 60, copies: 4, meta: 'Standard' },
  { value: 'pioneer', label: 'Pioneer', legality: 'pioneer', minSize: 60, copies: 4, meta: 'Pioneer' },
  { value: 'modern', label: 'Modern', legality: 'modern', minSize: 60, copies: 4, meta: 'Modern' },
  { value: 'legacy', label: 'Legacy', legality: 'legacy', minSize: 60, copies: 4, meta: 'Legacy' },
  { value: 'vintage', label: 'Vintage', legality: 'vintage', minSize: 60, copies: 4, meta: 'Vintage' },
  { value: 'pauper', label: 'Pauper', legality: 'pauper', minSize: 60, copies: 4, meta: 'Pauper' },
  { value: 'commander', label: 'Commander', legality: 'commander', minSize: 100, exactSize: 100, copies: 1, meta: 'EDH' },
  { value: 'brawl', label: 'Brawl', legality: 'brawl', minSize: 100, exactSize: 100, copies: 1 },
  { value: 'historic', label: 'Historic', legality: 'historic', minSize: 60, copies: 4 },
  { value: 'timeless', label: 'Timeless', legality: 'timeless', minSize: 60, copies: 4 },
  { value: 'alchemy', label: 'Alchemy', legality: 'alchemy', minSize: 60, copies: 4 },
  { value: 'casual', label: 'Casual', legality: null, minSize: 60, copies: 4 },
];

const ALIAS: Record<string, string> = { edh: 'commander', cedh: 'commander', 'commander / edh': 'commander' };

export function formatInfo(format: string | null | undefined): FormatInfo {
  const k = (format ?? 'casual').trim().toLowerCase();
  const v = ALIAS[k] ?? k;
  return FORMATS.find(f => f.value === v) ?? { value: v, label: format || 'Casual', legality: FORMATS.some(f => f.legality === v) ? v : null, minSize: 60, copies: 4 };
}

export const FORMAT_OPTIONS = FORMATS.map(f => ({ value: f.value, label: f.label }));

/** Formats the metagame service can sync. */
export const META_FORMATS = [
  { value: 'Standard', label: 'Standard' }, { value: 'Pioneer', label: 'Pioneer' }, { value: 'Modern', label: 'Modern' },
  { value: 'Legacy', label: 'Legacy' }, { value: 'Vintage', label: 'Vintage' }, { value: 'Pauper', label: 'Pauper' }, { value: 'EDH', label: 'Commander' },
];
