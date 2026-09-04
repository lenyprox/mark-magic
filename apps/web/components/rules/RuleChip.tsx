'use client';
// A small "CR 601.2" chip that opens the rule's text in a popover. The text comes from the bundled excerpt at once
// and is refreshed from /api/rules/[num] (the full Comprehensive Rules when data/rules/cr.json exists).
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { BookMarked } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { lookupExcerpt, sectionTitle, type RuleText } from '@/lib/rules/excerpts';
import styles from './rules.module.css';

export const ATTRIBUTION = 'Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.';

async function fetchRule(num: string): Promise<RuleText> {
  const res = await fetch(`/api/rules/${encodeURIComponent(num)}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) { const ex = lookupExcerpt(num); if (ex) return ex; throw new Error(`rule ${num} not found`); }
  return res.json() as Promise<RuleText>;
}

export function useRuleText(num: string | null) {
  return useQuery({
    queryKey: ['rule', num],
    queryFn: () => fetchRule(num!),
    enabled: !!num,
    staleTime: 24 * 60 * 60_000,
    initialData: num ? (lookupExcerpt(num) ?? undefined) : undefined,
    initialDataUpdatedAt: 0,
  });
}

export function RuleBody({ num, className }: { num: string; className?: string }) {
  const q = useRuleText(num);
  const r = q.data;
  return (
    <div className={clsx(styles.body, className)} data-testid="rule-popover" data-cr={num}>
      <div className={styles.head}>
        <span className={styles.num}>CR {num}</span>
        <span className={styles.section}>{sectionTitle(num)}</span>
      </div>
      {r ? (
        <p className={styles.text}>{r.text}{!r.exact && <span className={styles.note}> (text of rule {num.replace(/[a-z]$/, '')})</span>}</p>
      ) : q.isLoading ? <p className={styles.text}>Loading…</p> : <p className={styles.text}>This rule is not in the bundled excerpt. Run <code>npm run data:cr</code> to fetch the full Comprehensive Rules.</p>}
      <p className={styles.foot}>{r ? `Comprehensive Rules, effective ${r.version}` : 'Comprehensive Rules'} · {ATTRIBUTION}</p>
    </div>
  );
}

export interface RuleChipProps {
  cr: string;
  /** Short word shown before the number (e.g. "triggers"). */
  label?: string;
  size?: 'sm' | 'md';
  className?: string;
  /** Static (no popover), for transient overlays. */
  inert?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function RuleChip({ cr, label, size = 'md', className, inert, onOpenChange }: RuleChipProps) {
  const chip = (
    <button type="button" className={clsx(styles.chip, size === 'sm' && styles.chipSm, inert && styles.chipInert, className)} data-testid="rule-chip" data-cr={cr} aria-label={`Rule ${cr}${label ? ` (${label})` : ''}`} title={`Comprehensive Rules ${cr}`}>
      <BookMarked size={size === 'sm' ? 10 : 12} aria-hidden />
      {label && <span className={styles.chipLabel}>{label}</span>}
      <span className={styles.chipNum}>{cr}</span>
    </button>
  );
  if (inert) return chip;
  return (
    <Popover trigger={chip} placement="bottom-start" plain className={styles.popover} onOpenChange={onOpenChange}>
      <RuleBody num={cr} />
    </Popover>
  );
}
