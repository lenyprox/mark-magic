// Frame geometry for the shader's frame-aware masks. Rects are in card uv (0..1, top-left origin) measured
// against Scryfall's 488x680 `normal` image. `maskFor` picks the whole-card mode for layouts and treatments
// whose art isn't confined to the usual window.

export interface Rect { x0: number; y0: number; x1: number; y1: number }
export interface FrameMask {
  /** 0: whole card is treated uniformly, 1: art / text / title / type rects apply. */
  mode: 0 | 1;
  art: Rect;
  text: Rect;
  title: Rect;
  type: Rect;
  /** Border inset (fraction of the card width) from the trimmed edge to the frame. */
  inset: number;
}

export type FrameKey = '1993' | '1997' | '2003' | '2015' | 'future';

const r = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x0, y0, x1, y1 });

export const FRAME_MASKS: Record<FrameKey, FrameMask> = {
  '2015': { mode: 1, inset: 0.045, title: r(0.06, 0.046, 0.94, 0.098), art: r(0.075, 0.104, 0.925, 0.562), type: r(0.06, 0.566, 0.94, 0.617), text: r(0.075, 0.623, 0.925, 0.905) },
  '2003': { mode: 1, inset: 0.045, title: r(0.06, 0.046, 0.94, 0.096), art: r(0.075, 0.100, 0.925, 0.568), type: r(0.06, 0.572, 0.94, 0.625), text: r(0.075, 0.630, 0.925, 0.915) },
  '1997': { mode: 1, inset: 0.055, title: r(0.09, 0.045, 0.91, 0.092), art: r(0.10, 0.096, 0.90, 0.556), type: r(0.09, 0.560, 0.91, 0.605), text: r(0.10, 0.610, 0.90, 0.900) },
  '1993': { mode: 1, inset: 0.055, title: r(0.10, 0.048, 0.90, 0.095), art: r(0.105, 0.100, 0.895, 0.545), type: r(0.10, 0.550, 0.90, 0.598), text: r(0.105, 0.605, 0.895, 0.900) },
  future: { mode: 1, inset: 0.045, title: r(0.06, 0.046, 0.94, 0.098), art: r(0.075, 0.100, 0.925, 0.585), type: r(0.06, 0.590, 0.94, 0.640), text: r(0.075, 0.645, 0.925, 0.905) },
};

export const WHOLE_CARD: FrameMask = { mode: 0, inset: 0.0, title: r(0, 0, 1, 0), art: r(0, 0, 1, 1), type: r(0, 0, 1, 0), text: r(0, 0, 1, 0) };

/** Layouts whose faces don't use the standard art window. */
const WHOLE_LAYOUTS = new Set(['split', 'saga', 'planeswalker', 'adventure', 'battle', 'class', 'leveler', 'flip', 'mutate', 'case', 'prototype', 'art_series', 'emblem', 'scheme', 'planar', 'vanguard', 'reversible_card']);
/** Frame effects that push the art out of its window. */
const WHOLE_EFFECTS = new Set(['showcase', 'extendedart', 'borderless', 'inverted', 'shatteredglass', 'fullart', 'etched']);

export interface MaskPrinting {
  layout?: string | null;
  frame?: string | null;
  frameEffects?: string[] | null;
  fullArt?: boolean | null;
  textless?: boolean | null;
  borderColor?: string | null;
  /** Face index; back faces of transform cards keep the frame of the front. */
  face?: 0 | 1;
}

export function frameKeyOf(frame: string | null | undefined): FrameKey {
  switch (frame) {
    case '1993': case '1997': case '2003': case '2015': case 'future': return frame;
    default: return '2015';
  }
}

export function maskFor(p: MaskPrinting): FrameMask {
  if (p.fullArt || p.textless) return WHOLE_CARD;
  if (p.borderColor === 'borderless') return WHOLE_CARD;
  if (p.layout && WHOLE_LAYOUTS.has(p.layout)) return WHOLE_CARD;
  for (const fx of p.frameEffects ?? []) if (WHOLE_EFFECTS.has(fx) && fx !== 'etched') return WHOLE_CARD;
  return FRAME_MASKS[frameKeyOf(p.frame)];
}

/** The `uFinish` code for a finish name. */
export function finishCode(finish: string | null | undefined): 0 | 1 | 2 {
  return finish === 'foil' ? 1 : finish === 'etched' ? 2 : 0;
}

/** Default finish for a printing: nonfoil unless the printing has no nonfoil version. */
export function defaultFinish(finishes: readonly string[] | null | undefined): 'nonfoil' | 'foil' | 'etched' {
  const f = finishes ?? [];
  if (!f.length || f.includes('nonfoil')) return 'nonfoil';
  if (f.includes('foil')) return 'foil';
  return 'etched';
}
