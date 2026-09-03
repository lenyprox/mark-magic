'use client';
// Metagame → opponent decks: pick a format, refresh from TopDeck, browse archetypes, sample one or import a tournament list.
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw, Shuffle } from 'lucide-react';
import type { DeckRecord } from '@user/decks';
import { deckApi } from '@/lib/deck/api';
import { formatInfo, META_FORMATS } from '@/lib/deck/formats';
import { formatDate } from '@/lib/text/format';
import { toast } from '@/lib/stores/ui';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Badge, Callout, EmptyState, Meter, Skeleton } from '@/components/ui/Display';
import { CardRef } from '@/components/shell/CardRef';
import styles from '@/app/decks/decks.module.css';

export interface MetagameImportProps { defaultFormat?: string; onImported?: (deck: DeckRecord) => void }

export function MetagameImport({ defaultFormat, onImported }: MetagameImportProps) {
  const qc = useQueryClient();
  const [format, setFormat] = useState(() => formatInfo(defaultFormat).meta ?? 'Modern');
  const [selected, setSelected] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const meta = useQuery({ queryKey: ['meta', format], queryFn: ({ signal }) => deckApi.meta(format, signal), staleTime: 60_000 });
  const m = meta.data;
  const archetypes = useMemo(() => (m?.archetypes ?? []).slice().sort((a, b) => b.share - a.share), [m]);
  const current = archetypes.find(a => a.id === selected) ?? null;
  const decklists = useMemo(() => {
    const all = m?.decklists ?? [];
    if (!current) return all;
    return all.filter(d => d.archetypeId === current.id || (d.archetype && d.archetype.toLowerCase() === current.name.toLowerCase()));
  }, [m, current]);

  const refresh = async (force = false) => {
    setSyncing(true);
    try {
      const r = await deckApi.sync(format, { force });
      const failed = r.reports.filter(x => !x.ok && !x.skipped);
      toast({ title: failed.length ? 'Refresh finished with problems' : `${format} metagame refreshed`, body: r.reports.map(x => `${x.source}: ${x.message}`).join(' · ').slice(0, 240), kind: failed.length ? 'warn' : 'ok', ttl: 8000 });
      await qc.invalidateQueries({ queryKey: ['meta', format] });
    } catch (e) {
      toast({ title: 'Refresh failed', body: (e as Error).message, kind: 'danger' });
    } finally { setSyncing(false); }
  };
  const done = (deck: DeckRecord, missing: string[], what: string) => {
    toast({ title: `${what} saved under Opponents`, body: missing.length ? `${deck.name} — ${missing.length} card${missing.length === 1 ? '' : 's'} could not be resolved.` : deck.name, kind: missing.length ? 'warn' : 'ok' });
    onImported?.(deck);
  };
  const sample = async (id: string) => {
    setBusy(`a:${id}`);
    try { const r = await deckApi.sampleArchetype(id); done(r.deck, r.missing, 'Sampled deck'); }
    catch (e) { toast({ title: 'Could not sample the archetype', body: (e as Error).message, kind: 'danger' }); }
    finally { setBusy(null); }
  };
  const importList = async (id: string) => {
    setBusy(`d:${id}`);
    try { const r = await deckApi.importDecklist(id); done(r.deck, r.missing, 'Tournament list'); }
    catch (e) { toast({ title: 'Import failed', body: (e as Error).message, kind: 'danger' }); }
    finally { setBusy(null); }
  };

  return (
    <div className={styles.meta}>
      <div className={styles.metaHead}>
        <Select label="Format" options={META_FORMATS} value={format} onChange={(e) => { setFormat(e.target.value); setSelected(null); }} />
        <Button icon={<RefreshCw className={syncing ? styles.spin : undefined} />} onClick={() => refresh(false)} disabled={syncing || !m?.configured} aria-busy={syncing}>{syncing ? 'Refreshing…' : 'Refresh'}</Button>
        <div className={styles.metaStatus} aria-live="polite">
          {m?.lastRefresh ? <span>Last refresh {formatDate(m.lastRefresh.finishedAt.slice(0, 10))} · {m.lastRefresh.ok ? 'ok' : 'failed'}</span> : m ? <span>Never refreshed</span> : null}
          {m && <Badge tone={m.configured ? 'ok' : 'mute'} dot>{m.configured ? 'TopDeck connected' : 'No API key'}</Badge>}
        </div>
      </div>

      {meta.isError && <Callout variant="danger" title="Could not load the metagame">{(meta.error as Error).message}</Callout>}
      {m && !m.configured && (
        <Callout variant="info" title="Tournament data needs a TopDeck API key">
          Add <span className={styles.code}>TOPDECK_API_KEY=…</span> to <span className={styles.code}>.env.local</span>, restart the dev server, then run <span className={styles.code}>npm run meta:sync</span> (or press Refresh here). Archetypes already synced still show below.
        </Callout>
      )}

      {meta.isPending && <div className={styles.archetypes}>{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={74} />)}</div>}
      {m && archetypes.length === 0 && !meta.isPending && (
        <EmptyState title={`No ${format} archetypes yet`}>{m.configured ? 'Press Refresh to pull the last 30 days of tournament lists.' : 'Sync once with an API key and the archetype list appears here.'}</EmptyState>
      )}

      {archetypes.length > 0 && (
        <div className={styles.metaCols}>
          <div className={styles.archetypes} role="list" aria-label="Archetypes">
            {archetypes.map(a => (
              <div key={a.id} role="listitem" className={styles.archetype} data-active={a.id === selected}>
                <div className={styles.archetypeMain}>
                  <button type="button" className={styles.archetypeName} onClick={() => setSelected(s => s === a.id ? null : a.id)} aria-pressed={a.id === selected}>
                    <span>{a.name}</span>
                    <small>{a.deckCount} deck{a.deckCount === 1 ? '' : 's'}{a.winRate != null && ` · ${Math.round(a.winRate * 100)}% wins`}</small>
                  </button>
                  <div className={styles.archetypeShare}><Meter value={a.share} label={`${a.name} metagame share`} /></div>
                  {a.signature.length > 0 && <div className={styles.signature}>{a.signature.slice(0, 6).map(n => <CardRef key={n} name={n} />)}</div>}
                </div>
                <div className={styles.archetypeActions}>
                  <Button size="sm" icon={<Shuffle />} onClick={() => sample(a.id)} disabled={busy != null} aria-busy={busy === `a:${a.id}`}>{busy === `a:${a.id}` ? 'Sampling…' : 'Sample as opponent'}</Button>
                </div>
              </div>
            ))}
          </div>
          <div>
            <div className={styles.sectionHead}><h3>{current ? `${current.name} lists` : 'Recent tournament lists'}</h3><span className="faint small">{decklists.length}</span></div>
            {decklists.length === 0 ? <div className="faint small" style={{ padding: '12px 0' }}>No lists stored{current ? ' for this archetype' : ''}.</div> : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead><tr><th>Player</th><th className={styles.num}>Place</th><th>Event</th><th>Date</th>{!current && <th>Archetype</th>}<th /></tr></thead>
                  <tbody>
                    {decklists.map(d => (
                      <tr key={d.id}>
                        <td>{d.player ?? '—'}</td>
                        <td className="num">{d.placement != null ? `#${d.placement}` : '—'}</td>
                        <td><span className={styles.event} title={d.eventName ?? undefined}>{d.eventName ?? '—'}</span></td>
                        <td className="mono">{d.date ? formatDate(d.date.slice(0, 10)) : '—'}</td>
                        {!current && <td>{d.archetype ?? '—'}</td>}
                        <td><Button size="sm" variant="ghost" icon={<Download />} onClick={() => importList(d.id)} disabled={busy != null} aria-busy={busy === `d:${d.id}`}>{busy === `d:${d.id}` ? 'Importing…' : 'Import'}</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
