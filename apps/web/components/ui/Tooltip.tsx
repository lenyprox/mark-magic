'use client';
import { cloneElement, isValidElement, type HTMLAttributes, type ReactElement, type ReactNode, useState } from 'react';
import { autoUpdate, flip, FloatingPortal, offset, type Placement, shift, useDismiss, useFloating, useFocus, useHover, useInteractions, useRole } from '@floating-ui/react';
import styles from './overlay.module.css';

export interface TooltipProps { content: ReactNode; children: ReactElement<HTMLAttributes<HTMLElement>>; placement?: Placement; delay?: number }

export function Tooltip({ content, children, placement = 'top', delay = 300 }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({ open, onOpenChange: setOpen, placement, whileElementsMounted: autoUpdate, middleware: [offset(6), flip(), shift({ padding: 8 })] });
  const { getReferenceProps, getFloatingProps } = useInteractions([useHover(context, { delay: { open: delay, close: 60 }, move: false }), useFocus(context), useDismiss(context), useRole(context, { role: 'tooltip' })]);
  if (!isValidElement(children)) return children;
  return (
    <>
      {cloneElement(children, getReferenceProps({ ref: refs.setReference, ...children.props }) as HTMLAttributes<HTMLElement>)}
      {open && content && (
        <FloatingPortal>
          <div ref={refs.setFloating} style={floatingStyles} className={styles.tooltip} {...getFloatingProps()}>{content}</div>
        </FloatingPortal>
      )}
    </>
  );
}
