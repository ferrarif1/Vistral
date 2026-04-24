import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router-dom';
import type {
  AnnotationReviewReasonCode,
  AnnotationWithReview,
  DatasetItemRecord,
  DatasetRecord,
  DatasetVersionRecord,
  FileAttachment,
  ModelVersionRecord
} from '../../shared/domain';
import PredictionOverlayControls from '../components/annotation/PredictionOverlayControls';
import SampleReviewWorkbench from '../components/annotation/SampleReviewWorkbench';
import WorkspaceNextStepCard from '../components/onboarding/WorkspaceNextStepCard';
import type {
  AnnotationBox,
  AnnotationCanvasHandle,
  AnnotationCanvasToolMode
} from '../components/AnnotationCanvas';
import type { PolygonAnnotation } from '../components/PolygonCanvas';
import StateBlock from '../components/StateBlock';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { DetailList, InlineAlert } from '../components/ui/ConsolePage';
import { Input, Select, Textarea } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import { WorkspacePage, WorkspaceWorkbench } from '../components/ui/WorkspacePage';
import {
  annotationStatusSortWeight,
  filterItemsByAnnotationQueue,
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

const extractMetadataFilterValue = (filter: string, key: string): string => {
  const normalizedFilter = filter.trim();
  const normalizedKey = `${key.trim()}=`;
  if (!normalizedFilter.startsWith(normalizedKey)) {
    return '';
  }
  return normalizedFilter.slice(normalizedKey.length).trim();
};

type LaunchContext = {
  taskType?: string | null;
  framework?: string | null;
  executionTarget?: string | null;
  workerId?: string | null;
  returnTo?: string | null;
};

const appendTrainingLaunchContext = (
  searchParams: URLSearchParams,
  context?: LaunchContext
) => {
  if (!context) {
    return;
  }
  if (context.taskType?.trim() && !searchParams.has('task_type')) {
    searchParams.set('task_type', context.taskType.trim());
  }
  if (context.framework?.trim() && !searchParams.has('framework')) {
    searchParams.set('framework', context.framework.trim());
  }
  if (
    context.executionTarget?.trim() &&
    context.executionTarget.trim() !== 'auto' &&
    !searchParams.has('execution_target')
  ) {
    searchParams.set('execution_target', context.executionTarget.trim());
  }
  if (context.workerId?.trim() && !searchParams.has('worker')) {
    searchParams.set('worker', context.workerId.trim());
  }
  const returnTo = context.returnTo?.trim() ?? '';
  if (
    returnTo &&
    returnTo.startsWith('/') &&
    !returnTo.startsWith('//') &&
    !returnTo.includes('://') &&
    !searchParams.has('return_to')
  ) {
    searchParams.set('return_to', returnTo);
  }
};

const sanitizeReturnToPath = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('://')) {
    return null;
  }
  return trimmed;
};

const resolvePreferredFrameworkForTask = (
  taskType: DatasetRecord['task_type'] | string | null | undefined,
  preferredFramework?: string | null
): string | null => {
  const normalizedPreferred = preferredFramework?.trim().toLowerCase() ?? '';
  if (normalizedPreferred === 'paddleocr' || normalizedPreferred === 'doctr' || normalizedPreferred === 'yolo') {
    return normalizedPreferred;
  }
  if (taskType === 'ocr') {
    return 'paddleocr';
  }
  if (taskType === 'detection' || taskType === 'classification' || taskType === 'segmentation' || taskType === 'obb') {
    return 'yolo';
  }
  return null;
};

const buildDatasetDetailPath = (
  datasetId: string,
  options?: {
    versionId?: string | null;
    focus?: string | null;
    launchContext?: LaunchContext;
  }
): string => {
  const searchParams = new URLSearchParams();
  if (options?.versionId?.trim()) {
    searchParams.set('version', options.versionId.trim());
  }
  if (options?.focus?.trim()) {
    searchParams.set('focus', options.focus.trim());
  }
  appendTrainingLaunchContext(searchParams, options?.launchContext);
  const query = searchParams.toString();
  return query ? `/datasets/${datasetId}?${query}` : `/datasets/${datasetId}`;
};

const buildTrainingJobCreatePath = (
  datasetId: string,
  versionId: string,
  launchContext?: LaunchContext
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('dataset', datasetId);
  searchParams.set('version', versionId);
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/training/jobs/new?${searchParams.toString()}`;
};

const buildTrainingJobsPath = (
  datasetId: string,
  versionId?: string,
  launchContext?: LaunchContext
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('dataset', datasetId);
  if (versionId?.trim()) {
    searchParams.set('version', versionId.trim());
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/training/jobs?${searchParams.toString()}`;
};

const buildInferenceValidationPath = (
  datasetId: string,
  versionId?: string,
  options?: {
    modelVersionId?: string;
    runId?: string;
    focus?: string;
    launchContext?: LaunchContext;
  }
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('dataset', datasetId);
  if (versionId?.trim()) {
    searchParams.set('version', versionId.trim());
  }
  if (options?.modelVersionId?.trim()) {
    searchParams.set('modelVersion', options.modelVersionId.trim());
  }
  if (options?.runId?.trim()) {
    searchParams.set('run', options.runId.trim());
  }
  if (options?.focus?.trim()) {
    searchParams.set('focus', options.focus.trim());
  }
  appendTrainingLaunchContext(searchParams, options?.launchContext);
  return `/inference/validate?${searchParams.toString()}`;
};

