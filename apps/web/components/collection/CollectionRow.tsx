'use client';
// "Collection" entry on the card page: owned count, where the copies come from, which decks run it, and +/- by hand.
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Minus, Plus } from 'lucide-react';
import { collectionApi } from '@/lib/collection/api';
import { useCollection, useInvalidateCollection } from '@/lib/collection/useCollection';
import { toast } from '@/lib/stores/ui';
import { IconButton } from '@/components/ui/Button';
import { OwnedBadge } from './OwnedBadge';

export function CollectionRow({ oracleId, name, initial, className }: { oracleId: string; name: string; initial: number | null; className?: string }) {
  const collection = useCollection();
  const invalidate = useInvalidateCollection();
  const detail = useQuery({ queryKey: ['collection-detail', oracleId], queryFn: ({ signal }) => collectionApi.detail(oracleId, signal), staleTime: 60_000 });
  const count = detail.data ? detail.data.count : collection.ready ? collection.owned.get(oracleId) ?? 0 : initial;
  const change = async (delta: number) => {
    try {
      const r = await collectionApi.upsert(oracleId, delta);
      await invalidate();
      toast({ title: delta > 0 ? `${name} added to your collection` : `${name} removed from your collection`, body: `Now ${r.owned?.count ?? 0} registered`, kind: 'ok', ttl: 2200 });
    } catch (e) { toast({ title: 'Could not update the collection', body: (e as Error).message, kind: 'danger' }); }
  };
  if (count == null) return null;
  const decks = detail.data?.decks ?? [];
  const sources = detail.data?.sources ?? [];
  return (
    <div className={className} data-testid="collection-row">
      <dt>Collection</dt>
      <dd>
        <OwnedBadge count={count} />
        <span role="group" aria-label={`${name} copies in your collection`} style={{ display: 'inline-flex', gap: 2 }}>
          <IconButton label={`Remove one ${name} from your collection`} size="sm" onClick={() => change(-1)} disabled={!count}><Minus /></IconButton>
          <IconButton label={`Add one ${name} to your collection`} size="sm" onClick={() => change(1)}><Plus /></IconButton>
        </span>
        {sources.length > 0 && <span className="faint small">{sources.map(s => `${s.label ?? s.ref} ×${s.count}`).join(' · ')}</span>}
        {decks.length > 0 && <span className="small">In {decks.map((d, i) => <span key={d.id}>{i > 0 && ', '}<Link href={`/decks/${d.id}`} className="link">{d.name}</Link></span>)}</span>}
      </dd>
    </div>
  );
}
