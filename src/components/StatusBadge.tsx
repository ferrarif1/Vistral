import type { FileAttachmentStatus } from '../../shared/domain';
import { useI18n } from '../i18n/I18nProvider';
import { StatusTag } from './ui/Badge';

export default function StatusBadge({ status }: { status: FileAttachmentStatus }) {
  const { t } = useI18n();
  return <StatusTag status={status}>{t(status)}</StatusTag>;
}
