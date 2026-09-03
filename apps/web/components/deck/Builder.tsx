'use client';
// BuilderShell: loads the deck into the draft store, autosaves it (600 ms debounce), and lays out the picker and the deck pane
// as two resizable panes (a bottom drawer for the picker on small screens). Keyboard: ⌘Z / ⌘⇧Z undo–redo, [ and ] move focus.
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import type { DeckBoard } from '@cards/db';
import type { DeckRecord } from '@user/decks';
import { deckApi } from '@/lib/deck/api';
import { deckHistory, normalizeCards, useDeckStore, type DeckDraft } from '@/lib/stores/deck';
import { toast } from '@/lib/stores/ui';
import { useLocalStorage } from '@/lib/hooks/useLocalStorage';
import { useMediaQuery } from '@/lib/hooks/useMediaQuery';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { BuilderContext, type BuilderContextValue } from './context';
import { Picker } from './Picker';
import { DeckPane } from './DeckPane';
import styles from './deck.module.css';

const MIN_PANE = 360;
const SEP = 10;

function serialize(d: Pick<DeckDraft, 'name' | 'format' | 'coverPrintingId' | 'cards'>): string {
  return JSON.stringify([d.name, d.format, d.coverPrintingId, d.cards.map(c => [c.board, c.oracleId, c.printingId, c.count])]);
}

