'use client';
import { createContext, useContext } from 'react';
import type { DeckBoard } from '@cards/db';

export interface BuilderContextValue {
  deckId: string;
  /** The board the picker adds to (follows the deck pane's tab). */
  board: DeckBoard;
  setBoard: (b: DeckBoard) => void;
  /** Flush the debounced save now; resolves when the server has the current draft. */
  saveNow: () => Promise<void>;
  /** Move keyboard focus to a pane. */
  focusPane: (pane: 'picker' | 'deck') => void;
  openPicker: () => void;
  mobile: boolean;
}

export const BuilderContext = createContext<BuilderContextValue | null>(null);
export function useBuilder(): BuilderContextValue {
  const v = useContext(BuilderContext);
  if (!v) throw new Error('useBuilder outside <Builder>');
  return v;
}
