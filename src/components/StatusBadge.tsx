import type { FileAttachmentStatus } from '../../shared/domain';
import { useI18n } from '../i18n/I18nProvider';

export default function StatusBadge({ status }: { status: FileAttachmentStatus }) {
  const { t } = useI18n();
  return <span className={`badge badge-${status}`}>{t(status)}</span>;
}
