import Link from 'next/link';
import { EmptyState } from '@/components/ui/Display';
import styles from './page.module.css';

export default function NotFound() {
  return (
    <div className={`container ${styles.notFound}`}>
      <EmptyState title="Nothing filed here" actions={<><Link href="/cards" className={styles.tileLink}>Browse cards</Link><Link href="/" className={styles.tileLink}>Home</Link></>}>
        That page does not exist in the vault. The card may have a different oracle id, or the link is old.
      </EmptyState>
    </div>
  );
}
