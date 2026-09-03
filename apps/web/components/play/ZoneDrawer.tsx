'use client';
// Graveyard / exile contents in a drawer.
import type { CardView } from '@play/view';
import { Drawer } from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/Display';
import { CardImage } from '@/components/card/CardImage';
import { CardRef } from '@/components/shell/CardRef';
import styles from './table.module.css';

export function ZoneDrawer({ open, onClose, title, cards }: { open: boolean; onClose: () => void; title: string; cards: CardView[] }) {
  return (
    <Drawer open={open} onClose={onClose} title={`${title} · ${cards.length}`} width={480}>
      {cards.length === 0 ? <EmptyState title="Empty">Nothing here yet.</EmptyState> : (
        <div className={styles.zoneGrid}>
          {[...cards].reverse().map(c => (
            <div key={c.id} className={styles.zoneCard}>
              {c.printingId ? <CardImage printingId={c.printingId} face={c.face} size="normal" alt={c.name} /> : <div className={styles.miniPlaceholder}>{c.name}</div>}
              <CardRef name={c.name} printingId={c.printingId ?? undefined} oracleId={c.oracleId ?? undefined} className={styles.zoneName} />
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}
