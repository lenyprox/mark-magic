'use client';
import { useMemo } from 'react';
import { COLOR_NAME, manaSources, sourceCheck, type Entry } from '@/lib/deck/stats';
import { Badge } from '@/components/ui/Display';
import { ManaSymbol } from '@/components/text/ManaSymbol';
import styles from './deck.module.css';
import lib from '@/app/decks/decks.module.css';

const STATUS = { ok: { tone: 'ok', label: 'Fine' }, light: { tone: 'warn', label: 'Light' }, short: { tone: 'danger', label: 'Short' } } as const;

/** Lands' colour production against the pips they need to pay for. */
export function ManaSourceCheck({ entries }: { entries: Entry[] }) {
  const rows = useMemo(() => sourceCheck(entries), [entries]);
  const src = useMemo(() => manaSources(entries), [entries]);
  if (!rows.length) return null;
  const worst = rows.some(r => r.status === 'short') ? 'short' : rows.some(r => r.status === 'light') ? 'light' : 'ok';
  return (
    <div className={styles.sources}>
      <div className={styles.chartTitle}>Mana sources <span className="faint">{src.total} lands</span><Badge tone={STATUS[worst].tone} className={styles.sourcesBadge}>{worst === 'ok' ? 'Sources match pips' : worst === 'light' ? 'Some colours run light' : 'A colour is short on sources'}</Badge></div>
      <table className={lib.table}>
        <thead><tr><th>Colour</th><th className={lib.num}>Pips</th><th className={lib.num}>Share</th><th className={lib.num}>Sources</th><th className={lib.num}>Share</th><th /></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.color}>
              <td><span className={styles.srcColor}><ManaSymbol sym={r.color} size={14} />{COLOR_NAME[r.color]}</span></td>
              <td className="num">{r.pips}</td>
              <td className="num faint">{Math.round(r.pipShare * 100)}%</td>
              <td className="num">{r.sources}</td>
              <td className="num faint">{Math.round(r.sourceShare * 100)}%</td>
              <td><Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
