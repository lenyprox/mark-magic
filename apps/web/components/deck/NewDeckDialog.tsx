'use client';
import { type FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DeckRole } from '@user/decks';
import { deckApi } from '@/lib/deck/api';
import { FORMAT_OPTIONS } from '@/lib/deck/formats';
import { toast } from '@/lib/stores/ui';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Segmented } from '@/components/ui/Segmented';
import styles from '@/app/decks/decks.module.css';

export interface NewDeckFormProps { defaultRole?: DeckRole; defaultFormat?: string; onCancel?: () => void; autoFocus?: boolean }

/** The form alone (used by the dialog and by /decks/new). Creates the deck and navigates into the builder. */
export function NewDeckForm({ defaultRole = 'mine', defaultFormat = 'modern', onCancel, autoFocus = true }: NewDeckFormProps) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [format, setFormat] = useState(defaultFormat);
  const [role, setRole] = useState<DeckRole>(defaultRole);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const deck = await deckApi.create({ name: name.trim(), format, role });
      toast({ title: `Created ${deck.name}`, kind: 'ok' });
      router.push(`/decks/${deck.id}`);
    } catch (err) {
      toast({ title: 'Could not create the deck', body: (err as Error).message, kind: 'danger' });
      setBusy(false);
    }
  };
  return (
    <form className={styles.form} onSubmit={submit}>
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Boros Energy" autoFocus={autoFocus} required maxLength={80} />
      <div className={styles.formRow}>
        <Select label="Format" options={FORMAT_OPTIONS} value={format} onChange={(e) => setFormat(e.target.value)} />
        <div className={styles.roleField}>
          <span>Belongs to</span>
          <Segmented label="Deck owner" value={role} onChange={setRole} options={[{ value: 'mine', label: 'Me' }, { value: 'opponent', label: 'Opponent' }]} />
        </div>
      </div>
      <div className={styles.formActions}>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" disabled={!name.trim() || busy}>{busy ? 'Creating…' : 'Create deck'}</Button>
      </div>
    </form>
  );
}

export function NewDeckDialog({ open, onClose, defaultRole }: { open: boolean; onClose: () => void; defaultRole?: DeckRole }) {
  return (
    <Dialog open={open} onClose={onClose} title="New deck" width={480}>
      {open && <NewDeckForm defaultRole={defaultRole} onCancel={onClose} />}
    </Dialog>
  );
}
