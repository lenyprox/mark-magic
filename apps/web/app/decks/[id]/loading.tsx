import { Skeleton } from '@/components/ui/Display';
import styles from '@/components/deck/deck.module.css';

export default function Loading() {
  return (
    <div className={styles.shell} aria-busy="true" aria-label="Loading deck" style={{ '--left': '520px' } as React.CSSProperties}>
      <div className={styles.pane}><div className={styles.skelStack}><Skeleton height={36} /><Skeleton height={30} width="70%" />{Array.from({ length: 10 }, (_, i) => <Skeleton key={i} height={52} />)}</div></div>
      <div className={styles.sep} aria-hidden />
      <div className={styles.pane}><div className={styles.skelStack}><Skeleton height={44} width="60%" /><Skeleton height={64} /><Skeleton height={34} width="50%" />{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} height={40} />)}</div></div>
    </div>
  );
}
