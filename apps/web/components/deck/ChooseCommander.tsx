'use client';
// Commander decks without a card in the command zone: offer the legendary creatures (and "can be your commander" cards).
import { useMemo } from 'react';
import { canBeCommander } from '@collection/names';
import { formatInfo } from '@/lib/deck/formats';
import type { Entry } from '@/lib/deck/stats';
import { useDeckStore } from '@/lib/stores/deck';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Display';
import { CardRef } from '@/components/shell/CardRef';
import styles from './deck.module.css';

export function ChooseCommander({ format, entries }: { format: string; entries: Entry[] }) {
  const moveCard = useDeckStore(s => s.moveCard);
  const f = formatInfo(format);
  const hasCommander = entries.some(e => e.card.board === 'commander');
  const candidates = useMemo(() => entries.filter(e => e.card.board === 'main' && e.info && canBeCommander({ typeLine: e.info.typeLine, oracleText: e.info.oracleText })), [entries]);
  if (f.value !== 'commander' && f.value !== 'brawl' || hasCommander) return null;
  return (
    <Callout variant="warn" title="No commander chosen" className={styles.callout} data-testid="choose-commander">
      {candidates.length ? (
        <>
          <div>Pick the card that leads this deck; it moves to the command zone.</div>
          <div className={styles.issueCards} style={{ marginLeft: 0, marginTop: 6 }}>
            {candidates.map(e => (
              <span key={e.card.oracleId} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <CardRef name={e.card.name} oracleId={e.card.oracleId} printingId={e.card.printingId ?? e.info?.representativePrintingId} />
                <Button size="sm" onClick={() => moveCard(e.card.oracleId, 'main', 'commander', 1)}>Set as commander</Button>
              </span>
            ))}
          </div>
        </>
      ) : <div>Add a legendary creature, then use its row menu to move it to the command zone.</div>}
    </Callout>
  );
}
