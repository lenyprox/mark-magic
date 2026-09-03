import { Skeleton } from '@/components/ui/Display';

export default function Loading() {
  return (
    <div className="container" style={{ paddingBlock: 28, display: 'grid', gap: 14 }} aria-busy="true" aria-label="Loading sets">
      <Skeleton kind="text" width="20%" height={36} />
      <Skeleton kind="text" width="50%" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 6, marginTop: 24 }}>
        {Array.from({ length: 12 }, (_, i) => <Skeleton key={i} height={54} />)}
      </div>
    </div>
  );
}
