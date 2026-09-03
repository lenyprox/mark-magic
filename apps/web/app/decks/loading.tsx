import { Skeleton } from '@/components/ui/Display';
import styles from './decks.module.css';

export default function Loading() {
  return (
    <div className={`container ${styles.page}`} aria-busy="true" aria-label="Loading decks">
      <div className={styles.head}><Skeleton height={40} width={160} /><span className="grow" /><Skeleton height={36} width={110} /><Skeleton height={36} width={110} /></div>
      <Skeleton height={34} width={220} />
      <div className={styles.grid}>
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={220} className={styles.tileSkel} />)}
      </div>
    </div>
  );
}
