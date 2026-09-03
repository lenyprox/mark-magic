'use client';
// The deck draft being edited in the builder. Every mutation produces a new `draft` object; zundo records those for undo/redo.
// Saving is the builder's job (debounced PUT) — the store only tracks the save state.
import { create } from 'zustand';
import { temporal } from 'zundo';
import type { DeckBoard } from '@cards/db';
import type { DeckCard, DeckRecord, DeckRole } from '@user/decks';

export interface DeckDraft { id: string; name: string; format: string; role: DeckRole; coverPrintingId: string | null; cards: DeckCard[] }
export type SaveState = 'saved' | 'saving' | 'unsaved' | 'error';
export interface CardPick { oracleId: string; name: string; printingId?: string | null }

interface DeckState {
  draft: DeckDraft | null;
  saveState: SaveState;
  load: (deck: DeckRecord) => void;
  unload: () => void;
  setMeta: (patch: Partial<Pick<DeckDraft, 'name' | 'format' | 'coverPrintingId'>>) => void;
  addCard: (pick: CardPick, board?: DeckBoard, n?: number) => void;
  adjust: (board: DeckBoard, oracleId: string, delta: number) => void;
  setCount: (board: DeckBoard, oracleId: string, count: number) => void;
  setPrinting: (board: DeckBoard, oracleId: string, printingId: string | null) => void;
  moveCard: (oracleId: string, from: DeckBoard, to: DeckBoard, n?: number) => void;
  removeCard: (board: DeckBoard, oracleId: string) => void;
  replaceCards: (cards: DeckCard[]) => void;
  mergeCards: (cards: DeckCard[]) => void;
  setSaveState: (s: SaveState) => void;
}

/** Merge duplicate rows, drop empties, renumber positions per board. */
export function normalizeCards(cards: DeckCard[]): DeckCard[] {
  const merged = new Map<string, DeckCard>();
  for (const c of cards) {
    if (c.count <= 0) continue;
    const key = `${c.board}:${c.oracleId}`;
    const prev = merged.get(key);
    if (prev) merged.set(key, { ...prev, count: prev.count + c.count, printingId: prev.printingId ?? c.printingId ?? null });
    else merged.set(key, { ...c, printingId: c.printingId ?? null });
  }
  const pos: Partial<Record<DeckBoard, number>> = {};
  return [...merged.values()].map(c => ({ ...c, position: (pos[c.board] = (pos[c.board] ?? 0) + 1) - 1 }));
}

function mutate(cards: DeckCard[], fn: (cards: DeckCard[]) => DeckCard[]): DeckCard[] { return normalizeCards(fn(cards.map(c => ({ ...c })))); }

export const useDeckStore = create<DeckState>()(temporal((set, get) => ({
  draft: null,
  saveState: 'saved',
  load: (deck) => set({ draft: { id: deck.id, name: deck.name, format: deck.format, role: deck.role, coverPrintingId: deck.coverPrintingId, cards: normalizeCards(deck.cards) }, saveState: 'saved' }),
  unload: () => set({ draft: null, saveState: 'saved' }),
  setMeta: (patch) => { const d = get().draft; if (d) set({ draft: { ...d, ...patch } }); },
  addCard: (pick, board = 'main', n = 1) => {
    const d = get().draft; if (!d) return;
    set({ draft: { ...d, cards: mutate(d.cards, cs => [...cs, { board, oracleId: pick.oracleId, name: pick.name, printingId: pick.printingId ?? null, count: n, position: cs.length }]) } });
  },
  adjust: (board, oracleId, delta) => {
    const d = get().draft; if (!d) return;
    set({ draft: { ...d, cards: mutate(d.cards, cs => cs.map(c => c.board === board && c.oracleId === oracleId ? { ...c, count: c.count + delta } : c)) } });
  },
  setCount: (board, oracleId, count) => {
    const d = get().draft; if (!d) return;
    set({ draft: { ...d, cards: mutate(d.cards, cs => cs.map(c => c.board === board && c.oracleId === oracleId ? { ...c, count } : c)) } });
  },
  setPrinting: (board, oracleId, printingId) => {
    const d = get().draft; if (!d) return;
    set({ draft: { ...d, cards: d.cards.map(c => c.board === board && c.oracleId === oracleId ? { ...c, printingId } : c) } });
  },
  moveCard: (oracleId, from, to, n) => {
    const d = get().draft; if (!d || from === to) return;
    const src = d.cards.find(c => c.board === from && c.oracleId === oracleId); if (!src) return;
    const qty = Math.min(src.count, n ?? src.count);
    set({ draft: { ...d, cards: mutate(d.cards, cs => [...cs.map(c => c === src || (c.board === from && c.oracleId === oracleId) ? { ...c, count: c.count - qty } : c), { ...src, board: to, count: qty }]) } });
  },
  removeCard: (board, oracleId) => {
    const d = get().draft; if (!d) return;
    set({ draft: { ...d, cards: normalizeCards(d.cards.filter(c => !(c.board === board && c.oracleId === oracleId))) } });
  },
  replaceCards: (cards) => { const d = get().draft; if (d) set({ draft: { ...d, cards: normalizeCards(cards) } }); },
  mergeCards: (cards) => { const d = get().draft; if (d) set({ draft: { ...d, cards: normalizeCards([...d.cards, ...cards]) } }); },
  setSaveState: (saveState) => set({ saveState }),
}), {
  limit: 200,
  partialize: (s) => ({ draft: s.draft }) as DeckState,
  equality: (a, b) => a.draft === b.draft,
}));

export const deckHistory = () => useDeckStore.temporal.getState();
