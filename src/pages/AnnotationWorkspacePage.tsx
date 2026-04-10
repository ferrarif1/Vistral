import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type {
  AnnotationReviewReasonCode,
  AnnotationWithReview,
  DatasetItemRecord,
  DatasetRecord,
  FileAttachment,
  ModelVersionRecord
} from '../../shared/domain';
import PredictionOverlayControls from '../components/annotation/PredictionOverlayControls';
import SampleReviewWorkbench from '../components/annotation/SampleReviewWorkbench';
import type { AnnotationBox } from '../components/AnnotationCanvas';
import type { PolygonAnnotation } from '../components/PolygonCanvas';
import StateBlock from '../components/StateBlock';
import StatusBadge from '../components/StatusBadge';
import StepIndicator from '../components/StepIndicator';
import VirtualList from '../components/VirtualList';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { Checkbox, Input, Select, Textarea } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import {
  annotationQueueFilters,
  annotationStatusSortWeight,
  getAnnotationByItemId,
  getItemAnnotationStatus,
  matchesAnnotationQueue,
  normalizeAnnotationQueueFilter,
  summarizeAnnotationQueues,
  type AnnotationQueueFilter
} from '../features/annotationQueue';
import { matchesMetadataFilter } from '../features/metadataFilter';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

interface OcrLine {
  id: string;
  text: string;
  confidence: number;
  region_id: string | null;
}

interface PredictionCandidate {
  id: string;
  kind: 'ocr_line' | 'box' | 'rotated_box' | 'polygon' | 'label';
  title: string;
  confidence: number | null;
  extra: string;
  text?: string;
  regionId?: string | null;
}

