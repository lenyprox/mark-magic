'use client';
// Paste a list to merge into or replace the draft; copy the deck out as plain text or Arena format.
import { useState } from 'react';
import { ChevronDown, ClipboardCopy } from 'lucide-react';
import clsx from 'clsx';
import { deckApi } from '@/lib/deck/api';
import { useDeckStore } from '@/lib/stores/deck';
import { draftToText } from '@/lib/deck/stats';
import { toast } from '@/lib/stores/ui';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { Badge, Callout } from '@/components/ui/Display';
import { useBuilder } from './context';
import styles from './deck.module.css';
import lib from '@/app/decks/decks.module.css';

export function ImportExport() {
  const { saveNow, deckId } = useBuilder();
  const mergeCards = useDeckStore(s => s.mergeCards);
  const replaceCards = useDeckStore(s => s.replaceCards);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const [fmt, setFmt] = useState<'plain' | 'arena'>('plain');
  const [out, setOut] = useState('');

  const apply = async (mode: 'merge' | 'replace') => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await deckApi.importText({ text });
      if (mode === 'merge') mergeCards(r.cards); else replaceCards(r.cards);
      setMissing(r.missing);
      toast({ title: mode === 'merge' ? `Merged ${r.mainCount + r.sideCount} cards` : `Replaced with ${r.mainCount + r.sideCount} cards`, body: r.missing.length ? `${r.missing.length} not found` : undefined, kind: r.missing.length ? 'warn' : 'ok' });
      if (!r.missing.length) setText('');
    } catch (e) { toast({ title: 'Could not read the list', body: (e as Error).message, kind: 'danger' }); }
    finally { setBusy(false); }
  };
  const exportText = async (copy: boolean) => {
    setBusy(true);
    try {
      await saveNow();
      let t: string;
      try { t = await deckApi.exportText(deckId, fmt); }
      catch { t = draftToText(useDeckStore.getState().draft?.cards ?? []); }
      setOut(t);
      if (copy) { await navigator.clipboard.writeText(t); toast({ title: `Copied as ${fmt === 'arena' ? 'Arena' : 'plain text'}`, kind: 'ok', ttl: 2000 }); }
    } catch (e) { toast({ title: 'Export failed', body: (e as Error).message, kind: 'danger' }); }
    finally { setBusy(false); }
  };

  return (
    <section className={styles.section} aria-label="Import and export">
      <button type="button" className={styles.sectionToggle} onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <ChevronDown className={clsx(styles.chev, !open && styles.chevClosed)} aria-hidden /><h3>Import &amp; export</h3>
      </button>
      {open && (
        <div className={styles.ioGrid}>
          <div className={styles.ioCol}>
            <label htmlFor="deck-io-in" className="faint small">Paste a list (Arena, Moxfield or "4 Lightning Bolt" per line)</label>
            <textarea id="deck-io-in" className={lib.textarea} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} style={{ minHeight: 140 }} />
            <div className={styles.ioActions}>
              <Button size="sm" variant="primary" disabled={!text.trim() || busy} onClick={() => apply('merge')}>Merge into deck</Button>
              <Button size="sm" variant="danger" disabled={!text.trim() || busy} onClick={() => apply('replace')}>Replace deck</Button>
            </div>
            {missing.length > 0 && <Callout variant="warn" title="Not found"><div className={lib.missingList}>{missing.map(m => <Badge key={m} tone="warn">{m}</Badge>)}</div></Callout>}
          </div>
          <div className={styles.ioCol}>
            <div className={styles.ioActions}>
              <Segmented size="sm" label="Export format" value={fmt} onChange={setFmt} options={[{ value: 'plain', label: 'Plain' }, { value: 'arena', label: 'Arena' }]} />
              <Button size="sm" icon={<ClipboardCopy />} disabled={busy} onClick={() => exportText(true)}>Copy</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => exportText(false)}>Preview</Button>
            </div>
            <textarea aria-label="Exported deck list" className={lib.textarea} value={out} readOnly placeholder="Press Copy or Preview." style={{ minHeight: 140 }} />
          </div>
        </div>
      )}
    </section>
  );
}
