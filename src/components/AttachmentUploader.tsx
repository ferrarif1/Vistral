import { useState } from 'react';
import type { FileAttachment } from '../../shared/domain';
import { useI18n } from '../i18n/I18nProvider';
import StateBlock from './StateBlock';
import StatusBadge from './StatusBadge';

interface AttachmentUploaderProps {
  title: string;
  items: FileAttachment[];
  onUpload: (filename: string) => Promise<void>;
  onDelete: (attachmentId: string) => Promise<void>;
  disabled?: boolean;
  emptyDescription: string;
  uploadButtonLabel?: string;
}

export default function AttachmentUploader({
  title,
  items,
  onUpload,
  onDelete,
  disabled,
  emptyDescription,
  uploadButtonLabel
}: AttachmentUploaderProps) {
  const { t } = useI18n();
  const [filename, setFilename] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const finalUploadButtonLabel = uploadButtonLabel ?? t('Upload');

  const upload = async () => {
    const finalName = filename.trim() || `file-${Date.now()}.bin`;
    setPending(true);
    setError('');

    try {
      await onUpload(finalName);
      setFilename('');
    } catch (uploadError) {
      setError((uploadError as Error).message);
    } finally {
      setPending(false);
    }
  };

  const remove = async (attachmentId: string) => {
    setPending(true);
    setError('');

    try {
      await onDelete(attachmentId);
    } catch (removeError) {
      setError((removeError as Error).message);
    } finally {
      setPending(false);
    }
  };

  const isDisabled = pending || disabled;

  return (
    <section className="card stack">
      <div className="row gap between">
        <h3>{title}</h3>
        <span className="muted">{t('Visible in current context')}</span>
      </div>

      <div className="row gap">
        <input
          value={filename}
          placeholder={t('Enter file name, for example: sample-image.jpg')}
          onChange={(event) => setFilename(event.target.value)}
          disabled={isDisabled}
        />
        <button onClick={upload} disabled={isDisabled}>
          {pending ? t('Working...') : finalUploadButtonLabel}
        </button>
      </div>

      {error ? <StateBlock variant="error" title={t('Attachment Action Failed')} description={error} /> : null}

      {items.length === 0 ? (
        <StateBlock variant="empty" title={t('No Files Yet')} description={emptyDescription} />
      ) : (
        <ul className="list">
          {items.map((item) => (
            <li key={item.id} className="list-item stack">
              <div className="row between gap">
                <div className="stack tight">
                  <strong>{item.filename}</strong>
                  {item.upload_error ? <small className="error-text">{item.upload_error}</small> : null}
                </div>
                <div className="row gap">
                  <StatusBadge status={item.status} />
                  <button onClick={() => remove(item.id)} disabled={isDisabled}>
                    {t('Delete')}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
