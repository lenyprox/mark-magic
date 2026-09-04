'use client';
// One shared hover-preview overlay. Any <CardRef> (or grid cell) sets `preview` in the UI store with an anchor rect;
// this host positions a normal-size card next to it with floating-ui.
import { useEffect } from 'react';
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react';
import { CardImage } from '@/components/card/CardImage';
import { useUi } from '@/lib/stores/ui';
import { useCollection } from '@/lib/collection/useCollection';
import styles from './shell.module.css';

export function HoverPreviewHost() {
  const preview = useUi(s => s.preview);
  const collection = useCollection();
  const owned = preview?.oracleId && !collection.empty ? collection.owned.get(preview.oracleId) ?? 0 : null;
  const { refs, floatingStyles, update } = useFloating({ placement: 'right-start', open: !!preview, whileElementsMounted: autoUpdate, middleware: [offset(12), flip(), shift({ padding: 12 })] });
  useEffect(() => {
    if (!preview) return;
    const r = preview.anchor;
    refs.setPositionReference({ getBoundingClientRect: () => r, contextElement: document.body });
    update();
  }, [preview, refs, update]);
  useEffect(() => {
    if (!preview) return;
    const clear = () => useUi.getState().setPreview(null);
    window.addEventListener('scroll', clear, { passive: true, capture: true });
    window.addEventListener('keydown', clear);
    return () => { window.removeEventListener('scroll', clear, { capture: true }); window.removeEventListener('keydown', clear); };
  }, [preview]);
  if (!preview) return null;
  return (
    <div ref={refs.setFloating} style={floatingStyles} className={styles.preview} aria-hidden>
      <CardImage printingId={preview.printingId} face={preview.face ?? 0} size="normal" alt="" priority />
      {owned != null && <span className={styles.previewOwned} data-owned={owned ? '1' : undefined}>{owned ? `Owned ×${owned}` : 'Not owned'}</span>}
    </div>
  );
}
