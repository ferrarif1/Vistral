import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  AnnotationWithReview,
  DatasetItemRecord,
  DatasetRecord,
  FileAttachment,
  ModelVersionRecord
} from '../../shared/domain';
import AnnotationCanvas, { type AnnotationBox } from '../components/AnnotationCanvas';
import PolygonCanvas, { type PolygonAnnotation } from '../components/PolygonCanvas';
import StateBlock from '../components/StateBlock';
import StatusBadge from '../components/StatusBadge';
import StepIndicator from '../components/StepIndicator';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

interface OcrLine {
  id: string;
  text: string;
  confidence: number;
  region_id: string | null;
}

const nextLineId = (): string => `line-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const toNumber = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  return fallback;
};

export default function AnnotationWorkspacePage() {
  const { t } = useI18n();
  const steps = useMemo(() => [t('Select Item'), t('Annotate'), t('Review')], [t]);
  const { datasetId } = useParams<{ datasetId: string }>();
  const [dataset, setDataset] = useState<DatasetRecord | null>(null);
  const [items, setItems] = useState<DatasetItemRecord[]>([]);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [modelVersions, setModelVersions] = useState<ModelVersionRecord[]>([]);
  const [annotations, setAnnotations] = useState<AnnotationWithReview[]>([]);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [selectedModelVersionId, setSelectedModelVersionId] = useState('');
  const [boxes, setBoxes] = useState<AnnotationBox[]>([]);
  const [ocrLines, setOcrLines] = useState<OcrLine[]>([]);
  const [polygons, setPolygons] = useState<PolygonAnnotation[]>([]);
  const [lineText, setLineText] = useState('');
  const [lineConfidence, setLineConfidence] = useState('0.9');
  const [lineRegionId, setLineRegionId] = useState('');
  const [reviewQuality, setReviewQuality] = useState('0.9');
  const [reviewComment, setReviewComment] = useState('Looks good');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!datasetId) {
      return;
    }

    const [detail, annotationList, versions] = await Promise.all([
      api.getDatasetDetail(datasetId),
      api.listDatasetAnnotations(datasetId),
      api.listModelVersions()
    ]);

    setDataset(detail.dataset);
    setItems(detail.items);
    setAttachments(detail.attachments);
    setAnnotations(annotationList);
    const matchedVersions = versions.filter((version) => version.task_type === detail.dataset.task_type);
    setModelVersions(matchedVersions);
    setSelectedModelVersionId((prev) => prev || matchedVersions[0]?.id || '');
    setSelectedItemId((prev) => prev || detail.items[0]?.id || '');
  }, [datasetId]);

  useEffect(() => {
    if (!datasetId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    load()
      .then(() => setFeedback(null))
      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }))
      .finally(() => setLoading(false));
  }, [datasetId, load]);

  useEffect(() => {
    if (!datasetId) {
      return;
    }

    const timer = window.setInterval(() => {
      load().catch(() => {
        // no-op
      });
    }, 900);

    return () => window.clearInterval(timer);
  }, [datasetId, load]);

  const selectedAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.dataset_item_id === selectedItemId) ?? null,
    [annotations, selectedItemId]
  );

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedItemId) ?? null,
    [items, selectedItemId]
  );

  const attachmentById = useMemo(
    () => new Map(attachments.map((attachment) => [attachment.id, attachment])),
    [attachments]
  );

  const selectedFilename = useMemo(() => {
    if (!selectedItem) {
      return t('No dataset item selected');
    }

    return attachmentById.get(selectedItem.attachment_id)?.filename ?? selectedItem.attachment_id;
  }, [attachmentById, selectedItem, t]);

  const currentStep = useMemo(() => {
    if (!selectedItemId) {
      return 0;
    }

    if (!selectedAnnotation) {
      return 1;
    }

    if (['in_review', 'approved', 'rejected'].includes(selectedAnnotation.status)) {
      return 2;
    }

    return 1;
  }, [selectedAnnotation, selectedItemId]);

  useEffect(() => {
    if (!selectedAnnotation) {
      setBoxes([]);
      setOcrLines([]);
      setPolygons([]);
      setLineRegionId('');
      return;
    }

    const payload = selectedAnnotation.payload as Record<string, unknown>;
    const regionEntries = Array.isArray(payload.regions)
      ? payload.regions
      : Array.isArray(payload.boxes)
        ? payload.boxes
        : [];

    const nextBoxes: AnnotationBox[] = regionEntries
      .map((entry, index) => {
        const record = entry as {
          id?: string;
          x?: number;
          y?: number;
          width?: number;
          height?: number;
          label?: string;
        };

        return {
          id: record.id ?? `box-${index + 1}`,
          x: toNumber(record.x, 40 + index * 12),
          y: toNumber(record.y, 40 + index * 8),
          width: toNumber(record.width, 120),
          height: toNumber(record.height, 80),
          label: record.label ?? `region-${index + 1}`
        };
      })
      .filter((box) => box.width > 0 && box.height > 0);

    setBoxes(nextBoxes);

    const lineEntries = Array.isArray(payload.lines) ? payload.lines : [];
    const nextLines: OcrLine[] = lineEntries
      .map((entry, index) => {
        const record = entry as {
          id?: string;
          text?: string;
          confidence?: number;
          region_id?: string | null;
        };

        if (!record.text) {
          return null;
        }

        return {
          id: record.id ?? `line-${index + 1}`,
          text: record.text,
          confidence: toNumber(record.confidence, 0.9),
          region_id: record.region_id ?? null
        };
      })
      .filter((line): line is OcrLine => line !== null);

    setOcrLines(nextLines);
    setLineRegionId((prev) => prev || nextBoxes[0]?.id || '');

    const polygonEntries = Array.isArray(payload.polygons) ? payload.polygons : [];
    const nextPolygons: PolygonAnnotation[] = polygonEntries
      .map((entry, index) => {
        const record = entry as {
          id?: string;
          label?: string;
          points?: Array<{ x?: number; y?: number }>;
        };

        const points = Array.isArray(record.points)
          ? record.points
              .map((point) => ({
                x: toNumber(point.x, 0),
                y: toNumber(point.y, 0)
              }))
              .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
          : [];

        if (points.length < 3) {
          return null;
        }

        return {
          id: record.id ?? `poly-${index + 1}`,
          label: record.label ?? `polygon-${index + 1}`,
          points
        };
      })
      .filter((polygon): polygon is PolygonAnnotation => polygon !== null);

    setPolygons(nextPolygons);
  }, [selectedAnnotation]);

  useEffect(() => {
    if (!lineRegionId) {
      return;
    }

    if (!boxes.some((box) => box.id === lineRegionId)) {
      setLineRegionId(boxes[0]?.id ?? '');
    }
  }, [boxes, lineRegionId]);

  const addOcrLine = () => {
    if (!lineText.trim()) {
      setFeedback({ variant: 'error', text: t('OCR line text cannot be empty.') });
      return;
    }

    const confidence = Number(lineConfidence);
    if (Number.isNaN(confidence)) {
      setFeedback({ variant: 'error', text: t('OCR confidence must be a valid number.') });
      return;
    }

    setOcrLines((prev) => [
      ...prev,
      {
        id: nextLineId(),
        text: lineText.trim(),
        confidence,
        region_id: lineRegionId || null
      }
    ]);
    setLineText('');
    setFeedback(null);
  };

  const removeOcrLine = (lineId: string) => {
    setOcrLines((prev) => prev.filter((line) => line.id !== lineId));
  };

  const undoLast = () => {
    if (dataset?.task_type === 'ocr') {
      setOcrLines((prev) => prev.slice(0, -1));
      return;
    }

    if (dataset?.task_type === 'segmentation') {
      if (polygons.length > 0) {
        setPolygons((prev) => prev.slice(0, -1));
        return;
      }
    }

    setBoxes((prev) => prev.slice(0, -1));
  };

  const saveAnnotation = async (status: 'in_progress' | 'annotated') => {
    if (!datasetId || !dataset || !selectedItem) {
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      const payload =
        dataset.task_type === 'ocr'
          ? {
              regions: boxes,
              lines: ocrLines
            }
          : dataset.task_type === 'segmentation'
            ? {
                polygons,
                boxes
              }
          : {
              boxes
            };

      const upserted = await api.upsertDatasetAnnotation(datasetId, {
        dataset_item_id: selectedItem.id,
        task_type: dataset.task_type,
        source: 'manual',
        status,
        payload
      });

      setFeedback({
        variant: 'success',
        text: t('Annotation {annotationId} saved as {status}.', {
          annotationId: upserted.id,
          status: t(upserted.status)
        })
      });

      await load();
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const submitReview = async () => {
    if (!datasetId || !selectedAnnotation) {
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      await api.submitAnnotationForReview(datasetId, selectedAnnotation.id);
      setFeedback({ variant: 'success', text: t('Annotation submitted for review.') });
      await load();
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const reviewAnnotation = async (status: 'approved' | 'rejected') => {
    if (!datasetId || !selectedAnnotation) {
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      await api.reviewDatasetAnnotation(datasetId, selectedAnnotation.id, {
        status,
        quality_score: Number(reviewQuality),
        review_comment: reviewComment
      });

      setFeedback({
        variant: 'success',
        text: t('Annotation {status}.', { status: t(status) })
      });
      await load();
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const runPreAnnotation = async () => {
    if (!datasetId) {
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      const result = await api.runDatasetPreAnnotations(
        datasetId,
        selectedModelVersionId || undefined
      );
      setFeedback({
        variant: 'success',
        text: t('Pre-annotation completed. created {created}, updated {updated}.', {
          created: result.created,
          updated: result.updated
        })
      });
      await load();
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const moveRejectedToProgress = async () => {
    if (!datasetId || !dataset || !selectedItem || !selectedAnnotation) {
      return;
    }

    setBusy(true);

    try {
      const payload =
        dataset.task_type === 'ocr'
          ? {
              regions: boxes,
              lines: ocrLines
            }
          : dataset.task_type === 'segmentation'
            ? {
                polygons,
                boxes
              }
          : {
              boxes
            };

      await api.upsertDatasetAnnotation(datasetId, {
        dataset_item_id: selectedItem.id,
        task_type: dataset.task_type,
        source: selectedAnnotation.source,
        status: 'in_progress',
        payload
      });
      setFeedback({ variant: 'success', text: t('Rejected annotation moved back to in_progress.') });
      await load();
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!datasetId) {
    return (
      <div className="stack">
        <h2>{t('Annotation Workspace')}</h2>
        <StateBlock variant="error" title={t('Missing Dataset ID')} description={t('Open from dataset detail page.')} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="stack">
        <h2>{t('Annotation Workspace')}</h2>
        <StateBlock variant="loading" title={t('Loading')} description={t('Preparing annotation workspace.')} />
      </div>
    );
  }

  if (!dataset) {
    return (
      <div className="stack">
        <h2>{t('Annotation Workspace')}</h2>
        <StateBlock variant="error" title={t('Dataset Not Found')} description={t('Requested dataset is unavailable.')} />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row between gap align-center">
        <div className="stack tight">
          <h2>{t('Annotation Workspace')}</h2>
          <small className="muted">
            {dataset.name} · {t('task')} {t(dataset.task_type)}
          </small>
        </div>
        <Link to={`/datasets/${dataset.id}`} className="quick-link">
          {t('Back to Dataset Detail')}
        </Link>
      </div>

      <StepIndicator steps={steps} current={currentStep} />

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}

      <section className="card stack">
        <div className="row between gap align-center">
          <h3>{t('Dataset Items')}</h3>
          <div className="row gap align-center">
            <label>
              {t('Model Version')}
              <select
                value={selectedModelVersionId}
                onChange={(event) => setSelectedModelVersionId(event.target.value)}
              >
                {modelVersions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.version_name} ({t(version.framework)})
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={runPreAnnotation}
              disabled={busy || items.length === 0 || modelVersions.length === 0}
            >
              {t('Run Pre-Annotation')}
            </button>
          </div>
        </div>
        {modelVersions.length === 0 ? (
          <StateBlock
            variant="empty"
            title={t('No Matching Model Version')}
            description={t('Register a model version with same task type before pre-annotation.')}
          />
        ) : null}
        {items.length === 0 ? (
          <StateBlock variant="empty" title={t('No Items')} description={t('Upload dataset files first.')} />
        ) : (
          <ul className="list">
            {items.map((item) => {
              const itemAnnotation = annotations.find((annotation) => annotation.dataset_item_id === item.id) ?? null;
              return (
                <li key={item.id} className="list-item">
                  <label className="row gap align-center annotation-item-select">
                    <input
                      type="radio"
                      name="selected_item"
                      checked={selectedItemId === item.id}
                      onChange={() => setSelectedItemId(item.id)}
                    />
                    <span>{item.id}</span>
                    <span className="chip">{t(item.split)}</span>
                    <StatusBadge status={item.status} />
                    {itemAnnotation ? <span className="chip">{t('Annotation')}: {t(itemAnnotation.status)}</span> : null}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="stack">
        <AnnotationCanvas
          title={t('Annotation Canvas')}
          filename={selectedFilename}
          boxes={boxes}
          onChange={setBoxes}
          disabled={busy || !selectedItem}
        />

        {dataset.task_type === 'ocr' ? (
          <section className="card stack">
            <h3>{t('OCR Text Lines')}</h3>
            <div className="annotation-ocr-grid">
              <label>
                {t('Line Text')}
                <input value={lineText} onChange={(event) => setLineText(event.target.value)} />
              </label>
              <label>
                {t('Confidence')}
                <input
                  value={lineConfidence}
                  onChange={(event) => setLineConfidence(event.target.value)}
                  placeholder="0.90"
                />
              </label>
              <label>
                {t('Region Binding')}
                <select value={lineRegionId} onChange={(event) => setLineRegionId(event.target.value)}>
                  <option value="">{t('unbound')}</option>
                  {boxes.map((box) => (
                    <option key={box.id} value={box.id}>
                      {box.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button onClick={addOcrLine} disabled={busy}>
              {t('Add OCR Line')}
            </button>

            {ocrLines.length === 0 ? (
              <StateBlock
                variant="empty"
                title={t('No OCR Lines')}
                description={t('Add OCR text lines and optionally bind to regions.')}
              />
            ) : (
              <ul className="list">
                {ocrLines.map((line) => (
                  <li key={line.id} className="list-item row between gap">
                    <div className="stack tight">
                      <strong>{line.text}</strong>
                      <small className="muted">
                        {t('confidence')} {line.confidence.toFixed(2)} · {t('region')} {line.region_id ?? t('unbound')}
                      </small>
                    </div>
                    <button onClick={() => removeOcrLine(line.id)} disabled={busy}>
                      {t('Delete')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {dataset.task_type === 'segmentation' ? (
          <PolygonCanvas
            title={t('Segmentation Polygon Canvas')}
            filename={selectedFilename}
            polygons={polygons}
            onChange={setPolygons}
            disabled={busy || !selectedItem}
          />
        ) : null}
      </section>

      <section className="card stack">
        <h3>{t('Annotation Actions')}</h3>
        {selectedAnnotation ? (
          <div className="row gap align-center">
            <span className="chip">{t('Status')}: {t(selectedAnnotation.status)}</span>
            <span className="chip">{t('Source')}: {t(selectedAnnotation.source)}</span>
            {selectedAnnotation.latest_review ? (
              <span className="chip">{t('Latest Review')}: {t(selectedAnnotation.latest_review.status)}</span>
            ) : null}
          </div>
        ) : (
          <small className="muted">{t('No annotation yet for selected item.')}</small>
        )}

        <div className="row gap wrap">
          <button
            onClick={undoLast}
            disabled={busy || (!boxes.length && !ocrLines.length && !polygons.length)}
          >
            {t('Undo Last Change')}
          </button>
          <button onClick={() => saveAnnotation('in_progress')} disabled={busy || !selectedItem}>
            {t('Save In Progress')}
          </button>
          <button onClick={() => saveAnnotation('annotated')} disabled={busy || !selectedItem}>
            {t('Mark Annotated')}
          </button>
          <button
            onClick={submitReview}
            disabled={busy || !selectedAnnotation || selectedAnnotation.status !== 'annotated'}
          >
            {t('Submit Review')}
          </button>
        </div>
      </section>

      <section className="card stack">
        <h3>{t('Review')}</h3>
        {!selectedAnnotation ? (
          <StateBlock variant="empty" title={t('No Annotation')} description={t('Create or update annotation first.')} />
        ) : selectedAnnotation.status !== 'in_review' ? (
          <StateBlock
            variant="empty"
            title={t('Not In Review')}
            description={t('Move annotation to in_review before approve/reject.')}
          />
        ) : (
          <>
            <label>
              {t('Quality Score')}
              <input
                value={reviewQuality}
                onChange={(event) => setReviewQuality(event.target.value)}
                placeholder="0.9"
              />
            </label>
            <label>
              {t('Review Comment')}
              <textarea
                value={reviewComment}
                rows={3}
                onChange={(event) => setReviewComment(event.target.value)}
              />
            </label>
            <div className="row gap">
              <button onClick={() => reviewAnnotation('approved')} disabled={busy}>
                {t('Approve')}
              </button>
              <button onClick={() => reviewAnnotation('rejected')} disabled={busy}>
                {t('Reject')}
              </button>
            </div>
          </>
        )}

        {selectedAnnotation?.status === 'rejected' ? (
          <button onClick={moveRejectedToProgress} disabled={busy}>
            {t('Move Rejected Annotation Back to In Progress')}
          </button>
        ) : null}
      </section>
    </div>
  );
}
