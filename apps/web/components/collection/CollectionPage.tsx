'use client';
// /collection: headline numbers, breakdowns, import sources, the owned table, and the "check your bulk" list for a deck.
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Minus, Package, Plus, Search, Trash2, Upload } from 'lucide-react';
import type { CollectionSummary } from '@/lib/collection/api';
import { collectionApi } from '@/lib/collection/api';
import { COLLECTION_KEY, useInvalidateCollection } from '@/lib/collection/useCollection';
import { formatCount, formatPrice } from '@/lib/text/format';
import { toast } from '@/lib/stores/ui';
import { Button, IconButton } from '@/components/ui/Button';
import { SearchInput } from '@/components/ui/Input';
import { Badge, Callout, EmptyState, Skeleton, Stat } from '@/components/ui/Display';
import { ColorPips } from '@/components/text/ManaSymbol';
import { CardRef } from '@/components/shell/CardRef';
import { ImportCollectionDialog } from './ImportCollectionDialog';
import styles from './collection.module.css';

const PAGE = 120;

export function CollectionPage({ initialSummary, missingDeckId }: { initialSummary: CollectionSummary | null; missingDeckId: string | null }) {
  const [importOpen, setImportOpen] = useState(false);
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  const invalidate = useInvalidateCollection();
  const list = useQuery({ queryKey: COLLECTION_KEY, queryFn: ({ signal }) => collectionApi.list(undefined, signal), staleTime: 60_000 });
  const stats = useQuery({ queryKey: ['collection-stats'], queryFn: ({ signal }) => collectionApi.stats(signal), staleTime: 60_000, enabled: !!list.data && list.data.summary.distinct > 0 });
  const coverage = useQuery({ queryKey: ['collection-coverage', missingDeckId], queryFn: ({ signal }) => collectionApi.coverage(missingDeckId!, signal), enabled: !!missingDeckId, staleTime: 30_000 });
  const summary = list.data?.summary ?? initialSummary;
  const empty = !summary || summary.distinct === 0;
  const rows = useMemo(() => {
    const all = list.data?.cards ?? [];
    const s = q.trim().toLowerCase();
    return s ? all.filter(c => c.name.toLowerCase().includes(s)) : all;
  }, [list.data, q]);
  const [confirmSource, setConfirmSource] = useState<string | null>(null);

  const bump = async (oracleId: string, name: string, delta: number) => {
    try { await collectionApi.upsert(oracleId, delta); await invalidate(); }
    catch (e) { toast({ title: `Could not update ${name}`, body: (e as Error).message, kind: 'danger' }); }
  };
  const importBundled = async () => {
    try {
      const r = await collectionApi.import({ bundled: true, asDecks: true, format: 'commander' });
      await invalidate();
      toast({ title: `Imported ${r.results?.length ?? 0} file${r.results?.length === 1 ? '' : 's'}`, body: `${r.summary.distinct} distinct cards, ${r.summary.copies} copies`, kind: 'ok' });
    } catch (e) { toast({ title: 'Import failed', body: (e as Error).message, kind: 'danger' }); }
  };
  const removeSource = async (id: string, label: string) => {
    try { await collectionApi.removeSource(id); setConfirmSource(null); await invalidate(); toast({ title: `Removed ${label}`, kind: 'ok', ttl: 2500 }); }
    catch (e) { toast({ title: 'Could not remove the source', body: (e as Error).message, kind: 'danger' }); }
  };

  return (
    <div className={styles.page} data-testid="collection-page">
      <div className={styles.head}>
        <div>
          <h1>Collection</h1>
          <p className={styles.lede}>The cards you have registered. Everything that shows a card can tell you whether you own it, and the deck optimiser builds only from here (flagging what to dig out of your bulk).</p>
        </div>
        <div className={styles.actions}>
          <Button variant="primary" icon={<Upload size={14} />} onClick={() => setImportOpen(true)} data-testid="collection-import">Import…</Button>
          {!empty && <a className="link small" href={collectionApi.exportUrl('csv')} download><Download size={13} style={{ verticalAlign: '-2px' }} /> Export CSV</a>}
          {!empty && <Link className="link small" href="/cards?own=1"><Search size={13} style={{ verticalAlign: '-2px' }} /> Browse owned</Link>}
        </div>
      </div>

      {missingDeckId && (
        <section className={styles.panel} aria-label="Check your bulk" data-testid="bulk-check">
          <h2>Check your bulk {coverage.data && <small>{coverage.data.deck.name}</small>}</h2>
          {coverage.isPending && <Skeleton kind="text" width="40%" />}
          {coverage.isError && <Callout variant="danger" title="Could not load the deck">{(coverage.error as Error).message}</Callout>}
          {coverage.data && (coverage.data.missing.length === 0 ? (
            <Callout variant="note" title="Every card in this deck is registered" />
          ) : (
            <>
              <p className="small muted">{coverage.data.missing.length} card{coverage.data.missing.length === 1 ? '' : 's'} in <Link href={`/decks/${coverage.data.deck.id}`} className="link">{coverage.data.deck.name}</Link> are not registered. If you find one in your bulk, tick it off and it joins the collection.</p>
              <div className={styles.missing}>
                {coverage.data.missing.map(m => (
                  <div key={m.oracleId} className={styles.missingRow}>
                    <span><CardRef name={m.name} oracleId={m.oracleId} /></span>
                    <span className={styles.mono}>{m.have}/{m.need}</span>
                    <Button size="sm" icon={<Plus size={13} />} onClick={() => bump(m.oracleId, m.name, m.need - m.have)}>Found {m.need - m.have > 1 ? `${m.need - m.have}` : 'it'}</Button>
                  </div>
                ))}
              </div>
            </>
          ))}
        </section>
      )}

      {empty ? (
        <EmptyState title="No cards registered yet" icon={<Package />} actions={<><Button variant="primary" icon={<Upload size={14} />} onClick={() => setImportOpen(true)}>Import files</Button><Button onClick={importBundled} data-testid="import-bundled">Import the bundled decks/*.csv</Button></>}>
          Drop in a <code>count,name</code> CSV per deck, a Moxfield or Archidekt export, or an Arena list. Each file becomes a source you can remove again.
        </EmptyState>
      ) : (
        <>
          <div className={styles.stats}>
            <Stat className={styles.statCard} label="Distinct cards" value={formatCount(summary!.distinct)} size="lg" />
            <Stat className={styles.statCard} label="Copies" value={formatCount(summary!.copies)} size="lg" />
            <Stat className={styles.statCard} label="Sources" value={summary!.sources} unit={summary!.decks ? ` · ${summary!.decks} decks` : undefined} size="lg" />
            <Stat className={styles.statCard} label="Value" value={stats.data?.valueUsd == null ? (stats.isPending ? '…' : '—') : formatPrice(stats.data.valueUsd)} unit={stats.data?.valueUsd != null ? ' USD' : undefined} size="lg" />
          </div>

          <div className={styles.breakdown}>
            <section className={styles.panel} aria-label="By colour identity">
              <h2>By colour identity</h2>
              <div className={styles.pillRow}>
                {(stats.data?.byIdentity ?? []).map(b => <span key={b.identity} className={styles.pill}>{b.identity === 'C' ? <span>Colorless</span> : <ColorPips colors={b.identity.split('')} size={12} label={b.identity} />}<b>{b.copies}</b></span>)}
                {stats.isPending && <Skeleton kind="text" width="60%" />}
              </div>
            </section>
            <section className={styles.panel} aria-label="By type">
              <h2>By type</h2>
              <div className={styles.pillRow}>
                {(stats.data?.byType ?? []).map(b => <span key={b.type} className={styles.pill}>{b.type}<b>{b.copies}</b></span>)}
              </div>
            </section>
            <section className={styles.panel} aria-label="Sources">
              <h2>Sources <small>{list.data?.sources.length ?? 0}</small></h2>
              <div className={styles.sources}>
                {(list.data?.sources ?? []).map(s => (
                  <div key={s.id} className={styles.source}>
                    <div className={styles.sourceMain}>
                      <b>{s.label ?? s.ref}</b>
                      <span>{s.kind} · {s.ref}{s.deckId && <> · <Link href={`/decks/${s.deckId}`} className="link">deck</Link></>}{s.unresolved.length > 0 && <> · <Badge tone="warn">{s.unresolved.length} unresolved</Badge></>}</span>
                    </div>
                    <span className={styles.sourceNums}>{s.rows} rows · {s.copies} copies</span>
                    {confirmSource === s.id ? (
                      <span style={{ display: 'inline-flex', gap: 4 }}><Button size="sm" variant="danger" onClick={() => removeSource(s.id, s.label ?? s.ref)}>Remove</Button><Button size="sm" variant="ghost" onClick={() => setConfirmSource(null)}>Keep</Button></span>
                    ) : <IconButton label={`Remove ${s.label ?? s.ref} from the collection`} size="sm" onClick={() => setConfirmSource(s.id)}><Trash2 /></IconButton>}
                  </div>
                ))}
              </div>
            </section>
          </div>

          <section className={styles.tableWrap} aria-label="Owned cards">
            <div className={styles.tableHead}>
              <SearchInput value={q} onChange={(v) => { setQ(v); setShown(PAGE); }} placeholder="Filter by name" aria-label="Filter owned cards" />
              <span className="faint small">{rows.length.toLocaleString()} card{rows.length === 1 ? '' : 's'}</span>
            </div>
            <div className={styles.table} role="table">
              <div className={styles.thead} role="row"><span>Card</span><span className={styles.right}>Copies</span><span>Sources</span><span className={styles.right}>Adjust</span></div>
              {rows.slice(0, shown).map(c => (
                <div key={c.oracleId} className={styles.tr} role="row" data-testid="collection-row-item">
                  <span><CardRef name={c.name} oracleId={c.oracleId} /></span>
                  <span className={`${styles.mono} ${styles.right}`}>{c.count}</span>
                  <span className="faint small">{c.sources} source{c.sources === 1 ? '' : 's'}</span>
                  <span className={styles.trActions}>
                    <IconButton label={`Remove one ${c.name}`} size="sm" onClick={() => bump(c.oracleId, c.name, -1)}><Minus /></IconButton>
                    <IconButton label={`Add one ${c.name}`} size="sm" onClick={() => bump(c.oracleId, c.name, 1)}><Plus /></IconButton>
                  </span>
                </div>
              ))}
            </div>
            {rows.length > shown && <div className={styles.more}><Button onClick={() => setShown(s => s + PAGE)}>Show more</Button></div>}
          </section>
        </>
      )}

      <ImportCollectionDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
