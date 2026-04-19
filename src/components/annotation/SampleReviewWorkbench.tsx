import type { AnnotationWithReview, DatasetItemRecord } from '../../../shared/domain';
import { Badge, StatusTag } from '../ui/Badge';
import { Card } from '../ui/Surface';
import { formatCompactTimestamp } from '../../utils/formatting';

type TranslateFn = (source: string, vars?: Record<string, string | number>) => string;

const normalizeMetadataToken = (value: string): string =>
  value
    .replace(/[_:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const formatMetadataLabel = (key: string, t: TranslateFn): string => {
    switch (key.trim().toLowerCase()) {
    case 'inference_run_id':
      return t('Inference run');
    case 'feedback_reason':
      return t('Feedback reason');
    case 'source_attachment_id':
      return t('Source attachment');
    case 'import_source_attachment_id':
      return t('Imported attachment');
    case 'original_filename':
      return t('Original filename');
    case 'source':
      return t('Source');
    default:
      return normalizeMetadataToken(key);
  }
};

const formatMetadataValue = (key: string, value: string, t: TranslateFn): string => {
  const normalizedKey = key.trim().toLowerCase();
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return t('none');
  }

  if (normalizedValue === 'true') {
    return t('Yes');
  }

  if (normalizedValue === 'false') {
    return t('No');
  }

  if (normalizedKey === 'source' || normalizedKey === 'feedback_reason') {
    return normalizeMetadataToken(normalizedValue);
  }

  return normalizedValue;
};

interface SampleReviewWorkbenchProps {
  t: TranslateFn;
  selectedFilename: string;
  selectedItem: DatasetItemRecord | null;
  selectedAnnotation: AnnotationWithReview | null;
  selectedItemTagEntries: string[];
  selectedItemOperationalMetadataEntries: Array<[string, string]>;
  className?: string;
}

export default function SampleReviewWorkbench({
  t,
  selectedFilename,
  selectedItem,
  selectedAnnotation,
  selectedItemTagEntries,
  selectedItemOperationalMetadataEntries,
  className
}: SampleReviewWorkbenchProps) {
  const metadataPreview = selectedItemOperationalMetadataEntries.slice(0, 4);
  const tagPreview = selectedItemTagEntries.slice(0, 3);
  const showItemStatus = selectedItem?.status && selectedItem.status !== 'ready';
  const showAnnotationSource = selectedAnnotation?.source && selectedAnnotation.source !== 'manual';
  const latestReview = selectedAnnotation?.latest_review ?? null;

  return (
    <Card as="section" className={className}>
      <div className="row between gap wrap align-center">
        <div className="stack tight">
          <h3>{t('Current sample summary')}</h3>
        </div>
        {selectedAnnotation ? (
          <Badge tone="info">{t(selectedAnnotation.status)}</Badge>
        ) : null}
      </div>
      <div className="row gap wrap">
        {selectedItem ? <Badge tone="neutral">{t(selectedItem.split)}</Badge> : null}
        {showItemStatus && selectedItem ? <StatusTag status={selectedItem.status}>{t(selectedItem.status)}</StatusTag> : null}
        {showAnnotationSource && selectedAnnotation ? <Badge tone="neutral">{t(selectedAnnotation.source)}</Badge> : null}
      </div>
      <div className="annotation-sample-info-list">
        <div>
          <small className="muted">{t('File')}</small>
          <strong>{selectedFilename}</strong>
        </div>
        <div>
          <small className="muted">{t('Split')}</small>
          <strong>{selectedItem ? t(selectedItem.split) : t('none')}</strong>
        </div>
        <div>
          <small className="muted">{t('Status')}</small>
          <strong>{selectedAnnotation ? t(selectedAnnotation.status) : t('Unannotated')}</strong>
        </div>
      </div>
      {tagPreview.length > 0 || metadataPreview.length > 0 ? (
        <details className="workspace-disclosure" open={false}>
          <summary>
            <span>{t('More details')}</span>
            <Badge tone="neutral">
              {tagPreview.length + metadataPreview.length}
            </Badge>
          </summary>
          <div className="workspace-disclosure-content stack">
            {tagPreview.length > 0 ? (
              <div className="row gap wrap">
                {tagPreview.map((tag) => (
                  <Badge key={`sample-tag-${tag}`} tone="neutral">
                    #{tag}
                  </Badge>
                ))}
              </div>
            ) : null}
            {metadataPreview.length > 0 ? (
              <ul className="annotation-review-metadata-list">
                {metadataPreview.map(([key, value]) => (
                  <li key={`sample-metadata-${key}`}>
                    <strong>{formatMetadataLabel(key, t)}</strong>: {formatMetadataValue(key, String(value), t)}
                  </li>
                ))}
              </ul>
            ) : null}
            <small className="muted">
              {t('Updated')}: {selectedAnnotation ? formatCompactTimestamp(selectedAnnotation.updated_at, t('none')) : t('none')}
            </small>
          </div>
        </details>
      ) : null}
      {latestReview ? (
        <details className="workspace-disclosure" open={false}>
          <summary>
            <span>{t('History')}</span>
            <Badge tone="neutral">{formatCompactTimestamp(latestReview.created_at, t('none'))}</Badge>
          </summary>
          <div className="workspace-disclosure-content">
            <div className="row gap wrap align-center">
              <StatusTag status={latestReview.status}>{t(latestReview.status)}</StatusTag>
              {latestReview.review_reason_code ? <Badge tone="warning">{t(latestReview.review_reason_code)}</Badge> : null}
              {latestReview.quality_score !== null ? (
                <Badge tone="info">
                  {t('Quality Score')}: {latestReview.quality_score.toFixed(2)}
                </Badge>
              ) : null}
            </div>
            {latestReview.review_comment ? (
              <p className="workspace-record-summary">{latestReview.review_comment}</p>
            ) : (
              <small className="muted">{t('No comment yet.')}</small>
            )}
            <small className="muted">
              {t('Reviewed at')}: {formatCompactTimestamp(latestReview.created_at, t('none'))}
            </small>
          </div>
        </details>
      ) : null}
    </Card>
  );
}
