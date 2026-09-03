'use client';
import { useCallback, useEffect, useState } from 'react';

export function readLocal<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw == null ? fallback : (JSON.parse(raw) as T); } catch { return fallback; }
}
export function writeLocal<T>(key: string, value: T) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota or private mode */ }
}

/** SSR-safe localStorage state: renders the fallback first, then hydrates from storage. */
export function useLocalStorage<T>(key: string, fallback: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => { setValue(readLocal(key, fallback)); // eslint-disable-line react-hooks/exhaustive-deps
  }, [key]);
  const set = useCallback((v: T | ((prev: T) => T)) => {
    setValue(prev => { const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v; writeLocal(key, next); return next; });
  }, [key]);
  return [value, set];
}
