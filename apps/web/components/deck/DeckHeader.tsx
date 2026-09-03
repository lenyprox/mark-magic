'use client';
// Name, format, cover, stats, save state, undo/redo and the deck menu.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from 'zustand';
import { ArrowLeft, Copy, Globe, Image as ImageIcon, MoreHorizontal, Play, Redo2, Trash2, Undo2 } from 'lucide-react';
import type { DeckRecord } from '@user/decks';
import { deckApi, duplicateDeck } from '@/lib/deck/api';
import { FORMAT_OPTIONS, formatInfo } from '@/lib/deck/formats';
import { averageMv, colorIdentity, landCount, mainCount, type Entry } from '@/lib/deck/stats';
import type { CardInfo } from '@/lib/deck/useCardInfo';
import { useDeckStore } from '@/lib/stores/deck';
import { toast } from '@/lib/stores/ui';
import { imgUrl } from '@/lib/img';
import { Button, IconButton } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Popover } from '@/components/ui/Popover';
import { Select } from '@/components/ui/Select';
import { Badge, Stat } from '@/components/ui/Display';
import { ColorPips } from '@/components/text/ManaSymbol';
import { MetagameImport } from './MetagameImport';
import { useBuilder } from './context';
import styles from './deck.module.css';
import lib from '@/app/decks/decks.module.css';

const SAVE_LABEL = { saved: 'Saved', saving: 'Saving…', unsaved: 'Unsaved', error: 'Save failed' } as const;
const SOURCE_LABEL: Record<string, string> = { 'import:text': 'Imported list', 'meta:topdeck': 'TopDeck tournament list', 'meta:sample': 'Sampled from the metagame', 'meta:goldfish': 'MTGGoldfish list' };
const SAVE_TONE = { saved: 'ok', saving: 'info', unsaved: 'warn', error: 'danger' } as const;

