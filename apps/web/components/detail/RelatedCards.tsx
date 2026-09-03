'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CardDetail, PrintingDetail } from '@cards/query';
import { api } from '@/lib/api';
import { CardImage } from '@/components/card/CardImage';
import { Segmented } from '@/components/ui/Segmented';
import { Skeleton } from '@/components/ui/Display';
import styles from '@/app/cards/cards.module.css';

export function RelatedCards({ detail, printing }: { detail: CardDetail; printing?: PrintingDetail }) {
  const [mode, setMode] = useState<'set' | 'artist'>('set');
  const artist = printing?.artist ?? null;
  const set = printing?.setCode ?? null;
  const q = useQuery({
    queryKey: ['related', mode, mode === 'set' ? set : artist],
    queryFn: ({ signal }) => mode === 'set' ? api.cards({ set: set!, mode: 'printing', sort: 'edhrec', pageSize: 13 }, signal) : api.cards({ q: `"${artist}"`, mode: 'printing', sort: 'released', pageSize: 13 }, signal),
    enabled: mode === 'set' ? !!set : !!artist,
    staleTime: 5 * 60_000,
  });
  const items = (q.data?.items ?? []).filter(c => c.oracleId !== detail.oracleId).slice(0, 12);
  return (
    <section aria-labelledby="related-h">
      <h2 id="related-h" className={styles.sectionTitle}>
        <span>Also in the vault</span>
        <Segmented<'set' | 'artist'> size="sm" label="Related by" value={mode} onChange={setMode} options={[{ value: 'set', label: printing?.setCode.toUpperCase() ?? 'Set' }, ...(artist ? [{ value: 'artist' as const, label: artist.split(' ').slice(-1)[0] }] : [])]} />
      </h2>
      <div className={styles.related}>
        {q.isPending && Array.from({ length: 6 }, (_, i) => <Skeleton key={i} kind="card" />)}
        {items.map(c => (
          <Link key={c.printingId} href={`/cards/${c.oracleId}?p=${c.printingId}`} className={styles.relatedCard} aria-label={`${c.name}, ${c.typeLine}`}>
            <CardImage printingId={c.printingId} size="normal" alt="" />
          </Link>
        ))}
        {q.isSuccess && items.length === 0 && <p className="faint small">Nothing else to show.</p>}
      </div>
    </section>
  );
}