const buildClosureWizardPath = (
  datasetId: string,
  versionId?: string,
  launchContext?: LaunchContext
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('dataset', datasetId);
  if (versionId?.trim()) {
    searchParams.set('version', versionId.trim());
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/workflow/closure?${searchParams.toString()}`;
};

const buildDatasetsPath = (launchContext?: LaunchContext): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
  const query = searchParams.toString();
  return query ? `/datasets?${query}` : '/datasets';
};

const buildModelVersionsPath = (
  launchContext?: LaunchContext,
  options?: {
    selectedVersionId?: string | null;
    focus?: string | null;
  }
): string => {
  const searchParams = new URLSearchParams();
  if (options?.selectedVersionId?.trim()) {
    searchParams.set('selectedVersion', options.selectedVersionId.trim());
  }
  if (options?.focus?.trim()) {
    searchParams.set('focus', options.focus.trim());
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  const query = searchParams.toString();
  return query ? `/models/versions?${query}` : '/models/versions';
};

const buildAnnotationWorkspaceSignature = (payload: {
  dataset: DatasetRecord;
  items: DatasetItemRecord[];
  attachments: FileAttachment[];
  datasetVersions: DatasetVersionRecord[];
  modelVersions: ModelVersionRecord[];
  annotations: AnnotationWithReview[];
}): string =>
  JSON.stringify({
    dataset: payload.dataset,
    items: [...payload.items].sort((left, right) => left.id.localeCompare(right.id)),
    attachments: [...payload.attachments].sort((left, right) => left.id.localeCompare(right.id)),
    datasetVersions: [...payload.datasetVersions].sort((left, right) => left.id.localeCompare(right.id)),
    modelVersions: [...payload.modelVersions].sort((left, right) => left.id.localeCompare(right.id)),
    annotations: [...payload.annotations].sort((left, right) => left.id.localeCompare(right.id))
  });

interface CanvasDraft {
  boxes: AnnotationBox[];
  ocrLines: OcrLine[];
  polygons: PolygonAnnotation[];
}

const cloneCanvasDraft = (draft: CanvasDraft): CanvasDraft => ({
  boxes: draft.boxes.map((box) => ({ ...box })),
  ocrLines: draft.ocrLines.map((line) => ({ ...line })),
  polygons: draft.polygons.map((polygon) => ({
    ...polygon,
    points: polygon.points.map((point) => ({ ...point }))
  }))
});

const buildCanvasDraftFromPayload = (payload: Record<string, unknown>): CanvasDraft => {
  const regionEntries = Array.isArray(payload.regions)
    ? payload.regions
    : Array.isArray(payload.boxes)
      ? payload.boxes
      : [];

  const boxes: AnnotationBox[] = regionEntries
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

  const ocrLines: OcrLine[] = (Array.isArray(payload.lines) ? payload.lines : [])
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

  const polygons: PolygonAnnotation[] = (Array.isArray(payload.polygons) ? payload.polygons : [])
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

  return {
    boxes,
    ocrLines,
    polygons
  };
};

const buildAnnotationPayload = (
  taskType: DatasetRecord['task_type'],
  draft: CanvasDraft
) => {
  if (taskType === 'ocr') {
    return {
      regions: draft.boxes,
      lines: draft.ocrLines
    };
  }

  if (taskType === 'segmentation') {
    return {
      polygons: draft.polygons,
      boxes: draft.boxes
    };
  }

  return {
    boxes: draft.boxes
  };
};

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.isContentEditable;
};

export default function AnnotationWorkspacePage() {
  const { t } = useI18n();
  const location = useLocation();
  const { datasetId } = useParams<{ datasetId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedReturnTo = sanitizeReturnToPath(searchParams.get('return_to'));
  const currentTaskPath = useMemo(
    () => `${location.pathname}${location.search || ''}`,
    [location.pathname, location.search]
  );
  const outboundReturnTo = requestedReturnTo ?? currentTaskPath;
  const scopedDatasetVersionId = (searchParams.get('version') ?? '').trim();
  const preferredTaskTypeRaw = (searchParams.get('task_type') ?? '').trim().toLowerCase();
  const preferredTaskType =
    preferredTaskTypeRaw === 'ocr' ||
    preferredTaskTypeRaw === 'detection' ||
    preferredTaskTypeRaw === 'classification' ||
    preferredTaskTypeRaw === 'segmentation' ||
    preferredTaskTypeRaw === 'obb'
      ? preferredTaskTypeRaw
      : null;
  const preferredFrameworkRaw = (searchParams.get('framework') ?? searchParams.get('profile') ?? '')
    .trim()
    .toLowerCase();
  const preferredFramework =
    preferredFrameworkRaw === 'paddleocr' || preferredFrameworkRaw === 'doctr' || preferredFrameworkRaw === 'yolo'
      ? preferredFrameworkRaw
      : null;
  const preferredExecutionTarget = (searchParams.get('execution_target') ?? '').trim();
  const preferredWorkerId = (searchParams.get('worker') ?? '').trim();
  const preferredModelVersionId = (searchParams.get('modelVersion') ?? searchParams.get('model_version') ?? '').trim();
  const [dataset, setDataset] = useState<DatasetRecord | null>(null);
  const [items, setItems] = useState<DatasetItemRecord[]>([]);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [datasetVersions, setDatasetVersions] = useState<DatasetVersionRecord[]>([]);
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
  const [showPredictionOverlay, setShowPredictionOverlay] = useState(false);
  const [predictionConfidenceThreshold, setPredictionConfidenceThreshold] = useState('0.50');
  const [onlyLowConfidenceCandidates, setOnlyLowConfidenceCandidates] = useState(false);
  const [showShortcutGuide, setShowShortcutGuide] = useState(false);
  const [showOcrAdvancedFields, setShowOcrAdvancedFields] = useState(false);
  const [annotationSidebarTab, setAnnotationSidebarTab] = useState<'annotation' | 'prediction' | 'sample'>('annotation');
  const [isCanvasExpanded, setIsCanvasExpanded] = useState(false);
  const [canvasMode, setCanvasMode] = useState<AnnotationCanvasToolMode>('draw');
  const [selectedBox, setSelectedBox] = useState<AnnotationBox | null>(null);
  const [pendingLabelAssignmentBoxId, setPendingLabelAssignmentBoxId] = useState('');
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
  const [reviewComment, setReviewComment] = useState('');
  const [reviewReasonCode, setReviewReasonCode] = useState<AnnotationReviewReasonCode>('other');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const [queueToast, setQueueToast] = useState<{ variant: 'success' | 'info'; text: string } | null>(null);
  const workspaceSignatureRef = useRef('');
  const workspaceRootRef = useRef<HTMLDivElement | null>(null);
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
      setBoxes(nextBoxes);
    },
    []
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
        datasetVersions: detail.versions,
        modelVersions: matchedVersions,
        annotations: annotationList
      });

      if (workspaceSignatureRef.current !== nextSignature) {
        workspaceSignatureRef.current = nextSignature;
        setDataset(detail.dataset);
        setItems(detail.items);
        setAttachments(detail.attachments);
        setDatasetVersions(detail.versions);
        setAnnotations(annotationList);
        setModelVersions(matchedVersions);
        setSelectedModelVersionId((prev) =>
          (preferredModelVersionId && matchedVersions.some((version) => version.id === preferredModelVersionId)
            ? preferredModelVersionId
            : '') ||
          (prev && matchedVersions.some((version) => version.id === prev) ? prev : matchedVersions[0]?.id || '')
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
  }, [datasetId, preferredModelVersionId]);

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
    const requestedShowPredictionOverlay = normalizeBinaryParam(searchParams.get('pred'), false);
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
  const readyFileCount = useMemo(
    () => attachments.filter((attachment) => attachment.status === 'ready').length,
    [attachments]
  );
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
      if (!matchesAnnotationQueue(getItemAnnotationStatus(item.id, annotationByItemId), queueFilter)) {
        return false;
      }

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
    queueFilter,
    queueItemStatusFilter,
    queueItems,
    queueMetadataFilter,
    queueSearchText,
    queueSplitFilter
  ]);
  const hasActiveQueueFilters = Boolean(
    queueFilter !== 'all' ||
      queueSearchText.trim() ||
      queueSplitFilter !== 'all' ||
      queueItemStatusFilter !== 'all' ||
      queueMetadataFilter.trim() ||
      onlyLowConfidenceCandidates
  );
  const queueFilterBlockerHint = useMemo(() => {
    if (items.length === 0 || filteredItems.length > 0 || !hasActiveQueueFilters) {
      return '';
    }

    const queueScopedItems = filterItemsByAnnotationQueue(queueItems, annotations, queueFilter);
    if (queueFilter !== 'all' && queueScopedItems.length === 0) {
      return t('Queue filter currently has no matching samples.');
    }
    if (queueSearchText.trim()) {
      return t('Search keyword currently matches 0 samples in this queue.');
    }
    if (queueSplitFilter !== 'all') {
      return t('Split filter currently has no matching samples in this queue.');
    }
    if (queueItemStatusFilter !== 'all') {
      return t('Item status filter currently has no matching samples in this queue.');
    }
    if (queueMetadataFilter.trim()) {
      return t('Metadata filter currently has no matching samples in this queue.');
    }
    if (onlyLowConfidenceCandidates) {
      return t('No low-confidence prediction samples match the current queue yet.');
    }
    return t('Current queue filters are too strict. Clear one or more filters to continue.');
  }, [
    annotations,
    filteredItems.length,
    hasActiveQueueFilters,
    items.length,
    onlyLowConfidenceCandidates,
    queueFilter,
    queueItemStatusFilter,
    queueItems,
    queueMetadataFilter,
    queueSearchText,
    queueSplitFilter,
    t
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
      return t('No sample selected');
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
  const applySelectedBoxLabel = useCallback(
    (label: string) => {
      if (!selectedBox) {
        return;
      }

      setPreferredBoxLabel(label);
      setPendingLabelAssignmentBoxId((current) => (current === selectedBox.id ? '' : current));
      pushCanvasHistory();

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
    [pushCanvasHistory, selectedBox]
  );
  useEffect(() => {
    const fallbackLabel = labelChoices[0] ?? t('Default label');
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
  useEffect(() => {
    setAnnotationSidebarTab('annotation');
  }, [selectedItemId]);
  useEffect(() => {
    if (!selectedBox) {
      return;
    }

    setCanvasMode('select');
  }, [selectedBox]);
  useEffect(() => {
    if (!pendingLabelAssignmentBoxId) {
      return;
    }

    if (!boxes.some((box) => box.id === pendingLabelAssignmentBoxId)) {
      setPendingLabelAssignmentBoxId('');
    }
  }, [boxes, pendingLabelAssignmentBoxId]);
  const queuePositionSummary = useMemo(() => {
    if (selectedQueueIndex >= 0) {
      return t('Queue {current}/{total}', {
        current: selectedQueueIndex + 1,
        total: filteredItems.length
      });
    }

    if (filteredItems.length > 0) {
      return t('Queue item not selected');
    }

    return t('Samples {visible}/{total}', {
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
  const predictionOverlayBoxes = useMemo(() => {
    if (!selectedAnnotation || !hasPredictionOverlay) {
      return [] as AnnotationBox[];
    }

    return buildCanvasDraftFromPayload(selectedAnnotation.payload as Record<string, unknown>).boxes;
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
  const selectedDatasetVersion = useMemo(
    () => datasetVersions.find((version) => version.id === scopedDatasetVersionId) ?? null,
    [datasetVersions, scopedDatasetVersionId]
  );
  const scopedDatasetVersionMissing = useMemo(
    () => Boolean(scopedDatasetVersionId && datasetVersions.length > 0 && !selectedDatasetVersion),
    [datasetVersions.length, scopedDatasetVersionId, selectedDatasetVersion]
  );
  const selectedModelVersion = useMemo(
    () => modelVersions.find((version) => version.id === selectedModelVersionId) ?? null,
    [modelVersions, selectedModelVersionId]
  );
  const preferredModelVersionMissing = useMemo(
    () =>
      Boolean(
        preferredModelVersionId &&
          modelVersions.length > 0 &&
          !modelVersions.some((version) => version.id === preferredModelVersionId)
      ),
    [modelVersions, preferredModelVersionId]
  );
  const launchReadyDatasetVersions = useMemo(
    () =>
      datasetVersions.filter(
        (version) =>
          (version.split_summary.train ?? 0) > 0 && (version.annotation_coverage ?? 0) > 0
      ),
    [datasetVersions]
  );
  const latestLaunchReadyDatasetVersion = launchReadyDatasetVersions[0] ?? null;
  const selectedDatasetVersionHasTrainSplit = (selectedDatasetVersion?.split_summary.train ?? 0) > 0;
  const selectedDatasetVersionHasCoverage = (selectedDatasetVersion?.annotation_coverage ?? 0) > 0;
  const selectedDatasetVersionLaunchReady = Boolean(
    dataset?.status === 'ready' &&
      selectedDatasetVersion &&
      selectedDatasetVersionHasTrainSplit &&
      selectedDatasetVersionHasCoverage
  );
  const preferredLaunchReadyDatasetVersion =
    selectedDatasetVersionLaunchReady && selectedDatasetVersion
      ? selectedDatasetVersion
      : latestLaunchReadyDatasetVersion;
  const preferredTrainingDatasetVersion = selectedDatasetVersion ?? datasetVersions[0] ?? null;
  const preferredReviewQueue = useMemo(() => {
    if (annotationSummary.needs_work > 0) {
      return 'needs_work' as const;
    }
    if (annotationSummary.rejected > 0) {
      return 'rejected' as const;
    }
    if (annotationSummary.in_review > 0) {
      return 'in_review' as const;
    }
    return 'approved' as const;
  }, [annotationSummary.in_review, annotationSummary.needs_work, annotationSummary.rejected]);
  const currentVersionLabel = selectedDatasetVersion?.version_name ?? (scopedDatasetVersionId || t('Unlocked'));
  const resolvedDatasetId = datasetId ?? '';
  const scopedInferenceRunId = useMemo(
    () => extractMetadataFilterValue(queueMetadataFilter, 'inference_run_id'),
    [queueMetadataFilter]
  );
  const launchContextForAnnotationFlow: LaunchContext = {
    taskType: preferredTaskType ?? dataset?.task_type ?? null,
    framework: resolvePreferredFrameworkForTask(
      preferredTaskType ?? dataset?.task_type ?? null,
      preferredFramework ?? selectedModelVersion?.framework ?? null
    ),
    executionTarget: preferredExecutionTarget || null,
    workerId: preferredWorkerId || null,
    returnTo: outboundReturnTo
  };
  const datasetsPath = buildDatasetsPath(launchContextForAnnotationFlow);
  const modelVersionsPath = buildModelVersionsPath(launchContextForAnnotationFlow, {
    selectedVersionId: selectedModelVersionId || undefined
  });
  const datasetDetailPath = buildDatasetDetailPath(resolvedDatasetId, {
    versionId: scopedDatasetVersionId || undefined,
    launchContext: launchContextForAnnotationFlow
  });
  const clearVersionScopePath = useMemo(() => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('version');
    nextParams.delete('item');
    const query = nextParams.toString();
    return query ? `${location.pathname}?${query}` : location.pathname;
  }, [location.pathname, searchParams]);
  const clearModelVersionContextPath = useMemo(() => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('modelVersion');
    nextParams.delete('model_version');
    const query = nextParams.toString();
    return query ? `${location.pathname}?${query}` : location.pathname;
  }, [location.pathname, searchParams]);
  const clearQueueFiltersPath = useMemo(() => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('queue');
    nextParams.delete('item');
    nextParams.delete('q');
    nextParams.delete('split');
    nextParams.delete('item_status');
    nextParams.delete('meta');
    nextParams.delete('low_conf');
    nextParams.delete('conf');
    const query = nextParams.toString();
    return query ? `${location.pathname}?${query}` : location.pathname;
  }, [location.pathname, searchParams]);
  const preferredWorkspaceVersionId = scopedDatasetVersionId || preferredTrainingDatasetVersion?.id || undefined;
  const closureWizardPath = buildClosureWizardPath(
    resolvedDatasetId,
    preferredLaunchReadyDatasetVersion?.id ?? preferredTrainingDatasetVersion?.id,
    launchContextForAnnotationFlow
  );
  const inferenceValidationPath = buildInferenceValidationPath(
    resolvedDatasetId,
    preferredLaunchReadyDatasetVersion?.id ?? preferredTrainingDatasetVersion?.id,
    {
      launchContext: launchContextForAnnotationFlow
    }
  );
  const feedbackValidationPath = buildInferenceValidationPath(
    resolvedDatasetId,
    preferredLaunchReadyDatasetVersion?.id ?? preferredWorkspaceVersionId,
    {
      runId: scopedInferenceRunId || undefined,
      focus: scopedInferenceRunId ? 'feedback' : undefined,
      launchContext: launchContextForAnnotationFlow
    }
  );
  const canUsePredictionInOcrEditor = dataset?.task_type === 'ocr' && !isEditLocked;
  const predictionCandidateCount = useMemo(() => {
    if (!hasPredictionOverlay) {
      return 0;
    }
    return predictionCandidates.length;
  }, [
    hasPredictionOverlay,
    predictionCandidates.length
  ]);
  const lowConfidencePredictionCount = lowConfidencePredictionCandidates.length;
  const canvasBoxes = showAnnotationOverlay ? boxes : [];
  const pendingLabelSelectionActive = Boolean(selectedBox && selectedBox.id === pendingLabelAssignmentBoxId);
  const hasDraftContent =
    dataset?.task_type === 'ocr'
      ? ocrLines.length > 0 || boxes.length > 0
      : dataset?.task_type === 'segmentation'
        ? polygons.length > 0
        : boxes.length > 0;
  const canSubmitForReview =
    Boolean(selectedItem) &&
    hasDraftContent &&
    !busy &&
    !['in_review', 'approved', 'rejected'].includes(selectedAnnotation?.status ?? '');
  const canSaveInProgress = Boolean(selectedItem) && !busy && !isEditLocked;
  useEffect(() => {
    if (items.length === 0 || filteredItems.length === 0) {
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
      '';

    if (nextSelectedItemId !== selectedItemId) {
      setSelectedItemId(nextSelectedItemId);
    }
  }, [filteredItems, items.length, searchParams, selectedItemId]);

  useEffect(() => {
    if (!selectedAnnotation) {
      setBoxes([]);
      setOcrLines([]);
      setPolygons([]);
      setLineRegionId('');
      setSelectedBox(null);
      setPendingLabelAssignmentBoxId('');
      draftBaselineSignatureRef.current = '';
      canvasUndoStackRef.current = [];
      canvasRedoStackRef.current = [];
      return;
    }

    const draft = buildCanvasDraftFromPayload(selectedAnnotation.payload as Record<string, unknown>);

    setBoxes(draft.boxes);
    setOcrLines(draft.ocrLines);
    setPolygons(draft.polygons);
    setLineRegionId((prev) => prev || draft.boxes[0]?.id || '');
    setSelectedBox(null);
    setPendingLabelAssignmentBoxId('');
    draftBaselineSignatureRef.current = JSON.stringify(draft);
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
      setReviewComment('');
      return;
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
    const onFullscreenChange = () => {
      if (document.fullscreenElement !== workspaceRootRef.current) {
        setIsCanvasExpanded(false);
      }
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

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
        text: t('Prediction loaded into OCR editor.')
      });
    },
    [boxes, t]
  );

  const getCurrentCanvasDraft = useCallback(
    (): CanvasDraft =>
      cloneCanvasDraft({
        boxes,
        ocrLines,
        polygons
      }),
    [boxes, ocrLines, polygons]
  );

  const handleCanvasBoxCreate = useCallback(
    (box: AnnotationBox) => {
      setSelectedBox(box);
      setCanvasMode('select');
      setAnnotationSidebarTab('annotation');
      if (labelChoices.length > 1) {
        setPendingLabelAssignmentBoxId(box.id);
      }
      setQueueToast({
        variant: 'info',
        text:
          labelChoices.length > 1
            ? t('New box created. Choose a class right away.')
            : t('New box created. Keep adjusting position or size.')
      });
    },
    [labelChoices.length, t]
  );

  const applyPredictionDraft = useCallback(() => {
    if (!selectedAnnotation || !hasPredictionOverlay) {
      return;
    }

    pushCanvasHistory();
    const draft = buildCanvasDraftFromPayload(selectedAnnotation.payload as Record<string, unknown>);
    restoreCanvasSnapshot(draft);
    setLineRegionId(draft.boxes[0]?.id ?? '');
    setPendingLabelAssignmentBoxId('');
    setQueueToast({
      variant: 'success',
      text: t('Prediction applied. Keep editing.')
    });
  }, [hasPredictionOverlay, pushCanvasHistory, restoreCanvasSnapshot, selectedAnnotation, t]);

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
    async (status: 'in_progress' | 'annotated' = 'in_progress') => {
      const taskType = dataset?.task_type;
      if (!datasetId || !dataset || !selectedItem || !taskType) {
        return false;
      }

      setBusy(true);
      setFeedback(null);

      try {
        await api.upsertDatasetAnnotation(datasetId, {
          dataset_item_id: selectedItem.id,
          task_type: taskType,
          source: 'manual',
          status,
          payload: buildAnnotationPayload(taskType, getCurrentCanvasDraft())
        });

        await load('manual');
        setQueueToast({
          variant: 'success',
          text:
            status === 'annotated'
              ? t('Saved.')
              : t('Saved as in progress.')
        });
        return true;
      } catch (error) {
        setFeedback({ variant: 'error', text: (error as Error).message });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [
      dataset,
      datasetId,
      getCurrentCanvasDraft,
      load,
      selectedItem,
      t
    ]
  );

  const submitCurrentForReview = useCallback(
    async () => {
      const taskType = dataset?.task_type;
      if (!datasetId || !dataset || !selectedItem || !taskType) {
        return;
      }

      if (!hasDraftContent) {
        setFeedback({ variant: 'error', text: t('Add annotations before submit.') });
        return;
      }

      if (selectedAnnotation?.status === 'in_review' || selectedAnnotation?.status === 'approved') {
        return;
      }

      if (selectedAnnotation?.status === 'rejected') {
        setFeedback({ variant: 'error', text: t('Reopen rejected sample first.') });
        return;
      }

      setBusy(true);
      setFeedback(null);

      try {
        let annotationId = selectedAnnotation?.id ?? '';

        if (!selectedAnnotation || selectedAnnotation.status !== 'annotated' || hasUnsavedCanvasChanges) {
          const upserted = await api.upsertDatasetAnnotation(datasetId, {
            dataset_item_id: selectedItem.id,
            task_type: taskType,
            source: 'manual',
            status: 'annotated',
            payload: buildAnnotationPayload(taskType, getCurrentCanvasDraft())
          });
          annotationId = upserted.id;
        }

        if (!annotationId) {
          throw new Error(t('Nothing to submit yet.'));
        }

        await api.submitAnnotationForReview(datasetId, annotationId);
        await load('manual');
        setQueueToast({
          variant: 'success',
          text: t('Submitted for review. Moved to next item.')
        });
      } catch (error) {
        setFeedback({ variant: 'error', text: (error as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [
      dataset,
      datasetId,
      getCurrentCanvasDraft,
      hasDraftContent,
      hasUnsavedCanvasChanges,
      load,
      selectedAnnotation,
      selectedItem,
      t
    ]
  );

  const reviewAnnotation = useCallback(
    async (status: 'approved' | 'rejected') => {
      if (!datasetId || !selectedAnnotation) {
        return;
      }

      if (status === 'rejected' && !reviewReasonCode) {
        setFeedback({ variant: 'error', text: t('Reject reason is required for reject actions.') });
        return;
      }

      setBusy(true);
      setFeedback(null);

      try {
        await api.reviewDatasetAnnotation(datasetId, selectedAnnotation.id, {
          status,
          review_reason_code: status === 'rejected' ? reviewReasonCode : null,
          quality_score: null,
          review_comment: reviewComment
        });
        await load('manual');
        setQueueToast({
          variant: 'success',
          text: status === 'approved' ? t('Approve sample') : t('Send back for fixes')
        });
      } catch (error) {
        setFeedback({ variant: 'error', text: (error as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [
      datasetId,
      load,
      reviewComment,
      reviewReasonCode,
      selectedAnnotation,
      t
    ]
  );

  const requestQueueItemFocus = useCallback(
    async (nextQueueFilter: AnnotationQueueFilter, nextItemId: string) => {
      if (!nextItemId) {
        return false;
      }

      if (hasUnsavedCanvasChanges) {
        const shouldSave = window.confirm(t('Unsaved changes. Save before switching?'));
        if (!shouldSave) {
          return false;
        }

        const saved = await saveAnnotation('in_progress');
        if (!saved) {
          return false;
        }
      }

      focusWorkspaceItem(nextQueueFilter, nextItemId);
      return true;
    },
    [focusWorkspaceItem, hasUnsavedCanvasChanges, saveAnnotation, t]
  );

  const findFirstQueueItemId = useCallback(
    (filter: AnnotationQueueFilter): string => {
      const matchedItem = queueItems.find((item) =>
        matchesAnnotationQueue(getItemAnnotationStatus(item.id, annotationByItemId), filter)
      );
      return matchedItem?.id ?? queueItems[0]?.id ?? '';
    },
    [annotationByItemId, queueItems]
  );

  const focusQueueFilter = useCallback(
    async (nextQueueFilter: AnnotationQueueFilter) => {
      const nextItemId =
        nextQueueFilter === queueFilter && selectedItemId
          ? selectedItemId
          : findFirstQueueItemId(nextQueueFilter);

      if (!nextItemId) {
        setQueueFilter(nextQueueFilter);
        return;
      }

      await requestQueueItemFocus(nextQueueFilter, nextItemId);
    },
    [findFirstQueueItemId, queueFilter, requestQueueItemFocus, selectedItemId]
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

  type GuidanceAction = {
    label: string;
    to?: string;
    onClick?: () => void;
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  };
  type WorkspaceGuidanceState = {
    current: number;
    total: number;
    title: string;
    description: string;
    badgeTone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
    badgeLabel: string;
    actions: GuidanceAction[];
  };

  const workspaceGuidance = useMemo<WorkspaceGuidanceState>(() => {
    if (!dataset) {
      return {
        current: 1,
        total: 4,
        title: t('Open the dataset lane'),
        description: t('Return to the dataset detail page first to restore the current context.'),
        badgeTone: 'warning',
        badgeLabel: t('Blocked'),
        actions: [{ label: t('Back to dataset'), to: datasetDetailPath, variant: 'ghost' }]
      };
    }

    if (readyFileCount === 0) {
      return {
        current: 1,
        total: 4,
        title: t('Upload ready files first'),
        description: t('The annotation queue cannot close until at least one dataset file is ready.'),
        badgeTone: 'warning',
        badgeLabel: t('Need upload'),
        actions: [{ label: t('Back to dataset detail'), to: datasetDetailPath }]
      };
    }

    if (scopedInferenceRunId && filteredItems.length === 0) {
      return {
        current: 2,
        total: 4,
        title: t('Feedback sample is outside the current queue'),
        description: t('This workspace is scoped to inference run {runId}, but the current queue filters do not expose a matching sample. Return to validation or reopen the broader dataset lane.', {
          runId: scopedInferenceRunId
        }),
        badgeTone: 'warning',
        badgeLabel: t('Feedback scoped'),
        actions: [
          { label: t('Clear queue filters'), to: clearQueueFiltersPath },
          { label: t('Open validation page'), to: feedbackValidationPath },
          { label: t('Open dataset detail'), to: datasetDetailPath, variant: 'ghost' }
        ]
      };
    }

    if (scopedInferenceRunId) {
      return {
        current: 2,
        total: 4,
        title: t('Review the routed feedback sample'),
        description: t('This queue is already scoped to inference run {runId}. Correct the sample here, then continue into dataset versioning or training from the dataset lane.', {
          runId: scopedInferenceRunId
        }),
        badgeTone: 'info',
        badgeLabel: t('Feedback scoped'),
        actions: [
          { label: t('Open validation page'), to: feedbackValidationPath },
          { label: t('Open dataset detail'), to: datasetDetailPath, variant: 'ghost' }
        ]
      };
    }

    if (hasPredictionOverlay && predictionCandidateCount > 0 && !isEditLocked) {
      return {
        current: 2,
        total: 4,
        title: t('Review model suggestions before redrawing'),
        description: t('This sample already carries pre-annotation output. Inspect the prediction panel first, then keep or correct what you need.'),
        badgeTone: 'info',
        badgeLabel: t('Prediction ready'),
        actions: [
          { label: t('Open prediction panel'), onClick: () => setAnnotationSidebarTab('prediction') },
          {
            label: t('Open validation page'),
            to: buildInferenceValidationPath(
              resolvedDatasetId,
              preferredLaunchReadyDatasetVersion?.id ?? preferredWorkspaceVersionId,
              {
                modelVersionId: selectedModelVersionId || undefined,
                launchContext: launchContextForAnnotationFlow
              }
            ),
            variant: 'ghost'
          }
        ]
      };
    }

    if (annotationSummary.needs_work > 0) {
      return {
        current: 2,
        total: 4,
        title: t('Clear unresolved annotation work'),
        description: t('{count} samples still need manual labeling or completion before you freeze a version.', {
          count: annotationSummary.needs_work
        }),
        badgeTone: 'warning',
        badgeLabel: t('Needs work'),
        actions: [
          {
            label: t('Focus needs-work queue'),
            onClick: () => {
              void focusQueueFilter('needs_work');
            }
          },
          { label: t('Back to dataset detail'), to: datasetDetailPath, variant: 'ghost' }
        ]
      };
    }

    if (annotationSummary.rejected > 0) {
      return {
        current: 2,
        total: 4,
        title: t('Resolve rejected samples'),
        description: t('{count} samples were rejected and should be reopened or corrected before launch.', {
          count: annotationSummary.rejected
        }),
        badgeTone: 'warning',
        badgeLabel: t('Rejected'),
        actions: [
          {
            label: t('Focus rejected queue'),
            onClick: () => {
              void focusQueueFilter('rejected');
            }
          },
          { label: t('Back to dataset detail'), to: datasetDetailPath, variant: 'ghost' }
        ]
      };
    }

    if (annotationSummary.in_review > 0) {
      return {
        current: 2,
        total: 4,
        title: t('Finish review decisions'),
        description: t('{count} samples are waiting for approve or reject decisions.', {
          count: annotationSummary.in_review
        }),
        badgeTone: 'info',
        badgeLabel: t('Waiting review'),
        actions: [
          {
            label: t('Focus review queue'),
            onClick: () => {
              void focusQueueFilter('in_review');
            }
          },
          { label: t('Back to dataset detail'), to: datasetDetailPath, variant: 'ghost' }
        ]
      };
    }

    if (datasetVersions.length === 0) {
      return {
        current: 3,
        total: 4,
        title: t('Create the first version snapshot'),
        description: t('Annotation is stable. Freeze a dataset version so training and validation can reuse the same input scope.'),
        badgeTone: 'info',
        badgeLabel: t('Need version'),
        actions: [{ label: t('Open dataset detail'), to: datasetDetailPath }]
      };
    }

    if (!preferredLaunchReadyDatasetVersion) {
      return {
        current: 3,
        total: 4,
        title: t('Promote one version to launch-ready'),
        description: t('Create or choose a version with train split and annotation coverage before sending it to training or validation.'),
        badgeTone: 'info',
        badgeLabel: t('Version check'),
        actions: [
          { label: t('Open dataset detail'), to: datasetDetailPath },
          {
            label: t('Open training jobs'),
            to: buildTrainingJobsPath(
              dataset.id,
              preferredTrainingDatasetVersion?.id,
              launchContextForAnnotationFlow
            ),
            variant: 'ghost'
          }
        ]
      };
    }

    return {
      current: 4,
      total: 4,
      title: t('Start training, closure, or validation'),
      description: t('Version {version} is ready for downstream training, closure verification, and inference validation.', {
        version: preferredLaunchReadyDatasetVersion.version_name
      }),
      badgeTone: 'success',
      badgeLabel: t('Launch-ready'),
      actions: [
        {
          label: t('Create training job'),
          to: buildTrainingJobCreatePath(
            dataset.id,
            preferredLaunchReadyDatasetVersion.id,
            launchContextForAnnotationFlow
          )
        },
        { label: t('Open closure wizard'), to: closureWizardPath, variant: 'secondary' },
        { label: t('Validate inference'), to: inferenceValidationPath, variant: 'ghost' }
      ]
    };
  }, [
    annotationSummary.in_review,
    annotationSummary.needs_work,
    annotationSummary.rejected,
    closureWizardPath,
    clearQueueFiltersPath,
    dataset,
    datasetDetailPath,
    datasetVersions.length,
    feedbackValidationPath,
    filteredItems.length,
    focusQueueFilter,
    hasPredictionOverlay,
    inferenceValidationPath,
    isEditLocked,
    launchContextForAnnotationFlow,
    predictionCandidateCount,
    preferredLaunchReadyDatasetVersion,
    preferredTrainingDatasetVersion?.id,
    preferredWorkspaceVersionId,
    readyFileCount,
    resolvedDatasetId,
    scopedInferenceRunId,
    selectedModelVersionId,
    t
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isTypingTarget(event.target)) {
        return;
      }

      const withCommand = event.ctrlKey || event.metaKey;
      if (withCommand && event.key.toLowerCase() === 's' && !event.shiftKey && !busy && selectedItem) {
        event.preventDefault();
        void saveAnnotation('in_progress');
        return;
      }

      if (withCommand || event.altKey || busy) {
        return;
      }

      const key = event.key.toLowerCase();

      if (key === 'b') {
        event.preventDefault();
        setCanvasMode('draw');
        setAnnotationSidebarTab('annotation');
        return;
      }

      if (key === 'v') {
        event.preventDefault();
        setCanvasMode('select');
        setAnnotationSidebarTab('annotation');
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        void focusAdjacentQueueItem(-1);
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        void focusAdjacentQueueItem(1);
        return;
      }

      if (event.key === 'Enter') {
        if (isEditLocked || !selectedItem) {
          return;
        }
        event.preventDefault();
        void submitCurrentForReview();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, focusAdjacentQueueItem, isEditLocked, saveAnnotation, selectedItem, submitCurrentForReview]);

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
      void reviewAnnotation(key === 'a' ? 'approved' : 'rejected');
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, reviewAnnotation, selectedAnnotation]);

  const runPreAnnotation = async () => {
    if (!datasetId) {
      return;
    }

    const shouldContinue = window.confirm(t('Generate or update pre-annotation results for this dataset?'));
    if (!shouldContinue) {
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      const result = await api.runDatasetPreAnnotations(
        datasetId,
        selectedModelVersionId || undefined
      );
      setQueueToast({
        variant: 'success',
        text: t('Pre-labeling done: {created} created, {updated} updated.', {
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
      const updated = await api.upsertDatasetAnnotation(datasetId, {
        dataset_item_id: selectedItem.id,
        task_type: dataset.task_type,
        source: selectedAnnotation.source,
        status: 'in_progress',
        payload: buildAnnotationPayload(dataset.task_type, getCurrentCanvasDraft())
      });
      setAnnotations((current) =>
        current.map((annotation) =>
          annotation.id === selectedAnnotation.id
            ? updated
            : annotation
        )
      );
      focusWorkspaceItem('needs_work', selectedItem.id);
      setQueueToast({ variant: 'success', text: t('Reopened rejected sample.') });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const toggleCanvasExpand = useCallback(async () => {
    const nextExpanded = !isCanvasExpanded;
    const root = workspaceRootRef.current;

    try {
      if (nextExpanded) {
        if (root && document.fullscreenElement !== root && root.requestFullscreen) {
          await root.requestFullscreen();
        }
        setIsCanvasExpanded(true);
        return;
      }

      if (root && document.fullscreenElement === root && document.exitFullscreen) {
        await document.exitFullscreen();
      }
    } catch {
      // fall back to layout-only expansion when fullscreen is unavailable
    }

    setIsCanvasExpanded(nextExpanded);
  }, [isCanvasExpanded]);

  if (!datasetId) {
    return (
      <WorkspacePage>
        <Card as="header" className="annotation-focus-header">
          <div className="annotation-focus-header__left">
            <ButtonLink to={requestedReturnTo ?? datasetsPath} variant="ghost" size="sm">
              {t('Back to dataset')}
            </ButtonLink>
          </div>
          <div className="annotation-focus-header__center">
            <small className="workspace-eyebrow">{t('Annotation workspace')}</small>
            <strong className="annotation-focus-header__title">{t('Annotation workspace')}</strong>
            <div className="annotation-focus-header__meta">
              <Badge tone="neutral">{t('Current sample')}: {t('Not selected')}</Badge>
            </div>
          </div>
          <div className="annotation-focus-header__right" />
        </Card>
        <StateBlock variant="error" title={t('Missing dataset ID')} description={t('Please open the annotation workspace from a dataset detail page.')} />
      </WorkspacePage>
    );
  }

  if (loading) {
    return (
      <WorkspacePage>
        <Card as="header" className="annotation-focus-header">
          <div className="annotation-focus-header__left">
            <ButtonLink to={requestedReturnTo ?? datasetDetailPath} variant="ghost" size="sm">
              {t('Back to dataset')}
            </ButtonLink>
          </div>
          <div className="annotation-focus-header__center">
            <small className="workspace-eyebrow">{t('Annotation workspace')}</small>
            <strong className="annotation-focus-header__title">{t('Preparing annotation workspace.')}</strong>
            <div className="annotation-focus-header__meta">
              <Badge tone="neutral">{t('Current sample')}: {t('Loading')}</Badge>
            </div>
          </div>
          <div className="annotation-focus-header__right" />
        </Card>
        <StateBlock variant="loading" title={t('Loading')} description={t('Preparing annotation workspace.')} />
      </WorkspacePage>
    );
  }

  if (!dataset) {
    return (
      <WorkspacePage>
        <Card as="header" className="annotation-focus-header">
          <div className="annotation-focus-header__left">
            <ButtonLink to={requestedReturnTo ?? datasetsPath} variant="ghost" size="sm">
              {t('Back to dataset')}
            </ButtonLink>
          </div>
          <div className="annotation-focus-header__center">
            <small className="workspace-eyebrow">{t('Annotation workspace')}</small>
            <strong className="annotation-focus-header__title">{t('Current dataset unavailable')}</strong>
            <div className="annotation-focus-header__meta">
              <Badge tone="warning">{t('Current sample')}: {t('Unavailable')}</Badge>
            </div>
          </div>
          <div className="annotation-focus-header__right" />
        </Card>
        <StateBlock variant="error" title={t('Dataset not found')} description={t('The requested dataset is no longer available.')} />
      </WorkspacePage>
    );
  }

  const annotationTabs = (
    <div className="annotation-sidebar" role="presentation">
      <WorkspaceNextStepCard
        title={t('Closure handoff')}
        description={t('Keep the next page obvious while you annotate.')}
        stepLabel={workspaceGuidance.title}
        stepDetail={workspaceGuidance.description}
        current={workspaceGuidance.current}
        total={workspaceGuidance.total}
        badgeLabel={workspaceGuidance.badgeLabel}
        badgeTone={workspaceGuidance.badgeTone}
        actions={workspaceGuidance.actions.map((action) =>
          action.to ? (
            <ButtonLink key={action.label} to={action.to} variant={action.variant ?? 'primary'} size="sm">
              {action.label}
            </ButtonLink>
          ) : (
            <Button key={action.label} type="button" variant={action.variant ?? 'primary'} size="sm" onClick={action.onClick}>
              {action.label}
            </Button>
          )
        )}
      />

      <Card as="section" className="workspace-inspector-card">
        <div className="stack tight">
          <div className="row between gap wrap align-center">
            <h3>{t('Closure snapshot')}</h3>
            <Badge tone={preferredLaunchReadyDatasetVersion ? 'success' : 'neutral'}>
              {preferredLaunchReadyDatasetVersion ? t('Ready to launch') : t('Still preparing')}
            </Badge>
          </div>
          <small className="muted">
            {t('Use this panel to confirm whether you should stay in annotation, go back to dataset versions, or move into training.')}
          </small>
        </div>
        <DetailList
          items={[
            { label: t('Version scope'), value: currentVersionLabel },
            { label: t('Ready files'), value: readyFileCount },
            { label: t('Needs work'), value: annotationSummary.needs_work },
            { label: t('In review'), value: annotationSummary.in_review },
            { label: t('Rejected'), value: annotationSummary.rejected },
            { label: t('Approved'), value: annotationSummary.approved },
            { label: t('Dataset versions'), value: datasetVersions.length },
            { label: t('Launch-ready versions'), value: launchReadyDatasetVersions.length },
            {
              label: t('Preferred training version'),
              value: preferredLaunchReadyDatasetVersion?.version_name ?? preferredTrainingDatasetVersion?.version_name ?? '-'
            }
          ]}
        />
        <div className="row gap wrap">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              void focusQueueFilter(preferredReviewQueue);
            }}
          >
            {preferredReviewQueue === 'approved' ? t('Focus approved queue') : t('Focus current queue')}
          </Button>
          <ButtonLink to={datasetDetailPath} variant="ghost" size="sm">
            {t('Open dataset detail')}
          </ButtonLink>
          <ButtonLink to={closureWizardPath} variant="ghost" size="sm">
            {t('Open closure wizard')}
          </ButtonLink>
          <ButtonLink to={inferenceValidationPath} variant="ghost" size="sm">
            {t('Validate inference')}
          </ButtonLink>
        </div>
        {preferredWorkspaceVersionId ? (
          <small className="muted">
            {t('Current queue links keep dataset version {version} in context for downstream pages.', {
              version: currentVersionLabel
            })}
          </small>
        ) : null}
      </Card>

      <div className="annotation-sidebar-tabs" role="tablist" aria-label={t('Annotation tools')}>
        <Button
          type="button"
          size="sm"
          variant={annotationSidebarTab === 'annotation' ? 'secondary' : 'ghost'}
          onClick={() => setAnnotationSidebarTab('annotation')}
        >
          {t('Label')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={annotationSidebarTab === 'prediction' ? 'secondary' : 'ghost'}
          onClick={() => setAnnotationSidebarTab('prediction')}
        >
          {t('Compare')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={annotationSidebarTab === 'sample' ? 'secondary' : 'ghost'}
          onClick={() => setAnnotationSidebarTab('sample')}
        >
          {t('Info')}
        </Button>
      </div>

          {annotationSidebarTab === 'annotation' ? (
        <Card as="section" className="workspace-inspector-card">
            <div className="stack tight">
              <div className="row between gap wrap align-center">
              <h3>{t('Label')}</h3>
              <Badge tone={canvasMode === 'draw' ? 'info' : 'neutral'}>
                {canvasMode === 'draw' ? t('B') : t('V')}
              </Badge>
            </div>
            <small className="muted">{t('Draw, edit, delete.')}</small>
          </div>
          {dataset.task_type !== 'segmentation' ? (
            <>
              <div className="annotation-tool-toggle" role="group" aria-label={t('Annotation tools')}>
                <Button
                  type="button"
                  size="sm"
                  variant={canvasMode === 'draw' ? 'secondary' : 'ghost'}
                  onClick={() => setCanvasMode('draw')}
                >
                  {t('B')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={canvasMode === 'select' ? 'secondary' : 'ghost'}
                  onClick={() => setCanvasMode('select')}
                >
                  {t('V')}
                </Button>
              </div>
              <div className="stack tight">
                <div className="row between gap wrap align-center">
                  <small className="muted">{t('Active label')}</small>
                  <Badge tone="neutral">{preferredBoxLabel || labelChoices[0] || t('None')}</Badge>
                </div>
                {pendingLabelSelectionActive ? (
                  <Panel as="section" tone="accent" className="annotation-inline-prompt">
                    <strong>{t('Assign label')}</strong>
                    <span>{t('Choose a label for the new region, then keep editing the canvas.')}</span>
                  </Panel>
                ) : null}
                <div className="row gap wrap">
                  {(labelChoices.length > 0
                    ? labelChoices
                    : [t('Current label')]).map((label) => (
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
              </div>
              <div className="annotation-selected-box-card">
                <div className="row between gap wrap align-center">
                  <strong>{t('Selected region')}</strong>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => annotationCanvasRef.current?.deleteSelectedBox()}
                    disabled={busy || !selectedBox}
                  >
                    {t('Delete region')}
                  </Button>
                </div>
                {selectedBox ? (
                  <div className="annotation-selected-box-grid">
                    <div>
                      <small className="muted">{t('Label')}</small>
                      <strong>{selectedBox.label}</strong>
                    </div>
                    <div>
                      <small className="muted">{t('Coordinates')}</small>
                      <strong>
                        {Math.round(selectedBox.x)}, {Math.round(selectedBox.y)}
                      </strong>
                    </div>
                    <div>
                      <small className="muted">{t('Size')}</small>
                      <strong>
                        {Math.round(selectedBox.width)} × {Math.round(selectedBox.height)}
                      </strong>
                    </div>
                  </div>
                ) : (
                  <small className="muted">{t('Select a region to keep editing.')}</small>
                )}
              </div>
            </>
          ) : (
            <div className="annotation-selected-box-card">
              <div className="row between gap wrap align-center">
                <strong>{t('Annotation Canvas')}</strong>
                <Badge tone="info">{t('Polygons')}: {polygons.length}</Badge>
              </div>
            </div>
          )}
          {dataset.task_type === 'ocr' ? (
            <div className="annotation-ocr-panel">
              <div className="stack tight">
                <div className="row between gap wrap align-center">
                  <strong>{t('OCR')}</strong>
                  <Badge tone="neutral">{t('OCR text lines')}: {ocrLines.length}</Badge>
                </div>
              </div>
              <div className="annotation-ocr-entry-row">
                <label className="annotation-ocr-entry-main">
                  {t('Text')}
                  <Input value={lineText} onChange={(event) => setLineText(event.target.value)} disabled={busy || isEditLocked} />
                </label>
                <Button onClick={addOcrLine} variant="secondary" size="sm" disabled={busy || isEditLocked}>
                  {t('Add OCR Line')}
                </Button>
              </div>
              <details className="workspace-disclosure" open={showOcrAdvancedFields} onToggle={(event) => setShowOcrAdvancedFields(event.currentTarget.open)}>
                <summary>
                  <span>{t('Advanced')}</span>
                  {lineRegionId || lineConfidence.trim() !== '0.9' ? <Badge tone="info">{t('Configured')}</Badge> : null}
                </summary>
                <div className="workspace-disclosure-content">
                  <div className="annotation-ocr-grid">
                    <label>
                      {t('Confidence')}
                      <Input value={lineConfidence} onChange={(event) => setLineConfidence(event.target.value)} placeholder="0.90" disabled={busy || isEditLocked} />
                    </label>
                    <label>
                      {t('Linked region')}
                      <Select value={lineRegionId} onChange={(event) => setLineRegionId(event.target.value)} disabled={busy || isEditLocked}>
                        <option value="">{t('Unbound region')}</option>
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
                          {t('Delete')}
                        </Button>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">
                          {t('Confidence')}: {line.confidence.toFixed(2)}
                        </Badge>
                        {line.region_id ? <Badge tone="neutral">{t('region')}: {line.region_id}</Badge> : <Badge tone="neutral">{t('Unbound region')}</Badge>}
                      </div>
                    </Panel>
                  ))}
                </ul>
              ) : (
                <small className="muted">{t('No OCR lines yet')}</small>
              )}
            </div>
          ) : null}
          <details className="workspace-disclosure" open={showShortcutGuide} onToggle={(event) => setShowShortcutGuide(event.currentTarget.open)}>
            <summary>
              <span>{t('Shortcuts')}</span>
            </summary>
            <div className="workspace-disclosure-content">
              <div className="annotation-shortcut-grid">
                <div><Badge tone="neutral">B</Badge><small>{t('Draw')}</small></div>
                <div><Badge tone="neutral">V</Badge><small>{t('Select / edit')}</small></div>
                <div><Badge tone="neutral">Delete</Badge><small>{t('Delete region')}</small></div>
                <div><Badge tone="neutral">Ctrl/Cmd + S</Badge><small>{t('Save draft')}</small></div>
                <div><Badge tone="neutral">Enter</Badge><small>{t('Submit')}</small></div>
                <div><Badge tone="neutral">← / →</Badge><small>{t('Previous / next')}</small></div>
              </div>
            </div>
          </details>
        </Card>
      ) : null}

      {annotationSidebarTab === 'prediction' ? (
        <div className="stack">
          <PredictionOverlayControls
            t={t}
            className="workspace-inspector-card"
            busy={busy}
            hasPredictionOverlay={hasPredictionOverlay}
            showAnnotationOverlay={showAnnotationOverlay}
            showPredictionOverlay={showPredictionOverlay}
            predictionConfidenceThreshold={predictionConfidenceThreshold}
            predictionCandidateCount={predictionCandidateCount}
            lowConfidencePredictionCount={lowConfidencePredictionCount}
            predictionCandidates={predictionCandidates}
            numericPredictionConfidenceThreshold={numericPredictionConfidenceThreshold}
            canUsePredictionInOcrEditor={canUsePredictionInOcrEditor}
            canAdoptPrediction={hasPredictionOverlay}
            onShowAnnotationOverlayChange={setShowAnnotationOverlay}
            onShowPredictionOverlayChange={setShowPredictionOverlay}
            onPredictionConfidenceThresholdChange={setPredictionConfidenceThreshold}
            onUsePredictionCandidate={applyPredictionCandidateToOcrEditor}
            onAdoptPredictionResults={applyPredictionDraft}
          />
          <details className="workspace-disclosure" open={false}>
            <summary>
              <span>{t('Pre-annotation')}</span>
            </summary>
            <div className="workspace-disclosure-content">
              {modelVersions.length === 0 ? (
                <StateBlock
                  variant="empty"
                  title={t('No Matching Model Version')}
                  description={t('Register a model version with same task type before pre-annotation.')}
                  extra={
                    <ButtonLink to={modelVersionsPath} variant="secondary" size="sm">
                      {t('Open Model Versions')}
                    </ButtonLink>
                  }
                />
              ) : (
                <>
                  <label className="stack tight annotation-workspace-model-select">
                    <small className="muted">{t('Model version')}</small>
                    <Select value={selectedModelVersionId} onChange={(event) => setSelectedModelVersionId(event.target.value)}>
                      {modelVersions.map((version) => (
                        <option key={version.id} value={version.id}>
                          {version.version_name} ({t(version.framework)})
                        </option>
                      ))}
                    </Select>
                  </label>
                  <div className="row gap wrap">
                    <Button onClick={runPreAnnotation} variant="secondary" size="sm" disabled={busy || items.length === 0}>
                      {t('Run pre-annotation')}
                    </Button>
                    <ButtonLink
                      to={buildInferenceValidationPath(
                        resolvedDatasetId,
                        preferredLaunchReadyDatasetVersion?.id ?? preferredWorkspaceVersionId,
                        {
                          modelVersionId: selectedModelVersionId || undefined,
                          launchContext: launchContextForAnnotationFlow
                        }
                      )}
                      variant="ghost"
                      size="sm"
                    >
                      {t('Open validation page')}
                    </ButtonLink>
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
                      {refreshing ? t('Refreshing...') : t('Refresh')}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </details>
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
                  <h3>{t('Review')}</h3>
                  </div>
                  <div className="row gap wrap">
                    <Button onClick={() => void reviewAnnotation('approved')} variant="secondary" size="sm" disabled={busy}>
                      {t('Approve')}
                    </Button>
                    <Button onClick={() => void reviewAnnotation('rejected')} variant="danger" size="sm" disabled={busy}>
                      {t('Reject')}
                    </Button>
                  </div>
                  <label>
                  {t('Reason')}
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
                  {t('Comment')}
                  <Textarea value={reviewComment} rows={3} onChange={(event) => setReviewComment(event.target.value)} />
                </label>
              </div>
            </Card>
          ) : null}
          {selectedAnnotation?.status === 'rejected' ? (
            <Card as="section" className="workspace-inspector-card">
              <Button onClick={moveRejectedToProgress} variant="ghost" size="sm" disabled={busy}>
                {t('Reopen rejected sample')}
              </Button>
            </Card>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const annotationMain = (
    <div className="annotation-main-stack">
      {selectedItem ? (
        <Card as="section" className="annotation-canvas-shell">
          {dataset.task_type === 'segmentation' ? (
            <Suspense fallback={<StateBlock variant="loading" title={t('Loading')} description={t('Preparing polygon canvas.')} />}>
              <PolygonCanvas
                title={t('Segmentation Polygon Canvas')}
                filename={selectedFilename}
                imageUrl={selectedAttachmentPreviewUrl}
                polygons={polygons}
                onChange={handlePolygonsChange}
                disabled={busy || !selectedItem || isEditLocked}
              />
            </Suspense>
          ) : (
            <Suspense fallback={<StateBlock variant="loading" title={t('Loading')} description={t('Preparing annotation canvas.')} />}>
              <AnnotationCanvas
                ref={annotationCanvasRef}
                title={t('Annotation Canvas')}
                filename={selectedFilename}
                imageUrl={selectedAttachmentPreviewUrl}
                boxes={canvasBoxes}
                predictionBoxes={predictionOverlayBoxes}
                defaultLabel={preferredBoxLabel || labelChoices[0] || t('Default label')}
                toolMode={canvasMode}
                showPredictionOverlay={showPredictionOverlay && hasPredictionOverlay}
                onChange={handleBoxesChange}
                onInteractionStart={pushCanvasHistory}
                onSelectionChange={setSelectedBox}
                onBoxCreate={handleCanvasBoxCreate}
                disabled={busy || !selectedItem || isEditLocked}
              />
            </Suspense>
          )}
        </Card>
      ) : (
        <Card as="section" className="annotation-canvas-shell">
          <StateBlock
            variant="empty"
            title={t('No sample yet')}
            description={
              onlyLowConfidenceCandidates
                ? t('Clear filters or switch scope.')
                : t('Go to dataset detail to switch queues.')
            }
            extra={
              onlyLowConfidenceCandidates ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setOnlyLowConfidenceCandidates(false)}
                >
                  {t('Clear filters')}
                </Button>
              ) : null
            }
          />
        </Card>
      )}
    </div>
  );

  return (
    <WorkspacePage>
      <div ref={workspaceRootRef} className="annotation-focus-page">
        <Card as="header" className="annotation-focus-header">
          <div className="annotation-focus-header__left">
            <ButtonLink size="sm" variant="ghost" to={requestedReturnTo ?? datasetDetailPath}>
              {t('Back to dataset')}
            </ButtonLink>
          </div>
          <div className="annotation-focus-header__center">
            <small className="workspace-eyebrow">{t('Annotation workspace')}</small>
            <strong className="annotation-focus-header__title">{dataset.name}</strong>
            <small className="muted">
              {t('Sample {sample}', {
                sample: selectedFilename || t('Not selected')
              })}
            </small>
            <div className="annotation-focus-header__meta">
              <Badge tone="neutral">
                {t('Version')}: {currentVersionLabel}
              </Badge>
              <Badge tone="info">{queuePositionSummary}</Badge>
              <Button
                type="button"
                size="sm"
                variant={onlyLowConfidenceCandidates ? 'secondary' : 'ghost'}
                onClick={() => setOnlyLowConfidenceCandidates((current) => !current)}
              >
                {t('Only low-confidence')}
              </Button>
              {selectedAnnotation ? <Badge tone="neutral">{t(selectedAnnotation.status)}</Badge> : <Badge tone="warning">{t('Unannotated')}</Badge>}
            </div>
          </div>
          <div className="annotation-focus-header__right">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void focusAdjacentQueueItem(-1)}
              disabled={busy || !canMoveToPreviousQueueItem}
            >
              {t('Prev')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void focusAdjacentQueueItem(1)}
              disabled={busy || !canMoveToNextQueueItem}
            >
              {t('Next')}
            </Button>
            <Button
              type="button"
              variant={isCanvasExpanded ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => {
                void toggleCanvasExpand();
              }}
            >
              {isCanvasExpanded ? t('Exit full screen') : t('Expand')}
            </Button>
          </div>
        </Card>

        {queueToast ? (
          <div className={`workspace-toast ${queueToast.variant}`} role="status" aria-live="polite">
            {queueToast.text}
          </div>
        ) : null}

        {feedback?.variant === 'error' ? (
        <InlineAlert tone="danger" title={t('Action failed')} description={feedback.text} />
        ) : null}
        {scopedDatasetVersionMissing ? (
          <InlineAlert
            tone="warning"
            title={t('Requested version not found')}
            description={t('The dataset version from the incoming link is unavailable. Showing the current dataset scope instead.')}
            actions={
              <ButtonLink to={clearVersionScopePath} variant="ghost" size="sm">
                {t('Clear context')}
              </ButtonLink>
            }
          />
        ) : null}
        {preferredModelVersionMissing ? (
          <InlineAlert
            tone="warning"
            title={t('Requested model version not found')}
            description={t('The pre-annotation model version from the incoming link is unavailable. Choose another one from the current list.')}
            actions={
              <div className="row gap wrap">
                <ButtonLink to={clearModelVersionContextPath} variant="ghost" size="sm">
                  {t('Clear context')}
                </ButtonLink>
                <ButtonLink to={modelVersionsPath} variant="secondary" size="sm">
                  {t('Open Model Versions')}
                </ButtonLink>
              </div>
            }
          />
        ) : null}
        {queueFilterBlockerHint ? (
          <InlineAlert
            tone="info"
            title={t('Queue filters are hiding all samples')}
            description={queueFilterBlockerHint}
            actions={
              <ButtonLink to={clearQueueFiltersPath} variant="secondary" size="sm">
                {t('Clear filters')}
              </ButtonLink>
            }
          />
        ) : null}

        <WorkspaceWorkbench
          className={isCanvasExpanded ? 'annotation-studio-workbench annotation-studio-workbench--expanded' : 'annotation-studio-workbench'}
          main={annotationMain}
          side={isCanvasExpanded ? null : annotationTabs}
        />

        <Card as="section" className="annotation-bottom-actions annotation-command-bar">
          <div className="annotation-command-bar__summary">
            <div className="row gap wrap align-center annotation-command-bar__status">
              {hasUnsavedCanvasChanges ? (
                <Badge tone="warning">{t('Unsaved changes')}</Badge>
              ) : (
                <Badge tone="neutral">{t('No unsaved changes')}</Badge>
              )}
            </div>
          </div>
          <div className="annotation-command-bar__actions">
            <div className="row gap wrap annotation-command-bar__secondary-actions">
              <Button onClick={undoLast} variant="ghost" size="sm" disabled={busy || canvasUndoStackRef.current.length === 0}>
                {t('Undo')}
              </Button>
              <Button onClick={redoLast} variant="ghost" size="sm" disabled={busy || canvasRedoStackRef.current.length === 0}>
                {t('Redo')}
              </Button>
              <Button onClick={() => void saveAnnotation('in_progress')} variant="secondary" size="sm" disabled={!canSaveInProgress}>
                {t('Save draft')}
              </Button>
            </div>
            <div className="row gap wrap annotation-command-bar__primary-actions">
              <Button onClick={() => void submitCurrentForReview()} variant="primary" size="sm" disabled={!canSubmitForReview}>
                {t('Submit review')}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </WorkspacePage>
  );
}
