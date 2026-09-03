'use client';
import { useMemo } from 'react';
import type { DeckCard } from '@user/decks';
import type { CardInfo } from '@/lib/deck/useCardInfo';
import { formatInfo } from '@/lib/deck/formats';
import { legalityIssues } from '@/lib/deck/stats';
import { Callout } from '@/components/ui/Display';
import { CardRef } from '@/components/shell/CardRef';
import styles from './deck.module.css';

export function LegalityCheck({ format, cards, info }: { format: string; cards: DeckCard[]; info: CardInfo }) {
  const issues = useMemo(() => legalityIssues(format, cards, info.map), [format, cards, info.map]);
  if (!issues.length) return null;
  const f = formatInfo(format);
  const severe = issues.some(i => i.kind === 'illegal' || i.kind === 'copies');
  return (
    <Callout variant={severe ? 'danger' : 'warn'} title={`Not ready for ${f.label}`} className={styles.callout}>
      <ul className={styles.issueList}>
        {issues.map((i, k) => (
          <li key={k}>
            {i.message}
            {i.cards.length > 0 && <span className={styles.issueCards}>{i.cards.map(c => <CardRef key={c.oracleId} name={c.name} oracleId={c.oracleId} printingId={c.printingId ?? undefined} />)}</span>}
          </li>
        ))}
      </ul>
    </Callout>
  );
}