export function DeckHeader({ deck, entries, info }: { deck: DeckRecord; entries: Entry[]; info: CardInfo }) {
  const router = useRouter();
  const { saveNow, deckId } = useBuilder();
  const draft = useDeckStore(s => s.draft)!;
  const saveState = useDeckStore(s => s.saveState);
  const setMeta = useDeckStore(s => s.setMeta);
  const canUndo = useStore(useDeckStore.temporal, s => s.pastStates.length > 0);
  const canRedo = useStore(useDeckStore.temporal, s => s.futureStates.length > 0);
  const [name, setName] = useState(draft.name);
  useEffect(() => { setName(draft.name); }, [draft.name]);
  const commitName = () => { const n = name.trim(); if (!n) { setName(draft.name); return; } if (n !== draft.name) setMeta({ name: n }); };
  const [dialog, setDialog] = useState<'meta' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);

  const f = formatInfo(draft.format);
  const main = mainCount(draft.cards);
  const avg = averageMv(entries);
  const lands = landCount(entries);
  const identity = colorIdentity(entries);
  const coverOptions = (() => {
    const seen = new Set<string>(); const out: { id: string; name: string }[] = [];
    for (const e of entries) { const id = e.card.printingId ?? e.info?.representativePrintingId; if (id && !seen.has(id)) { seen.add(id); out.push({ id, name: e.card.name }); } }
    return out;
  })();
  const cover = draft.coverPrintingId ?? coverOptions.find(o => /\bCreature\b/.test(info.map.get(entries.find(e => (e.card.printingId ?? e.info?.representativePrintingId) === o.id)?.card.oracleId ?? '')?.typeLine ?? ''))?.id ?? coverOptions[0]?.id ?? null;

  const duplicate = async () => {
    await saveNow();
    try { const copy = await duplicateDeck(deckId); toast({ title: `Duplicated as ${copy.name}`, kind: 'ok' }); router.push(`/decks/${copy.id}`); }
    catch (e) { toast({ title: 'Could not duplicate', body: (e as Error).message, kind: 'danger' }); }
  };
  const remove = async () => {
    setBusy(true);
    try { await deckApi.remove(deckId); toast({ title: `Deleted ${draft.name}` }); router.push('/decks'); }
    catch (e) { toast({ title: 'Delete failed', body: (e as Error).message, kind: 'danger' }); setBusy(false); }
  };

  return (
    <header className={styles.header}>
      <div className={styles.headerTop}>
        <Link href="/decks" className={styles.back}><ArrowLeft size={14} /> Decks</Link>
        <span className={styles.headerSpacer} />
        <Badge tone={SAVE_TONE[saveState]} dot className={styles.saveBadge} title="Changes save automatically"><span aria-live="polite">{SAVE_LABEL[saveState]}</span></Badge>
        <IconButton label="Undo (Ctrl+Z)" size="sm" disabled={!canUndo} onClick={() => useDeckStore.temporal.getState().undo()}><Undo2 /></IconButton>
        <IconButton label="Redo (Ctrl+Shift+Z)" size="sm" disabled={!canRedo} onClick={() => useDeckStore.temporal.getState().redo()}><Redo2 /></IconButton>
        <Popover placement="bottom-end" trigger={<IconButton label="Deck menu" size="sm"><MoreHorizontal /></IconButton>}>
          {(close) => (
            <div className={lib.menu} role="menu">
              <button type="button" role="menuitem" className={lib.menuItem} onClick={() => { close(); setDialog('meta'); }}><Globe />Opponent decks…</button>
              <Link href="/play" role="menuitem" className={lib.menuItem} onClick={close}><Play />Play</Link>
              <button type="button" role="menuitem" className={lib.menuItem} onClick={() => { close(); void duplicate(); }}><Copy />Duplicate</button>
              <div className={lib.menuSep} />
              <button type="button" role="menuitem" className={lib.menuItem} data-danger onClick={() => { close(); setDialog('delete'); }}><Trash2 />Delete…</button>
            </div>
          )}
        </Popover>
      </div>
      <div className={styles.titleRow}>
        <Popover placement="bottom-start" trigger={
          <button type="button" className={styles.coverBtn} aria-label="Choose cover art">
            {cover ? <img src={imgUrl(cover, 'art_crop')} alt="" /> : <ImageIcon />}
          </button>}>
          {(close) => (
            <div className={styles.coverGrid} role="listbox" aria-label="Cover art">
              {coverOptions.length === 0 && <div className="faint small">Add cards to pick a cover.</div>}
              {coverOptions.map(o => (
                <button key={o.id} type="button" role="option" aria-selected={o.id === draft.coverPrintingId} className={styles.coverItem} title={o.name} onClick={() => { setMeta({ coverPrintingId: o.id }); close(); }}>
                  <img src={imgUrl(o.id, 'art_crop')} alt={o.name} loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </Popover>
        <div className={styles.titleMain}>
          <input data-deck-focus className={styles.nameInput} value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } if (e.key === 'Escape') { setName(draft.name); (e.target as HTMLInputElement).blur(); } }}
            aria-label="Deck name" maxLength={80} spellCheck={false} />
          <div className={styles.headerMeta}>
            <Select size="sm" aria-label="Format" options={FORMAT_OPTIONS.some(o => o.value === f.value) ? FORMAT_OPTIONS : [...FORMAT_OPTIONS, { value: f.value, label: f.label }]} value={f.value} onChange={(e) => setMeta({ format: e.target.value })} />
            {draft.role === 'opponent' && <Badge tone="info">Opponent{deck.archetype ? ` · ${deck.archetype}` : ''}</Badge>}
            {deck.source !== 'manual' && <span className="faint small">{SOURCE_LABEL[deck.source] ?? deck.source}</span>}
          </div>
        </div>
      </div>
      <div className={styles.stats}>
        <Stat label="Cards" value={main} unit={f.exactSize ? `/ ${f.exactSize}` : `/ ${f.minSize}`} />
        <Stat label="Avg. mana value" value={avg == null ? '—' : avg.toFixed(2)} />
        <Stat label="Lands" value={lands} unit={main ? `${Math.round(lands / main * 100)}%` : undefined} />
        <div className={styles.statPips}><span>Colours</span>{identity.length ? <ColorPips colors={identity} size={16} label="Colour identity" /> : <span className="faint">—</span>}</div>
      </div>

      <Dialog open={dialog === 'meta'} onClose={() => setDialog(null)} title="Opponent decks from the metagame" width={880}>
        {dialog === 'meta' && <MetagameImport defaultFormat={draft.format} onImported={(d) => toast({ title: 'Open it', body: d.name, kind: 'ok' })} />}
        <div className={lib.formActions} style={{ marginTop: 12 }}><Link href="/decks?tab=opponents" className="link small">See all opponent decks</Link></div>
      </Dialog>
      <Dialog open={dialog === 'delete'} onClose={() => setDialog(null)} title="Delete this deck?" width={420}
        footer={<div className={lib.formActions}><Button variant="ghost" onClick={() => setDialog(null)}>Keep it</Button><Button variant="danger" onClick={remove} disabled={busy}>{busy ? 'Deleting…' : 'Delete'}</Button></div>}>
        <p className={lib.deleteBody}><b>{draft.name}</b> ({main} cards) will be removed for good.</p>
      </Dialog>
    </header>
  );
}
