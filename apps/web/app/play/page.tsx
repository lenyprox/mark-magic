import type { Metadata } from 'next';
import { PlaySetup } from '@/components/play/PlaySetup';

export const metadata: Metadata = { title: 'Play' };
export const dynamic = 'force-dynamic';

export default function PlayPage() {
  return <PlaySetup />;
}
