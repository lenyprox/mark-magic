import type { Metadata } from 'next';
import { KitPage } from '@/components/dev/KitPage';

export const metadata: Metadata = { title: 'Kit', robots: { index: false } };

export default function Page() { return <KitPage />; }
