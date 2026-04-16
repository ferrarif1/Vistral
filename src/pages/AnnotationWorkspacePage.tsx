import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { AnnotationCanvasHandle } from '../components/AnnotationCanvas';
import type { AnnotationBox } from '../components/AnnotationCanvas';
import type { PolygonAnnotation } from '../components/PolygonCanvas';
import StateBlock from '../components/StateBlock';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { InlineAlert, PageHeader } from '../components/ui/ConsolePage';
import { Input, Select, Textarea } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import { WorkspacePage, WorkspaceWorkbench } from '../components/ui/WorkspacePage';
import {
  annotationStatusSortWeight,
  getAnnotationByItemId,
  getItemAnnotationStatus,
  normalizeAnnotationQueueFilter,
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
const shortcutAutoAdvanceStorageKey = 'vistral.annotation.shortcutAutoAdvance';

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

export default function AnnotationWorkspacePage() {
  const { t } = useI18n();
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
  const [shortcutAutoAdvance] = useState(() => {
    if (typeof window === 'undefined') {
      return true;
    }

    const persisted = window.localStorage.getItem(shortcutAutoAdvanceStorageKey);
    if (!persisted) {
      return true;
    }

    return persisted === '1';
  });
  const [showShortcutGuide, setShowShortcutGuide] = useState(false);
  const [showOcrAdvancedFields, setShowOcrAdvancedFields] = useState(false);
  const [annotationSidebarTab, setAnnotationSidebarTab] = useState<'annotation' | 'prediction' | 'sample'>('annotation');
  const [isCanvasExpanded, setIsCanvasExpanded] = useState(false);
  const [selectedBox, setSelectedBox] = useState<AnnotationBox | null>(null);
  const labelChoices = useMemo(() => {
    const classes = dataset?.label_schema?.classes ?? [];
    return classes
      .map((label) => label.trim())
      .filter((label) => Boolean(label))
      .slice(0, 12);
  }, [dataset?.label_schema?.classes]);
  const [preferredBoxLabel, setPreferredBoxLabel] = useState('');
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
  const annotationCanvasRef = useRef<AnnotationCanvasHandle | null>(null);
  const draftBaselineSignatureRef = useRef('');
  const canvasUndoStackRef = useRef<Array<{ boxes: AnnotationBox[]; ocrLines: OcrLine[]; polygons: PolygonAnnotation[] }>>([]);
  const canvasRedoStackRef = useRef<Array<{ boxes: AnnotationBox[]; ocrLines: OcrLine[]; polygons: PolygonAnnotation[] }>>([]);
  const isRestoringCanvasRef = useRef(false);
  const reviewReasonSelectRef = useRef<HTMLSelectElement | null>(null);

  const canvasSnapshotSignature = useMemo(
    () =>
      JSON.stringify({
        boxes,
        ocrLines,
        polygons
      }),
    [boxes, ocrLines, polygons]
  );
  const pushCanvasHistory = useCallback(() => {
    if (isRestoringCanvasRef.current) {
      return;
    }

    canvasUndoStackRef.current.push({
      boxes: boxes.map((box) => ({ ...box })),
      ocrLines: ocrLines.map((line) => ({ ...line })),
      polygons: polygons.map((polygon) => ({
        ...polygon,
        points: polygon.points.map((point) => ({ ...point }))
      }))
    });

    if (canvasUndoStackRef.current.length > 40) {
      canvasUndoStackRef.current.shift();
    }

    canvasRedoStackRef.current = [];
  }, [boxes, ocrLines, polygons]);
  const restoreCanvasSnapshot = useCallback(
    (snapshot: { boxes: AnnotationBox[]; ocrLines: OcrLine[]; polygons: PolygonAnnotation[] }) => {
      isRestoringCanvasRef.current = true;
      setBoxes(snapshot.boxes.map((box) => ({ ...box })));
      setOcrLines(snapshot.ocrLines.map((line) => ({ ...line })));
      setPolygons(
        snapshot.polygons.map((polygon) => ({
          ...polygon,
          points: polygon.points.map((point) => ({ ...point }))
        }))
      );
      window.requestAnimationFrame(() => {
        isRestoringCanvasRef.current = false;
      });
    },
    []
  );
  const undoLast = useCallback(() => {
    const previous = canvasUndoStackRef.current.pop();
    if (!previous) {
      return;
    }

    canvasRedoStackRef.current.push({
      boxes: boxes.map((box) => ({ ...box })),
      ocrLines: ocrLines.map((line) => ({ ...line })),
      polygons: polygons.map((polygon) => ({
        ...polygon,
        points: polygon.points.map((point) => ({ ...point }))
      }))
    });
    restoreCanvasSnapshot(previous);
  }, [boxes, ocrLines, polygons, restoreCanvasSnapshot]);
  const redoLast = useCallback(() => {
    const next = canvasRedoStackRef.current.pop();
    if (!next) {
      return;
    }

    canvasUndoStackRef.current.push({
      boxes: boxes.map((box) => ({ ...box })),
      ocrLines: ocrLines.map((line) => ({ ...line })),
      polygons: polygons.map((polygon) => ({
        ...polygon,
        points: polygon.points.map((point) => ({ ...point }))
      }))
    });
    restoreCanvasSnapshot(next);
  }, [boxes, ocrLines, polygons, restoreCanvasSnapshot]);
  const handleBoxesChange = useCallback(
    (nextBoxes: AnnotationBox[]) => {
      pushCanvasHistory();
      setBoxes(nextBoxes);
    },
    [pushCanvasHistory]
  );
  const handleOcrLinesChange = useCallback(
    (nextLines: OcrLine[]) => {
      pushCanvasHistory();
      setOcrLines(nextLines);
    },
    [pushCanvasHistory]
  );
  const handlePolygonsChange = useCallback(
    (nextPolygons: PolygonAnnotation[]) => {
      pushCanvasHistory();
      setPolygons(nextPolygons);
    },
    [pushCanvasHistory]
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
  const hasUnsavedCanvasChanges =
    Boolean(selectedAnnotation) && canvasSnapshotSignature !== draftBaselineSignatureRef.current;

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedItemId) ?? null,
    [items, selectedItemId]
  );

  const attachmentById = useMemo(
    () => new Map(attachments.map((attachment) => [attachment.id, attachment])),
    [attachments]
  );
  const annotationByItemId = useMemo(() => getAnnotationByItemId(annotations), [annotations]);
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
  const queueItems = sortedQueueItems;
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
  const selectedQueueIndex = useMemo(
    () => filteredItems.findIndex((item) => item.id === selectedItemId),
    [filteredItems, selectedItemId]
  );
  const canMoveToPreviousQueueItem = selectedQueueIndex > 0;
  const canMoveToNextQueueItem =
      selectedQueueIndex >= 0
      ? selectedQueueIndex < filteredItems.length - 1
      : filteredItems.length > 0;
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
      return t('尚未选择样本');
    }

    return attachmentById.get(selectedItem.attachment_id)?.filename ?? t('文件不可用');
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
  const applySelectedBoxLabel = useCallback(
    (label: string) => {
      if (!selectedBox) {
        return;
      }

      setPreferredBoxLabel(label);

      setBoxes((current) =>
        current.map((box) =>
          box.id === selectedBox.id
            ? {
                ...box,
                label
              }
            : box
        )
      );
    },
    [selectedBox]
  );
  useEffect(() => {
    const fallbackLabel = labelChoices[0] ?? t('默认类别');
    setPreferredBoxLabel((current) => {
      if (!current) {
        return fallbackLabel;
      }

      if (labelChoices.length === 0) {
        return current.trim() ? current : fallbackLabel;
      }

      return labelChoices.includes(current) ? current : fallbackLabel;
    });
  }, [labelChoices, t]);
  useEffect(() => {
    if (selectedBox?.label?.trim()) {
      setPreferredBoxLabel(selectedBox.label.trim());
    }
  }, [selectedBox]);
  useEffect(() => {
    if (selectedBox && annotationSidebarTab !== 'annotation') {
      setAnnotationSidebarTab('annotation');
    }
  }, [annotationSidebarTab, selectedBox]);
  const queuePositionSummary = useMemo(() => {
    if (selectedQueueIndex >= 0) {
      return t('队列位置 {current} / {total}', {
        current: selectedQueueIndex + 1,
        total: filteredItems.length
      });
    }

    if (filteredItems.length > 0) {
      return t('当前队列未选中样本');
    }

    return t('可见样本 {visible} / {total}', {
      visible: filteredItems.length,
      total: items.length
    });
  }, [filteredItems.length, items.length, selectedQueueIndex, t]);
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
    const nextSelectedItemId =
      (requestedItemVisible ? requestedItemId : '') ||
      (currentItemVisible ? selectedItemId : '') ||
      filteredItems[0]?.id ||
      items[0]?.id ||
      '';

    if (nextSelectedItemId !== selectedItemId) {
      setSelectedItemId(nextSelectedItemId);
    }
  }, [filteredItems, items, searchParams, selectedItemId]);

  useEffect(() => {
    if (!selectedAnnotation) {
      setBoxes([]);
      setOcrLines([]);
      setPolygons([]);
      setLineRegionId('');
      setSelectedBox(null);
      draftBaselineSignatureRef.current = '';
      canvasUndoStackRef.current = [];
      canvasRedoStackRef.current = [];
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
    setSelectedBox(null);
    draftBaselineSignatureRef.current = JSON.stringify({
      boxes: nextBoxes,
      ocrLines: nextLines,
      polygons: nextPolygons
    });
    canvasUndoStackRef.current = [];
    canvasRedoStackRef.current = [];
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
    if (lineRegionId || lineConfidence.trim() !== '0.9') {
      setShowOcrAdvancedFields(true);
    }
  }, [lineConfidence, lineRegionId]);

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
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedCanvasChanges) {
        return;
      }

      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsavedCanvasChanges]);

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

  const resolveNextQueueItemId = useCallback(
    (currentItemId: string): string => {
      if (!currentItemId || filteredItems.length === 0) {
        return '';
      }

      const currentIndex = filteredItems.findIndex((item) => item.id === currentItemId);
      if (currentIndex < 0) {
        return filteredItems[0]?.id ?? '';
      }

      for (let index = currentIndex + 1; index < filteredItems.length; index += 1) {
        const candidateId = filteredItems[index]?.id ?? '';
        if (candidateId && candidateId !== currentItemId) {
          return candidateId;
        }
      }

      for (let index = 0; index < currentIndex; index += 1) {
        const candidateId = filteredItems[index]?.id ?? '';
        if (candidateId && candidateId !== currentItemId) {
          return candidateId;
        }
      }

      return '';
    },
    [filteredItems]
  );

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
          ? t('已将当前样本标记为低置信待处理。')
          : t('已移除当前样本的低置信标记。')
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
        text: t('已将预测文本载入 OCR 编辑器，可继续调整后再添加。')
      });
    },
    [boxes, t]
  );

  const addOcrLine = () => {
    if (!lineText.trim()) {
      setFeedback({ variant: 'error', text: t('OCR 文本不能为空。') });
      return;
    }

    const confidence = Number(lineConfidence);
    if (Number.isNaN(confidence)) {
      setFeedback({ variant: 'error', text: t('OCR 置信度必须是有效数字。') });
      return;
    }

    handleOcrLinesChange([
      ...ocrLines,
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
    handleOcrLinesChange(ocrLines.filter((line) => line.id !== lineId));
  };

  const saveAnnotation = useCallback(
    async (status: 'in_progress' | 'annotated', options?: { continueInQueue?: boolean }) => {
      const taskType = dataset?.task_type;
      if (!datasetId || !dataset || !selectedItem || !taskType) {
        return;
      }

      const continueInQueue = options?.continueInQueue === true;
      const nextQueueItemId = continueInQueue ? resolveNextQueueItemId(selectedItem.id) : '';
      setBusy(true);
      setFeedback(null);

      try {
        const payload =
          taskType === 'ocr'
            ? {
                regions: boxes,
                lines: ocrLines
              }
            : taskType === 'segmentation'
              ? {
                  polygons,
                  boxes
                }
              : {
                  boxes
                };

        const upserted = await api.upsertDatasetAnnotation(datasetId, {
          dataset_item_id: selectedItem.id,
          task_type: taskType,
          source: 'manual',
          status,
          payload
        });

        await load('manual');
        if (continueInQueue) {
          if (nextQueueItemId) {
            focusWorkspaceItem(queueFilter, nextQueueItemId);
            setQueueToast({
              variant: 'success',
              text: t('已保存为 {status}，并切到下一张。', {
                status: t(upserted.status)
              })
            });
          } else {
            setQueueToast({
              variant: 'info',
              text: t('已保存为 {status}，当前队列已没有更多样本。', {
                status: t(upserted.status)
              })
            });
          }
          setFeedback(null);
        } else {
          setFeedback({
            variant: 'success',
            text: t('已保存为 {status}。', { status: t(upserted.status) })
          });
        }
      } catch (error) {
        setFeedback({ variant: 'error', text: (error as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [
      boxes,
      dataset,
      datasetId,
      focusWorkspaceItem,
      load,
      ocrLines,
      polygons,
      queueFilter,
      resolveNextQueueItemId,
      selectedItem,
      t
    ]
  );

  const submitReview = useCallback(
    async (options?: { continueInQueue?: boolean }) => {
      const taskType = dataset?.task_type;
      if (!datasetId || !dataset || !selectedAnnotation || !taskType) {
        return;
      }

      const continueInQueue = options?.continueInQueue === true;
      const nextQueueItemId = continueInQueue
        ? resolveNextQueueItemId(selectedAnnotation.dataset_item_id)
        : '';
      setBusy(true);
      setFeedback(null);

      try {
        if (hasUnsavedCanvasChanges) {
          await api.upsertDatasetAnnotation(datasetId, {
            dataset_item_id: selectedItem?.id ?? selectedAnnotation.dataset_item_id,
            task_type: taskType,
            source: selectedAnnotation.source,
            status: 'annotated',
            payload:
              taskType === 'ocr'
                ? {
                    regions: boxes,
                    lines: ocrLines
                  }
                : taskType === 'segmentation'
                  ? {
                      polygons,
                      boxes
                    }
                  : {
                      boxes
                    }
          });
          await load('manual');
        }
        await api.submitAnnotationForReview(datasetId, selectedAnnotation.id);
        await load('manual');
        if (continueInQueue) {
          if (nextQueueItemId) {
            focusWorkspaceItem(queueFilter, nextQueueItemId);
            setQueueToast({
              variant: 'success',
              text: t('已提交复核，并切到下一张。')
            });
          } else {
            setQueueToast({
              variant: 'info',
              text: t('已提交复核，当前队列已结束。')
            });
          }
          setFeedback(null);
        } else {
          setFeedback({ variant: 'success', text: t('已提交复核。') });
        }
      } catch (error) {
        setFeedback({ variant: 'error', text: (error as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [
      boxes,
      dataset,
      datasetId,
      focusWorkspaceItem,
      hasUnsavedCanvasChanges,
      load,
      ocrLines,
      polygons,
      queueFilter,
      resolveNextQueueItemId,
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
        isTypingTarget(event.target)
      ) {
        return;
      }

      const withCommand = event.ctrlKey || event.metaKey;
      if (!withCommand || busy || !selectedItem) {
        return;
      }

      if (event.key.toLowerCase() === 's' && !event.shiftKey) {
        event.preventDefault();
        void saveAnnotation('in_progress', { continueInQueue: shortcutAutoAdvance });
        return;
      }

      if (event.key === 'Enter' && event.shiftKey) {
        if (!selectedAnnotation || selectedAnnotation.status !== 'annotated') {
          return;
        }
        event.preventDefault();
        void submitReview({ continueInQueue: shortcutAutoAdvance });
        return;
      }

      if (event.key === 'Enter') {
        if (isEditLocked) {
          return;
        }
        event.preventDefault();
        void saveAnnotation('annotated', { continueInQueue: shortcutAutoAdvance });
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, isEditLocked, saveAnnotation, selectedAnnotation, selectedItem, shortcutAutoAdvance, submitReview]);

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
          setFeedback(null);
          if (nextInReviewItemId) {
            setQueueToast({
              variant: 'success',
              text: t('复核已保存，继续下一张。')
            });
          } else {
            setQueueToast({
              variant: 'info',
              text: t('当前复核队列已完成。')
            });
          }
        } else {
          setFeedback({
            variant: 'success',
            text: t('复核结果已更新为 {status}。', { status: t(status) })
          });
        }
      } catch (error) {
        setFeedback({ variant: 'error', text: (error as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [
      filteredItems,
      focusWorkspaceItem,
      datasetId,
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

  const requestQueueItemFocus = useCallback(
    async (nextQueueFilter: AnnotationQueueFilter, nextItemId: string) => {
      if (!nextItemId) {
        return false;
      }

      if (hasUnsavedCanvasChanges) {
        const shouldSave = window.confirm(t('当前样本还有未保存改动。先保存为进行中，再切换吗？'));
        if (!shouldSave) {
          return false;
        }

        await saveAnnotation('in_progress');
      }

      focusWorkspaceItem(nextQueueFilter, nextItemId);
      return true;
    },
    [focusWorkspaceItem, hasUnsavedCanvasChanges, saveAnnotation, t]
  );

  const focusAdjacentQueueItem = useCallback(
    async (direction: -1 | 1) => {
      if (filteredItems.length === 0) {
        return;
      }

      const currentIndex =
        selectedQueueIndex >= 0 ? selectedQueueIndex : direction === 1 ? -1 : filteredItems.length;
      const nextIndex = currentIndex + direction;
      if (nextIndex < 0 || nextIndex >= filteredItems.length) {
        return;
      }

      await requestQueueItemFocus(queueFilter, filteredItems[nextIndex].id);
    },
    [filteredItems, queueFilter, requestQueueItemFocus, selectedQueueIndex]
  );

  const focusNextLowConfidenceQueueItem = useCallback(async () => {
    if (!nextLowConfidenceQueueItemId) {
      setQueueToast({
        variant: 'info',
        text: t('当前队列中没有更多低置信样本。')
      });
      return;
    }

    const moved = await requestQueueItemFocus(queueFilter, nextLowConfidenceQueueItemId);
    if (!moved) {
      return;
    }

    setQueueToast({
      variant: 'info',
      text: t('已切换到当前队列中的下一个低置信样本。')
    });
  }, [nextLowConfidenceQueueItemId, queueFilter, requestQueueItemFocus, t]);

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
        continueInQueue: queueFilter === 'in_review' && shortcutAutoAdvance
      });
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, queueFilter, reviewAnnotation, selectedAnnotation, shortcutAutoAdvance]);

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
        text: t('预标注完成：新增 {created} 条，更新 {updated} 条。', {
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

  if (!datasetId) {
    return (
      <WorkspacePage>
        <PageHeader
          eyebrow={t('标注工作台')}
          title={t('标注工作台')}
          description={t('从数据集详情进入后，才能打开当前样本标注。')}
          secondaryActions={
            <ButtonLink to="/datasets" variant="ghost" size="sm">
              {t('返回数据集')}
            </ButtonLink>
          }
        />
        <StateBlock variant="error" title={t('缺少数据集 ID')} description={t('请从数据集详情页打开标注工作台。')} />
      </WorkspacePage>
    );
  }

  if (loading) {
    return (
      <WorkspacePage>
        <PageHeader
          eyebrow={t('标注工作台')}
          title={t('标注工作台')}
          description={t('正在准备当前样本。')}
          secondaryActions={
            <ButtonLink to={`/datasets/${datasetId}`} variant="ghost" size="sm">
              {t('返回数据集')}
            </ButtonLink>
          }
        />
        <StateBlock variant="loading" title={t('加载中')} description={t('正在准备标注环境。')} />
      </WorkspacePage>
    );
  }

  if (!dataset) {
    return (
      <WorkspacePage>
        <PageHeader
          eyebrow={t('标注工作台')}
          title={t('标注工作台')}
          description={t('当前数据集不可用。')}
          secondaryActions={
            <ButtonLink to="/datasets" variant="ghost" size="sm">
              {t('返回数据集')}
            </ButtonLink>
          }
        />
        <StateBlock variant="error" title={t('未找到数据集')} description={t('请求的数据集已不可用。')} />
      </WorkspacePage>
    );
  }

  const annotationTabs = (
    <div className="annotation-sidebar" role="presentation">
      <div className="annotation-sidebar-tabs" role="tablist" aria-label={t('标注侧栏')}>
        <Button
          type="button"
          size="sm"
          variant={annotationSidebarTab === 'annotation' ? 'secondary' : 'ghost'}
          onClick={() => setAnnotationSidebarTab('annotation')}
        >
          {t('标注')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={annotationSidebarTab === 'prediction' ? 'secondary' : 'ghost'}
          onClick={() => setAnnotationSidebarTab('prediction')}
        >
          {t('预测对比')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={annotationSidebarTab === 'sample' ? 'secondary' : 'ghost'}
          onClick={() => setAnnotationSidebarTab('sample')}
        >
          {t('样本信息')}
        </Button>
      </div>

      {annotationSidebarTab === 'annotation' ? (
        <Card as="section" className="workspace-inspector-card">
          <div className="stack tight">
            <div className="row between gap wrap align-center">
              <h3>{t('标注')}</h3>
              <Badge tone="info">
                {dataset.task_type === 'segmentation' ? t('多边形') : t('框')}: {dataset.task_type === 'ocr' ? ocrLines.length : boxes.length}
              </Badge>
            </div>
            <small className="muted">{t('画布是主区域。这里只保留类别、选中项和删框操作。')}</small>
          </div>
          <div className="stack tight">
            <div className="row between gap wrap align-center">
              <small className="muted">{t('类别')}</small>
              <Badge tone="neutral">
                {t('新框默认标签')}: {preferredBoxLabel || labelChoices[0] || t('默认类别')}
              </Badge>
            </div>
            <div className="row gap wrap">
              {(labelChoices.length > 0
                ? labelChoices
                : [t('默认类别')]).map((label) => (
                <Button
                  key={label}
                  type="button"
                  size="sm"
                  variant={selectedBox?.label === label ? 'secondary' : 'ghost'}
                  onClick={() => applySelectedBoxLabel(label)}
                  disabled={!selectedBox || busy}
                >
                  {label}
                </Button>
              ))}
            </div>
            <small className="muted">{t('选中框后点类别即可应用；新建框会沿用上次使用的标签。')}</small>
          </div>
          <div className="annotation-selected-box-card">
            <div className="row between gap wrap align-center">
              <strong>{t('当前选中框属性')}</strong>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => annotationCanvasRef.current?.deleteSelectedBox()}
                disabled={busy || !selectedBox}
              >
                {t('删除选中框')}
              </Button>
            </div>
            {selectedBox ? (
              <div className="annotation-selected-box-grid">
                <div>
                  <small className="muted">{t('标签')}</small>
                  <strong>{selectedBox.label}</strong>
                </div>
                <div>
                  <small className="muted">{t('坐标')}</small>
                  <strong>
                    {Math.round(selectedBox.x)}, {Math.round(selectedBox.y)}
                  </strong>
                </div>
                <div>
                  <small className="muted">{t('尺寸')}</small>
                  <strong>
                    {Math.round(selectedBox.width)} × {Math.round(selectedBox.height)}
                  </strong>
                </div>
              </div>
            ) : (
              <small className="muted">{t('先在画布里选中一个框。')}</small>
            )}
          </div>
          <details className="workspace-disclosure" open={showShortcutGuide} onToggle={(event) => setShowShortcutGuide(event.currentTarget.open)}>
            <summary>
              <span>{t('快捷键')}</span>
            </summary>
            <div className="workspace-disclosure-content">
              <div className="annotation-shortcut-grid">
                <div><Badge tone="neutral">B</Badge><small>{t('框选模式')}</small></div>
                <div><Badge tone="neutral">V</Badge><small>{t('选择模式')}</small></div>
                <div><Badge tone="neutral">Delete</Badge><small>{t('删除选中框')}</small></div>
                <div><Badge tone="neutral">Ctrl/Cmd + S</Badge><small>{t('保存为进行中')}</small></div>
                <div><Badge tone="neutral">Enter</Badge><small>{t('提交复核')}</small></div>
                <div><Badge tone="neutral">← / →</Badge><small>{t('上一张 / 下一张')}</small></div>
              </div>
            </div>
          </details>
        </Card>
      ) : null}

      {annotationSidebarTab === 'prediction' ? (
        <div className="stack">
          <Card as="section" className="workspace-inspector-card">
            <div className="stack tight">
              <div className="row between gap wrap align-center">
                <h3>{t('预标注')}</h3>
                <Badge tone="neutral">{t('可选')}</Badge>
              </div>
              <small className="muted">{t('先选模型版本，再跑预标注，最后回到预测对比。')}</small>
            </div>
            <div className="row gap wrap">
              <label className="stack tight annotation-workspace-model-select">
                <small className="muted">{t('模型版本')}</small>
                <Select value={selectedModelVersionId} onChange={(event) => setSelectedModelVersionId(event.target.value)}>
                  {modelVersions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.version_name} ({t(version.framework)})
                    </option>
                  ))}
                </Select>
              </label>
              <Button onClick={runPreAnnotation} variant="secondary" size="sm" disabled={busy || items.length === 0 || modelVersions.length === 0}>
                {t('运行预标注')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  load('manual').catch((loadError) => {
                    setFeedback({ variant: 'error', text: (loadError as Error).message });
                  });
                }}
                disabled={busy || refreshing}
              >
                {refreshing ? t('刷新中...') : t('刷新')}
              </Button>
            </div>
          </Card>
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
            onShowAnnotationOverlayChange={setShowAnnotationOverlay}
            onShowPredictionOverlayChange={setShowPredictionOverlay}
            onPredictionConfidenceThresholdChange={setPredictionConfidenceThreshold}
            onUsePredictionCandidate={applyPredictionCandidateToOcrEditor}
            onFocusNextLowConfidence={focusNextLowConfidenceQueueItem}
            onToggleLowConfidenceTag={() => {
              void toggleLowConfidenceTagForSelectedItem();
            }}
          />
        </div>
      ) : null}

      {annotationSidebarTab === 'sample' ? (
        <div className="stack">
          <SampleReviewWorkbench
            t={t}
            selectedFilename={selectedFilename}
            selectedItem={selectedItem}
            selectedAnnotation={selectedAnnotation}
            selectedItemTagEntries={selectedItemTagEntries}
            selectedItemOperationalMetadataEntries={selectedItemOperationalMetadataEntries}
            className="workspace-inspector-card"
          />
          {selectedAnnotation?.status === 'in_review' ? (
            <Card as="section" className="workspace-inspector-card">
              <div className="annotation-review-panel">
                <div className="stack tight">
                  <h3>{t('复核')}</h3>
                  <small className="muted">{t('当前样本已进入复核，只显示通过 / 退回。')}</small>
                </div>
                <div className="row gap wrap">
                  <Button onClick={() => void reviewAnnotation('approved')} variant="secondary" size="sm" disabled={busy}>
                    {t('通过')}
                  </Button>
                  <Button onClick={() => void reviewAnnotation('rejected')} variant="danger" size="sm" disabled={busy}>
                    {t('退回')}
                  </Button>
                </div>
                <label>
                  {t('退回原因')}
                  <Select
                    ref={reviewReasonSelectRef}
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
                <label>
                  {t('复核备注')}
                  <Textarea value={reviewComment} rows={3} onChange={(event) => setReviewComment(event.target.value)} />
                </label>
              </div>
            </Card>
          ) : null}
          {selectedAnnotation?.status === 'rejected' ? (
            <Card as="section" className="workspace-inspector-card">
              <Button onClick={moveRejectedToProgress} variant="ghost" size="sm" disabled={busy}>
                {t('退回重新编辑')}
              </Button>
            </Card>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const annotationMain = (
    <div className="annotation-main-stack">
      <Card as="section" className="annotation-canvas-shell">
        <div className="annotation-canvas-shell__header">
          <div className="stack tight">
            <small className="muted">{t('当前样本')}</small>
            <strong className="line-clamp-1">{selectedFilename}</strong>
          </div>
          <div className="row gap wrap align-center">
            <Badge tone="neutral">{t(dataset.task_type)}</Badge>
            {selectedItem ? <Badge tone="neutral">{t(selectedItem.split)}</Badge> : null}
            {selectedAnnotation ? <Badge tone="info">{t(selectedAnnotation.status)}</Badge> : <Badge tone="warning">{t('unannotated')}</Badge>}
            {selectedItemHasLowConfidenceTag ? <Badge tone="warning">{t('低置信')}</Badge> : null}
          </div>
        </div>

        <Suspense fallback={<StateBlock variant="loading" title={t('加载中')} description={t('正在准备画布。')} />}>
          <AnnotationCanvas
            ref={annotationCanvasRef}
            title={t('标注画布')}
            filename={selectedFilename}
            imageUrl={selectedAttachmentPreviewUrl}
            boxes={canvasBoxes}
            defaultLabel={preferredBoxLabel || labelChoices[0] || t('默认类别')}
            onChange={handleBoxesChange}
            onSelectionChange={setSelectedBox}
            disabled={busy || !selectedItem || isEditLocked}
          />
        </Suspense>

        {dataset.task_type === 'ocr' ? (
          <Card as="section" className="annotation-ocr-panel">
            <div className="stack tight">
              <div className="row between gap wrap align-center">
                <h3>{t('OCR 文本')}</h3>
                {ocrLines.length > 0 ? <Badge tone="info">{t('已保存')}: {ocrLines.length}</Badge> : null}
              </div>
              <small className="muted">{t('先填一行，再加入当前样本。')}</small>
            </div>
            <div className="annotation-ocr-entry-row">
              <label className="annotation-ocr-entry-main">
                {t('文本')}
                <Input value={lineText} onChange={(event) => setLineText(event.target.value)} disabled={busy || isEditLocked} />
              </label>
              <Button onClick={addOcrLine} variant="secondary" size="sm" disabled={busy || isEditLocked}>
                {t('添加')}
              </Button>
            </div>
            <details className="workspace-disclosure" open={showOcrAdvancedFields} onToggle={(event) => setShowOcrAdvancedFields(event.currentTarget.open)}>
              <summary>
                <span>{t('高级')}</span>
                {lineRegionId || lineConfidence.trim() !== '0.9' ? <Badge tone="info">{t('已配置')}</Badge> : null}
              </summary>
              <div className="workspace-disclosure-content">
                <div className="annotation-ocr-grid">
                  <label>
                    {t('置信度')}
                    <Input value={lineConfidence} onChange={(event) => setLineConfidence(event.target.value)} placeholder="0.90" disabled={busy || isEditLocked} />
                  </label>
                  <label>
                    {t('绑定区域')}
                    <Select value={lineRegionId} onChange={(event) => setLineRegionId(event.target.value)} disabled={busy || isEditLocked}>
                      <option value="">{t('不绑定')}</option>
                      {boxes.map((box) => (
                        <option key={box.id} value={box.id}>
                          {box.label}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>
              </div>
            </details>
            {ocrLines.length > 0 ? (
              <ul className="workspace-record-list compact">
                {ocrLines.map((line) => (
                  <Panel key={line.id} as="li" className="workspace-record-item compact stack tight" tone="soft">
                    <div className="row between gap wrap align-center">
                      <strong className="line-clamp-2">{line.text}</strong>
                      <Button onClick={() => removeOcrLine(line.id)} variant="ghost" size="sm" disabled={busy || isEditLocked}>
                        {t('删除')}
                      </Button>
                    </div>
                    <div className="row gap wrap">
                      <Badge tone="neutral">
                        {t('置信度')}: {line.confidence.toFixed(2)}
                      </Badge>
                      {line.region_id ? <Badge tone="neutral">{t('区域')}: {line.region_id}</Badge> : <Badge tone="neutral">{t('未绑定区域')}</Badge>}
                    </div>
                  </Panel>
                ))}
              </ul>
            ) : (
              <StateBlock variant="empty" title={t('暂无文本行')} description={t('先添加一行 OCR 文本。')} />
            )}
          </Card>
        ) : null}

        {dataset.task_type === 'segmentation' ? (
          <Suspense fallback={<StateBlock variant="loading" title={t('加载中')} description={t('正在准备多边形画布。')} />}>
            <PolygonCanvas
              title={t('分割多边形')}
              filename={selectedFilename}
              imageUrl={selectedAttachmentPreviewUrl}
              polygons={polygons}
              onChange={handlePolygonsChange}
              disabled={busy || !selectedItem || isEditLocked}
            />
          </Suspense>
        ) : null}
      </Card>

      <Card as="section" className="annotation-bottom-actions">
        <div className="row between gap wrap align-center">
          <div className="stack tight">
            <h3>{t('操作条')}</h3>
            <small className="muted">{t('先保存，再提交。保存前会自动带上当前画布改动。')}</small>
          </div>
          <div className="row gap wrap align-center">
            {selectedAnnotation ? <Badge tone="info">{t(selectedAnnotation.status)}</Badge> : null}
            {hasUnsavedCanvasChanges ? <Badge tone="warning">{t('未保存')}</Badge> : <Badge tone="neutral">{t('已同步')}</Badge>}
          </div>
        </div>
        <div className="annotation-action-groups">
          <Panel as="section" className="annotation-action-group" tone="soft">
            <div className="stack tight">
              <strong>{t('编辑')}</strong>
              <small className="muted">{t('撤销、重做、保存为进行中。')}</small>
            </div>
            <div className="row gap wrap">
              <Button onClick={undoLast} variant="ghost" size="sm" disabled={busy || canvasUndoStackRef.current.length === 0}>
                {t('撤销')}
              </Button>
              <Button onClick={redoLast} variant="ghost" size="sm" disabled={busy || canvasRedoStackRef.current.length === 0}>
                {t('重做')}
              </Button>
              <Button onClick={() => void saveAnnotation('in_progress')} variant="secondary" size="sm" disabled={busy || !selectedItem}>
                {t('保存为进行中')}
              </Button>
            </div>
          </Panel>
          <Panel as="section" className="annotation-action-group" tone="soft">
            <div className="stack tight">
              <strong>{t('提交')}</strong>
              <small className="muted">{t('保存后提交复核。')}</small>
            </div>
            <div className="row gap wrap">
              <Button
                onClick={() => void saveAnnotation('annotated')}
                variant="secondary"
                size="sm"
                disabled={busy || !selectedItem || isEditLocked}
              >
                {t('标记完成')}
              </Button>
              <Button
                onClick={() => void submitReview()}
                variant="primary"
                size="sm"
                disabled={busy || !selectedAnnotation || selectedAnnotation.status !== 'annotated'}
              >
                {t('提交复核')}
              </Button>
            </div>
          </Panel>
        </div>
      </Card>
    </div>
  );

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('标注工作台')}
        title={dataset.name}
        description={
          scopedDatasetVersionId
            ? t('任务 {task} · 版本 {version} · 单样本标注。', {
                task: t(dataset.task_type),
                version: scopedDatasetVersionId
              })
            : t('任务 {task} · 单样本标注。', {
                task: t(dataset.task_type)
              })
        }
        meta={
          <div className="row gap wrap align-center">
            <Badge tone="neutral">{t('当前样本')}: {selectedFilename}</Badge>
            <Badge tone="info">{t('队列位置')}: {queuePositionSummary}</Badge>
            {selectedItem ? <Badge tone="neutral">{t(selectedItem.split)}</Badge> : null}
            {selectedAnnotation ? <Badge tone="info">{t(selectedAnnotation.status)}</Badge> : <Badge tone="warning">{t('未标注')}</Badge>}
          </div>
        }
        primaryAction={{
          label: t('上一张'),
          onClick: () => focusAdjacentQueueItem(-1),
          disabled: busy || !canMoveToPreviousQueueItem
        }}
        secondaryActions={
          <div className="row gap wrap align-center">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => focusAdjacentQueueItem(1)}
              disabled={busy || !canMoveToNextQueueItem}
            >
              {t('下一张')}
            </Button>
            <Button
              type="button"
              variant={isCanvasExpanded ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setIsCanvasExpanded((current) => !current)}
            >
              {isCanvasExpanded ? t('退出全屏') : t('全屏')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowShortcutGuide((current) => !current)}
            >
              {t('快捷键')}
            </Button>
            <ButtonLink size="sm" variant="ghost" to={`/datasets/${dataset.id}`}>
              {t('返回数据集')}
            </ButtonLink>
          </div>
        }
      />

      {queueToast ? (
        <div className={`workspace-toast ${queueToast.variant}`} role="status" aria-live="polite">
          {queueToast.text}
        </div>
      ) : null}

      {feedback ? (
        <InlineAlert
          tone={feedback.variant === 'success' ? 'success' : 'danger'}
          title={feedback.variant === 'success' ? t('操作完成') : t('操作失败')}
          description={feedback.text}
        />
      ) : null}

      <WorkspaceWorkbench
        className={isCanvasExpanded ? 'annotation-studio-workbench annotation-studio-workbench--expanded' : 'annotation-studio-workbench'}
        main={annotationMain}
        side={isCanvasExpanded ? null : annotationTabs}
      />
    </WorkspacePage>
  );
}
