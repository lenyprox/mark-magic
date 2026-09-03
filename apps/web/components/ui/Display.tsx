// Small presentational pieces: Callout, Skeleton, Kbd, Badge, Stat, Meter, EmptyState. Server-safe.
import type { CSSProperties, ReactNode } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Cog, Info, OctagonAlert, SearchX } from 'lucide-react';
import styles from './display.module.css';

export type CalloutVariant = 'note' | 'warn' | 'danger' | 'engine' | 'info';
const CALLOUT_ICON: Record<CalloutVariant, ReactNode> = { note: <Info />, warn: <AlertTriangle />, danger: <OctagonAlert />, engine: <Cog />, info: <Info /> };
export function Callout({ variant = 'note', title, children, className, icon }: { variant?: CalloutVariant; title?: ReactNode; children?: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <div className={clsx(styles.callout, className)} data-variant={variant} role={variant === 'danger' ? 'alert' : undefined}>
      {icon ?? CALLOUT_ICON[variant]}
      <div>
        {title && <div className={styles.calloutTitle}>{title}</div>}
        {children && <div className={styles.calloutBody}>{children}</div>}
      </div>
    </div>
  );
}

export function Skeleton({ kind = 'block', width, height, className, style }: { kind?: 'block' | 'text' | 'card'; width?: number | string; height?: number | string; className?: string; style?: CSSProperties }) {
  return <div aria-hidden className={clsx(styles.skeleton, kind === 'text' && styles.text, kind === 'card' && styles.card, className)} style={{ width, height, ...style }} />;
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={clsx(styles.kbd, className)}>{children}</kbd>;
}

export type BadgeTone = 'neutral' | 'brass' | 'ok' | 'warn' | 'danger' | 'info' | 'mute';
export function Badge({ tone = 'neutral', dot, children, className, title }: { tone?: BadgeTone; dot?: boolean; children: ReactNode; className?: string; title?: string }) {
  return <span className={clsx(styles.badge, className)} data-tone={tone} title={title}>{dot && <span className={styles.badgeDot} />}{children}</span>;
}

export function RarityBadge({ rarity, className }: { rarity: string; className?: string }) {
  return <span className={clsx(styles.badge, styles.rarity, className)} data-rarity={rarity}><span className={styles.badgeDot} />{rarity}</span>;
}

const LEGALITY_TONE: Record<string, BadgeTone> = { legal: 'ok', restricted: 'warn', banned: 'danger', not_legal: 'mute' };
const LEGALITY_LABEL: Record<string, string> = { legal: 'Legal', restricted: 'Restricted', banned: 'Banned', not_legal: 'Not legal' };
export function LegalityBadge({ status, className }: { status: string; className?: string }) {
  return <Badge tone={LEGALITY_TONE[status] ?? 'mute'} className={className}>{LEGALITY_LABEL[status] ?? status}</Badge>;
}

export function Stat({ label, value, unit, size, className }: { label: ReactNode; value: ReactNode; unit?: ReactNode; size?: 'lg'; className?: string }) {
  return (
    <div className={clsx(styles.stat, className)}>
      <span className={styles.statLabel}>{label}</span>
      <span className={clsx(styles.statValue, size === 'lg' && styles.lg)}>{value}{unit && <span className={styles.statUnit}>{unit}</span>}</span>
    </div>
  );
}

/** Odds meter on the brass gradient; value in [0,1]. The gradient is fixed to the full width so the colour reads the value. */
export function Meter({ value, label, showValue = true, className }: { value: number; label: string; showValue?: boolean; className?: string }) {
  const v = Math.max(0, Math.min(1, value));
  const pct = Math.round(v * 1000) / 10;
  const bar = (
    <div className={styles.meter} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${pct}%`}>
      <div className={styles.meterFill} style={{ width: `${pct}%`, backgroundSize: `${v > 0 ? 100 / v : 100}% 100%` }} />
    </div>
  );
  if (!showValue) return <div className={className}>{bar}</div>;
  return <div className={clsx(styles.meterRow, className)}>{bar}<span className={styles.meterValue}>{pct.toFixed(1)}%</span></div>;
}

export function EmptyState({ title, children, actions, icon, className }: { title: ReactNode; children?: ReactNode; actions?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={clsx(styles.empty, className)}>
      {icon ?? <SearchX />}
      <div className={styles.emptyTitle}>{title}</div>
      {children && <div className={styles.emptyBody}>{children}</div>}
      {actions && <div className={styles.emptyActions}>{actions}</div>}
    </div>
  );
}
