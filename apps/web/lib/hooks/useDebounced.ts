'use client';
import { useEffect, useRef, useState } from 'react';

export function useDebouncedValue<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** Returns a stable debounced callback. */
export function useDebouncedCallback<A extends unknown[]>(fn: (...a: A) => void, ms = 250): (...a: A) => void {
  const ref = useRef(fn); ref.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return useRef((...a: A) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => ref.current(...a), ms);
  }).current;
}
