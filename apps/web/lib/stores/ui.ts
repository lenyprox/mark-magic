'use client';
// Small UI store: toasts, command palette, hover preview, browse view preferences.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Toast { id: number; title: string; body?: string; kind?: 'note' | 'ok' | 'warn' | 'danger'; ttl?: number }
export interface PreviewRequest { printingId: string; face?: 0 | 1; name: string; anchor: DOMRect; oracleId?: string }

interface UiState {
  toasts: Toast[];
  toast: (t: Omit<Toast, 'id'>) => number;
  dismissToast: (id: number) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  preview: PreviewRequest | null;
  setPreview: (p: PreviewRequest | null) => void;
}

let toastSeq = 1;
export const useUi = create<UiState>()((set) => ({
  toasts: [],
  toast: (t) => { const id = toastSeq++; set(s => ({ toasts: [...s.toasts, { id, ttl: 5000, ...t }] })); return id; },
  dismissToast: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  preview: null,
  setPreview: (preview) => set({ preview }),
}));

export type GridDensity = 's' | 'm' | 'l';
export type ViewMode = 'grid' | 'list';
interface BrowsePrefs { view: ViewMode; density: GridDensity; setView: (v: ViewMode) => void; setDensity: (d: GridDensity) => void }
export const useBrowsePrefs = create<BrowsePrefs>()(persist((set) => ({
  view: 'grid', density: 'm',
  setView: (view) => set({ view }), setDensity: (density) => set({ density }),
}), { name: 'vault.browse' }));

export const toast = (t: Omit<Toast, 'id'>) => useUi.getState().toast(t);
