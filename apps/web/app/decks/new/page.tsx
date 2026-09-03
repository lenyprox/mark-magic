import type { Metadata } from 'next';
import { NewDeckPage } from '@/components/deck/NewDeckPage';

export const metadata: Metadata = { title: 'New deck' };

export default function Page() {
  return <div className="container"><NewDeckPage /></div>;
}