const nextLineId = (): string => `line-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const toNumber = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  return fallback;
};

const toOptionalNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  return null;
};

const buildPredictionCandidates = (payload: Record<string, unknown>): PredictionCandidate[] => {
  const candidates: PredictionCandidate[] = [];

  const ocrLines = Array.isArray(payload.lines) ? payload.lines : [];
  for (let index = 0; index < ocrLines.length; index += 1) {
    const line = ocrLines[index] as { id?: unknown; text?: unknown; confidence?: unknown; region_id?: unknown };
    const text = typeof line.text === 'string' ? line.text.trim() : '';
    if (!text) {
      continue;
    }
    const confidence = toOptionalNumber(line.confidence);
    const regionId = typeof line.region_id === 'string' && line.region_id.trim() ? line.region_id : null;
    candidates.push({
      id: (typeof line.id === 'string' && line.id.trim()) || `prediction-line-${index + 1}`,
      kind: 'ocr_line',
      title: text,
      confidence,
      extra: regionId ? `region ${regionId}` : 'unbound',
      text,
      regionId
    });
  }

  const boxes = Array.isArray(payload.boxes) ? payload.boxes : [];
  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index] as { label?: unknown; score?: unknown; confidence?: unknown; width?: unknown; height?: unknown };
    const label = typeof box.label === 'string' && box.label.trim() ? box.label.trim() : `box-${index + 1}`;
    const confidence = toOptionalNumber(box.score) ?? toOptionalNumber(box.confidence);
    const width = toOptionalNumber(box.width);
    const height = toOptionalNumber(box.height);
    const areaSummary =
      width !== null && height !== null ? `${Math.max(0, Math.round(width))}×${Math.max(0, Math.round(height))}` : 'bbox';
    candidates.push({
      id: `prediction-box-${index + 1}`,
      kind: 'box',
      title: label,
      confidence,
      extra: areaSummary
    });
  }

  const rotatedBoxes = Array.isArray(payload.rotated_boxes) ? payload.rotated_boxes : [];
  for (let index = 0; index < rotatedBoxes.length; index += 1) {
    const rotatedBox = rotatedBoxes[index] as { label?: unknown; score?: unknown; confidence?: unknown; angle?: unknown };
    const label =
      typeof rotatedBox.label === 'string' && rotatedBox.label.trim()
        ? rotatedBox.label.trim()
        : `rotated-${index + 1}`;
    const confidence = toOptionalNumber(rotatedBox.score) ?? toOptionalNumber(rotatedBox.confidence);
    const angle = toOptionalNumber(rotatedBox.angle);
    candidates.push({
      id: `prediction-rotated-${index + 1}`,
      kind: 'rotated_box',
      title: label,
      confidence,
      extra: angle === null ? 'obb' : `angle ${angle.toFixed(1)}°`
    });
  }

  const polygons = Array.isArray(payload.polygons) ? payload.polygons : [];
  for (let index = 0; index < polygons.length; index += 1) {
    const polygon = polygons[index] as { label?: unknown; score?: unknown; confidence?: unknown; points?: unknown };
    const label =
      typeof polygon.label === 'string' && polygon.label.trim()
        ? polygon.label.trim()
        : `polygon-${index + 1}`;
    const confidence = toOptionalNumber(polygon.score) ?? toOptionalNumber(polygon.confidence);
    const points = Array.isArray(polygon.points) ? polygon.points.length : 0;
    candidates.push({
      id: `prediction-polygon-${index + 1}`,
      kind: 'polygon',
      title: label,
      confidence,
      extra: points > 0 ? `${points} pts` : 'polygon'
    });
  }

  const labels = Array.isArray(payload.labels) ? payload.labels : [];
  for (let index = 0; index < labels.length; index += 1) {
    const item = labels[index] as { label?: unknown; score?: unknown; confidence?: unknown };
    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : `label-${index + 1}`;
    const confidence = toOptionalNumber(item.score) ?? toOptionalNumber(item.confidence);
    candidates.push({
      id: `prediction-label-${index + 1}`,
      kind: 'label',
      title: label,
      confidence,
      extra: 'class'
    });
  }

  return candidates;
};

const hasLowConfidencePredictionSignal = (
  annotation: AnnotationWithReview | null | undefined,
  threshold: number
): boolean => {
  if (!annotation || annotation.source !== 'pre_annotation') {
    return false;
  }

  const payload = annotation.payload as Record<string, unknown>;
  const candidates = buildPredictionCandidates(payload);
  return candidates.some(
    (candidate) => candidate.confidence !== null && candidate.confidence < threshold
  );
};

const countLowConfidencePredictionSignals = (
  annotation: AnnotationWithReview | null | undefined,
  threshold: number
): number => {
  if (!annotation || annotation.source !== 'pre_annotation') {
    return 0;
  }

  const payload = annotation.payload as Record<string, unknown>;
  const candidates = buildPredictionCandidates(payload);
  return candidates.filter(
    (candidate) => candidate.confidence !== null && candidate.confidence < threshold
  ).length;
};

const backgroundRefreshIntervalMs = 5000;
const AnnotationCanvas = lazy(() => import('../components/AnnotationCanvas'));
const PolygonCanvas = lazy(() => import('../components/PolygonCanvas'));

type LoadMode = 'initial' | 'manual' | 'background';

const reviewReasonOptions: AnnotationReviewReasonCode[] = [
  'box_mismatch',
  'label_error',
  'text_error',
  'missing_object',
  'polygon_issue',
  'other'
];

const normalizeQueueSplitFilter = (
  value: string | null
): 'all' | 'train' | 'val' | 'test' | 'unassigned' => {
  if (value === 'train' || value === 'val' || value === 'test' || value === 'unassigned') {
    return value;
  }

  return 'all';
};

const normalizeQueueItemStatusFilter = (
  value: string | null
): 'all' | 'uploading' | 'processing' | 'ready' | 'error' => {
  if (value === 'uploading' || value === 'processing' || value === 'ready' || value === 'error') {
    return value;
  }

  return 'all';
};

const normalizeBinaryParam = (value: string | null, fallback: boolean): boolean => {
  if (value === null) {
    return fallback;
  }

  return value === '1' || value === 'true';
};

const buildAnnotationWorkspaceSignature = (payload: {
  dataset: DatasetRecord;
  items: DatasetItemRecord[];
  attachments: FileAttachment[];
  modelVersions: ModelVersionRecord[];
  annotations: AnnotationWithReview[];
}): string =>
  JSON.stringify({
    dataset: payload.dataset,
    items: [...payload.items].sort((left, right) => left.id.localeCompare(right.id)),
    attachments: [...payload.attachments].sort((left, right) => left.id.localeCompare(right.id)),
    modelVersions: [...payload.modelVersions].sort((left, right) => left.id.localeCompare(right.id)),
    annotations: [...payload.annotations].sort((left, right) => left.id.localeCompare(right.id))
  });

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.isContentEditable;
};

const buildScopedInferenceValidationPath = (datasetId: string, versionId?: string): string => {
  const search = new URLSearchParams();
  search.set('dataset', datasetId);
  const normalizedVersionId = versionId?.trim() ?? '';
  if (normalizedVersionId) {
    search.set('version', normalizedVersionId);
  }
  return `/inference/validate?${search.toString()}`;
};

export default function AnnotationWorkspacePage() {
  const { t } = useI18n();
  const steps = useMemo(() => [t('Select Item'), t('Annotate'), t('Review')], [t]);
  const { datasetId } = useParams<{ datasetId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const scopedDatasetVersionId = (searchParams.get('version') ?? '').trim();
  const [dataset, setDataset] = useState<DatasetRecord | null>(null);
  const [items, setItems] = useState<DatasetItemRecord[]>([]);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [modelVersions, setModelVersions] = useState<ModelVersionRecord[]>([]);
  const [annotations, setAnnotations] = useState<AnnotationWithReview[]>([]);
  const [queueFilter, setQueueFilter] = useState<AnnotationQueueFilter>(() =>
    normalizeAnnotationQueueFilter(searchParams.get('queue'))
  );
  const [queueSearchText, setQueueSearchText] = useState('');
  const [queueSplitFilter, setQueueSplitFilter] = useState<'all' | 'train' | 'val' | 'test' | 'unassigned'>('all');
  const [queueItemStatusFilter, setQueueItemStatusFilter] = useState<'all' | 'uploading' | 'processing' | 'ready' | 'error'>('all');
  const [queueMetadataFilter, setQueueMetadataFilter] = useState('');
  const [selectedItemId, setSelectedItemId] = useState('');
  const [selectedModelVersionId, setSelectedModelVersionId] = useState('');
  const [showAnnotationOverlay, setShowAnnotationOverlay] = useState(true);
  const [showPredictionOverlay, setShowPredictionOverlay] = useState(true);
  const [predictionConfidenceThreshold, setPredictionConfidenceThreshold] = useState('0.50');
  const [onlyLowConfidenceCandidates, setOnlyLowConfidenceCandidates] = useState(false);
  const [boxes, setBoxes] = useState<AnnotationBox[]>([]);
  const [ocrLines, setOcrLines] = useState<OcrLine[]>([]);
  const [polygons, setPolygons] = useState<PolygonAnnotation[]>([]);
  const [lineText, setLineText] = useState('');
  const [lineConfidence, setLineConfidence] = useState('0.9');
  const [lineRegionId, setLineRegionId] = useState('');
  const [reviewQuality, setReviewQuality] = useState('0.9');
  const [reviewComment, setReviewComment] = useState('');
  const [reviewReasonCode, setReviewReasonCode] = useState<AnnotationReviewReasonCode>('other');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const [queueToast, setQueueToast] = useState<{ variant: 'success' | 'info'; text: string } | null>(null);
  const workspaceSignatureRef = useRef('');
  const scopedInferenceValidationPath = useMemo(
    () =>
      datasetId
        ? buildScopedInferenceValidationPath(datasetId, scopedDatasetVersionId)
        : '/inference/validate',
    [datasetId, scopedDatasetVersionId]
  );

  const load = useCallback(async (mode: LoadMode) => {
    if (!datasetId) {
      return;
    }

    if (mode === 'initial') {
      setLoading(true);
    }

    if (mode === 'manual') {
      setRefreshing(true);
    }

    try {
      const [detail, annotationList, versions] = await Promise.all([
        api.getDatasetDetail(datasetId),
        api.listDatasetAnnotations(datasetId),
        api.listModelVersions()
      ]);

      const matchedVersions = versions.filter((version) => version.task_type === detail.dataset.task_type);
      const nextSignature = buildAnnotationWorkspaceSignature({
        dataset: detail.dataset,
        items: detail.items,
        attachments: detail.attachments,
        modelVersions: matchedVersions,
        annotations: annotationList
      });

      if (workspaceSignatureRef.current !== nextSignature) {
        workspaceSignatureRef.current = nextSignature;
        setDataset(detail.dataset);
        setItems(detail.items);
        setAttachments(detail.attachments);
        setAnnotations(annotationList);
        setModelVersions(matchedVersions);
        setSelectedModelVersionId((prev) =>
          prev && matchedVersions.some((version) => version.id === prev) ? prev : matchedVersions[0]?.id || ''
        );
        setSelectedItemId((prev) =>
          prev && detail.items.some((item) => item.id === prev) ? prev : detail.items[0]?.id || ''
        );
      }
    } finally {
      if (mode === 'initial') {
        setLoading(false);
      }

      if (mode === 'manual') {
        setRefreshing(false);
      }
    }
  }, [datasetId]);

  useEffect(() => {
    if (!datasetId) {
      setLoading(false);
      return;
    }

    load('initial')
      .then(() => setFeedback(null))
      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }));
  }, [datasetId, load]);

  useEffect(() => {
    const requestedQueueFilter = normalizeAnnotationQueueFilter(searchParams.get('queue'));
    setQueueFilter((current) => (current === requestedQueueFilter ? current : requestedQueueFilter));
    const requestedQueueSearchText = searchParams.get('q') ?? '';
    setQueueSearchText((current) =>
      current === requestedQueueSearchText ? current : requestedQueueSearchText
    );
    const requestedQueueSplitFilter = normalizeQueueSplitFilter(searchParams.get('split'));
    setQueueSplitFilter((current) =>
      current === requestedQueueSplitFilter ? current : requestedQueueSplitFilter
    );
    const requestedQueueItemStatusFilter = normalizeQueueItemStatusFilter(
      searchParams.get('item_status')
    );
    setQueueItemStatusFilter((current) =>
      current === requestedQueueItemStatusFilter ? current : requestedQueueItemStatusFilter
    );
    const requestedQueueMetadataFilter = searchParams.get('meta') ?? '';
    setQueueMetadataFilter((current) =>
      current === requestedQueueMetadataFilter ? current : requestedQueueMetadataFilter
    );
    const requestedShowAnnotationOverlay = normalizeBinaryParam(searchParams.get('ann'), true);
    setShowAnnotationOverlay((current) =>
      current === requestedShowAnnotationOverlay ? current : requestedShowAnnotationOverlay
    );
    const requestedShowPredictionOverlay = normalizeBinaryParam(searchParams.get('pred'), true);
    setShowPredictionOverlay((current) =>
      current === requestedShowPredictionOverlay ? current : requestedShowPredictionOverlay
    );
    const requestedOnlyLowConfidenceCandidates = normalizeBinaryParam(searchParams.get('low_conf'), false);
    setOnlyLowConfidenceCandidates((current) =>
      current === requestedOnlyLowConfidenceCandidates ? current : requestedOnlyLowConfidenceCandidates
    );
    const requestedConfidence = searchParams.get('conf') ?? '0.50';
    setPredictionConfidenceThreshold((current) =>
      current === requestedConfidence ? current : requestedConfidence
    );
  }, [searchParams]);

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
  const annotationByItemId = useMemo(() => getAnnotationByItemId(annotations), [annotations]);
  const annotationSummary = useMemo(
    () => summarizeAnnotationQueues(items, annotations),
    [annotations, items]
  );
  const hasTransientWorkspaceState = useMemo(
    () =>
      items.some((item) => item.status === 'uploading' || item.status === 'processing') ||
      annotations.some((annotation) => annotation.status === 'in_review'),
    [annotations, items]
  );
  const sortedQueueItems = useMemo(
    () =>
      [...items].sort((left, right) => {
        const leftStatus = getItemAnnotationStatus(left.id, annotationByItemId);
        const rightStatus = getItemAnnotationStatus(right.id, annotationByItemId);
        const statusDelta = annotationStatusSortWeight[leftStatus] - annotationStatusSortWeight[rightStatus];
        if (statusDelta !== 0) {
          return statusDelta;
        }
        return left.id.localeCompare(right.id);
      }),
    [annotationByItemId, items]
  );
  const queueItemsByFilter = useMemo(() => {
    const buckets: Record<AnnotationQueueFilter, DatasetItemRecord[]> = {
      all: [],
      needs_work: [],
      in_review: [],
      rejected: [],
      approved: []
    };

    for (const item of sortedQueueItems) {
      const itemStatus = getItemAnnotationStatus(item.id, annotationByItemId);
      buckets.all.push(item);
      if (matchesAnnotationQueue(itemStatus, 'needs_work')) {
        buckets.needs_work.push(item);
      }
      if (itemStatus === 'in_review') {
        buckets.in_review.push(item);
      }
      if (itemStatus === 'rejected') {
        buckets.rejected.push(item);
      }
      if (itemStatus === 'approved') {
        buckets.approved.push(item);
      }
    }

    return buckets;
  }, [annotationByItemId, sortedQueueItems]);
  const queueItems = queueItemsByFilter[queueFilter];
  const numericPredictionConfidenceThreshold = useMemo(() => {
    const parsed = Number(predictionConfidenceThreshold);
    if (Number.isNaN(parsed)) {
      return 0;
    }

    return Math.max(0, Math.min(parsed, 1));
  }, [predictionConfidenceThreshold]);
  const filteredItems = useMemo(() => {
    const normalizedSearch = queueSearchText.trim().toLowerCase();
    return queueItems.filter((item) => {
      if (queueSplitFilter !== 'all' && item.split !== queueSplitFilter) {
        return false;
      }

      if (queueItemStatusFilter !== 'all' && item.status !== queueItemStatusFilter) {
        return false;
      }

      if (normalizedSearch) {
        const filename = attachmentById.get(item.attachment_id)?.filename?.toLowerCase() ?? '';
        if (!filename.includes(normalizedSearch)) {
          return false;
        }
      }

      if (!matchesMetadataFilter(item.metadata, queueMetadataFilter)) {
        return false;
      }

      if (onlyLowConfidenceCandidates) {
        const itemAnnotation = annotationByItemId.get(item.id);
        if (!hasLowConfidencePredictionSignal(itemAnnotation, numericPredictionConfidenceThreshold)) {
          return false;
        }
      }

      return true;
    });
  }, [
    attachmentById,
    annotationByItemId,
    numericPredictionConfidenceThreshold,
    onlyLowConfidenceCandidates,
    queueItemStatusFilter,
    queueItems,
    queueMetadataFilter,
    queueSearchText,
    queueSplitFilter
  ]);
  const activeQueueFilters = useMemo(() => {
    const filters = [
      queueFilter !== 'all'
        ? `${t('Queue')}: ${queueFilter === 'needs_work' ? t('Needs Work') : t(queueFilter)}`
        : '',
      queueSearchText.trim() ? `${t('Search')}: ${queueSearchText.trim()}` : '',
      queueSplitFilter !== 'all' ? `${t('Split')}: ${t(queueSplitFilter)}` : '',
      queueItemStatusFilter !== 'all' ? `${t('Status')}: ${t(queueItemStatusFilter)}` : '',
      queueMetadataFilter.trim() ? `${t('Metadata')}: ${queueMetadataFilter.trim()}` : '',
      onlyLowConfidenceCandidates ? t('Only low-confidence') : ''
    ].filter(Boolean);

    return filters;
  }, [
    onlyLowConfidenceCandidates,
    queueFilter,
    queueItemStatusFilter,
    queueMetadataFilter,
    queueSearchText,
    queueSplitFilter,
    t
  ]);
  const queueMetadataQuickFilters = useMemo(() => {
    const lowConfidenceTaggedCount = items.filter(
      (item) => item.metadata['tag:low_confidence'] === 'true'
    ).length;
    const feedbackReturnedCount = items.filter((item) => {
      const runId = item.metadata.inference_run_id;
      return typeof runId === 'string' && runId.trim().length > 0;
    }).length;
    const feedbackReasonCounts = new Map<string, number>();
    for (const item of items) {
      const reason = item.metadata.feedback_reason;
      if (!reason || !reason.trim()) {
        continue;
      }
      const key = reason.trim().toLowerCase();
      feedbackReasonCounts.set(key, (feedbackReasonCounts.get(key) ?? 0) + 1);
    }
    const topFeedbackReason = [...feedbackReasonCounts.entries()].sort((a, b) => b[1] - a[1])[0];

    const presets: Array<{ key: string; label: string; value: string; count: number }> = [];
    if (lowConfidenceTaggedCount > 0) {
      presets.push({
        key: 'low_confidence',
        label: t('Tag · low_confidence'),
        value: 'tag:low_confidence=true',
        count: lowConfidenceTaggedCount
      });
    }
    if (feedbackReturnedCount > 0) {
      presets.push({
        key: 'feedback_return',
        label: t('Feedback Return'),
        value: 'inference_run_id',
        count: feedbackReturnedCount
      });
    }
    if (topFeedbackReason && topFeedbackReason[1] > 0) {
      presets.push({
        key: `feedback_reason_${topFeedbackReason[0]}`,
        label: t('Feedback reason · {value}', { value: topFeedbackReason[0] }),
        value: `feedback_reason=${topFeedbackReason[0]}`,
        count: topFeedbackReason[1]
      });
    }
    return presets;
  }, [items, t]);
  const clearQueueFilters = useCallback(() => {
    setQueueFilter('all');
    setQueueSearchText('');
    setQueueSplitFilter('all');
    setQueueItemStatusFilter('all');
    setQueueMetadataFilter('');
    setOnlyLowConfidenceCandidates(false);
    setPredictionConfidenceThreshold('0.50');
  }, []);
  const shouldVirtualizeQueueList = filteredItems.length > 10;
  const selectedQueueIndex = useMemo(
    () => filteredItems.findIndex((item) => item.id === selectedItemId),
    [filteredItems, selectedItemId]
  );
  const canMoveToPreviousQueueItem = selectedQueueIndex > 0;
  const canMoveToNextQueueItem =
    selectedQueueIndex >= 0
      ? selectedQueueIndex < filteredItems.length - 1
      : filteredItems.length > 0;
  const lowConfidenceCountByItemId = useMemo(() => {
    const next = new Map<string, number>();
    for (const item of filteredItems) {
      const annotation = annotationByItemId.get(item.id);
      const lowConfidenceCount = countLowConfidencePredictionSignals(
        annotation,
        numericPredictionConfidenceThreshold
      );
      if (lowConfidenceCount > 0) {
        next.set(item.id, lowConfidenceCount);
      }
    }
    return next;
  }, [annotationByItemId, filteredItems, numericPredictionConfidenceThreshold]);
  const lowConfidenceQueueRadarItems = useMemo(
    () =>
      filteredItems
        .map((item) => ({
          item,
          count: lowConfidenceCountByItemId.get(item.id) ?? 0
        }))
        .filter((entry) => entry.count > 0)
        .sort((left, right) => right.count - left.count)
        .slice(0, 6),
    [filteredItems, lowConfidenceCountByItemId]
  );
  const totalLowConfidenceQueueSignals = useMemo(
    () =>
      lowConfidenceQueueRadarItems.reduce(
        (total, entry) => total + entry.count,
        0
      ),
    [lowConfidenceQueueRadarItems]
  );
  const nextLowConfidenceQueueItemId = useMemo(() => {
    if (filteredItems.length === 0) {
      return '';
    }

    const currentIndex = selectedQueueIndex >= 0 ? selectedQueueIndex : -1;
    const loopIndexes: number[] = [];
    for (let offset = 1; offset <= filteredItems.length; offset += 1) {
      const index = (currentIndex + offset + filteredItems.length) % filteredItems.length;
      loopIndexes.push(index);
    }

    for (const index of loopIndexes) {
      const candidate = filteredItems[index];
      if (!candidate || candidate.id === selectedItemId) {
        continue;
      }
      const annotation = annotationByItemId.get(candidate.id);
      if (hasLowConfidencePredictionSignal(annotation, numericPredictionConfidenceThreshold)) {
        return candidate.id;
      }
    }

    return '';
  }, [
    annotationByItemId,
    filteredItems,
    numericPredictionConfidenceThreshold,
    selectedItemId,
    selectedQueueIndex
  ]);
  const inReviewQueueContext = useMemo(() => {
    if (queueFilter !== 'in_review') {
      return null;
    }

    const total = filteredItems.length;
    const current = selectedQueueIndex >= 0 ? selectedQueueIndex + 1 : 0;
    const remaining = current > 0 ? Math.max(total - current, 0) : total;
    return {
      current,
      total,
      remaining
    };
  }, [filteredItems.length, queueFilter, selectedQueueIndex]);
  const reviewFollowupQueues = useMemo(
    () => [
      {
        key: 'needs_work' as const,
        label: t('Open Needs Work Queue ({count})', { count: queueItemsByFilter.needs_work.length }),
        count: queueItemsByFilter.needs_work.length
      },
      {
        key: 'rejected' as const,
        label: t('Open Rejected Queue ({count})', { count: queueItemsByFilter.rejected.length }),
        count: queueItemsByFilter.rejected.length
      },
      {
        key: 'approved' as const,
        label: t('Open Approved Queue ({count})', { count: queueItemsByFilter.approved.length }),
        count: queueItemsByFilter.approved.length
      }
    ],
    [queueItemsByFilter.approved.length, queueItemsByFilter.needs_work.length, queueItemsByFilter.rejected.length, t]
  );
  const availableReviewFollowupQueues = useMemo(
    () => reviewFollowupQueues.filter((queue) => queue.count > 0),
    [reviewFollowupQueues]
  );

  useBackgroundPolling(
    () => {
      load('background').catch(() => {
        // no-op
      });
    },
    {
      intervalMs: backgroundRefreshIntervalMs,
      enabled: Boolean(datasetId) && hasTransientWorkspaceState
    }
  );

  const selectedFilename = useMemo(() => {
    if (!selectedItem) {
      return t('No dataset item selected');
    }

    return attachmentById.get(selectedItem.attachment_id)?.filename ?? t('File unavailable');
  }, [attachmentById, selectedItem, t]);
  const selectedAttachmentPreviewUrl = useMemo(() => {
    if (!selectedItem) {
      return null;
    }

    const selectedAttachmentId = selectedItem.attachment_id?.trim();
    if (!selectedAttachmentId) {
      return null;
    }

    const attachment = attachmentById.get(selectedAttachmentId);
    if (attachment && attachment.status !== 'ready') {
      return null;
    }

    return api.attachmentContentUrl(selectedAttachmentId);
  }, [attachmentById, selectedItem]);
  const isEditLocked = Boolean(
    selectedAnnotation && ['in_review', 'rejected', 'approved'].includes(selectedAnnotation.status)
  );
  const selectedItemMetadataEntries = useMemo(
    () => (selectedItem ? Object.entries(selectedItem.metadata) : []),
    [selectedItem]
  );
  const selectedItemTagEntries = useMemo(
    () =>
      selectedItemMetadataEntries
        .filter(([key]) => key.startsWith('tag:'))
        .map(([key]) => key.slice(4)),
    [selectedItemMetadataEntries]
  );
  const selectedItemOperationalMetadataEntries = useMemo(
    () => selectedItemMetadataEntries.filter(([key]) => !key.startsWith('tag:')),
    [selectedItemMetadataEntries]
  );
  const hasPredictionOverlay = selectedAnnotation?.source === 'pre_annotation';
  const predictionCandidates = useMemo(() => {
    if (!selectedAnnotation || !hasPredictionOverlay) {
      return [] as PredictionCandidate[];
    }

    const payload = selectedAnnotation.payload as Record<string, unknown>;
    return buildPredictionCandidates(payload);
  }, [hasPredictionOverlay, selectedAnnotation]);
  const lowConfidencePredictionCandidates = useMemo(
    () =>
      predictionCandidates.filter(
        (candidate) =>
          candidate.confidence !== null &&
          candidate.confidence < numericPredictionConfidenceThreshold
      ),
    [numericPredictionConfidenceThreshold, predictionCandidates]
  );
  const canUsePredictionInOcrEditor = dataset?.task_type === 'ocr' && !isEditLocked;
  const selectedItemHasLowConfidenceTag = Boolean(selectedItem?.metadata['tag:low_confidence']);
  const predictionCandidateCount = useMemo(() => {
    if (!showPredictionOverlay || !hasPredictionOverlay) {
      return 0;
    }
    return predictionCandidates.length;
  }, [
    hasPredictionOverlay,
    predictionCandidates.length,
    showPredictionOverlay
  ]);
  const lowConfidencePredictionCount = lowConfidencePredictionCandidates.length;
  const canvasBoxes = showAnnotationOverlay ? boxes : [];
  const editLockMessage = useMemo(() => {
    if (!selectedAnnotation) {
      return '';
    }

    if (selectedAnnotation.status === 'in_review') {
      return t('This annotation is locked while review is in progress.');
    }

    if (selectedAnnotation.status === 'rejected') {
      return t('Move rejected annotation back to in_progress before editing again.');
    }

    if (selectedAnnotation.status === 'approved') {
      return t('Approved annotations are read-only in this workspace.');
    }

    return '';
  }, [selectedAnnotation, t]);

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
    if (items.length === 0) {
      if (selectedItemId) {
        setSelectedItemId('');
      }
      return;
    }

    const requestedItemId = searchParams.get('item')?.trim() ?? '';
    const requestedItemVisible = requestedItemId && filteredItems.some((item) => item.id === requestedItemId);
    const currentItemVisible = selectedItemId && filteredItems.some((item) => item.id === selectedItemId);
    const fallbackItemId = queueFilter === 'all' ? items[0]?.id ?? '' : '';
    const nextSelectedItemId =
      (requestedItemVisible ? requestedItemId : '') ||
      (currentItemVisible ? selectedItemId : '') ||
      filteredItems[0]?.id ||
      fallbackItemId ||
      '';

    if (nextSelectedItemId !== selectedItemId) {
      setSelectedItemId(nextSelectedItemId);
    }
  }, [filteredItems, items, queueFilter, searchParams, selectedItemId]);

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

  useEffect(() => {
    if (selectedAnnotation?.latest_review?.review_reason_code) {
      setReviewReasonCode(selectedAnnotation.latest_review.review_reason_code);
      return;
    }

    if (dataset?.task_type === 'ocr') {
      setReviewReasonCode('text_error');
      return;
    }

    if (dataset?.task_type === 'segmentation') {
      setReviewReasonCode('polygon_issue');
      return;
    }

    setReviewReasonCode('box_mismatch');
  }, [dataset?.task_type, selectedAnnotation?.id, selectedAnnotation?.latest_review?.review_reason_code]);

  useEffect(() => {
    if (!selectedAnnotation) {
      setReviewQuality('0.9');
      setReviewComment('');
      return;
    }

    if (selectedAnnotation.latest_review?.quality_score !== null && selectedAnnotation.latest_review?.quality_score !== undefined) {
      setReviewQuality(selectedAnnotation.latest_review.quality_score.toFixed(2));
    } else {
      setReviewQuality('0.9');
    }

    setReviewComment(selectedAnnotation.latest_review?.review_comment ?? '');
  }, [selectedAnnotation?.id, selectedAnnotation]);

  useEffect(() => {
    if (!queueToast) {
      return;
    }

    const timer = window.setTimeout(() => {
      setQueueToast(null);
    }, 2200);

    return () => window.clearTimeout(timer);
  }, [queueToast]);

  useEffect(() => {
    const nextParams = new URLSearchParams(searchParams);
    if (queueFilter === 'all') {
      nextParams.delete('queue');
    } else {
      nextParams.set('queue', queueFilter);
    }

    if (selectedItemId) {
      nextParams.set('item', selectedItemId);
    } else {
      nextParams.delete('item');
    }

    if (queueSearchText.trim()) {
      nextParams.set('q', queueSearchText.trim());
    } else {
      nextParams.delete('q');
    }

    if (queueSplitFilter === 'all') {
      nextParams.delete('split');
    } else {
      nextParams.set('split', queueSplitFilter);
    }

    if (queueItemStatusFilter === 'all') {
      nextParams.delete('item_status');
    } else {
      nextParams.set('item_status', queueItemStatusFilter);
    }

    if (queueMetadataFilter.trim()) {
      nextParams.set('meta', queueMetadataFilter.trim());
    } else {
      nextParams.delete('meta');
    }

    if (showAnnotationOverlay) {
      nextParams.delete('ann');
    } else {
      nextParams.set('ann', '0');
    }

    if (showPredictionOverlay) {
      nextParams.delete('pred');
    } else {
      nextParams.set('pred', '0');
    }

    if (onlyLowConfidenceCandidates) {
      nextParams.set('low_conf', '1');
    } else {
      nextParams.delete('low_conf');
    }

    if (predictionConfidenceThreshold.trim() && predictionConfidenceThreshold.trim() !== '0.50') {
      nextParams.set('conf', predictionConfidenceThreshold.trim());
    } else {
      nextParams.delete('conf');
    }

    if (nextParams.toString() !== searchParams.toString()) {
      setSearchParams(nextParams, { replace: true });
    }
  }, [
    onlyLowConfidenceCandidates,
    predictionConfidenceThreshold,
    queueFilter,
    queueItemStatusFilter,
    queueMetadataFilter,
    queueSearchText,
    queueSplitFilter,
    searchParams,
    selectedItemId,
    setSearchParams,
    showAnnotationOverlay,
    showPredictionOverlay
  ]);

  const focusWorkspaceItem = useCallback(
    (nextQueueFilter: AnnotationQueueFilter, nextItemId: string) => {
      setQueueFilter(nextQueueFilter);
      setSelectedItemId(nextItemId);
    },
    []
  );
  const openQueueFilter = useCallback(
    (targetFilter: AnnotationQueueFilter) => {
      const targetItems = queueItemsByFilter[targetFilter];
      focusWorkspaceItem(targetFilter, targetItems[0]?.id ?? '');
    },
    [focusWorkspaceItem, queueItemsByFilter]
  );

  const focusAdjacentQueueItem = useCallback(
    (direction: -1 | 1) => {
      if (filteredItems.length === 0) {
        return;
      }

      if (selectedQueueIndex < 0) {
        focusWorkspaceItem(queueFilter, filteredItems[0].id);
        return;
      }

      const nextIndex = selectedQueueIndex + direction;
      if (nextIndex < 0 || nextIndex >= filteredItems.length) {
        return;
      }

      focusWorkspaceItem(queueFilter, filteredItems[nextIndex].id);
    },
    [filteredItems, focusWorkspaceItem, queueFilter, selectedQueueIndex]
  );
  const focusNextLowConfidenceQueueItem = useCallback(() => {
    if (!nextLowConfidenceQueueItemId) {
      setQueueToast({
        variant: 'info',
        text: t('No additional low-confidence sample found in current queue.')
      });
      return;
    }

    focusWorkspaceItem(queueFilter, nextLowConfidenceQueueItemId);
    setQueueToast({
      variant: 'info',
      text: t('Moved to next low-confidence sample in current queue.')
    });
  }, [focusWorkspaceItem, nextLowConfidenceQueueItemId, queueFilter, t]);

  const toggleLowConfidenceTagForSelectedItem = useCallback(async () => {
    if (!datasetId || !selectedItem) {
      return;
    }

    const nextMetadata = { ...selectedItem.metadata };
    if (nextMetadata['tag:low_confidence']) {
      delete nextMetadata['tag:low_confidence'];
      delete nextMetadata['triage:confidence'];
    } else {
      nextMetadata['tag:low_confidence'] = 'true';
      nextMetadata['triage:confidence'] = 'low';
    }

    setBusy(true);
    setFeedback(null);
    try {
      await api.updateDatasetItem(datasetId, selectedItem.id, {
        metadata: nextMetadata
      });
      await load('manual');
      setFeedback({
        variant: 'success',
        text: nextMetadata['tag:low_confidence']
          ? t('Selected sample tagged as low-confidence triage.')
          : t('Low-confidence triage tag removed from selected sample.')
      });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [datasetId, load, selectedItem, t]);

  const applyPredictionCandidateToOcrEditor = useCallback(
    (candidate: PredictionCandidate) => {
      if (candidate.kind !== 'ocr_line' || !candidate.text) {
        return;
      }

      setLineText(candidate.text);
      setLineConfidence(
        candidate.confidence !== null ? candidate.confidence.toFixed(2) : '0.90'
      );
      if (candidate.regionId && boxes.some((box) => box.id === candidate.regionId)) {
        setLineRegionId(candidate.regionId);
      }
      setQueueToast({
        variant: 'info',
        text: t('Prediction line loaded into OCR editor. Adjust and add it as needed.')
      });
    },
    [boxes, t]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        isTypingTarget(event.target)
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === 'j') {
        if (!canMoveToNextQueueItem) {
          return;
        }
        event.preventDefault();
        focusAdjacentQueueItem(1);
        return;
      }

      if (key === 'k') {
        if (!canMoveToPreviousQueueItem) {
          return;
        }
        event.preventDefault();
        focusAdjacentQueueItem(-1);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canMoveToNextQueueItem, canMoveToPreviousQueueItem, focusAdjacentQueueItem]);

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
        text: t('Annotation saved as {status}.', { status: t(upserted.status) })
      });

      await load('manual');
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
      await load('manual');
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const reviewAnnotation = useCallback(
    async (status: 'approved' | 'rejected', options?: { continueInQueue?: boolean }) => {
      if (!datasetId || !selectedAnnotation) {
        return;
      }

      if (status === 'rejected' && !reviewReasonCode) {
        setFeedback({ variant: 'error', text: t('Select a reject reason before rejecting this annotation.') });
        return;
      }

      setBusy(true);
      setFeedback(null);
      const continueInQueue = options?.continueInQueue === true;
      const currentInReviewQueueTotal = queueFilter === 'in_review' ? filteredItems.length : 0;
      const remainingAfterCurrentReview = currentInReviewQueueTotal > 0 ? Math.max(currentInReviewQueueTotal - 1, 0) : 0;
      const nextInReviewItemId =
        continueInQueue && queueFilter === 'in_review' && selectedItem
          ? (() => {
              const currentIndex = filteredItems.findIndex((item) => item.id === selectedItem.id);
              if (currentIndex < 0) {
                return '';
              }

              for (let index = currentIndex + 1; index < filteredItems.length; index += 1) {
                const candidateId = filteredItems[index]?.id ?? '';
                if (candidateId && candidateId !== selectedItem.id) {
                  return candidateId;
                }
              }

              for (let index = 0; index < currentIndex; index += 1) {
                const candidateId = filteredItems[index]?.id ?? '';
                if (candidateId && candidateId !== selectedItem.id) {
                  return candidateId;
                }
              }

              return '';
            })()
          : '';

      try {
        await api.reviewDatasetAnnotation(datasetId, selectedAnnotation.id, {
          status,
          review_reason_code: status === 'rejected' ? reviewReasonCode : null,
          quality_score: Number(reviewQuality),
          review_comment: reviewComment
        });

        await load('manual');
        if (continueInQueue && queueFilter === 'in_review') {
          focusWorkspaceItem('in_review', nextInReviewItemId);
          setFeedback({
            variant: 'success',
            text: nextInReviewItemId
              ? t('Annotation {status}. Continued to next in-review item.', { status: t(status) })
              : t('Annotation {status}. No more items in in_review queue.', { status: t(status) })
          });
          if (nextInReviewItemId) {
            setQueueToast({
              variant: 'success',
              text: t('Review saved. {count} items remain in in_review queue.', { count: remainingAfterCurrentReview })
            });
          } else {
            setQueueToast({
              variant: 'info',
              text: t('In-review queue cleared. Great job.')
            });
          }
        } else {
          setFeedback({
            variant: 'success',
            text: t('Annotation {status}.', { status: t(status) })
          });
        }
      } catch (error) {
        setFeedback({ variant: 'error', text: (error as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [
      datasetId,
      filteredItems,
      focusWorkspaceItem,
      load,
      queueFilter,
      reviewComment,
      reviewQuality,
      reviewReasonCode,
      selectedAnnotation,
      selectedItem,
      t
    ]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        isTypingTarget(event.target)
      ) {
        return;
      }

      if (!selectedAnnotation || selectedAnnotation.status !== 'in_review' || busy) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key !== 'a' && key !== 'r') {
        return;
      }

      event.preventDefault();
      void reviewAnnotation(key === 'a' ? 'approved' : 'rejected', {
        continueInQueue: queueFilter === 'in_review'
      });
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, queueFilter, reviewAnnotation, selectedAnnotation]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        isTypingTarget(event.target)
      ) {
        return;
      }

      if (queueFilter !== 'in_review' || filteredItems.length > 0 || availableReviewFollowupQueues.length === 0 || busy) {
        return;
      }

      const key = event.key.trim();
      if (!['1', '2', '3'].includes(key)) {
        return;
      }

      const queue = availableReviewFollowupQueues[Number(key) - 1];
      if (!queue) {
        return;
      }

      event.preventDefault();
      openQueueFilter(queue.key);
      setQueueToast({
        variant: 'info',
        text: t('Switched to {queue} queue.', { queue: t(queue.key === 'needs_work' ? 'Needs Work' : queue.key) })
      });
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [availableReviewFollowupQueues, busy, filteredItems.length, openQueueFilter, queueFilter, t]);

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
      await load('manual');
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

      const updated = await api.upsertDatasetAnnotation(datasetId, {
        dataset_item_id: selectedItem.id,
        task_type: dataset.task_type,
        source: selectedAnnotation.source,
        status: 'in_progress',
        payload
      });
      setAnnotations((current) =>
        current.map((annotation) =>
          annotation.id === selectedAnnotation.id
            ? updated
            : annotation
        )
      );
      focusWorkspaceItem('needs_work', selectedItem.id);
      setFeedback({ variant: 'success', text: t('Rejected annotation moved back to in_progress.') });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const heroSection = (
    <WorkspaceHero
      eyebrow={t('Annotation Lane')}
      title={t('Annotation Workspace')}
      description={
        dataset
          ? `${dataset.name} · ${t('task')} ${t(dataset.task_type)}`
          : t('Review queue status, annotate items, and complete approvals in one flow.')
      }
      stats={[
        { label: t('Items'), value: items.length },
        { label: t('Visible'), value: filteredItems.length },
        { label: t('Models'), value: modelVersions.length },
        {
          label: t('Queue'),
          value: queueFilter === 'all' ? t('All') : queueFilter === 'needs_work' ? t('Needs Work') : t(queueFilter)
        }
      ]}
    />
  );

  const renderShell = (content: ReactNode) => (
    <WorkspacePage>
      {heroSection}
      {content}
    </WorkspacePage>
  );

  if (!datasetId) {
    return renderShell(
      <StateBlock variant="error" title={t('Missing Dataset ID')} description={t('Open from dataset detail page.')} />
    );
  }

  if (loading) {
    return renderShell(
      <StateBlock variant="loading" title={t('Loading')} description={t('Preparing annotation workspace.')} />
    );
  }

  if (!dataset) {
    return renderShell(
      <StateBlock variant="error" title={t('Dataset Not Found')} description={t('Requested dataset is unavailable.')} />
    );
  }

  return (
    <WorkspacePage>
      {heroSection}

      <StepIndicator steps={steps} current={currentStep} />

      {queueToast ? (
        <div className={`workspace-toast ${queueToast.variant}`} role="status" aria-live="polite">
          {queueToast.text}
        </div>
      ) : null}

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}

      <WorkspaceMetricGrid
        items={[
          {
            title: t('Needs Work'),
            description: t('Items still awaiting annotation or submit-review actions.'),
            value: annotationSummary.needs_work
          },
          {
            title: t('in_review'),
            description: t('Items currently in reviewer lane.'),
            value: annotationSummary.in_review,
            tone: annotationSummary.in_review > 0 ? 'attention' : 'default'
          },
          {
            title: t('rejected'),
            description: t('Rejected items that should be moved back to rework flow.'),
            value: annotationSummary.rejected,
            tone: annotationSummary.rejected > 0 ? 'attention' : 'default'
          },
          {
            title: t('approved'),
            description: t('Approved items are ready for downstream versioning and training.'),
            value: annotationSummary.approved
          }
        ]}
      />

      <section className="annotation-studio-layout">
      <div className="annotation-studio-queue">
      <Card as="section">
        <WorkspaceSectionHeader
          title={t('Annotation Queue')}
          description={t('Visible items {visible} / {total}', {
            visible: filteredItems.length,
            total: items.length
          })}
        />
        <div className="row gap wrap align-center">
          <Badge tone="neutral">{t('Queue')}: {queueFilter === 'all' ? t('All items') : queueFilter === 'needs_work' ? t('Needs Work') : t(queueFilter)}</Badge>
          <Badge tone="info">{t('Visible items')}: {filteredItems.length}</Badge>
          <Badge tone="neutral">{t('Dataset')}: {dataset.name}</Badge>
          {scopedDatasetVersionId ? (
            <Badge tone="info">{t('Version')}: {scopedDatasetVersionId}</Badge>
          ) : null}
          {selectedItem ? (
            <Badge tone="neutral">{t('Selected')}: {selectedFilename}</Badge>
          ) : null}
        </div>
        <small className="muted">
          {t('Queue summary')}: {annotationSummary.needs_work} {t('needs_work')} / {annotationSummary.in_review} {t('in_review')} / {annotationSummary.approved} {t('approved')} / {annotationSummary.rejected} {t('rejected')}
        </small>
        <div className="annotation-filter-row">
          {annotationQueueFilters.map((filter) => {
            const count =
              filter === 'all'
                ? annotationSummary.total
                : filter === 'needs_work'
                  ? annotationSummary.needs_work
                  : annotationSummary[filter];
            const nextItems = queueItemsByFilter[filter];
            const nextSelectedItemId = nextItems.some((item) => item.id === selectedItemId)
              ? selectedItemId
              : nextItems[0]?.id ?? items[0]?.id ?? '';
            const isActive = queueFilter === filter;

            return (
              <Button
                key={filter}
                type="button"
                variant={isActive ? 'primary' : 'secondary'}
                size="sm"
                trailing={<Badge tone={isActive ? 'neutral' : 'info'}>{count}</Badge>}
                onClick={() => {
                  focusWorkspaceItem(filter, nextSelectedItemId);
                }}
                disabled={busy}
              >
                {filter === 'all' ? t('All items') : filter === 'needs_work' ? t('Needs Work') : t(filter)}
              </Button>
            );
          })}
        </div>
        <div className="annotation-queue-advanced-filters">
          <Input
            value={queueSearchText}
            onChange={(event) => setQueueSearchText(event.target.value)}
            placeholder={t('Search filename')}
          />
          <Select
            value={queueSplitFilter}
            onChange={(event) =>
              setQueueSplitFilter(
                event.target.value as 'all' | 'train' | 'val' | 'test' | 'unassigned'
              )
            }
          >
            <option value="all">{t('All splits')}</option>
            <option value="unassigned">{t('unassigned')}</option>
            <option value="train">{t('train')}</option>
            <option value="val">{t('val')}</option>
            <option value="test">{t('test')}</option>
          </Select>
          <Select
            value={queueItemStatusFilter}
            onChange={(event) =>
              setQueueItemStatusFilter(
                event.target.value as 'all' | 'uploading' | 'processing' | 'ready' | 'error'
              )
            }
          >
            <option value="all">{t('All statuses')}</option>
            <option value="ready">{t('ready')}</option>
            <option value="processing">{t('processing')}</option>
            <option value="uploading">{t('uploading')}</option>
            <option value="error">{t('error')}</option>
          </Select>
                <Input
                  value={queueMetadataFilter}
                  onChange={(event) => setQueueMetadataFilter(event.target.value)}
                  placeholder={t('Filter metadata/tag (supports key=value)')}
                />
        </div>
        <div className="annotation-queue-filter-summary">
          <div className="row gap wrap">
            {activeQueueFilters.length > 0 ? (
              activeQueueFilters.map((filter) => (
                <Badge key={`queue-filter-${filter}`} tone="neutral">
                  {filter}
                </Badge>
              ))
            ) : (
              <small className="muted">{t('No active queue filters')}</small>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearQueueFilters}
            disabled={busy || activeQueueFilters.length === 0}
          >
            {t('Clear filters')}
          </Button>
        </div>
        {queueMetadataQuickFilters.length > 0 ? (
          <div className="annotation-queue-filter-summary">
            <div className="row gap wrap align-center">
              <small className="muted">{t('Metadata quick filters')}:</small>
              {queueMetadataQuickFilters.map((preset) => (
                <Button
                  key={preset.key}
                  type="button"
                  variant="secondary"
                  size="sm"
                  trailing={<Badge tone="info">{preset.count}</Badge>}
                  onClick={() => {
                    setQueueMetadataFilter(preset.value);
                  }}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="annotation-queue-lowconf-row">
          <div className="row gap wrap align-center">
            <Badge tone={lowConfidenceQueueRadarItems.length > 0 ? 'warning' : 'neutral'}>
              {t('Low-confidence samples')}: {lowConfidenceQueueRadarItems.length}
            </Badge>
            <Badge tone={totalLowConfidenceQueueSignals > 0 ? 'warning' : 'neutral'}>
              {t('Low-confidence signals')}: {totalLowConfidenceQueueSignals}
            </Badge>
          </div>
          <Button
            type="button"
            variant={onlyLowConfidenceCandidates ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setOnlyLowConfidenceCandidates((current) => !current)}
          >
            {onlyLowConfidenceCandidates
              ? t('Show full queue')
              : t('Only low-confidence')}
          </Button>
        </div>
        <div className="annotation-queue-nav">
          <small className="muted">
            {selectedQueueIndex >= 0
              ? t('Queue position {current} / {total}', {
                  current: selectedQueueIndex + 1,
                  total: filteredItems.length
                })
              : filteredItems.length > 0
                ? t('No item selected in current queue.')
                : t('Visible items {visible} / {total}', {
                    visible: filteredItems.length,
                    total: items.length
                  })}
          </small>
          <div className="annotation-queue-nav-actions">
            <small className="muted annotation-queue-shortcuts">{t('Queue shortcuts: J next · K previous')}</small>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => focusAdjacentQueueItem(-1)}
              disabled={busy || !canMoveToPreviousQueueItem}
            >
              {t('Previous Item')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => focusAdjacentQueueItem(1)}
              disabled={busy || !canMoveToNextQueueItem}
            >
              {t('Next Item')}
            </Button>
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
        ) : filteredItems.length === 0 ? (
          <StateBlock
            variant="empty"
            title={queueFilter === 'in_review' ? t('In-review queue is clear.') : t('No items in this queue right now.')}
            description={
              queueFilter === 'in_review'
                ? t('All submitted items are now processed. Switch queue filters for follow-up.')
                : t('Switch queue filters or run pre-annotation to continue.')
            }
            extra={
              queueFilter === 'in_review' ? (
                <div className="row gap wrap review-empty-followup">
                  {availableReviewFollowupQueues.length > 0 ? (
                    <>
                      <small className="muted review-followup-shortcuts">
                        {t('Follow-up shortcuts: press 1 / 2 / 3 to open visible queues.')}
                      </small>
                      {availableReviewFollowupQueues.map((queue, index) => (
                        <Button
                          key={queue.key}
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => openQueueFilter(queue.key)}
                          disabled={busy}
                          title={t('Shortcut {key}', { key: index + 1 })}
                        >
                          {queue.label}
                        </Button>
                      ))}
                    </>
                  ) : (
                    <small className="muted">{t('No follow-up queues with pending items.')}</small>
                  )}
                </div>
              ) : null
            }
          />
        ) : shouldVirtualizeQueueList ? (
            <VirtualList
              items={filteredItems}
              itemHeight={112}
              height={440}
              ariaLabel={t('Annotation Queue')}
              listClassName="workspace-record-list"
              itemKey={(item) => item.id}
              renderItem={(item) => {
                const itemAnnotation = annotationByItemId.get(item.id) ?? null;
                const itemFilename = attachmentById.get(item.attachment_id)?.filename ?? t('File unavailable');
                const lowConfidenceCount = lowConfidenceCountByItemId.get(item.id) ?? 0;
                return (
                  <div className={`workspace-record-item virtualized${selectedItemId === item.id ? ' selected' : ''}`}>
                    <label className="row gap wrap align-center annotation-item-select">
                      <Checkbox
                        type="radio"
                        name="selected_item"
                        checked={selectedItemId === item.id}
                        onChange={() => {
                          focusWorkspaceItem(queueFilter, item.id);
                        }}
                      />
                      <div className="stack tight annotation-item-copy">
                        <strong>{itemFilename}</strong>
                      </div>
                      <Badge tone="neutral">{t(item.split)}</Badge>
                      <StatusBadge status={item.status} />
                      {itemAnnotation ? <Badge tone="info">{t('Annotation')}: {t(itemAnnotation.status)}</Badge> : null}
                      {!itemAnnotation ? <Badge tone="warning">{t('Annotation')}: {t('unannotated')}</Badge> : null}
                      {lowConfidenceCount > 0 ? (
                        <Badge tone="warning">{t('Low conf')}: {lowConfidenceCount}</Badge>
                      ) : null}
                      {itemAnnotation?.latest_review?.review_reason_code ? (
                        <Badge tone="warning">{t(itemAnnotation.latest_review.review_reason_code)}</Badge>
                      ) : null}
                    </label>
                    {itemAnnotation?.latest_review?.review_comment ? (
                      <small className="muted line-clamp-2">{itemAnnotation.latest_review.review_comment}</small>
                    ) : null}
                  </div>
                );
              }}
            />
          ) : (
            <ul className="workspace-record-list">
              {filteredItems.map((item) => {
                const itemAnnotation = annotationByItemId.get(item.id) ?? null;
                const itemFilename = attachmentById.get(item.attachment_id)?.filename ?? t('File unavailable');
                const lowConfidenceCount = lowConfidenceCountByItemId.get(item.id) ?? 0;
                return (
                  <Panel
                    key={item.id}
                    as="li"
                    className={`workspace-record-item${selectedItemId === item.id ? ' selected' : ''}`}
                    tone="soft"
                  >
                    <label className="row gap wrap align-center annotation-item-select">
                      <Checkbox
                        type="radio"
                        name="selected_item"
                        checked={selectedItemId === item.id}
                        onChange={() => {
                          focusWorkspaceItem(queueFilter, item.id);
                        }}
                      />
                      <div className="stack tight annotation-item-copy">
                        <strong>{itemFilename}</strong>
                      </div>
                      <Badge tone="neutral">{t(item.split)}</Badge>
                      <StatusBadge status={item.status} />
                      {itemAnnotation ? <Badge tone="info">{t('Annotation')}: {t(itemAnnotation.status)}</Badge> : null}
                      {!itemAnnotation ? <Badge tone="warning">{t('Annotation')}: {t('unannotated')}</Badge> : null}
                      {lowConfidenceCount > 0 ? (
                        <Badge tone="warning">{t('Low conf')}: {lowConfidenceCount}</Badge>
                      ) : null}
                      {itemAnnotation?.latest_review?.review_reason_code ? (
                        <Badge tone="warning">{t(itemAnnotation.latest_review.review_reason_code)}</Badge>
                      ) : null}
                    </label>
                    {itemAnnotation?.latest_review?.review_comment ? (
                      <small className="muted line-clamp-2">{itemAnnotation.latest_review.review_comment}</small>
                    ) : null}
                  </Panel>
                );
              })}
            </ul>
          )
        }
      </Card>
      </div>

      <WorkspaceWorkbench
        className="annotation-studio-workbench"
        toolbar={
          <Card as="section" className="workspace-toolbar-card">
            <div className="workspace-toolbar-head">
              <div className="workspace-toolbar-copy">
                <h3>{t('Annotation Controls')}</h3>
                <small className="muted">
                  {t('Keep queue prep, pre-annotation, and workspace navigation together before entering the review lane.')}
                </small>
              </div>
              <div className="workspace-toolbar-actions">
                <label className="stack tight">
                  <small className="muted">{t('Model Version')}</small>
                  <Select
                    value={selectedModelVersionId}
                    onChange={(event) => setSelectedModelVersionId(event.target.value)}
                  >
                    {modelVersions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {version.version_name} ({t(version.framework)})
                      </option>
                    ))}
                  </Select>
                </label>
                <Button
                  onClick={runPreAnnotation}
                  variant="secondary"
                  size="sm"
                  disabled={busy || items.length === 0 || modelVersions.length === 0}
                >
                  {t('Run Pre-Annotation')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    load('manual').catch((loadError) => {
                      setFeedback({ variant: 'error', text: (loadError as Error).message });
                    });
                  }}
                  disabled={busy || refreshing}
                >
                  {refreshing ? t('Refreshing...') : t('Refresh')}
                </Button>
                <ButtonLink size="sm" variant="ghost" to={`/datasets/${dataset.id}`}>
                  {t('Back to Dataset')}
                </ButtonLink>
                <ButtonLink size="sm" variant="ghost" to={scopedInferenceValidationPath}>
                  {t('Validate Inference')}
                </ButtonLink>
              </div>
            </div>
            <div className="workspace-toolbar-meta">
              <div className="workspace-segmented-actions">
                <Badge tone="neutral">
                  {t('Queue')}: {queueFilter === 'all' ? t('All items') : queueFilter === 'needs_work' ? t('Needs Work') : t(queueFilter)}
                </Badge>
                <Badge tone="info">{t('Visible items')}: {filteredItems.length}</Badge>
                <Badge tone="neutral">{t('Dataset')}: {dataset.name}</Badge>
                {scopedDatasetVersionId ? (
                  <Badge tone="info">{t('Version')}: {scopedDatasetVersionId}</Badge>
                ) : null}
                {selectedItem ? (
                  <Badge tone="neutral">{t('Selected')}: {selectedFilename}</Badge>
                ) : null}
              </div>
            </div>
          </Card>
        }
        main={
          <div className="workspace-main-stack">
          <section className="stack">
            <Suspense
              fallback={
                <StateBlock variant="loading" title={t('Loading')} description={t('Preparing annotation canvas.')} />
              }
            >
              <AnnotationCanvas
                title={t('Annotation Canvas')}
                filename={selectedFilename}
                imageUrl={selectedAttachmentPreviewUrl}
                boxes={canvasBoxes}
                onChange={setBoxes}
                disabled={busy || !selectedItem || isEditLocked}
              />
            </Suspense>

            {dataset.task_type === 'ocr' ? (
              <Card as="section">
                <h3>{t('OCR Text Lines')}</h3>
                <div className="annotation-ocr-grid">
                  <label>
                    {t('Line Text')}
                    <Input value={lineText} onChange={(event) => setLineText(event.target.value)} disabled={busy || isEditLocked} />
                  </label>
                  <label>
                    {t('Confidence')}
                    <Input
                      value={lineConfidence}
                      onChange={(event) => setLineConfidence(event.target.value)}
                      placeholder="0.90"
                      disabled={busy || isEditLocked}
                    />
                  </label>
                  <label>
                    {t('Region Binding')}
                    <Select value={lineRegionId} onChange={(event) => setLineRegionId(event.target.value)} disabled={busy || isEditLocked}>
                      <option value="">{t('unbound')}</option>
                      {boxes.map((box) => (
                        <option key={box.id} value={box.id}>
                          {box.label}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>
                <Button onClick={addOcrLine} variant="secondary" size="sm" disabled={busy || isEditLocked}>
                  {t('Add OCR Line')}
                </Button>

                {ocrLines.length === 0 ? (
                  <StateBlock
                    variant="empty"
                    title={t('No OCR Lines')}
                    description={t('Add OCR text lines and optionally bind to regions.')}
                  />
                ) : (
                  <ul className="workspace-record-list compact">
                    {ocrLines.map((line) => (
                      <Panel key={line.id} as="li" className="workspace-record-item compact row between gap wrap" tone="soft">
                        <div className="stack tight">
                          <strong>{line.text}</strong>
                          <small className="muted">
                            {t('confidence')} {line.confidence.toFixed(2)} · {t('region')} {line.region_id ?? t('unbound')}
                          </small>
                        </div>
                        <Button onClick={() => removeOcrLine(line.id)} variant="ghost" size="sm" disabled={busy || isEditLocked}>
                          {t('Delete')}
                        </Button>
                      </Panel>
                    ))}
                  </ul>
                )}
              </Card>
            ) : null}

            {dataset.task_type === 'segmentation' ? (
              <Suspense
                fallback={
                  <StateBlock variant="loading" title={t('Loading')} description={t('Preparing polygon canvas.')} />
                }
              >
                <PolygonCanvas
                  title={t('Segmentation Polygon Canvas')}
                  filename={selectedFilename}
                  imageUrl={selectedAttachmentPreviewUrl}
                  polygons={polygons}
                  onChange={setPolygons}
                  disabled={busy || !selectedItem || isEditLocked}
                />
              </Suspense>
            ) : null}
          </section>

          <Card as="section">
            <h3>{t('Annotation Actions')}</h3>
            {selectedAnnotation ? (
              <div className="row gap wrap align-center">
                <Badge tone="info">{t('Status')}: {t(selectedAnnotation.status)}</Badge>
                <Badge tone="neutral">{t('Source')}: {t(selectedAnnotation.source)}</Badge>
                {selectedAnnotation.latest_review ? (
                  <Badge tone="warning">{t('Latest Review')}: {t(selectedAnnotation.latest_review.status)}</Badge>
                ) : null}
              </div>
            ) : (
              <small className="muted">{t('No annotation yet for selected item.')}</small>
            )}

            {isEditLocked ? (
              <StateBlock variant="empty" title={t('Editing Locked')} description={editLockMessage} />
            ) : (
              <div className="row gap wrap">
                <Button
                  onClick={undoLast}
                  variant="ghost"
                  size="sm"
                  disabled={busy || (!boxes.length && !ocrLines.length && !polygons.length)}
                >
                  {t('Undo Last Change')}
                </Button>
                <Button onClick={() => saveAnnotation('in_progress')} variant="secondary" size="sm" disabled={busy || !selectedItem}>
                  {t('Save In Progress')}
                </Button>
                <Button onClick={() => saveAnnotation('annotated')} variant="secondary" size="sm" disabled={busy || !selectedItem}>
                  {t('Mark Annotated')}
                </Button>
                <Button
                  onClick={submitReview}
                  variant="secondary"
                  size="sm"
                  disabled={busy || !selectedAnnotation || selectedAnnotation.status !== 'annotated'}
                >
                  {t('Submit Review')}
                </Button>
              </div>
            )}
          </Card>
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <SampleReviewWorkbench
              t={t}
              selectedFilename={selectedFilename}
              selectedItem={selectedItem}
              selectedAnnotation={selectedAnnotation}
              selectedItemTagEntries={selectedItemTagEntries}
              selectedItemOperationalMetadataEntries={selectedItemOperationalMetadataEntries}
              className="workspace-inspector-card"
            />

            <PredictionOverlayControls
              t={t}
              className="workspace-inspector-card"
              busy={busy}
              hasPredictionOverlay={hasPredictionOverlay}
              showAnnotationOverlay={showAnnotationOverlay}
              showPredictionOverlay={showPredictionOverlay}
              onlyLowConfidenceCandidates={onlyLowConfidenceCandidates}
              predictionConfidenceThreshold={predictionConfidenceThreshold}
              predictionCandidateCount={predictionCandidateCount}
              lowConfidencePredictionCount={lowConfidencePredictionCount}
              selectedItemHasLowConfidenceTag={selectedItemHasLowConfidenceTag}
              predictionCandidates={predictionCandidates}
              numericPredictionConfidenceThreshold={numericPredictionConfidenceThreshold}
              canUsePredictionInOcrEditor={canUsePredictionInOcrEditor}
              nextLowConfidenceQueueItemId={nextLowConfidenceQueueItemId}
              hasSelectedItem={Boolean(selectedItem)}
              scopedInferenceValidationPath={scopedInferenceValidationPath}
              onShowAnnotationOverlayChange={setShowAnnotationOverlay}
              onShowPredictionOverlayChange={setShowPredictionOverlay}
              onOnlyLowConfidenceChange={setOnlyLowConfidenceCandidates}
              onPredictionConfidenceThresholdChange={setPredictionConfidenceThreshold}
              onUsePredictionCandidate={applyPredictionCandidateToOcrEditor}
              onFocusNextLowConfidence={focusNextLowConfidenceQueueItem}
              onToggleLowConfidenceTag={() => {
                void toggleLowConfidenceTagForSelectedItem();
              }}
            />

            <Card as="section" className="workspace-inspector-card">
              <div className="stack tight">
                <h3>{t('Queue Focus')}</h3>
                <small className="muted">
                  {selectedQueueIndex >= 0
                    ? t('Queue position {current} / {total}', {
                        current: selectedQueueIndex + 1,
                        total: filteredItems.length
                      })
                    : t('No item selected in current queue.')}
                </small>
              </div>
              <div className="row gap wrap">
                <Badge tone="neutral">
                  {t('queue')}:{' '}
                  {queueFilter === 'all'
                    ? t('All items')
                    : queueFilter === 'needs_work'
                      ? t('Needs Work')
                      : t(queueFilter)}
                </Badge>
                {selectedItem ? <Badge tone="neutral">{t(selectedItem.split)}</Badge> : null}
                {selectedAnnotation ? <Badge tone="info">{t(selectedAnnotation.status)}</Badge> : null}
              </div>
              <small className="muted">{selectedFilename}</small>
              <small className="muted">{t('Queue shortcuts: J next · K previous')}</small>
              <div className="workspace-button-stack">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => focusAdjacentQueueItem(-1)}
                  disabled={busy || !canMoveToPreviousQueueItem}
                >
                  {t('Previous Item')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => focusAdjacentQueueItem(1)}
                  disabled={busy || !canMoveToNextQueueItem}
                >
                  {t('Next Item')}
                </Button>
              </div>
            </Card>

          <Card as="section" className="workspace-inspector-card">
            <div className="row between gap wrap align-center">
              <h3>{t('Low-confidence Radar')}</h3>
              <Badge tone={lowConfidenceQueueRadarItems.length > 0 ? 'warning' : 'neutral'}>
                {lowConfidenceQueueRadarItems.length}
              </Badge>
            </div>
            {lowConfidenceQueueRadarItems.length === 0 ? (
              <small className="muted">
                {t('No low-confidence prediction signals in the current filtered queue.')}
              </small>
            ) : (
              <ul className="workspace-record-list compact">
                {lowConfidenceQueueRadarItems.map(({ item, count }) => {
                  const filename =
                    attachmentById.get(item.attachment_id)?.filename ?? t('File unavailable');
                  const itemAnnotation = annotationByItemId.get(item.id) ?? null;
                  return (
                    <Panel key={`low-conf-radar-${item.id}`} as="li" className="workspace-record-item compact stack tight" tone="soft">
                      <div className="row between gap wrap align-center">
                        <strong className="line-clamp-1">{filename}</strong>
                        <Badge tone="warning">{t('Low conf')}: {count}</Badge>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">{t(item.split)}</Badge>
                        {itemAnnotation ? (
                          <Badge tone="info">{t(itemAnnotation.status)}</Badge>
                        ) : (
                          <Badge tone="warning">{t('unannotated')}</Badge>
                        )}
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => focusWorkspaceItem(queueFilter, item.id)}
                        disabled={busy}
                      >
                        {t('Open sample')}
                      </Button>
                    </Panel>
                  );
                })}
              </ul>
            )}
          </Card>

          {selectedAnnotation?.latest_review ? (
            <Card as="section" className="workspace-inspector-card">
              <div className="row between gap wrap align-center">
                <h3>{t('Latest Review Context')}</h3>
                <StatusTag status={selectedAnnotation.latest_review.status}>
                  {t(selectedAnnotation.latest_review.status)}
                </StatusTag>
              </div>
              <div className="row gap wrap">
                {selectedAnnotation.latest_review.review_reason_code ? (
                  <Badge tone="warning">{t(selectedAnnotation.latest_review.review_reason_code)}</Badge>
                ) : null}
                {selectedAnnotation.latest_review.quality_score !== null ? (
                  <Badge tone="info">
                    {t('Quality Score')}: {selectedAnnotation.latest_review.quality_score.toFixed(2)}
                  </Badge>
                ) : null}
              </div>
              {selectedAnnotation.latest_review.review_comment ? (
                <p className="workspace-record-summary">{selectedAnnotation.latest_review.review_comment}</p>
              ) : (
                <small className="muted">{t('No review comment yet.')}</small>
              )}
            </Card>
          ) : null}

          <Card as="section" className="workspace-inspector-card">
            <div className="row between gap wrap align-center">
              <h3>{t('Review')}</h3>
              {inReviewQueueContext ? (
                <div className="review-queue-hints">
                  <Badge tone="info">
                    {t('In-review queue {current} / {total}', {
                      current: inReviewQueueContext.current,
                      total: inReviewQueueContext.total
                    })}
                  </Badge>
                  <Badge tone="neutral">
                    {t('Remaining after current: {count}', { count: inReviewQueueContext.remaining })}
                  </Badge>
                </div>
              ) : null}
            </div>
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
                  {t('Reject Reason')}
                  <Select
                    value={reviewReasonCode}
                    onChange={(event) => setReviewReasonCode(event.target.value as AnnotationReviewReasonCode)}
                  >
                    {reviewReasonOptions.map((option) => (
                      <option key={option} value={option}>
                        {t(option)}
                      </option>
                    ))}
                  </Select>
                </label>
                <small className="muted">{t('Reject reason is required for reject actions.')}</small>
                <small className="muted">
                  {queueFilter === 'in_review'
                    ? t('Review shortcuts: A approve-next · R reject-next')
                    : t('Review shortcuts: A approve · R reject')}
                </small>
                <div className="row gap wrap review-action-row">
                  <Button onClick={() => reviewAnnotation('approved')} variant="secondary" size="sm" disabled={busy}>
                    {t('Approve')}
                  </Button>
                  {queueFilter === 'in_review' ? (
                    <Button onClick={() => reviewAnnotation('approved', { continueInQueue: true })} variant="ghost" size="sm" disabled={busy}>
                      {t('Approve & Next')}
                    </Button>
                  ) : null}
                </div>
                <div className="row gap wrap review-action-row">
                  <Button onClick={() => reviewAnnotation('rejected')} variant="danger" size="sm" disabled={busy}>
                    {t('Reject')}
                  </Button>
                  {queueFilter === 'in_review' ? (
                    <Button onClick={() => reviewAnnotation('rejected', { continueInQueue: true })} variant="danger" size="sm" disabled={busy}>
                      {t('Reject & Next')}
                    </Button>
                  ) : null}
                </div>
                <details className="review-optional-metadata">
                  <summary>{t('Optional review metadata')}</summary>
                  <div className="stack">
                    <label>
                      {t('Quality Score')}
                      <Input
                        value={reviewQuality}
                        onChange={(event) => setReviewQuality(event.target.value)}
                        placeholder="0.9"
                      />
                    </label>
                    <label>
                      {t('Review Comment')}
                      <Textarea
                        value={reviewComment}
                        rows={3}
                        onChange={(event) => setReviewComment(event.target.value)}
                        placeholder={t('No review comment yet.')}
                      />
                    </label>
                  </div>
                </details>
              </>
            )}

            {selectedAnnotation?.status === 'rejected' ? (
              <Button onClick={moveRejectedToProgress} variant="ghost" size="sm" disabled={busy}>
                {t('Move Rejected Annotation Back to In Progress')}
              </Button>
            ) : null}
          </Card>
          </div>
        }
      />
      </section>
    </WorkspacePage>
  );
}
