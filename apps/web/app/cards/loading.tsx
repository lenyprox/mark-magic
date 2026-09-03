import { Skeleton } from '@/components/ui/Display';
import styles from './cards.module.css';

export default function Loading() {
  return (
    <div className={`container ${styles.skel}`} aria-busy="true" aria-label="Loading cards">
      <div className={styles.skelRail}>
        <Skeleton height={36} /><Skeleton kind="text" width="60%" /><Skeleton height={34} width="80%" /><Skeleton kind="text" width="40%" /><Skeleton height={30} /><Skeleton height={30} />
      </div>
      <div className={styles.skelGrid}>
        {Array.from({ length: 18 }, (_, i) => <Skeleton key={i} kind="card" />)}
      </div>
    </div>
  );
}
