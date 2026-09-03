import type { CSSProperties } from 'react';
import clsx from 'clsx';
import { SET_ICON } from '@/lib/mana/sets';
import styles from './text.module.css';

const SPRITE = '/sets/sprite.svg';

/** Set symbol from the sprite, tinted by rarity when given. Falls back to the code in a small box. */
export function SetIcon({ code, rarity, size = 16, className, title }: { code: string; rarity?: string; size?: number; className?: string; title?: string }) {
  const id = SET_ICON[code.toLowerCase()];
  const style = { '--set': `${size}px` } as CSSProperties;
  const label = title ?? code.toUpperCase();
  if (!id) return <span className={clsx(styles.setFallback, className)} style={style} role="img" aria-label={label}>{code.slice(0, 3)}</span>;
  return (
    <svg className={clsx(styles.setIcon, className)} style={style} data-rarity={rarity} role="img" aria-label={label}>
      <title>{label}</title>
      <use href={`${SPRITE}#${id}`} />
    </svg>
  );
}
