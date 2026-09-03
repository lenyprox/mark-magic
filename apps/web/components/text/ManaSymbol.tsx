import type { CSSProperties } from 'react';
import clsx from 'clsx';
import { SYMBOLS } from '@/lib/mana/symbols';
import { splitCost } from '@/lib/text/tokenize';
import styles from './text.module.css';

const SPRITE = '/mana/sprite.svg';

/** One `{…}` symbol from the sprite; unknown symbols fall back to a labelled disc so nothing is ever blank. */
export function ManaSymbol({ sym, size, className, title }: { sym: string; size?: number | string; className?: string; title?: string }) {
  const key = sym.startsWith('{') ? sym : `{${sym}}`;
  const info = SYMBOLS[key];
  const style = size != null ? ({ '--sym': typeof size === 'number' ? `${size}px` : size } as CSSProperties) : undefined;
  const label = title ?? info?.english ?? key;
  if (!info) return <span className={clsx(styles.symText, className)} style={style} role="img" aria-label={label}>{key.slice(1, -1)}</span>;
  return (
    <svg className={clsx(styles.sym, className)} style={style} role="img" aria-label={label}>
      <title>{label}</title>
      <use href={`${SPRITE}#${info.id}`} />
    </svg>
  );
}

/** A full cost like `{2}{W}{W}`; `//` splits multi-face costs. */
export function ManaCost({ cost, size, className }: { cost: string | null | undefined; size?: number | string; className?: string }) {
  if (!cost) return null;
  const parts = cost.split('//').map(p => p.trim());
  const text = cost.replace(/\{([^}]+)\}/g, '$1 ').trim();
  return (
    <span className={clsx(styles.cost, className)} aria-label={`Mana cost ${text}`} role="img">
      {parts.map((p, i) => (
        <span key={i} className={styles.cost} aria-hidden>
          {i > 0 && <span className={styles.slash}>//</span>}
          {splitCost(p).map((s, k) => <ManaSymbol key={k} sym={s} size={size} />)}
        </span>
      ))}
    </span>
  );
}

const COLOR_NAME: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' };
/** Compact colour indicator: coloured discs that each carry their letter (never colour alone). */
export function ColorPips({ colors, size = 14, showColorless = true, className, label = 'Colors' }: { colors: string[]; size?: number; showColorless?: boolean; className?: string; label?: string }) {
  const list = colors.length ? colors : (showColorless ? ['C'] : []);
  if (!list.length) return null;
  const names = list.map(c => COLOR_NAME[c] ?? c).join(', ');
  return (
    <span className={clsx(styles.pips, className)} role="img" aria-label={`${label}: ${names}`} style={{ '--pip': `${size}px` } as CSSProperties}>
      {list.map(c => <span key={c} className={styles.pip} style={{ '--p': `var(--mana-${c})`, '--p-ink': `var(--mana-${c}-ink)` } as CSSProperties} aria-hidden>{c}</span>)}
    </span>
  );
}