export function Builder({ deck }: { deck: DeckRecord }) {
  const router = useRouter();
  const load = useDeckStore(s => s.load);
  const draft = useDeckStore(s => s.draft);
  const setSaveState = useDeckStore(s => s.setSaveState);
  const mobile = useMediaQuery('(max-width: 900px)');
  const [board, setBoard] = useState<DeckBoard>('main');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [leftW, setLeftW] = useLocalStorage('vault.builder.left', 520);
  const shell = useRef<HTMLDivElement>(null);
  const pickerPane = useRef<HTMLDivElement>(null);
  const deckPane = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState('');

  // ---- load the record into the store (fresh history per deck)
  useLayoutEffect(() => { load(deck); deckHistory().clear(); }, [deck.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = draft?.id === deck.id;

  // ---- autosave
  const lastSaved = useRef(serialize({ name: deck.name, format: deck.format, coverPrintingId: deck.coverPrintingId, cards: normalizeCards(deck.cards) }));
  const timer = useRef<number | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const doSave = useCallback(async () => {
    if (inflight.current) await inflight.current.catch(() => undefined);
    const d = useDeckStore.getState().draft;
    if (!d || d.id !== deck.id) return;
    const snap = serialize(d);
    if (snap === lastSaved.current) { setSaveState('saved'); return; }
    setSaveState('saving');
    const p = deckApi.update(d.id, { name: d.name, format: d.format, coverPrintingId: d.coverPrintingId, cards: d.cards })
      .then(() => {
        lastSaved.current = snap;
        const now = useDeckStore.getState().draft;
        setSaveState(now && serialize(now) !== snap ? 'unsaved' : 'saved');
      })
      .catch((e: Error) => { setSaveState('error'); toast({ title: 'Save failed', body: e.message, kind: 'danger' }); })
      .finally(() => { if (inflight.current === p) inflight.current = null; });
    inflight.current = p;
    await p;
  }, [deck.id, setSaveState]);
  useEffect(() => {
    if (!draft || draft.id !== deck.id) return;
    if (serialize(draft) === lastSaved.current) return;
    setSaveState('unsaved');
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; void doSave(); }, 600);
  }, [draft, deck.id, doSave, setSaveState]);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const saveNow = useCallback(async () => { if (timer.current) { window.clearTimeout(timer.current); timer.current = null; } await doSave(); }, [doSave]);
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => { if (useDeckStore.getState().saveState !== 'saved') { e.preventDefault(); } };
    window.addEventListener('beforeunload', onUnload); return () => window.removeEventListener('beforeunload', onUnload);
  }, []);
  // Flush on route change (unmount) so nothing waits in the timer.
  useEffect(() => () => { if (timer.current) { window.clearTimeout(timer.current); timer.current = null; void doSave(); } }, [doSave]);

  // ---- focus and keys
  const focusPane = useCallback((pane: 'picker' | 'deck') => {
    if (pane === 'picker') {
      if (mobile) { setPickerOpen(true); return; }
      const input = pickerPane.current?.querySelector<HTMLElement>('input[type="search"]');
      (input ?? pickerPane.current)?.focus();
      setLive('Card picker');
    } else {
      const first = deckPane.current?.querySelector<HTMLElement>('[data-deck-focus]');
      (first ?? deckPane.current)?.focus();
      setLive('Deck');
    }
  }, [mobile]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { if (typing) return; e.preventDefault(); if (e.shiftKey) deckHistory().redo(); else deckHistory().undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { if (typing) return; e.preventDefault(); deckHistory().redo(); return; }
      if (typing || mod || e.altKey) return;
      if (e.key === '[') { e.preventDefault(); focusPane('picker'); }
      else if (e.key === ']') { e.preventDefault(); focusPane('deck'); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [focusPane]);

  // ---- resizer
  const clamp = useCallback((w: number) => {
    const total = shell.current?.getBoundingClientRect().width ?? 1200;
    return Math.round(Math.max(MIN_PANE, Math.min(total - MIN_PANE - SEP, w)));
  }, []);
  const onSepPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget; el.setPointerCapture(e.pointerId);
    const left = shell.current?.getBoundingClientRect().left ?? 0;
    const move = (ev: PointerEvent) => setLeftW(clamp(ev.clientX - left - SEP / 2));
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };
  const onSepKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 96 : 24;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setLeftW(w => clamp(w - step)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setLeftW(w => clamp(w + step)); }
    else if (e.key === 'Home') { e.preventDefault(); setLeftW(clamp(0)); }
    else if (e.key === 'End') { e.preventDefault(); setLeftW(clamp(99999)); }
  };
  useEffect(() => { if (!mobile) setLeftW(w => clamp(w)); }, [mobile, clamp, setLeftW]);

  const quickLook = useCallback((oracleId: string) => router.push(`/cards/${oracleId}`), [router]);
  const ctx = useMemo<BuilderContextValue>(() => ({ deckId: deck.id, board, setBoard, saveNow, focusPane, openPicker: () => setPickerOpen(true), mobile }), [deck.id, board, saveNow, focusPane, mobile]);

  if (!ready) return null;
  const picker = <Picker format={draft.format} onQuickLook={quickLook} />;
  return (
    <BuilderContext.Provider value={ctx}>
      <div ref={shell} className={styles.shell} data-mobile={mobile || undefined} style={{ '--left': `${leftW}px` } as CSSProperties}>
        {!mobile && (
          <>
            <section ref={pickerPane} className={styles.pane} aria-label="Card picker" tabIndex={-1}>{picker}</section>
            <div className={styles.sep} role="separator" aria-orientation="vertical" aria-label="Resize panes" aria-valuemin={MIN_PANE} aria-valuenow={leftW} tabIndex={0} onPointerDown={onSepPointerDown} onKeyDown={onSepKey}><span /></div>
          </>
        )}
        <section ref={deckPane} className={styles.pane} aria-label="Deck" tabIndex={-1}><DeckPane deck={deck} /></section>
        {mobile && (
          <>
            <div className={styles.fab}><Button variant="primary" icon={<Plus />} onClick={() => setPickerOpen(true)} aria-haspopup="dialog">Add cards</Button></div>
            <Drawer open={pickerOpen} onClose={() => setPickerOpen(false)} side="bottom" title="Add cards">
              <div className={styles.drawerPicker}>{picker}</div>
            </Drawer>
          </>
        )}
        <div className="sr-only" aria-live="polite">{live}</div>
      </div>
    </BuilderContext.Provider>
  );
}
