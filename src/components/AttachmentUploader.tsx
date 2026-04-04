import { useRef, useState, type ChangeEvent as ReactChangeEvent } from 'react';
import type { FileAttachment } from '../../shared/domain';
import {
  UPLOAD_SOFT_LIMIT_LABEL,
  findOversizedUpload,
  formatByteSize
} from '../../shared/uploadLimits';
import { useI18n } from '../i18n/I18nProvider';
import AdvancedSection from './AdvancedSection';
import StateBlock from './StateBlock';
import StatusBadge from './StatusBadge';

interface AttachmentUploaderProps {
  title: string;
  items: FileAttachment[];
  onUpload: (filename: string) => Promise<void>;
  onUploadFiles?: (files: File[]) => Promise<void>;
  contentUrlBuilder?: (attachmentId: string) => string;
  onDelete: (attachmentId: string) => Promise<void>;
  disabled?: boolean;
  emptyDescription: string;
  uploadButtonLabel?: string;
}

export default function AttachmentUploader({
  title,
  items,
  onUpload,
  onUploadFiles,
  contentUrlBuilder,
  onDelete,
  disabled,
  emptyDescription,
  uploadButtonLabel
}: AttachmentUploaderProps) {
  const { t } = useI18n();
  const [filename, setFilename] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const finalUploadButtonLabel = uploadButtonLabel ?? t('Upload');
  const isImageFile = (filename: string): boolean =>
    /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(filename.trim());
  const fileExtension = (filename: string): string => {
    const parts = filename.trim().split('.');
    if (parts.length <= 1) {
      return 'file';
    }
    return (parts[parts.length - 1] || 'file').toLowerCase();
  };

  const previewTokenForFile = (filename: string): string => {
    const ext = fileExtension(filename);
    if (ext === 'pdf') {
      return 'PDF';
    }
    if (ext === 'txt' || ext === 'md' || ext === 'csv') {
      return 'TXT';
    }
    if (ext === 'json' || ext === 'yaml' || ext === 'yml') {
      return 'JSON';
    }
    if (ext === 'zip' || ext === 'tar' || ext === 'gz' || ext === 'rar' || ext === '7z') {
      return 'ZIP';
    }
    return ext.toUpperCase();
  };

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

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const openAttachment = (attachmentId: string) => {
    if (!contentUrlBuilder) {
      return;
    }
    window.open(contentUrlBuilder(attachmentId), '_blank', 'noopener,noreferrer');
  };

  const uploadSelectedFiles = async (event: ReactChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    if (!onUploadFiles || selectedFiles.length === 0) {
      return;
    }

    const oversized = findOversizedUpload(selectedFiles);
    if (oversized) {
      setError(
        t('File {filename} is {size}. Keep each file under {limit} to avoid proxy rejection (413).', {
          filename: oversized.name,
          size: formatByteSize(oversized.size),
          limit: UPLOAD_SOFT_LIMIT_LABEL
        })
      );
      return;
    }

    setPending(true);
    setError('');

    try {
      await onUploadFiles(selectedFiles);
    } catch (uploadError) {
      setError((uploadError as Error).message);
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
        <button type="button" onClick={openFilePicker} disabled={isDisabled || !onUploadFiles}>
          {pending ? t('Working...') : t('Upload photos and files')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="chat-hidden-file-input"
          onChange={uploadSelectedFiles}
          disabled={isDisabled || !onUploadFiles}
        />
      </div>
      <small className="muted">
        {t('BMP and common image/document files are supported. Keep each file under {limit}.', {
          limit: UPLOAD_SOFT_LIMIT_LABEL
        })}
      </small>

      <AdvancedSection
        title={t('Manual filename upload')}
        description={t('Use this compatibility mode when direct file selection is unavailable.')}
      >
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
      </AdvancedSection>

      {error ? <StateBlock variant="error" title={t('Attachment Action Failed')} description={error} /> : null}

      {items.length === 0 ? (
        <StateBlock variant="empty" title={t('No Files Yet')} description={emptyDescription} />
      ) : (
        <ul className="list">
          {items.map((item) => (
            <li key={item.id} className="list-item stack attachment-uploader-item">
              <div className="row between gap">
                <div className="stack tight">
                  <strong>{item.filename}</strong>
                  {item.upload_error ? <small className="error-text">{item.upload_error}</small> : null}
                </div>
                <div className="row gap">
                  <StatusBadge status={item.status} />
                  {item.status === 'ready' && contentUrlBuilder ? (
                    <button onClick={() => openAttachment(item.id)} disabled={isDisabled}>
                      {t('Open')}
                    </button>
                  ) : null}
                  <button onClick={() => remove(item.id)} disabled={isDisabled}>
                    {t('Delete')}
                  </button>
                </div>
              </div>
              {item.status === 'ready' && contentUrlBuilder && isImageFile(item.filename) ? (
                <a
                  className="attachment-uploader-preview-link"
                  href={contentUrlBuilder(item.id)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    className="attachment-uploader-preview-image"
                    src={contentUrlBuilder(item.id)}
                    alt={item.filename}
                    loading="lazy"
                  />
                </a>
              ) : null}
              {item.status === 'ready' && contentUrlBuilder && !isImageFile(item.filename) ? (
                <a
                  className="attachment-uploader-preview-placeholder"
                  href={contentUrlBuilder(item.id)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="attachment-uploader-preview-token">
                    {previewTokenForFile(item.filename)}
                  </span>
                  <div className="stack tight">
                    <small>{t('Preview unavailable for this file type.')}</small>
                    <small className="muted">{t('Open file to inspect content.')}</small>
                  </div>
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
