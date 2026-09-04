'use client';
// Deck builder callout: how much of the deck is in the registered collection, with the missing list and a bulk-search link.
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { DeckCard } from '@user/decks';
import { useCollection } from '@/lib/collection/useCollection';
import { Callout } from '@/components/ui/Display';
import { CardRef } from '@/components/shell/CardRef';
import styles from '@/components/deck/deck.module.css';

export function CollectionCoverage({ deckId, cards }: { deckId: string; cards: DeckCard[] }) {
  const collection = useCollection();
  const [open, setOpen] = useState(false);
  const cov = useMemo(() => {
    const need = new Map<string, { name: string; need: number; printingId: string | null }>();
    for (const c of cards) { if (c.board === 'maybe') continue; const p = need.get(c.oracleId); if (p) p.need += c.count; else need.set(c.oracleId, { name: c.name, need: c.count, printingId: c.printingId }); }
    let have = 0, total = 0; const missing: { oracleId: string; name: string; need: number; have: number; printingId: string | null }[] = [];
    for (const [oracleId, n] of need) { const h = Math.min(n.need, collection.owned.get(oracleId) ?? 0); have += h; total += n.need; if (h < n.need) missing.push({ oracleId, name: n.name, need: n.need, have: h, printingId: n.printingId }); }
    missing.sort((a, b) => a.name.localeCompare(b.name));
    return { have, total, missing };
  }, [cards, collection.owned]);
  if (!collection.ready || collection.empty || cov.total === 0) return null;
  const full = cov.missing.length === 0;
  const short = cov.missing.reduce((a, m) => a + (m.need - m.have), 0);
  return (
    <Callout variant={full ? 'note' : 'info'} title={full ? `All ${cov.total} cards are in your collection` : `${cov.have} of ${cov.total} cards registered in your collection`} className={styles.callout} data-testid="collection-coverage">
      {!full && (
        <>
          <div>{short} cop{short === 1 ? 'y is' : 'ies are'} not registered. They may still be in your bulk: <Link href={`/collection?missing=${encodeURIComponent(deckId)}`} className="link">check your bulk</Link> to tick them off, or swap them for cards you own.</div>
          <button type="button" className={styles.linkBtn} onClick={() => setOpen(o => !o)} aria-expanded={open}>{open ? 'Hide' : 'Show'} the {cov.missing.length} missing card{cov.missing.length === 1 ? '' : 's'}</button>
          {open && (
            <div className={styles.issueCards} style={{ marginLeft: 0, marginTop: 6 }}>
              {cov.missing.map(m => <span key={m.oracleId}><CardRef name={m.name} oracleId={m.oracleId} printingId={m.printingId ?? undefined} />{m.need > 1 && <span className="faint"> {m.have}/{m.need}</span>}</span>)}
            </div>
          )}
        </>
      )}
    </Callout>
  );
}
