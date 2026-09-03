'use client';
import { cloneElement, isValidElement, type ReactElement, type ReactNode, useState, type HTMLAttributes } from 'react';
import { autoUpdate, flip, FloatingFocusManager, FloatingPortal, offset, type Placement, shift, size, useClick, useDismiss, useFloating, useInteractions, useRole } from '@floating-ui/react';
import clsx from 'clsx';
import styles from './overlay.module.css';

export interface PopoverProps {
  /** A single element that receives the reference props (must forward refs). */
  trigger: ReactElement<HTMLAttributes<HTMLElement>>;
  children: ReactNode | ((close: () => void) => ReactNode);
  placement?: Placement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** No padding; the content draws its own surface. */
  plain?: boolean;
  matchWidth?: boolean;
  className?: string;
  initialFocus?: number | React.RefObject<HTMLElement | null>;
  modal?: boolean;
}

export function Popover({ trigger, children, placement = 'bottom-start', open: controlled, onOpenChange, plain, matchWidth, className, initialFocus, modal = false }: PopoverProps) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlled ?? uncontrolled;
  const setOpen = (v: boolean) => { setUncontrolled(v); onOpenChange?.(v); };
  const { refs, floatingStyles, context } = useFloating({
    open, onOpenChange: setOpen, placement, whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 }), size({ apply({ rects, elements, availableHeight }) { Object.assign(elements.floating.style, { maxHeight: `${Math.max(160, availableHeight - 8)}px`, ...(matchWidth ? { width: `${rects.reference.width}px` } : {}) }); } })],
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([useClick(context), useDismiss(context), useRole(context, { role: 'dialog' })]);
  const ref = isValidElement(trigger) ? cloneElement(trigger, getReferenceProps({ ref: refs.setReference, ...trigger.props }) as HTMLAttributes<HTMLElement>) : trigger;
  return (
    <>
      {ref}
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={modal} initialFocus={initialFocus}>
            <div ref={refs.setFloating} style={floatingStyles} data-plain={plain ? 'true' : undefined} className={clsx(styles.popover, className)} {...getFloatingProps()}>
              {typeof children === 'function' ? children(() => setOpen(false)) : children}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
