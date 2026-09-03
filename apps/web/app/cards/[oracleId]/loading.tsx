import { Skeleton } from '@/components/ui/Display';
import styles from '../cards.module.css';

export default function Loading() {
  return (
    <div className={`container ${styles.detail}`} aria-busy="true" aria-label="Loading card">
      <div className={styles.heroCol}><Skeleton kind="card" /></div>
      <div className={styles.facts}>
        <Skeleton kind="text" width="55%" height={44} />
        <Skeleton kind="text" width="35%" />
        <Skeleton height={140} />
        <Skeleton kind="text" width="70%" />
        <Skeleton height={90} />
      </div>
    </div>
  );
}
