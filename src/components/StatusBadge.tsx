import type { AttachmentStatus } from '../types/domain';

export default function StatusBadge({ status }: { status: AttachmentStatus }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}
