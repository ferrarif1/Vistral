import type { FileAttachmentStatus } from '../../shared/domain';

export default function StatusBadge({ status }: { status: FileAttachmentStatus }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}
