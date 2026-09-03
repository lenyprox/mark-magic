import { Skeleton } from '@/components/ui/Display';

export default function Loading() {
  return (
    <div className="container" style={{ paddingBlock: 40, display: 'grid', gap: 16 }} aria-busy="true" aria-label="Loading">
      <Skeleton kind="text" width="38%" height={40} />
      <Skeleton kind="text" width="56%" />
      <Skeleton height={320} />
    </div>
  );
}
