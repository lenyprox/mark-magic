// Owned / not-owned pill. `count` null means no collection is registered, so nothing is shown.
import { Badge } from '@/components/ui/Display';

export function OwnedBadge({ count, need, className }: { count: number | null | undefined; need?: number; className?: string }) {
  if (count == null) return null;
  if (count === 0) return <Badge tone="mute" className={className} title="Not in your registered collection">Not owned</Badge>;
  if (need != null && count < need) return <Badge tone="warn" className={className} title={`${count} of ${need} in your collection`}>Have {count} of {need}</Badge>;
  return <Badge tone="ok" dot className={className} title={`${count} in your registered collection`}>Owned ×{count}</Badge>;
}
