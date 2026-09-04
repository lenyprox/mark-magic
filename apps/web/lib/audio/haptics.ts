'use client';
// Haptic feedback through `navigator.vibrate` (feature-detected): a short pulse when a card is dropped to cast, a
// double when an attack is declared, a thump when the viewer takes damage and a longer pattern at game over.
// Only fires for touch pointers (the last pointer-down's type is tracked), never under Playwright, and the setting
// in the table sheet turns it off.
let enabled = true;
let lastPointerType: string = 'mouse';
let uninstall: (() => void) | null = null;

export const HAPTIC = {
  cast: 14,
  attack: [12, 40, 24],
  damage: 45,
  gameOver: [30, 60, 30, 60, 90],
} as const satisfies Record<string, number | readonly number[]>;

export function configureHaptics(on: boolean) { enabled = on; }
export function hapticsSupported(): boolean { return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'; }
export function lastPointerWasTouch(): boolean { return lastPointerType === 'touch' || lastPointerType === 'pen'; }

/** Track the pointer type of every pointer-down (idempotent). */
export function installPointerTracking(): () => void {
  if (uninstall) return uninstall;
  if (typeof window === 'undefined') return () => undefined;
  const on = (e: PointerEvent) => { lastPointerType = e.pointerType || 'mouse'; };
  window.addEventListener('pointerdown', on, { capture: true, passive: true });
  uninstall = () => { window.removeEventListener('pointerdown', on, true); uninstall = null; };
  return uninstall;
}

/** Vibrate if haptics are on, supported, the last input was touch and this is not an automated run. */
export function vibrate(pattern: number | readonly number[]): boolean {
  if (!enabled || !hapticsSupported() || !lastPointerWasTouch()) return false;
  if (navigator.webdriver) return false;
  try { return navigator.vibrate(Array.isArray(pattern) ? [...(pattern as readonly number[])] : (pattern as number)); } catch { return false; }
}
