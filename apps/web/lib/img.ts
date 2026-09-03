// URL helpers for card images served by /api/img (cached from Scryfall on first request).
export type ImageSize = 'small' | 'normal' | 'large' | 'png' | 'art_crop' | 'border_crop';

export function imgUrl(printingId: string, size: ImageSize = 'normal', face: 0 | 1 = 0): string {
  return `/api/img/${printingId}/${face}/${size}`;
}

/** Natural pixel sizes of Scryfall image variants (width x height). */
export const IMAGE_DIMENSIONS: Record<ImageSize, [number, number]> = {
  small: [146, 204], normal: [488, 680], large: [672, 936], png: [745, 1040], art_crop: [626, 457], border_crop: [480, 680],
};

export const CARD_ASPECT = 488 / 680; // width / height
