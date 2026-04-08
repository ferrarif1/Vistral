import type { AnnotationWithReview, DatasetItemRecord } from '../../../shared/domain';
import { Badge, StatusTag } from '../ui/Badge';
import { Card } from '../ui/Surface';
import { formatCompactTimestamp } from '../../utils/formatting';

type TranslateFn = (source: string, vars?: Record<string, string | number>) => string;

interface SampleReviewWorkbenchProps {
  t: TranslateFn;
  selectedFilename: string;
  selectedItem: DatasetItemRecord | null;
  selectedAnnotation: AnnotationWithReview | null;
  selectedItemTagEntries: string[];
  selectedItemOperationalMetadataEntries: Array<[string, string]>;
}

export default function SampleReviewWorkbench({
  t,
  selectedFilename,
  selectedItem,
  selectedAnnotation,
  selectedItemTagEntries,
  selectedItemOperationalMetadataEntries
}: SampleReviewWorkbenchProps) {
  return (
    <Card as="section">
      <div className="stack tight">
        <h3>{t('Sample Review Workbench')}</h3>
        <small className="muted">{selectedFilename}</small>
      </div>
      <div className="row gap wrap">
        {selectedItem ? <Badge tone="neutral">{t(selectedItem.split)}</Badge> : null}
        {selectedItem ? <StatusTag status={selectedItem.status}>{t(selectedItem.status)}</StatusTag> : null}
        {selectedAnnotation ? <Badge tone="info">{t(selectedAnnotation.status)}</Badge> : null}
        {selectedAnnotation ? <Badge tone="neutral">{t(selectedAnnotation.source)}</Badge> : null}
      </div>
      {selectedItemTagEntries.length > 0 ? (
        <div className="row gap wrap">
          {selectedItemTagEntries.slice(0, 6).map((tag) => (
            <Badge key={`sample-tag-${tag}`} tone="neutral">
              #{tag}
            </Badge>
          ))}
        </div>
      ) : (
        <small className="muted">{t('No tags')}</small>
      )}
      <div className="stack tight">
        <small className="muted">{t('Metadata')}</small>
        {selectedItemOperationalMetadataEntries.length > 0 ? (
          <ul className="annotation-review-metadata-list">
            {selectedItemOperationalMetadataEntries.slice(0, 6).map(([key, value]) => (
              <li key={`sample-metadata-${key}`}>
                <strong>{key}</strong>: {String(value)}
              </li>
            ))}
          </ul>
        ) : (
          <small className="muted">{t('No metadata')}</small>
        )}
      </div>
      {selectedAnnotation ? (
        <small className="muted">
          {t('Annotation updated')}: {formatCompactTimestamp(selectedAnnotation.updated_at, t('n/a'))}
        </small>
      ) : null}
    </Card>
  );
}
