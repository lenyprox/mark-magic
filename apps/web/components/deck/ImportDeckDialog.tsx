'use client';
// Paste a list (Arena, Moxfield or plain "4 Lightning Bolt"), see what resolves, then save it as a deck.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { DeckRole } from '@user/decks';
import { deckApi } from '@/lib/deck/api';
import { FORMAT_OPTIONS } from '@/lib/deck/formats';
import { useDebouncedValue } from '@/lib/hooks/useDebounced';
import { toast } from '@/lib/stores/ui';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Segmented } from '@/components/ui/Segmented';
import { Badge, Callout, Skeleton } from '@/components/ui/Display';
import styles from '@/app/decks/decks.module.css';

const SAMPLE = `Deck
4 Lightning Bolt
20 Mountain

Sideboard
2 Smash to Smithereens`;

export function ImportDeckDialog({ open, onClose, defaultRole = 'mine' }: { open: boolean; onClose: () => void; defaultRole?: DeckRole }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [format, setFormat] = useState('');
  const [role, setRole] = useState<DeckRole>(defaultRole);
  const [busy, setBusy] = useState(false);
  const dtext = useDebouncedValue(text, 400);
  useEffect(() => { if (open) { setText(''); setName(''); setFormat(''); setRole(defaultRole); setBusy(false); } }, [open, defaultRole]);

  const preview = useQuery({
    queryKey: ['deck-import-preview', dtext],
    queryFn: ({ signal }) => deckApi.importText({ text: dtext }, signal),
    enabled: open && dtext.trim().length > 0,
    staleTime: 60_000,
  });
  const p = preview.data;
  const resolved = p ? p.cards.length : 0;

  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const r = await deckApi.importText({ text, name: name.trim() || undefined, format: format || undefined, role, save: true });
      toast({ title: `Imported ${r.deck?.name ?? 'deck'}`, body: r.missing.length ? `${r.missing.length} card${r.missing.length === 1 ? '' : 's'} could not be found.` : `${r.mainCount} main, ${r.sideCount} sideboard.`, kind: r.missing.length ? 'warn' : 'ok' });
      onClose();
      if (r.deck) router.push(`/decks/${r.deck.id}`); else router.refresh();
    } catch (err) {
      toast({ title: 'Import failed', body: (err as Error).message, kind: 'danger' });
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Import a deck list" width={640}
      footer={<div className={styles.formActions}><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!text.trim() || busy || preview.isFetching} onClick={save}>{busy ? 'Saving…' : `Save${resolved ? ` ${p!.mainCount + p!.sideCount} cards` : ''}`}</Button></div>}>
      <div className={styles.form}>
        <div>
          <label htmlFor="import-text" className="faint small" style={{ display: 'block', marginBottom: 6 }}>Deck list — Arena export, Moxfield, or one card per line</label>
          <textarea id="import-text" className={styles.textarea} value={text} onChange={(e) => setText(e.target.value)} placeholder={SAMPLE} spellCheck={false} autoFocus />
        </div>
        <div className={styles.formRow}>
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder={p?.name || 'From the list, or "Imported deck"'} maxLength={80} />
          <Select label="Format" options={FORMAT_OPTIONS} placeholder={p?.format ? `Detected: ${p.format}` : 'Detect from the list'} value={format} onChange={(e) => setFormat(e.target.value)} />
        </div>
        <div className={styles.roleField}>
          <span>Belongs to</span>
          <Segmented label="Deck owner" value={role} onChange={setRole} options={[{ value: 'mine', label: 'Me' }, { value: 'opponent', label: 'Opponent' }]} />
        </div>
        <div className={styles.preview} aria-live="polite">
          {preview.isFetching && !p && <Skeleton kind="text" width="40%" />}
          {preview.isError && <Callout variant="danger" title="Could not parse the list">{(preview.error as Error).message}</Callout>}
          {p && text.trim() && (
            <>
              <div className={styles.previewRow}>
                <Badge tone="ok" dot>{p.mainCount} main</Badge>
                <Badge tone={p.sideCount ? 'info' : 'mute'} dot>{p.sideCount} sideboard</Badge>
                <Badge tone={p.missing.length ? 'danger' : 'mute'} dot>{p.missing.length} missing</Badge>
                {p.unknownLines.length > 0 && <Badge tone="warn" dot>{p.unknownLines.length} line{p.unknownLines.length === 1 ? '' : 's'} skipped</Badge>}
              </div>
              {p.missing.length > 0 && (
                <Callout variant="warn" title="Not found in the card database">
                  <div className={styles.missingList}>{p.missing.map(m => <Badge key={m} tone="warn">{m}</Badge>)}</div>
                </Callout>
              )}
              {p.unknownLines.length > 0 && <div className="faint small">Skipped: {p.unknownLines.slice(0, 4).join(' · ')}{p.unknownLines.length > 4 && ' …'}</div>}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
