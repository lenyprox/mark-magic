import { Skeleton } from '@/components/ui/Display';

export default function PlayLoading() {
  return (
    <div className="container" style={{ paddingBlock: 32, display: 'grid', gap: 16, maxWidth: 960 }} aria-busy="true" aria-label="Loading">
      <Skeleton kind="text" width={220} height={36} />
      <Skeleton height={180} />
      <Skeleton height={180} />
      <Skeleton height={120} />
    </div>
  );
}
