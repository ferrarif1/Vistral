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
      return t('推理任务');
    case 'feedback_reason':
      return t('反馈原因');
    case 'source_attachment_id':
      return t('源附件');
    case 'import_source_attachment_id':
      return t('导入附件');
    case 'original_filename':
      return t('原始文件名');
    case 'source':
      return t('来源');
    default:
      return normalizeMetadataToken(key);
  }
};

const formatMetadataValue = (key: string, value: string, t: TranslateFn): string => {
  const normalizedKey = key.trim().toLowerCase();
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return t('无');
  }

  if (normalizedValue === 'true') {
    return t('是');
  }

  if (normalizedValue === 'false') {
    return t('否');
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
  const metadataPreview = selectedItemOperationalMetadataEntries.slice(0, 2);
  const tagPreview = selectedItemTagEntries.slice(0, 3);
  const showItemStatus = selectedItem?.status && selectedItem.status !== 'ready';
  const showAnnotationSource = selectedAnnotation?.source && selectedAnnotation.source !== 'manual';
  const hasMetadataPreview = metadataPreview.length > 0;
  const hasTagPreview = tagPreview.length > 0;
  const latestReview = selectedAnnotation?.latest_review ?? null;
  const hasVisibleSummary = hasTagPreview || hasMetadataPreview || Boolean(latestReview);

  return (
    <Card as="section" className={className}>
      <div className="row between gap wrap align-center">
        <div className="stack tight">
          <h3>{t('样本信息')}</h3>
          <small className="muted">{selectedFilename}</small>
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
      {hasTagPreview ? (
        <div className="row gap wrap">
          {tagPreview.map((tag) => (
            <Badge key={`sample-tag-${tag}`} tone="neutral">
              #{tag}
            </Badge>
          ))}
        </div>
      ) : null}
      {hasMetadataPreview ? (
        <div className="stack tight">
          <small className="muted">{t('关键字段')}</small>
          <ul className="annotation-review-metadata-list">
            {metadataPreview.map(([key, value]) => (
              <li key={`sample-metadata-${key}`}>
                <strong>{formatMetadataLabel(key, t)}</strong>: {formatMetadataValue(key, String(value), t)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {latestReview ? (
        <div className="annotation-review-inline-summary stack tight">
          <small className="muted">{t('最近复核')}</small>
          <div className="row gap wrap align-center">
            <StatusTag status={latestReview.status}>{t(latestReview.status)}</StatusTag>
            {latestReview.review_reason_code ? <Badge tone="warning">{t(latestReview.review_reason_code)}</Badge> : null}
            {latestReview.quality_score !== null ? (
              <Badge tone="info">
                {t('质量分')}: {latestReview.quality_score.toFixed(2)}
              </Badge>
            ) : null}
          </div>
          {latestReview.review_comment ? (
            <p className="workspace-record-summary">{latestReview.review_comment}</p>
          ) : (
            <small className="muted">{t('暂无复核备注。')}</small>
          )}
          <small className="muted">
            {t('复核时间')}: {formatCompactTimestamp(latestReview.created_at, t('无'))}
          </small>
        </div>
      ) : null}
      {!hasVisibleSummary ? <small className="muted">{t('暂无额外样本信息。')}</small> : null}
      {selectedItemOperationalMetadataEntries.length > metadataPreview.length ? (
        <small className="muted">
          {t('仅显示 {count} 个字段。', { count: metadataPreview.length })}
        </small>
      ) : null}
      {selectedAnnotation ? (
        <small className="muted">
          {t('标注更新时间')}: {formatCompactTimestamp(selectedAnnotation.updated_at, t('无'))}
        </small>
      ) : null}
    </Card>
  );
}
