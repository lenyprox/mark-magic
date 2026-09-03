'use client';
// The static card picture: an <img> from /api/img with rounded corners and a blur-up from the small size.
// This is the shared contract between the browse/detail pages and the 3D renderer (Card3D renders on top of it).
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { imgUrl, type ImageSize } from '@/lib/img';
import styles from './CardImage.module.css';

export interface CardImageProps {
  printingId: string;
  face?: 0 | 1;
  size?: ImageSize;             // default 'normal'
  alt: string;
  /** CSS width; the height follows the 5:7 card ratio. */
  width?: number | string;
  className?: string;
  priority?: boolean;           // eager loading for above-the-fold cards
  onLoad?: () => void;
  /** Extra attributes spread onto the <img> (e.g. data-card-anchor for the renderer). */
  imgProps?: React.ImgHTMLAttributes<HTMLImageElement>;
}

export function CardImage({ printingId, face = 0, size = 'normal', alt, width, className, priority, onLoad, imgProps }: CardImageProps) {
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  const src = imgUrl(printingId, size, face);
  // Server-rendered eager images can finish loading before hydration attaches onLoad: check on mount and on src change.
  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth > 0 && img.currentSrc.endsWith(src)) { setLoaded(true); onLoad?.(); }
    else setLoaded(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
  return (
    <span className={clsx(styles.frame, loaded && styles.loaded, className)} style={width != null ? { width } : undefined}>
      <img
        {...imgProps}
        ref={ref}
        src={src}
        alt={alt}
        width={488}
        height={680}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
        draggable={false}
        onLoad={() => { setLoaded(true); onLoad?.(); }}
        className={clsx(styles.img, imgProps?.className)}
      />
    </span>
  );
}
