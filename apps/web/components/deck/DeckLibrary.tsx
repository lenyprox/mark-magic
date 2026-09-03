'use client';
// /decks: Mine | Opponents, deck tiles, and the new / import / metagame dialogs. Mutations go through the API, then the
// server component re-renders via router.refresh() so tile data (colours, covers) stays server-derived.
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { ClipboardPaste, Globe, Plus } from 'lucide-react';
import type { DeckTileData } from '@/lib/deck/server';
import { deckApi, duplicateDeck } from '@/lib/deck/api';
import { toast } from '@/lib/stores/ui';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Tabs } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/Display';
import { DeckTile } from './DeckTile';
import { NewDeckDialog } from './NewDeckDialog';
import { ImportDeckDialog } from './ImportDeckDialog';
import { MetagameImport } from './MetagameImport';
import styles from '@/app/decks/decks.module.css';

type Tab = 'mine' | 'opponents';
const tabParser = parseAsStringLiteral(['mine', 'opponents'] as const).withDefault('mine');

export function DeckLibrary({ decks }: { decks: DeckTileData[] }) {
  const router = useRouter();
  const [tab, setTab] = useQueryState('tab', tabParser);
  const [dialog, setDialog] = useState<'new' | 'import' | 'meta' | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeckTileData | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const visible = useMemo(() => decks.filter(d => !hidden.has(d.id) && (tab === 'mine' ? d.role === 'mine' : d.role === 'opponent')), [decks, hidden, tab]);
  const mineCount = decks.filter(d => d.role === 'mine' && !hidden.has(d.id)).length;
  const oppCount = decks.filter(d => d.role === 'opponent' && !hidden.has(d.id)).length;

  const onDuplicate = async (d: DeckTileData) => {
    try { const copy = await duplicateDeck(d.id); toast({ title: `Duplicated as ${copy.name}`, kind: 'ok' }); router.refresh(); }
    catch (e) { toast({ title: 'Could not duplicate', body: (e as Error).message, kind: 'danger' }); }
  };
  const confirmDelete = async () => {
    const d = pendingDelete; if (!d) return;
    setBusy(true);
    try {
      await deckApi.remove(d.id);
      setHidden(h => new Set(h).add(d.id));
      toast({ title: `Deleted ${d.name}`, kind: 'note' });
      setPendingDelete(null); router.refresh();
    } catch (e) { toast({ title: 'Delete failed', body: (e as Error).message, kind: 'danger' }); }
    finally { setBusy(false); }
  };
  const role = tab === 'mine' ? 'mine' : 'opponent';

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <h1>Decks</h1>
        {tab === 'opponents' && <Button icon={<Globe />} onClick={() => setDialog('meta')}>Metagame</Button>}
        <Button icon={<ClipboardPaste />} onClick={() => setDialog('import')}>Import</Button>
        <Button variant="primary" icon={<Plus />} onClick={() => setDialog('new')}>New deck</Button>
      </div>
      <div className={styles.tabRow}>
        <Tabs<Tab> label="Deck owner" value={tab} onChange={(v) => void setTab(v)} items={[{ value: 'mine', label: 'Mine', count: mineCount }, { value: 'opponents', label: 'Opponents', count: oppCount }]} />
        <span className={styles.sub}>{tab === 'mine' ? 'Lists you build and play with.' : 'Decks the AI pilots against you — imported, sampled from the metagame, or built by hand.'}</span>
      </div>

      {visible.length === 0 ? (
        tab === 'mine' ? (
          <EmptyState title="No decks yet" icon={<Plus />} actions={<><Button variant="primary" icon={<Plus />} onClick={() => setDialog('new')}>New deck</Button><Button icon={<ClipboardPaste />} onClick={() => setDialog('import')}>Import a list</Button></>}>
            Start from a blank list, or paste an Arena or Moxfield export.
          </EmptyState>
        ) : (
          <EmptyState title="No opponent decks" icon={<Globe />} actions={<><Button variant="primary" icon={<Globe />} onClick={() => setDialog('meta')}>Browse the metagame</Button><Button icon={<ClipboardPaste />} onClick={() => setDialog('import')}>Import a list</Button><Button variant="ghost" icon={<Plus />} onClick={() => setDialog('new')}>Build one</Button></>}>
            Sample an archetype from tournament data, import a specific list, or build an opponent by hand.
          </EmptyState>
        )
      ) : (
        <div className={styles.grid}>
          {visible.map(d => <DeckTile key={d.id} deck={d} onDuplicate={onDuplicate} onDelete={setPendingDelete} />)}
        </div>
      )}

      <NewDeckDialog open={dialog === 'new'} onClose={() => setDialog(null)} defaultRole={role} />
      <ImportDeckDialog open={dialog === 'import'} onClose={() => setDialog(null)} defaultRole={role} />
      <Dialog open={dialog === 'meta'} onClose={() => setDialog(null)} title="Opponent decks from the metagame" width={880}>
        {dialog === 'meta' && <MetagameImport onImported={() => { router.refresh(); void setTab('opponents'); }} />}
      </Dialog>
      <Dialog open={!!pendingDelete} onClose={() => setPendingDelete(null)} title="Delete this deck?" width={420}
        footer={<div className={styles.formActions}><Button variant="ghost" onClick={() => setPendingDelete(null)}>Keep it</Button><Button variant="danger" onClick={confirmDelete} disabled={busy}>{busy ? 'Deleting…' : 'Delete'}</Button></div>}>
        <p className={styles.deleteBody}><b>{pendingDelete?.name}</b> ({pendingDelete?.mainCount} cards) will be removed for good. Games already played with it keep their snapshot.</p>
      </Dialog>
    </div>
  );
}
