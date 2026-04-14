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
import WorkspaceFollowUpHint from '../components/onboarding/WorkspaceFollowUpHint';
import WorkspaceOnboardingCard from '../components/onboarding/WorkspaceOnboardingCard';
import StateBlock from '../components/StateBlock';
import StatusBadge from '../components/StatusBadge';
import StepIndicator from '../components/StepIndicator';
import VirtualList from '../components/VirtualList';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import WorkspaceActionStack from '../components/ui/WorkspaceActionStack';
import { Checkbox, Input, Select, Textarea } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
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

interface ReviewActionEntry {
  id: string;
  itemId: string;
  filename: string;
  status: 'approved' | 'rejected';
  reasonCode: AnnotationReviewReasonCode | null;
  queueAtAction: AnnotationQueueFilter;
  queueSearchText: string;
  queueSplitFilter: 'all' | 'train' | 'val' | 'test' | 'unassigned';
  queueItemStatusFilter: 'all' | 'uploading' | 'processing' | 'ready' | 'error';
  queueMetadataFilter: string;
  onlyLowConfidenceCandidates: boolean;
  predictionConfidenceThreshold: string;
  timestamp: number;
}

interface WorkspaceReturnPoint {
  id: string;
  savedAt: number;
  label: string;
  locked: boolean;
  selectedItemId: string;
  selectedFilename: string;
  queueFilter: AnnotationQueueFilter;
  queueSearchText: string;
  queueSplitFilter: 'all' | 'train' | 'val' | 'test' | 'unassigned';
  queueItemStatusFilter: 'all' | 'uploading' | 'processing' | 'ready' | 'error';
  queueMetadataFilter: string;
  onlyLowConfidenceCandidates: boolean;
  predictionConfidenceThreshold: string;
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
const nextReturnPointId = (): string => `rp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const annotationWorkspaceOnboardingDismissedStorageKey = 'vistral-annotation-onboarding-dismissed';

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
const reviewReasonShortcutMap: Record<string, AnnotationReviewReasonCode> = {
  Digit1: 'box_mismatch',
  Digit2: 'label_error',
  Digit3: 'text_error',
  Digit4: 'missing_object',
  Digit5: 'polygon_issue',
  Digit6: 'other'
};
const queueShortcutFilters: AnnotationQueueFilter[] = [
  'all',
  'needs_work',
  'in_review',
  'rejected',
  'approved'
];
const shortcutAutoAdvanceStorageKey = 'vistral.annotation.shortcutAutoAdvance';
const followupAutoSwitchStorageKey = 'vistral.annotation.followupAutoSwitch';
const workspaceReturnPointsStorageKeyLegacy = 'vistral.annotation.workspaceReturnPoints';
const workspaceReturnPointsStorageKeyPrefix = 'vistral.annotation.workspaceReturnPoints';
const reviewSessionStorageKeyPrefix = 'vistral.annotation.reviewSession';
const workspaceReturnPointMaxSlots = 3;
const reviewSessionHistoryMaxEntries = 120;

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

const parseWorkspaceReturnPoints = (raw: string | null): WorkspaceReturnPoint[] => {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry, index) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }

        const record = entry as Record<string, unknown>;
        const selectedItemId = typeof record.selectedItemId === 'string' ? record.selectedItemId.trim() : '';
        const selectedFilename = typeof record.selectedFilename === 'string' ? record.selectedFilename.trim() : '';
        if (!selectedItemId) {
          return null;
        }

        return {
          id: typeof record.id === 'string' && record.id.trim() ? record.id : `rp-restored-${index}-${Date.now()}`,
          savedAt: typeof record.savedAt === 'number' && Number.isFinite(record.savedAt) ? record.savedAt : Date.now(),
          label:
            typeof record.label === 'string' && record.label.trim()
              ? record.label.trim()
              : selectedFilename,
          locked: record.locked === true,
          selectedItemId,
          selectedFilename,
          queueFilter: normalizeAnnotationQueueFilter(
            typeof record.queueFilter === 'string' ? record.queueFilter : 'all'
          ),
          queueSearchText: typeof record.queueSearchText === 'string' ? record.queueSearchText : '',
          queueSplitFilter: normalizeQueueSplitFilter(
            typeof record.queueSplitFilter === 'string' ? record.queueSplitFilter : null
          ),
          queueItemStatusFilter: normalizeQueueItemStatusFilter(
            typeof record.queueItemStatusFilter === 'string' ? record.queueItemStatusFilter : null
          ),
          queueMetadataFilter: typeof record.queueMetadataFilter === 'string' ? record.queueMetadataFilter : '',
          onlyLowConfidenceCandidates: record.onlyLowConfidenceCandidates === true,
          predictionConfidenceThreshold:
            typeof record.predictionConfidenceThreshold === 'string' && record.predictionConfidenceThreshold.trim()
              ? record.predictionConfidenceThreshold
              : '0.50'
        } satisfies WorkspaceReturnPoint;
      })
      .filter((entry): entry is WorkspaceReturnPoint => entry !== null)
      .slice(0, workspaceReturnPointMaxSlots);
  } catch {
    return [];
  }
};

const parseReviewActionHistory = (value: unknown): ReviewActionEntry[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const itemId = typeof record.itemId === 'string' ? record.itemId.trim() : '';
      if (!itemId) {
        return null;
      }

      const status = record.status === 'rejected' ? 'rejected' : record.status === 'approved' ? 'approved' : null;
      if (!status) {
        return null;
      }

      const reasonCodeValue = record.reasonCode;
      const reasonCode: AnnotationReviewReasonCode | null =
        reasonCodeValue === 'box_mismatch' ||
        reasonCodeValue === 'label_error' ||
        reasonCodeValue === 'text_error' ||
        reasonCodeValue === 'missing_object' ||
        reasonCodeValue === 'polygon_issue' ||
        reasonCodeValue === 'other'
          ? reasonCodeValue
          : null;

      return {
        id:
          typeof record.id === 'string' && record.id.trim()
            ? record.id
            : `history-restored-${index}-${Date.now()}`,
        itemId,
        filename:
          typeof record.filename === 'string' && record.filename.trim()
            ? record.filename
            : itemId,
        status,
        reasonCode,
        queueAtAction: normalizeAnnotationQueueFilter(
          typeof record.queueAtAction === 'string' ? record.queueAtAction : 'all'
        ),
        queueSearchText: typeof record.queueSearchText === 'string' ? record.queueSearchText : '',
        queueSplitFilter: normalizeQueueSplitFilter(
          typeof record.queueSplitFilter === 'string' ? record.queueSplitFilter : null
        ),
        queueItemStatusFilter: normalizeQueueItemStatusFilter(
          typeof record.queueItemStatusFilter === 'string' ? record.queueItemStatusFilter : null
        ),
        queueMetadataFilter: typeof record.queueMetadataFilter === 'string' ? record.queueMetadataFilter : '',
        onlyLowConfidenceCandidates: record.onlyLowConfidenceCandidates === true,
        predictionConfidenceThreshold:
          typeof record.predictionConfidenceThreshold === 'string' && record.predictionConfidenceThreshold.trim()
            ? record.predictionConfidenceThreshold
            : '0.50',
        timestamp:
          typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
            ? record.timestamp
            : Date.now()
      } satisfies ReviewActionEntry;
    })
    .filter((entry): entry is ReviewActionEntry => entry !== null)
    .slice(0, reviewSessionHistoryMaxEntries);
};

const parseReviewSessionSnapshot = (
  raw: string | null
): {
  stats: { total: number; approved: number; rejected: number };
  startedAt: number | null;
  lastActionAt: number | null;
  history: ReviewActionEntry[];
  historyFilter: 'all' | 'rejected';
  historyCursor: number;
  restoreContextOnReopen: boolean;
} => {
  if (!raw) {
    return {
      stats: { total: 0, approved: 0, rejected: 0 },
      startedAt: null,
      lastActionAt: null,
      history: [],
      historyFilter: 'all',
      historyCursor: 0,
      restoreContextOnReopen: false
    };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('invalid review session payload');
    }

    const record = parsed as Record<string, unknown>;
    const history = parseReviewActionHistory(record.history);
    const total = Math.max(0, Math.floor(toNumber(record.total, history.length)));
    const approved = Math.max(0, Math.floor(toNumber(record.approved, 0)));
    const rejected = Math.max(0, Math.floor(toNumber(record.rejected, 0)));
    return {
      stats: {
        total,
        approved: Math.min(approved, total),
        rejected: Math.min(rejected, total)
      },
      startedAt:
        typeof record.startedAt === 'number' && Number.isFinite(record.startedAt)
          ? record.startedAt
          : null,
      lastActionAt:
        typeof record.lastActionAt === 'number' && Number.isFinite(record.lastActionAt)
          ? record.lastActionAt
          : null,
      history,
      historyFilter: record.historyFilter === 'rejected' ? 'rejected' : 'all',
      historyCursor: Math.max(0, Math.floor(toNumber(record.historyCursor, 0))),
      restoreContextOnReopen: record.restoreContextOnReopen === true
    };
  } catch {
    return {
      stats: { total: 0, approved: 0, rejected: 0 },
      startedAt: null,
      lastActionAt: null,
      history: [],
      historyFilter: 'all',
      historyCursor: 0,
      restoreContextOnReopen: false
    };
  }
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

const formatSessionClock = (timestamp: number | null, fallback: string): string => {
  if (!timestamp) {
    return fallback;
  }

  try {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return fallback;
  }
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
  const [shortcutAutoAdvance, setShortcutAutoAdvance] = useState(() => {
    if (typeof window === 'undefined') {
      return true;
    }

    const persisted = window.localStorage.getItem(shortcutAutoAdvanceStorageKey);
    if (!persisted) {
      return true;
    }

    return persisted === '1';
  });
  const [autoSwitchAfterInReviewClear, setAutoSwitchAfterInReviewClear] = useState(() => {
    if (typeof window === 'undefined') {
      return true;
    }

    const persisted = window.localStorage.getItem(followupAutoSwitchStorageKey);
    if (!persisted) {
      return true;
    }

    return persisted === '1';
  });
  const [showShortcutGuide, setShowShortcutGuide] = useState(false);
  const [showWorkspaceUtilities, setShowWorkspaceUtilities] = useState(false);
  const [showAdvancedQueueFilters, setShowAdvancedQueueFilters] = useState(false);
  const [showOcrAdvancedFields, setShowOcrAdvancedFields] = useState(false);
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
  const [pendingFollowupQueueSwitch, setPendingFollowupQueueSwitch] = useState(false);
  const [reviewSessionStats, setReviewSessionStats] = useState<{
    total: number;
    approved: number;
    rejected: number;
  }>({
    total: 0,
    approved: 0,
    rejected: 0
  });
  const [reviewSessionStartedAt, setReviewSessionStartedAt] = useState<number | null>(null);
  const [reviewSessionLastActionAt, setReviewSessionLastActionAt] = useState<number | null>(null);
  const [reviewActionHistory, setReviewActionHistory] = useState<ReviewActionEntry[]>([]);
  const [reviewHistoryFilter, setReviewHistoryFilter] = useState<'all' | 'rejected'>('all');
  const [reviewHistoryCursor, setReviewHistoryCursor] = useState(0);
  const [historyRestoreContextOnReopen, setHistoryRestoreContextOnReopen] = useState(false);
  const [reviewSessionHydrated, setReviewSessionHydrated] = useState(false);
  const [reviewSessionHydratedKey, setReviewSessionHydratedKey] = useState('');
  const [workspaceReturnPoints, setWorkspaceReturnPoints] = useState<WorkspaceReturnPoint[]>([]);
  const [workspaceReturnPointsHydrated, setWorkspaceReturnPointsHydrated] = useState(false);
  const [workspaceReturnPointsHydratedKey, setWorkspaceReturnPointsHydratedKey] = useState('');
  const [editingReturnPointId, setEditingReturnPointId] = useState<string | null>(null);
  const [editingReturnPointLabel, setEditingReturnPointLabel] = useState('');
  const workspaceSignatureRef = useRef('');
  const queueSearchInputRef = useRef<HTMLInputElement | null>(null);
  const queueMetadataInputRef = useRef<HTMLInputElement | null>(null);
  const reviewReasonSelectRef = useRef<HTMLSelectElement | null>(null);
  const queueSectionRef = useRef<HTMLDivElement | null>(null);
  const canvasSectionRef = useRef<HTMLDivElement | null>(null);
  const actionSectionRef = useRef<HTMLDivElement | null>(null);
  const reviewSessionStorageKey = useMemo(
    () =>
      datasetId
        ? scopedDatasetVersionId
          ? `${reviewSessionStorageKeyPrefix}.${datasetId}.${scopedDatasetVersionId}`
          : `${reviewSessionStorageKeyPrefix}.${datasetId}`
        : '',
    [datasetId, scopedDatasetVersionId]
  );
  const reviewSessionStorageLegacyKey = useMemo(
    () => (datasetId ? `${reviewSessionStorageKeyPrefix}.${datasetId}` : ''),
    [datasetId]
  );
  const workspaceReturnPointsStorageKey = useMemo(() => {
    if (!datasetId) {
      return '';
    }

    return scopedDatasetVersionId
      ? `${workspaceReturnPointsStorageKeyPrefix}.${datasetId}.${scopedDatasetVersionId}`
      : `${workspaceReturnPointsStorageKeyPrefix}.${datasetId}`;
  }, [datasetId, scopedDatasetVersionId]);
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
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(shortcutAutoAdvanceStorageKey, shortcutAutoAdvance ? '1' : '0');
  }, [shortcutAutoAdvance]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(followupAutoSwitchStorageKey, autoSwitchAfterInReviewClear ? '1' : '0');
  }, [autoSwitchAfterInReviewClear]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (!workspaceReturnPointsStorageKey) {
      setWorkspaceReturnPoints([]);
      setWorkspaceReturnPointsHydrated(false);
      setWorkspaceReturnPointsHydratedKey('');
      return;
    }

    const scopedRaw = window.localStorage.getItem(workspaceReturnPointsStorageKey);
    if (scopedRaw !== null) {
      setWorkspaceReturnPoints(parseWorkspaceReturnPoints(scopedRaw));
      setWorkspaceReturnPointsHydrated(true);
      setWorkspaceReturnPointsHydratedKey(workspaceReturnPointsStorageKey);
      return;
    }

    const legacyRaw = window.localStorage.getItem(workspaceReturnPointsStorageKeyLegacy);
    setWorkspaceReturnPoints(parseWorkspaceReturnPoints(legacyRaw));
    setWorkspaceReturnPointsHydrated(true);
    setWorkspaceReturnPointsHydratedKey(workspaceReturnPointsStorageKey);
  }, [workspaceReturnPointsStorageKey]);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !workspaceReturnPointsStorageKey ||
      !workspaceReturnPointsHydrated ||
      workspaceReturnPointsHydratedKey !== workspaceReturnPointsStorageKey
    ) {
      return;
    }

    if (workspaceReturnPoints.length === 0) {
      window.localStorage.removeItem(workspaceReturnPointsStorageKey);
      return;
    }

    window.localStorage.setItem(
      workspaceReturnPointsStorageKey,
      JSON.stringify(workspaceReturnPoints.slice(0, workspaceReturnPointMaxSlots))
    );
    window.localStorage.removeItem(workspaceReturnPointsStorageKeyLegacy);
  }, [
    workspaceReturnPoints,
    workspaceReturnPointsHydrated,
    workspaceReturnPointsHydratedKey,
    workspaceReturnPointsStorageKey
  ]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (!reviewSessionStorageKey) {
      setReviewSessionHydrated(false);
      setReviewSessionHydratedKey('');
      return;
    }

    const scopedRaw = window.localStorage.getItem(reviewSessionStorageKey);
    const fallbackRaw =
      scopedRaw !== null
        ? scopedRaw
        : reviewSessionStorageLegacyKey &&
            reviewSessionStorageLegacyKey !== reviewSessionStorageKey
          ? window.localStorage.getItem(reviewSessionStorageLegacyKey)
          : null;
    const snapshot = parseReviewSessionSnapshot(fallbackRaw);
    setReviewSessionStats(snapshot.stats);
    setReviewSessionStartedAt(snapshot.startedAt);
    setReviewSessionLastActionAt(snapshot.lastActionAt);
    setReviewActionHistory(snapshot.history);
    setReviewHistoryFilter(snapshot.historyFilter);
    setReviewHistoryCursor(snapshot.historyCursor);
    setHistoryRestoreContextOnReopen(snapshot.restoreContextOnReopen);
    setReviewSessionHydrated(true);
    setReviewSessionHydratedKey(reviewSessionStorageKey);
  }, [reviewSessionStorageKey, reviewSessionStorageLegacyKey]);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !reviewSessionStorageKey ||
      !reviewSessionHydrated ||
      reviewSessionHydratedKey !== reviewSessionStorageKey
    ) {
      return;
    }

    const hasSessionData =
      reviewSessionStats.total > 0 ||
      reviewSessionStats.approved > 0 ||
      reviewSessionStats.rejected > 0 ||
      reviewSessionStartedAt !== null ||
      reviewSessionLastActionAt !== null ||
      reviewActionHistory.length > 0 ||
      reviewHistoryFilter !== 'all' ||
      reviewHistoryCursor !== 0 ||
      historyRestoreContextOnReopen;

    if (!hasSessionData) {
      window.localStorage.removeItem(reviewSessionStorageKey);
      if (reviewSessionStorageLegacyKey && reviewSessionStorageLegacyKey !== reviewSessionStorageKey) {
        window.localStorage.removeItem(reviewSessionStorageLegacyKey);
      }
      return;
    }

    window.localStorage.setItem(
      reviewSessionStorageKey,
      JSON.stringify({
        total: reviewSessionStats.total,
        approved: reviewSessionStats.approved,
        rejected: reviewSessionStats.rejected,
        startedAt: reviewSessionStartedAt,
        lastActionAt: reviewSessionLastActionAt,
        history: reviewActionHistory.slice(0, reviewSessionHistoryMaxEntries),
        historyFilter: reviewHistoryFilter,
        historyCursor: reviewHistoryCursor,
        restoreContextOnReopen: historyRestoreContextOnReopen
      })
    );
    if (reviewSessionStorageLegacyKey && reviewSessionStorageLegacyKey !== reviewSessionStorageKey) {
      window.localStorage.removeItem(reviewSessionStorageLegacyKey);
    }
  }, [
    historyRestoreContextOnReopen,
    reviewActionHistory,
    reviewHistoryCursor,
    reviewHistoryFilter,
    reviewSessionHydrated,
    reviewSessionHydratedKey,
    reviewSessionLastActionAt,
    reviewSessionStartedAt,
    reviewSessionStats,
    reviewSessionStorageKey,
    reviewSessionStorageLegacyKey
  ]);

  useEffect(() => {
    if (!editingReturnPointId) {
      return;
    }

    const exists = workspaceReturnPoints.some((point) => point.id === editingReturnPointId);
    if (!exists) {
      setEditingReturnPointId(null);
      setEditingReturnPointLabel('');
    }
  }, [editingReturnPointId, workspaceReturnPoints]);

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
  const itemIdSet = useMemo(() => new Set(items.map((item) => item.id)), [items]);

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
  const hasActiveQueueRefinements = useMemo(
    () =>
      queueSearchText.trim().length > 0 ||
      queueSplitFilter !== 'all' ||
      queueItemStatusFilter !== 'all' ||
      queueMetadataFilter.trim().length > 0 ||
      onlyLowConfidenceCandidates,
    [
      onlyLowConfidenceCandidates,
      queueItemStatusFilter,
      queueMetadataFilter,
      queueSearchText,
      queueSplitFilter
    ]
  );
  const hasAdvancedQueueRefinements = useMemo(
    () => queueItemStatusFilter !== 'all' || queueMetadataFilter.trim().length > 0,
    [queueItemStatusFilter, queueMetadataFilter]
  );
  const advancedQueueFilterCount = useMemo(
    () => Number(queueItemStatusFilter !== 'all') + Number(queueMetadataFilter.trim().length > 0),
    [queueItemStatusFilter, queueMetadataFilter]
  );
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
    setShowAdvancedQueueFilters(false);
  }, []);
  const shouldVirtualizeQueueList = filteredItems.length > 10;
  const selectedQueueIndex = useMemo(
    () => filteredItems.findIndex((item) => item.id === selectedItemId),
    [filteredItems, selectedItemId]
  );
  const queueProgressContext = useMemo(() => {
    const total = filteredItems.length;
    const current = selectedQueueIndex >= 0 ? selectedQueueIndex + 1 : 0;
    const remaining = current > 0 ? Math.max(total - current, 0) : total;
    return {
      current,
      total,
      remaining
    };
  }, [filteredItems.length, selectedQueueIndex]);
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

    return queueProgressContext;
  }, [queueFilter, queueProgressContext]);
  const reviewSessionAverageSeconds = useMemo(() => {
    if (!reviewSessionStartedAt || !reviewSessionLastActionAt || reviewSessionStats.total <= 0) {
      return null;
    }

    const elapsedSeconds = Math.max((reviewSessionLastActionAt - reviewSessionStartedAt) / 1000, 0);
    return elapsedSeconds / reviewSessionStats.total;
  }, [reviewSessionLastActionAt, reviewSessionStartedAt, reviewSessionStats.total]);
  const filteredReviewActionHistory = useMemo(
    () =>
      reviewHistoryFilter === 'rejected'
        ? reviewActionHistory.filter((entry) => entry.status === 'rejected')
        : reviewActionHistory,
    [reviewActionHistory, reviewHistoryFilter]
  );
  const latestReviewAction = filteredReviewActionHistory[0] ?? null;
  const primaryWorkspaceReturnPoint = workspaceReturnPoints[0] ?? null;
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

  useEffect(() => {
    if (filteredReviewActionHistory.length === 0) {
      if (reviewHistoryCursor !== 0) {
        setReviewHistoryCursor(0);
      }
      return;
    }

    if (reviewHistoryCursor >= filteredReviewActionHistory.length) {
      setReviewHistoryCursor(filteredReviewActionHistory.length - 1);
    }
  }, [filteredReviewActionHistory.length, reviewHistoryCursor]);

  useEffect(() => {
    setWorkspaceReturnPoints((current) => {
      const next = current.filter((point) => itemIdSet.has(point.selectedItemId));
      return next.length === current.length ? current : next;
    });
    setReviewActionHistory((current) => {
      const next = current.filter((entry) => itemIdSet.has(entry.itemId));
      return next.length === current.length ? current : next;
    });
  }, [itemIdSet]);

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
  const queueLabel = useCallback(
    (value: AnnotationQueueFilter) => {
      if (value === 'all') {
        return t('All items');
      }
      if (value === 'needs_work') {
        return t('Needs Work');
      }
      return t(value);
    },
    [t]
  );
  const queuePositionSummary = useMemo(() => {
    if (queueProgressContext.current > 0) {
      return t('Queue position {current} / {total}', {
        current: queueProgressContext.current,
        total: queueProgressContext.total
      });
    }

    if (filteredItems.length > 0) {
      return t('No item selected in current queue.');
    }

    return t('Visible items {visible} / {total}', {
      visible: filteredItems.length,
      total: items.length
    });
  }, [filteredItems.length, items.length, queueProgressContext, t]);
  const renderQueueRecord = useCallback(
    (item: DatasetItemRecord, options?: { virtualized?: boolean }) => {
      const itemAnnotation = annotationByItemId.get(item.id) ?? null;
      const itemFilename = attachmentById.get(item.attachment_id)?.filename ?? t('File unavailable');
      const lowConfidenceCount = lowConfidenceCountByItemId.get(item.id) ?? 0;
      const annotationState = itemAnnotation ? t(itemAnnotation.status) : t('unannotated');
      const showItemStatus = item.status !== 'ready';
      const summaryText = itemAnnotation?.latest_review?.review_comment
        ? itemAnnotation.latest_review.review_comment
        : itemAnnotation?.latest_review?.review_reason_code
          ? t('Review reason: {reason}', { reason: t(itemAnnotation.latest_review.review_reason_code) })
          : lowConfidenceCount > 0
            ? t('Contains {count} low-confidence prediction signals.', { count: lowConfidenceCount })
            : t('Open this sample to continue annotation or review.');

      return (
        <Panel
          key={item.id}
          as={options?.virtualized ? 'div' : 'li'}
          className={`workspace-record-item${options?.virtualized ? ' virtualized' : ''}${selectedItemId === item.id ? ' selected' : ''}`}
          tone="soft"
        >
          <label className="row gap wrap align-center annotation-item-select">
            <Checkbox
              type="radio"
              name="selected_item"
              checked={selectedItemId === item.id}
              onChange={() => {
                setQueueFilter(queueFilter);
                setSelectedItemId(item.id);
              }}
            />
            <div className="stack tight annotation-item-copy">
              <strong>{itemFilename}</strong>
              <small className="muted line-clamp-2">{summaryText}</small>
            </div>
            <Badge tone="neutral">{t(item.split)}</Badge>
            {showItemStatus ? <StatusBadge status={item.status} /> : null}
            <Badge tone={itemAnnotation ? 'info' : 'warning'}>
              {t('Annotation')}: {annotationState}
            </Badge>
            {lowConfidenceCount > 0 ? (
              <Badge tone="warning">{t('Low conf')}: {lowConfidenceCount}</Badge>
            ) : null}
          </label>
        </Panel>
      );
    },
    [
      annotationByItemId,
      attachmentById,
      lowConfidenceCountByItemId,
      queueFilter,
      selectedItemId,
      setQueueFilter,
      setSelectedItemId,
      t
    ]
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
  const annotationWorkspaceEntryPath = useMemo(() => {
    if (!datasetId) {
      return '/datasets';
    }

    if (!scopedDatasetVersionId) {
      return `/datasets/${datasetId}/annotate`;
    }

    const search = new URLSearchParams();
    search.set('version', scopedDatasetVersionId);
    return `/datasets/${datasetId}/annotate?${search.toString()}`;
  }, [datasetId, scopedDatasetVersionId]);
  const onboardingSteps = useMemo(
    () => [
      {
        key: 'select',
        label: t('Select queue sample'),
        detail: t('Pick one sample from queue filters so edits and review actions stay focused.'),
        done: Boolean(selectedItem),
        to: items.length === 0 && datasetId ? `/datasets/${datasetId}` : annotationWorkspaceEntryPath,
        cta: items.length === 0 ? t('Open Dataset Detail') : t('Focus queue')
      },
      {
        key: 'annotate',
        label: t('Create annotation payload'),
        detail: t('Add boxes/OCR lines/polygons and save at least one annotation state for this item.'),
        done: Boolean(selectedAnnotation),
        to: annotationWorkspaceEntryPath,
        cta: t('Open annotation canvas')
      },
      {
        key: 'review',
        label: t('Submit into review flow'),
        detail: t('Move annotations from editing states into in_review/approved/rejected lifecycle.'),
        done: Boolean(
          selectedAnnotation && ['in_review', 'approved', 'rejected'].includes(selectedAnnotation.status)
        ),
        to: annotationWorkspaceEntryPath,
        cta: t('Open annotation actions')
      },
      {
        key: 'loop',
        label: t('Continue to next loop lane'),
        detail: t('After review signals exist, continue with scoped validation follow-up.'),
        done: reviewSessionStats.total > 0 || annotationSummary.approved > 0,
        to: scopedInferenceValidationPath,
        cta: t('Validate Inference')
      }
    ],
    [
      annotationSummary.approved,
      annotationWorkspaceEntryPath,
      datasetId,
      items.length,
      reviewSessionStats.total,
      scopedInferenceValidationPath,
      selectedAnnotation,
      selectedItem,
      t
    ]
  );
  const nextOnboardingStep = useMemo(
    () => onboardingSteps.find((stepItem) => !stepItem.done) ?? null,
    [onboardingSteps]
  );
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
    const fallbackItemId = queueFilter === 'all' && !hasActiveQueueRefinements ? items[0]?.id ?? '' : '';
    const nextSelectedItemId =
      (requestedItemVisible ? requestedItemId : '') ||
      (currentItemVisible ? selectedItemId : '') ||
      filteredItems[0]?.id ||
      fallbackItemId ||
      '';

    if (nextSelectedItemId !== selectedItemId) {
      setSelectedItemId(nextSelectedItemId);
    }
  }, [filteredItems, hasActiveQueueRefinements, items, queueFilter, searchParams, selectedItemId]);

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
    if (hasAdvancedQueueRefinements) {
      setShowAdvancedQueueFilters(true);
    }
  }, [hasAdvancedQueueRefinements]);

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
  const focusQueueSection = useCallback(() => {
    queueSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (filteredItems.length > 0) {
      focusWorkspaceItem(queueFilter, selectedItemId || filteredItems[0].id);
      return;
    }
    queueSearchInputRef.current?.focus();
  }, [filteredItems, focusWorkspaceItem, queueFilter, selectedItemId]);
  const focusAnnotationCanvas = useCallback(() => {
    canvasSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
  const focusAnnotationActions = useCallback(() => {
    actionSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
  const createWorkspaceReturnPoint = useCallback(
    (): WorkspaceReturnPoint => ({
      id: nextReturnPointId(),
      savedAt: Date.now(),
      label: selectedFilename,
      locked: false,
      selectedItemId,
      selectedFilename,
      queueFilter,
      queueSearchText,
      queueSplitFilter,
      queueItemStatusFilter,
      queueMetadataFilter,
      onlyLowConfidenceCandidates,
      predictionConfidenceThreshold
    }),
    [
      onlyLowConfidenceCandidates,
      predictionConfidenceThreshold,
      queueFilter,
      queueItemStatusFilter,
      queueMetadataFilter,
      queueSearchText,
      queueSplitFilter,
      selectedFilename,
      selectedItemId
    ]
  );
  const saveWorkspaceReturnPoint = useCallback(
    (point: WorkspaceReturnPoint): 'saved' | 'updated' | 'blocked_locked' => {
      let outcome: 'saved' | 'updated' | 'blocked_locked' = 'saved';
      setWorkspaceReturnPoints((current) => {
        const existingIndex = current.findIndex(
          (entry) =>
            entry.selectedItemId === point.selectedItemId &&
            entry.queueFilter === point.queueFilter &&
            entry.queueSearchText === point.queueSearchText &&
            entry.queueSplitFilter === point.queueSplitFilter &&
            entry.queueItemStatusFilter === point.queueItemStatusFilter &&
            entry.queueMetadataFilter === point.queueMetadataFilter &&
            entry.onlyLowConfidenceCandidates === point.onlyLowConfidenceCandidates &&
            entry.predictionConfidenceThreshold === point.predictionConfidenceThreshold
        );
        if (existingIndex >= 0) {
          const existing = current[existingIndex];
          const updated: WorkspaceReturnPoint = {
            ...point,
            id: existing.id,
            label: existing.label,
            locked: existing.locked
          };
          outcome = 'updated';
          return [updated, ...current.filter((entry) => entry.id !== existing.id)].slice(0, workspaceReturnPointMaxSlots);
        }

        if (current.length < workspaceReturnPointMaxSlots) {
          outcome = 'saved';
          return [point, ...current];
        }

        const evictIndex = [...current].reverse().findIndex((entry) => !entry.locked);
        if (evictIndex < 0) {
          outcome = 'blocked_locked';
          return current;
        }

        const actualEvictIndex = current.length - 1 - evictIndex;
        const next = current.filter((_, index) => index !== actualEvictIndex);
        outcome = 'saved';
        return [point, ...next];
      });
      return outcome;
    },
    []
  );
  const updateWorkspaceReturnPoint = useCallback(
    (id: string, updates: Partial<Pick<WorkspaceReturnPoint, 'label' | 'locked'>>) => {
      setWorkspaceReturnPoints((current) =>
        current.map((point) => (point.id === id ? { ...point, ...updates } : point))
      );
    },
    []
  );
  const removeWorkspaceReturnPoint = useCallback((id: string) => {
    setWorkspaceReturnPoints((current) => current.filter((point) => point.id !== id));
  }, []);
  const beginEditReturnPoint = useCallback((point: WorkspaceReturnPoint) => {
    setEditingReturnPointId(point.id);
    setEditingReturnPointLabel((point.label || point.selectedFilename).trim());
  }, []);
  const cancelEditReturnPoint = useCallback(() => {
    setEditingReturnPointId(null);
    setEditingReturnPointLabel('');
  }, []);
  const commitEditReturnPoint = useCallback(() => {
    if (!editingReturnPointId) {
      return;
    }

    const trimmed = editingReturnPointLabel.trim();
    if (!trimmed) {
      setQueueToast({
        variant: 'info',
        text: t('Return point label cannot be empty.')
      });
      return;
    }

    updateWorkspaceReturnPoint(editingReturnPointId, { label: trimmed });
    setEditingReturnPointId(null);
    setEditingReturnPointLabel('');
  }, [editingReturnPointId, editingReturnPointLabel, t, updateWorkspaceReturnPoint]);
  const restoreWorkspaceReturnPoint = useCallback(
    (point: WorkspaceReturnPoint) => {
      if (!point.selectedItemId) {
        setQueueToast({
          variant: 'info',
          text: t('Saved workspace point has no selectable item.')
        });
        return;
      }
      if (!itemIdSet.has(point.selectedItemId)) {
        setQueueToast({
          variant: 'info',
          text: t('Saved workspace point item is no longer available.')
        });
        return;
      }
      setQueueSearchText(point.queueSearchText);
      setQueueSplitFilter(point.queueSplitFilter);
      setQueueItemStatusFilter(point.queueItemStatusFilter);
      setQueueMetadataFilter(point.queueMetadataFilter);
      setOnlyLowConfidenceCandidates(point.onlyLowConfidenceCandidates);
      setPredictionConfidenceThreshold(point.predictionConfidenceThreshold || '0.50');
      focusWorkspaceItem(point.queueFilter, point.selectedItemId);
      setQueueToast({
        variant: 'info',
        text: t('Returned to saved workspace point: {file}', { file: point.selectedFilename })
      });
    },
    [focusWorkspaceItem, itemIdSet, t]
  );
  const restoreWorkspaceReturnPointByIndex = useCallback(
    (index: number) => {
      const point = workspaceReturnPoints[index];
      if (!point) {
        setQueueToast({
          variant: 'info',
          text: t('No saved workspace point in slot {slot}.', { slot: index + 1 })
        });
        return;
      }
      restoreWorkspaceReturnPoint(point);
    },
    [restoreWorkspaceReturnPoint, t, workspaceReturnPoints]
  );
  const saveCurrentWorkspaceReturnPoint = useCallback(() => {
    if (!selectedItemId) {
      setQueueToast({
        variant: 'info',
        text: t('Select a sample before saving workspace return point.')
      });
      return;
    }

    const outcome = saveWorkspaceReturnPoint(createWorkspaceReturnPoint());
    if (outcome === 'blocked_locked') {
      setQueueToast({
        variant: 'info',
        text: t('All return point slots are locked. Unlock one before saving a new point.')
      });
      return;
    }

    setQueueToast({
      variant: 'success',
      text:
        outcome === 'updated'
          ? t('Workspace return point refreshed in slot 1.')
          : t('Workspace return point saved to slot 1.')
    });
  }, [createWorkspaceReturnPoint, saveWorkspaceReturnPoint, selectedItemId, t]);
  const switchQueueByShortcut = useCallback(
    (targetFilter: AnnotationQueueFilter) => {
      const targetItems = queueItemsByFilter[targetFilter];
      const nextItemId = targetItems.some((item) => item.id === selectedItemId)
        ? selectedItemId
        : targetItems[0]?.id ?? '';
      focusWorkspaceItem(targetFilter, nextItemId);
      setQueueToast({
        variant: 'info',
        text: t('Switched to {queue} queue.', {
          queue: t(targetFilter === 'needs_work' ? 'Needs Work' : targetFilter === 'all' ? 'All items' : targetFilter)
        })
      });
    },
    [focusWorkspaceItem, queueItemsByFilter, selectedItemId, t]
  );
  const focusReviewedItem = useCallback(
    (entry: ReviewActionEntry, options?: { restoreQueueContext?: boolean }) => {
      if (!itemIdSet.has(entry.itemId)) {
        setQueueToast({
          variant: 'info',
          text: t('Reviewed sample is no longer available in current dataset.')
        });
        return;
      }
      const restoreQueueContext =
        options?.restoreQueueContext === true || historyRestoreContextOnReopen;
      const fallbackQueue: AnnotationQueueFilter =
        entry.status === 'approved' ? 'approved' : 'rejected';
      const targetQueue = restoreQueueContext ? entry.queueAtAction : fallbackQueue;
      if (restoreQueueContext) {
        setQueueSearchText(entry.queueSearchText);
        setQueueSplitFilter(entry.queueSplitFilter);
        setQueueItemStatusFilter(entry.queueItemStatusFilter);
        setQueueMetadataFilter(entry.queueMetadataFilter);
        setOnlyLowConfidenceCandidates(entry.onlyLowConfidenceCandidates);
        setPredictionConfidenceThreshold(entry.predictionConfidenceThreshold || '0.50');
      } else {
        setQueueSearchText('');
        setQueueSplitFilter('all');
        setQueueItemStatusFilter('all');
        setQueueMetadataFilter('');
        setOnlyLowConfidenceCandidates(false);
        setPredictionConfidenceThreshold('0.50');
      }
      focusWorkspaceItem(targetQueue, entry.itemId);
      setQueueToast({
        variant: 'info',
        text: restoreQueueContext
          ? t('Reopened reviewed sample with saved queue context: {file}', { file: entry.filename })
          : t('Reopened reviewed sample: {file}', { file: entry.filename })
      });
    },
    [focusWorkspaceItem, historyRestoreContextOnReopen, itemIdSet, t]
  );
  const focusReviewHistoryByIndex = useCallback(
    (index: number, options?: { restoreQueueContext?: boolean }) => {
      if (filteredReviewActionHistory.length === 0) {
        setQueueToast({
          variant: 'info',
          text: t('No reviewed sample in current session yet.')
        });
        return;
      }

      const boundedIndex = Math.max(0, Math.min(index, filteredReviewActionHistory.length - 1));
      const entry = filteredReviewActionHistory[boundedIndex];
      if (!entry) {
        return;
      }

      if (selectedItemId) {
        saveWorkspaceReturnPoint(createWorkspaceReturnPoint());
      }
      setReviewHistoryCursor(boundedIndex);
      focusReviewedItem(entry, options);
    },
    [
      createWorkspaceReturnPoint,
      filteredReviewActionHistory,
      focusReviewedItem,
      saveWorkspaceReturnPoint,
      selectedItemId,
      t,
    ]
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

  useEffect(() => {
    if (!pendingFollowupQueueSwitch) {
      return;
    }

    if (!autoSwitchAfterInReviewClear) {
      setPendingFollowupQueueSwitch(false);
      return;
    }

    if (queueFilter !== 'in_review') {
      setPendingFollowupQueueSwitch(false);
      return;
    }

    if (filteredItems.length > 0) {
      return;
    }

    const followupQueue = availableReviewFollowupQueues[0];
    if (!followupQueue) {
      setPendingFollowupQueueSwitch(false);
      setQueueToast({
        variant: 'info',
        text: t('In-review queue cleared. No follow-up queues with pending items.')
      });
      return;
    }

    openQueueFilter(followupQueue.key);
    setPendingFollowupQueueSwitch(false);
    setQueueToast({
      variant: 'info',
      text: t('In-review queue cleared. Switched to {queue}.', {
        queue: t(followupQueue.key === 'needs_work' ? 'Needs Work' : followupQueue.key)
      })
    });
  }, [
    availableReviewFollowupQueues,
    autoSwitchAfterInReviewClear,
    filteredItems.length,
    openQueueFilter,
    pendingFollowupQueueSwitch,
    queueFilter,
    t
  ]);

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        !event.altKey ||
        isTypingTarget(event.target)
      ) {
        return;
      }

      if (event.code === 'Comma') {
        event.preventDefault();
        focusReviewHistoryByIndex(reviewHistoryCursor + 1);
        return;
      }

      if (event.code === 'Period') {
        event.preventDefault();
        focusReviewHistoryByIndex(reviewHistoryCursor - 1);
        return;
      }

      const key = event.key.trim().toLowerCase();
      if (['1', '2', '3', '4', '5'].includes(key)) {
        const targetFilter = queueShortcutFilters[Number(key) - 1];
        if (!targetFilter) {
          return;
        }

        event.preventDefault();
        switchQueueByShortcut(targetFilter);
        return;
      }

      if (key === 'l') {
        event.preventDefault();
        setOnlyLowConfidenceCandidates((current) => {
          const next = !current;
          setQueueToast({
            variant: 'info',
            text: next
              ? t('Low-confidence-only filter enabled.')
              : t('Low-confidence-only filter disabled.')
          });
          return next;
        });
        return;
      }

      if (key === 'n') {
        event.preventDefault();
        focusNextLowConfidenceQueueItem();
        return;
      }

      if (key === 'c') {
        event.preventDefault();
        clearQueueFilters();
        setQueueToast({
          variant: 'info',
          text: t('Queue filters cleared.')
        });
        return;
      }

      if (key === 'v') {
        event.preventDefault();
        setShortcutAutoAdvance((current) => {
          const next = !current;
          setQueueToast({
            variant: 'info',
            text: next
              ? t('Shortcut auto-advance enabled.')
              : t('Shortcut auto-advance disabled.')
          });
          return next;
        });
        return;
      }

      if (key === 'b') {
        event.preventDefault();
        setAutoSwitchAfterInReviewClear((current) => {
          const next = !current;
          setQueueToast({
            variant: 'info',
            text: next
              ? t('Auto-switch after in_review clear enabled.')
              : t('Auto-switch after in_review clear disabled.')
          });
          return next;
        });
        return;
      }

      if (key === 'r') {
        event.preventDefault();
        focusReviewHistoryByIndex(0, { restoreQueueContext: event.shiftKey });
        return;
      }

      if (key === 'g') {
        event.preventDefault();
        if (event.shiftKey) {
          saveCurrentWorkspaceReturnPoint();
          return;
        }
        if (!primaryWorkspaceReturnPoint) {
          setQueueToast({
            variant: 'info',
            text: t('No saved workspace return point yet.')
          });
          return;
        }
        restoreWorkspaceReturnPoint(primaryWorkspaceReturnPoint);
        return;
      }

      if (key === '0') {
        event.preventDefault();
        if (!primaryWorkspaceReturnPoint) {
          setQueueToast({
            variant: 'info',
            text: t('No saved workspace return point to lock.')
          });
          return;
        }
        const nextLocked = !primaryWorkspaceReturnPoint.locked;
        updateWorkspaceReturnPoint(primaryWorkspaceReturnPoint.id, { locked: nextLocked });
        setQueueToast({
          variant: 'info',
          text: nextLocked
            ? t('Workspace return point slot 1 locked.')
            : t('Workspace return point slot 1 unlocked.')
        });
        return;
      }

      if (['7', '8', '9'].includes(key)) {
        event.preventDefault();
        restoreWorkspaceReturnPointByIndex(Number(key) - 7);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    clearQueueFilters,
    focusNextLowConfidenceQueueItem,
    focusReviewHistoryByIndex,
    reviewHistoryCursor,
    primaryWorkspaceReturnPoint,
    saveCurrentWorkspaceReturnPoint,
    restoreWorkspaceReturnPointByIndex,
    restoreWorkspaceReturnPoint,
    switchQueueByShortcut,
    t,
    updateWorkspaceReturnPoint
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        isTypingTarget(event.target)
      ) {
        return;
      }

      if (event.key === '/') {
        event.preventDefault();
        queueSearchInputRef.current?.focus();
        queueSearchInputRef.current?.select();
        return;
      }

      if (event.key.toLowerCase() === 'm') {
        event.preventDefault();
        queueMetadataInputRef.current?.focus();
        queueMetadataInputRef.current?.select();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isTypingTarget(event.target)) {
        return;
      }

      if (event.key === '?') {
        event.preventDefault();
        setShowShortcutGuide((current) => !current);
        return;
      }

      if (event.key === 'Escape') {
        setShowShortcutGuide(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        !event.shiftKey ||
        isTypingTarget(event.target)
      ) {
        return;
      }

      if (!selectedAnnotation || selectedAnnotation.status !== 'in_review') {
        return;
      }

      const reasonCode = reviewReasonShortcutMap[event.code];
      if (!reasonCode) {
        return;
      }

      event.preventDefault();
      setReviewReasonCode(reasonCode);
      reviewReasonSelectRef.current?.focus();
      setQueueToast({
        variant: 'info',
        text: t('Reject reason set to {reason}.', { reason: t(reasonCode) })
      });
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedAnnotation, t]);

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

  const saveAnnotation = useCallback(
    async (status: 'in_progress' | 'annotated', options?: { continueInQueue?: boolean }) => {
      if (!datasetId || !dataset || !selectedItem) {
        return;
      }

      const continueInQueue = options?.continueInQueue === true;
      const nextQueueItemId = continueInQueue ? resolveNextQueueItemId(selectedItem.id) : '';
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

        await load('manual');
        if (continueInQueue) {
          if (nextQueueItemId) {
            focusWorkspaceItem(queueFilter, nextQueueItemId);
            setQueueToast({
              variant: 'success',
              text: t('Annotation saved as {status}. Continued to next item.', {
                status: t(upserted.status)
              })
            });
          } else {
            setQueueToast({
              variant: 'info',
              text: t('Annotation saved as {status}. No more items in current queue.', {
                status: t(upserted.status)
              })
            });
          }
          setFeedback(null);
        } else {
          setFeedback({
            variant: 'success',
            text: t('Annotation saved as {status}.', { status: t(upserted.status) })
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
      if (!datasetId || !selectedAnnotation) {
        return;
      }

      const continueInQueue = options?.continueInQueue === true;
      const nextQueueItemId = continueInQueue
        ? resolveNextQueueItemId(selectedAnnotation.dataset_item_id)
        : '';
      setBusy(true);
      setFeedback(null);

      try {
        await api.submitAnnotationForReview(datasetId, selectedAnnotation.id);
        await load('manual');
        if (continueInQueue) {
          if (nextQueueItemId) {
            focusWorkspaceItem(queueFilter, nextQueueItemId);
            setQueueToast({
              variant: 'success',
              text: t('Annotation submitted for review. Continued to next item.')
            });
          } else {
            setQueueToast({
              variant: 'info',
              text: t('Annotation submitted for review. No more items in current queue.')
            });
          }
          setFeedback(null);
        } else {
          setFeedback({ variant: 'success', text: t('Annotation submitted for review.') });
        }
      } catch (error) {
        setFeedback({ variant: 'error', text: (error as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [datasetId, focusWorkspaceItem, load, queueFilter, resolveNextQueueItemId, selectedAnnotation, t]
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
        const reviewEventAt = Date.now();
        setReviewSessionStats((current) => ({
          total: current.total + 1,
          approved: current.approved + (status === 'approved' ? 1 : 0),
          rejected: current.rejected + (status === 'rejected' ? 1 : 0)
        }));
        setReviewSessionStartedAt((current) => current ?? reviewEventAt);
        setReviewSessionLastActionAt(reviewEventAt);
        if (selectedItem) {
          const filename = attachmentById.get(selectedItem.attachment_id)?.filename ?? selectedFilename;
          setReviewActionHistory((current) =>
            [
              {
                id: `review-${selectedAnnotation.id}-${reviewEventAt}`,
                itemId: selectedItem.id,
                filename,
                status,
                reasonCode: status === 'rejected' ? reviewReasonCode : null,
                queueAtAction: queueFilter,
                queueSearchText,
                queueSplitFilter,
                queueItemStatusFilter,
                queueMetadataFilter,
                onlyLowConfidenceCandidates,
                predictionConfidenceThreshold,
                timestamp: reviewEventAt
              },
              ...current
            ].slice(0, reviewSessionHistoryMaxEntries)
          );
          setReviewHistoryCursor(0);
        }

        await load('manual');
        if (continueInQueue && queueFilter === 'in_review') {
          focusWorkspaceItem('in_review', nextInReviewItemId);
          setFeedback(null);
          if (nextInReviewItemId) {
            setQueueToast({
              variant: 'success',
              text: t('Review saved. {count} items remain in in_review queue.', { count: remainingAfterCurrentReview })
            });
          } else {
            if (autoSwitchAfterInReviewClear) {
              setPendingFollowupQueueSwitch(true);
            } else {
              setQueueToast({
                variant: 'info',
                text: t('In-review queue cleared. Great job.')
              });
            }
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
      queueSearchText,
      queueSplitFilter,
      queueItemStatusFilter,
      queueMetadataFilter,
      onlyLowConfidenceCandidates,
      predictionConfidenceThreshold,
      attachmentById,
      autoSwitchAfterInReviewClear,
      selectedAnnotation,
      selectedFilename,
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
        continueInQueue: queueFilter === 'in_review' && shortcutAutoAdvance
      });
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, queueFilter, reviewAnnotation, selectedAnnotation, shortcutAutoAdvance]);

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
      title={dataset ? dataset.name : t('Annotation Workspace')}
      description={
        dataset
          ? scopedDatasetVersionId
            ? t('Task {task} · Version {version}. Keep one sample in focus and move it through annotation and review.', {
                task: t(dataset.task_type),
                version: scopedDatasetVersionId
              })
            : t('Task {task}. Keep one sample in focus and move it through annotation and review.', {
                task: t(dataset.task_type)
              })
          : t('Review queue status, annotate items, and complete approvals in one flow.')
      }
      actions={
        dataset ? (
          <div className="row gap wrap align-center">
            <Badge tone="neutral">{t(dataset.task_type)}</Badge>
            <Badge tone="info">{queueLabel(queueFilter)}</Badge>
            {scopedDatasetVersionId ? <Badge tone="neutral">{t('Version')}: {scopedDatasetVersionId}</Badge> : null}
            {selectedItem ? <Badge tone="neutral">{t('Current sample')}: {selectedFilename}</Badge> : null}
          </div>
        ) : undefined
      }
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

      <section className="annotation-studio-layout">
      <div className="annotation-studio-queue" ref={queueSectionRef}>
      <Card as="section">
        <WorkspaceSectionHeader
          title={t('Annotation Queue')}
          description={queuePositionSummary}
        />
        <div className="annotation-queue-context">
          <div className="stack tight">
            <small className="muted">{t('Current sample')}</small>
            <strong className="line-clamp-1">
              {selectedItem ? selectedFilename : t('No dataset item selected')}
            </strong>
          </div>
          <div className="row gap wrap align-center">
            <Badge tone="neutral">{queueLabel(queueFilter)}</Badge>
            <Badge tone="info">{t('Visible items')}: {filteredItems.length}</Badge>
            {selectedItem ? <Badge tone="neutral">{t(selectedItem.split)}</Badge> : null}
            {selectedAnnotation ? (
              <Badge tone="info">{t('Annotation')}: {t(selectedAnnotation.status)}</Badge>
            ) : selectedItem ? (
              <Badge tone="warning">{t('Annotation')}: {t('unannotated')}</Badge>
            ) : null}
            {selectedItemHasLowConfidenceTag ? <Badge tone="warning">{t('Low-confidence tag')}</Badge> : null}
          </div>
        </div>
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
                {queueLabel(filter)}
              </Button>
            );
          })}
        </div>
        <div className="annotation-queue-primary-filters">
          <Input
            ref={queueSearchInputRef}
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
        </div>
        <div className="annotation-queue-more-filters">
          <Button
            type="button"
            variant={showAdvancedQueueFilters ? 'secondary' : 'ghost'}
            size="sm"
            trailing={advancedQueueFilterCount > 0 ? <Badge tone="info">{advancedQueueFilterCount}</Badge> : undefined}
            onClick={() => setShowAdvancedQueueFilters((current) => !current)}
          >
            {showAdvancedQueueFilters ? t('Hide extra filters') : t('More filters')}
          </Button>
          {showAdvancedQueueFilters ? (
            <div className="annotation-queue-advanced-filters">
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
                ref={queueMetadataInputRef}
                value={queueMetadataFilter}
                onChange={(event) => setQueueMetadataFilter(event.target.value)}
                placeholder={t('Filter metadata/tag (supports key=value)')}
              />
              {queueMetadataQuickFilters.length > 0 ? (
                <div className="annotation-queue-quick-filter-row">
                  <small className="muted">{t('Metadata quick filters')}:</small>
                  <div className="row gap wrap">
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
            </div>
          ) : null}
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
        <div className="annotation-queue-footer">
          <div className="row gap wrap align-center">
            <Badge tone={lowConfidenceQueueRadarItems.length > 0 ? 'warning' : 'neutral'}>
              {t('Low-confidence samples')}: {lowConfidenceQueueRadarItems.length}
            </Badge>
            <Badge tone={totalLowConfidenceQueueSignals > 0 ? 'warning' : 'neutral'}>
              {t('Low-confidence signals')}: {totalLowConfidenceQueueSignals}
            </Badge>
            {queueProgressContext.total > 0 ? (
              <Badge tone="neutral">
                {t('Remaining')}: {queueProgressContext.remaining}
              </Badge>
            ) : null}
          </div>
          <div className="annotation-queue-footer-actions">
            <Button
              type="button"
              variant={onlyLowConfidenceCandidates ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setOnlyLowConfidenceCandidates((current) => !current)}
            >
              {onlyLowConfidenceCandidates ? t('Show full queue') : t('Only low-confidence')}
            </Button>
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
            extra={
              <div className="row gap wrap review-empty-followup">
                <ButtonLink to="/models/versions" variant="secondary" size="sm">
                  {t('Open Model Versions')}
                </ButtonLink>
              </div>
            }
          />
        ) : null}
        {items.length === 0 ? (
          <StateBlock
            variant="empty"
            title={t('No Items')}
            description={
              nextOnboardingStep
                ? t('No queue items yet. Finish the recommended review step below to continue.')
                : t('Upload sample files first, then come back here to annotate and review them.')
            }
            extra={
              <div className="row gap wrap review-empty-followup">
                {nextOnboardingStep ? (
                  <ButtonLink to={nextOnboardingStep.to} variant="secondary" size="sm">
                    {nextOnboardingStep.cta}
                  </ButtonLink>
                ) : (
                  <ButtonLink to={`/datasets/${datasetId}`} variant="secondary" size="sm">
                    {t('Open Dataset Detail')}
                  </ButtonLink>
                )}
                {nextOnboardingStep ? <small className="muted">{nextOnboardingStep.detail}</small> : null}
              </div>
            }
          />
        ) : filteredItems.length === 0 ? (
          <StateBlock
            variant="empty"
            title={queueFilter === 'in_review' ? t('In-review queue is clear.') : t('No items in this queue right now.')}
            description={
              queueFilter === 'in_review'
                ? t('All submitted items are now processed. Switch queue filters for follow-up.')
                : nextOnboardingStep
                  ? t('No queue items yet. Finish the recommended review step below to continue.')
                  : t('Try another queue or run pre-annotation to bring more samples into this lane.')
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
              ) : nextOnboardingStep ? (
                <WorkspaceFollowUpHint
                  layout="inline"
                  className="review-empty-followup"
                  actions={
                    nextOnboardingStep.key === 'select' && items.length > 0 ? (
                      <Button type="button" variant="secondary" size="sm" onClick={focusQueueSection}>
                        {t('Focus queue')}
                      </Button>
                    ) : nextOnboardingStep.key === 'annotate' ? (
                      <Button type="button" variant="secondary" size="sm" onClick={focusAnnotationCanvas}>
                        {t('Open annotation canvas')}
                      </Button>
                    ) : nextOnboardingStep.key === 'review' ? (
                      <Button type="button" variant="secondary" size="sm" onClick={focusAnnotationActions}>
                        {t('Open annotation actions')}
                      </Button>
                    ) : (
                      <ButtonLink to={nextOnboardingStep.to} variant="secondary" size="sm">
                        {nextOnboardingStep.cta}
                      </ButtonLink>
                    )
                  }
                  detail={nextOnboardingStep.detail}
                />
              ) : null
            }
          />
        ) : shouldVirtualizeQueueList ? (
            <VirtualList
              items={filteredItems}
              itemHeight={112}
              height={440}
              scrollToIndex={selectedQueueIndex >= 0 ? selectedQueueIndex : null}
              ariaLabel={t('Annotation Queue')}
              listClassName="workspace-record-list"
              itemKey={(item) => item.id}
              renderItem={(item) => renderQueueRecord(item, { virtualized: true })}
            />
          ) : (
            <ul className="workspace-record-list">
              {filteredItems.map((item) => renderQueueRecord(item))}
            </ul>
          )
        }
      </Card>
      </div>

      <WorkspaceWorkbench
        className="annotation-studio-workbench"
        toolbar={
          <Card as="section" className="workspace-toolbar-card">
            <div className="stack">
              <WorkspaceSectionHeader
                title={t('Workspace actions')}
                description={t('Run pre-annotation and refresh this annotation lane when needed.')}
              />
              <div className="annotation-workspace-action-bar">
                <label className="stack tight annotation-workspace-model-select">
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
                <Button
                  type="button"
                  variant={showWorkspaceUtilities ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setShowWorkspaceUtilities((current) => !current)}
                >
                  {showWorkspaceUtilities ? t('Hide workspace tools') : t('Open workspace tools')}
                </Button>
                <ButtonLink size="sm" variant="ghost" to={`/datasets/${dataset.id}`}>
                  {t('Back to Dataset')}
                </ButtonLink>
              </div>
              {showWorkspaceUtilities ? (
                <Panel as="section" className="annotation-utility-panel" tone="soft">
                  <div className="workspace-section-header">
                    <div className="stack tight">
                      <h3>{t('Workspace tools')}</h3>
                      <small className="muted">
                        {t('Advanced shortcuts, review-session tracking, and return points stay here so the main workbench can stay focused.')}
                      </small>
                    </div>
                  </div>
                  <details className="workspace-disclosure">
                    <summary>
                      <span>{t('Workspace preferences')}</span>
                    </summary>
                    <div className="workspace-disclosure-content">
                      <div className="row gap wrap align-center">
                        <label className="row gap align-center">
                          <Checkbox
                            checked={shortcutAutoAdvance}
                            onChange={(event) => setShortcutAutoAdvance(event.target.checked)}
                          />
                          <small className="muted">{t('Shortcut actions auto-advance to next sample')}</small>
                        </label>
                        <label className="row gap align-center">
                          <Checkbox
                            checked={autoSwitchAfterInReviewClear}
                            onChange={(event) => setAutoSwitchAfterInReviewClear(event.target.checked)}
                          />
                          <small className="muted">{t('Auto-switch to follow-up queue when review queue is empty')}</small>
                        </label>
                      </div>
                    </div>
                  </details>
                  {showShortcutGuide ? (
                    <Panel as="section" className="workspace-keyline-list" tone="soft">
                      <div className="row between gap wrap align-center">
                        <strong>{t('Annotation Shortcut Guide')}</strong>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowShortcutGuide(false)}
                        >
                          {t('Close')}
                        </Button>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">J / K</Badge>
                        <small className="muted">{t('Move to next/previous sample in current queue')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">Alt + 1..5</Badge>
                        <small className="muted">{t('Switch queue (all / needs_work / in_review / rejected / approved)')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">Alt + L</Badge>
                        <small className="muted">{t('Toggle low-confidence-only filter')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">Alt + N</Badge>
                        <small className="muted">{t('Jump to next low-confidence sample in current queue')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">Alt + C</Badge>
                        <small className="muted">{t('Clear queue filters')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">Alt + V</Badge>
                        <small className="muted">{t('Toggle shortcut auto-advance')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">Alt + B</Badge>
                        <small className="muted">{t('Toggle auto-switch after in_review queue clears')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">Alt + R</Badge>
                        <small className="muted">{t('Reopen latest reviewed sample in session')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">Alt + Shift + R</Badge>
                        <small className="muted">{t('Reopen latest reviewed sample with saved queue context')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">Alt + G</Badge>
                        <small className="muted">{t('Return to saved workspace point')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">Alt + Shift + G</Badge>
                        <small className="muted">{t('Save current workspace point to slot 1')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">Alt + 0</Badge>
                        <small className="muted">{t('Lock/unlock workspace return point slot 1')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">Alt + 7..9</Badge>
                        <small className="muted">{t('Return to workspace point slot 1/2/3')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">Alt + , / .</Badge>
                        <small className="muted">{t('Open previous/next reviewed sample in history')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">/</Badge>
                        <small className="muted">{t('Focus queue search input')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">M</Badge>
                        <small className="muted">{t('Focus metadata filter input')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">{t('Ctrl/Cmd')} + S</Badge>
                        <small className="muted">{t('Save as in_progress')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">{t('Ctrl/Cmd')} + Enter</Badge>
                        <small className="muted">{t('Mark as annotated')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">{t('Ctrl/Cmd')} + Shift + Enter</Badge>
                        <small className="muted">{t('Submit review when status is annotated')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">A / R</Badge>
                        <small className="muted">{t('Approve or reject while in_review')}</small>
                      </div>
                      <div className="row gap wrap">
                        <Badge tone="neutral">Shift + 1..6</Badge>
                        <small className="muted">{t('Set reject reason quickly while in_review')}</small>
                      </div>
                      <small className="muted">{t('Press ? to toggle this panel, Esc to close it.')}</small>
                    </Panel>
                  ) : null}
                  <div className="row gap wrap">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowShortcutGuide((current) => !current)}
                    >
                      {showShortcutGuide ? t('Hide shortcut guide') : t('Open shortcut guide')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={saveCurrentWorkspaceReturnPoint}
                      disabled={!selectedItemId}
                    >
                      {t('Set Return Point')}
                    </Button>
                  </div>
                  <details className="workspace-disclosure">
                    <summary>
                      <span>{t('Review session summary')}</span>
                      <Badge tone="info">{reviewSessionStats.total}</Badge>
                    </summary>
                    <div className="workspace-disclosure-content">
                      <div className="row gap wrap">
                        <Badge tone="neutral">{t('Session reviewed')}: {reviewSessionStats.total}</Badge>
                        <Badge tone="info">{t('Approved')}: {reviewSessionStats.approved}</Badge>
                        <Badge tone="warning">{t('Rejected')}: {reviewSessionStats.rejected}</Badge>
                      </div>
                      <div className="row gap wrap">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setReviewSessionStats({
                              total: 0,
                              approved: 0,
                              rejected: 0
                            });
                            setReviewSessionStartedAt(null);
                            setReviewSessionLastActionAt(null);
                            setReviewActionHistory([]);
                            setReviewHistoryCursor(0);
                          }}
                          disabled={reviewSessionStats.total === 0}
                        >
                          {t('Reset Session Counter')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            focusReviewHistoryByIndex(0);
                          }}
                          disabled={!latestReviewAction}
                        >
                          {t('Reopen Last Reviewed')}
                        </Button>
                      </div>
                      <small className="muted">
                        {t('Session start')}: {formatSessionClock(reviewSessionStartedAt, t('n/a'))} · {t('Last review')}:{' '}
                        {formatSessionClock(reviewSessionLastActionAt, t('n/a'))} · {t('Avg/review')}:{' '}
                        {reviewSessionAverageSeconds === null ? t('n/a') : `${reviewSessionAverageSeconds.toFixed(1)}s`}
                      </small>
                    </div>
                  </details>
                  <details className="workspace-disclosure">
                    <summary>
                      <span>{t('Saved workspace points')}</span>
                      <Badge tone="neutral">{workspaceReturnPoints.length}</Badge>
                    </summary>
                    <div className="workspace-disclosure-content">
                      {primaryWorkspaceReturnPoint ? (
                        <small className="muted">
                          {t('Return point')}: {primaryWorkspaceReturnPoint.selectedFilename} ({t('slot')} 1/{workspaceReturnPoints.length})
                        </small>
                      ) : (
                        <small className="muted">{t('No saved workspace return point yet.')}</small>
                      )}
                      <div className="row gap wrap">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (!primaryWorkspaceReturnPoint) {
                              return;
                            }
                            restoreWorkspaceReturnPoint(primaryWorkspaceReturnPoint);
                          }}
                          disabled={!primaryWorkspaceReturnPoint}
                        >
                          {t('Return To Point')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setWorkspaceReturnPoints([])}
                          disabled={!primaryWorkspaceReturnPoint}
                        >
                          {t('Clear Return Points')}
                        </Button>
                      </div>
                      {workspaceReturnPoints.length > 0 ? (
                        <div className="row gap wrap">
                          {workspaceReturnPoints.map((point, index) => (
                            <Panel
                              key={`return-point-slot-${point.id}`}
                              as="section"
                              className="workspace-record-item compact stack tight annotation-return-point"
                              tone="soft"
                            >
                              {editingReturnPointId === point.id ? (
                                <div className="row gap wrap align-center">
                                  <Input
                                    value={editingReturnPointLabel}
                                    onChange={(event) => setEditingReturnPointLabel(event.target.value)}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.preventDefault();
                                        commitEditReturnPoint();
                                      } else if (event.key === 'Escape') {
                                        event.preventDefault();
                                        cancelEditReturnPoint();
                                      }
                                    }}
                                    autoFocus
                                    placeholder={t('Return point label')}
                                  />
                                  <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    onClick={commitEditReturnPoint}
                                    disabled={!editingReturnPointLabel.trim()}
                                  >
                                    {t('Save')}
                                  </Button>
                                  <Button type="button" variant="ghost" size="sm" onClick={cancelEditReturnPoint}>
                                    {t('Cancel')}
                                  </Button>
                                </div>
                              ) : null}
                              <div className="row between gap wrap align-center">
                                <strong className="line-clamp-1">
                                  {t('Slot {slot}', { slot: index + 1 })}: {point.label}
                                </strong>
                                {point.locked ? <Badge tone="warning">{t('Locked')}</Badge> : <Badge tone="neutral">{t('Unlocked')}</Badge>}
                              </div>
                              <small className="muted">
                                {point.selectedFilename} · {formatSessionClock(point.savedAt, t('n/a'))}
                              </small>
                              <div className="row gap wrap">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => restoreWorkspaceReturnPointByIndex(index)}
                                >
                                  {t('Return')}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => beginEditReturnPoint(point)}
                                  disabled={editingReturnPointId === point.id}
                                >
                                  {t('Rename')}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => updateWorkspaceReturnPoint(point.id, { locked: !point.locked })}
                                >
                                  {point.locked ? t('Unlock') : t('Lock')}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => removeWorkspaceReturnPoint(point.id)}
                                >
                                  {t('Remove')}
                                </Button>
                              </div>
                            </Panel>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </details>
                </Panel>
              ) : null}
            </div>
          </Card>
        }
        main={
          <div className="workspace-main-stack">
            <WorkspaceOnboardingCard
              as="section"
              inlineMode="summary"
              title={t('Annotation first-run guide')}
              description={t('Use this page to move queue samples through annotation and review, then continue scoped validation lane.')}
              summary={t('Guide status is computed from selected sample, annotation status, review actions, and approved queue count.')}
              storageKey={`${annotationWorkspaceOnboardingDismissedStorageKey}:${datasetId ?? 'unknown'}`}
              steps={onboardingSteps.map((stepItem) => ({
                key: stepItem.key,
                label: stepItem.label,
                detail: stepItem.detail,
                done: stepItem.done,
                primaryAction: {
                  to: stepItem.to,
                  label: stepItem.cta,
                  onClick:
                    stepItem.key === 'select' && items.length > 0
                      ? focusQueueSection
                      : stepItem.key === 'annotate'
                        ? focusAnnotationCanvas
                        : stepItem.key === 'review'
                          ? focusAnnotationActions
                          : undefined
                }
              }))}
	            />

            <div ref={canvasSectionRef}>
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
                <div className="stack tight">
                  <div className="row between gap wrap align-center">
                    <h3>{t('OCR Text Lines')}</h3>
                    {ocrLines.length > 0 ? <Badge tone="info">{t('Saved lines')}: {ocrLines.length}</Badge> : null}
                  </div>
                  <small className="muted">{t('Type one line from the image, then add it to the current sample.')}</small>
                </div>
                <div className="annotation-ocr-entry-row">
                  <label className="annotation-ocr-entry-main">
                    {t('Line Text')}
                    <Input
                      value={lineText}
                      onChange={(event) => setLineText(event.target.value)}
                      placeholder={t('Enter text from the image')}
                      disabled={busy || isEditLocked}
                    />
                  </label>
                  <Button onClick={addOcrLine} variant="secondary" size="sm" disabled={busy || isEditLocked}>
                    {t('Add OCR Line')}
                  </Button>
                </div>
                <details
                  className="workspace-disclosure annotation-ocr-options"
                  open={showOcrAdvancedFields}
                  onToggle={(event) => setShowOcrAdvancedFields(event.currentTarget.open)}
                >
                  <summary>
                    <span>{t('OCR optional fields')}</span>
                    {lineRegionId || lineConfidence.trim() !== '0.9' ? <Badge tone="info">{t('Configured')}</Badge> : null}
                  </summary>
                  <div className="workspace-disclosure-content">
                    <div className="annotation-ocr-grid">
                      <label>
                        {t('Confidence (optional)')}
                        <Input
                          value={lineConfidence}
                          onChange={(event) => setLineConfidence(event.target.value)}
                          placeholder="0.90"
                          disabled={busy || isEditLocked}
                        />
                      </label>
                      <label>
                        {t('Link to region (optional)')}
                        <Select
                          value={lineRegionId}
                          onChange={(event) => setLineRegionId(event.target.value)}
                          disabled={busy || isEditLocked}
                        >
                          <option value="">{t('No linked region')}</option>
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

                {ocrLines.length === 0 ? (
                  <StateBlock
                    variant="empty"
                    title={t('No OCR Lines Yet')}
                    description={t('Add the first text line you want to keep from this image.')}
                  />
                ) : (
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
                          <Badge tone="neutral">{t('Confidence')}: {line.confidence.toFixed(2)}</Badge>
                          {line.region_id ? (
                            <Badge tone="neutral">{t('Linked region')}: {line.region_id}</Badge>
                          ) : (
                            <Badge tone="neutral">{t('No linked region')}</Badge>
                          )}
                        </div>
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

          <div ref={actionSectionRef}>
            <Card as="section">
              <h3>{t('Annotation Actions')}</h3>
              {selectedAnnotation ? (
                <div className="row gap wrap align-center">
                  <Badge tone="info">{t('Status')}: {t(selectedAnnotation.status)}</Badge>
                  {selectedAnnotation.latest_review ? (
                    <Badge tone="warning">{t('Latest Review')}: {t(selectedAnnotation.latest_review.status)}</Badge>
                  ) : null}
                  {queueProgressContext.total > 0 ? (
                    <Badge tone="neutral">
                      {t('Queue {current} / {total}', {
                        current: queueProgressContext.current,
                        total: queueProgressContext.total
                      })}
                    </Badge>
                  ) : null}
                  {queueProgressContext.total > 0 ? (
                    <Badge tone="info">
                      {t('Remaining')}: {queueProgressContext.remaining}
                    </Badge>
                  ) : null}
                </div>
            ) : (
              <small className="muted">{t('No annotation yet for selected item.')}</small>
            )}
            <small className="muted">{t('Suggested order: save progress -> mark annotated -> submit review.')}</small>

            {isEditLocked ? (
              <StateBlock variant="empty" title={t('Editing Locked')} description={editLockMessage} />
            ) : (
              <div className="annotation-action-groups">
                <Panel as="section" className="annotation-action-group" tone="soft">
                  <div className="stack tight">
                    <strong>{t('Keep editing')}</strong>
                    <small className="muted">{t('Use these actions while you are still refining this sample.')}</small>
                  </div>
                  <div className="row gap wrap">
                    <Button
                      onClick={undoLast}
                      variant="ghost"
                      size="sm"
                      disabled={busy || (!boxes.length && !ocrLines.length && !polygons.length)}
                    >
                      {t('Undo Last Change')}
                    </Button>
                    <Button onClick={() => void saveAnnotation('in_progress')} variant="secondary" size="sm" disabled={busy || !selectedItem}>
                      {t('Save In Progress')}
                    </Button>
                    <Button
                      onClick={() => void saveAnnotation('in_progress', { continueInQueue: true })}
                      variant="ghost"
                      size="sm"
                      disabled={busy || !selectedItem || !canMoveToNextQueueItem}
                    >
                      {t('Save In Progress & Next')}
                    </Button>
                  </div>
                </Panel>
                <Panel as="section" className="annotation-action-group" tone="soft">
                  <div className="stack tight">
                    <strong>{t('Move forward')}</strong>
                    <small className="muted">{t('When this sample is ready, move it into the next workflow stage.')}</small>
                  </div>
                  <div className="row gap wrap">
                    <Button onClick={() => void saveAnnotation('annotated')} variant="secondary" size="sm" disabled={busy || !selectedItem}>
                      {t('Mark Annotated')}
                    </Button>
                    <Button
                      onClick={() => void saveAnnotation('annotated', { continueInQueue: true })}
                      variant="ghost"
                      size="sm"
                      disabled={busy || !selectedItem || !canMoveToNextQueueItem}
                    >
                      {t('Mark Annotated & Next')}
                    </Button>
                    <Button
                      onClick={() => void submitReview()}
                      variant="secondary"
                      size="sm"
                      disabled={busy || !selectedAnnotation || selectedAnnotation.status !== 'annotated'}
                    >
                      {t('Submit Review')}
                    </Button>
                    <Button
                      onClick={() => void submitReview({ continueInQueue: true })}
                      variant="ghost"
                      size="sm"
                      disabled={
                        busy ||
                        !selectedAnnotation ||
                        selectedAnnotation.status !== 'annotated' ||
                        !canMoveToNextQueueItem
                      }
                    >
                      {t('Submit Review & Next')}
                    </Button>
                  </div>
                </Panel>
                </div>
              )}
            </Card>
          </div>
            </div>
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
              onShowAnnotationOverlayChange={setShowAnnotationOverlay}
              onShowPredictionOverlayChange={setShowPredictionOverlay}
              onPredictionConfidenceThresholdChange={setPredictionConfidenceThreshold}
              onUsePredictionCandidate={applyPredictionCandidateToOcrEditor}
              onFocusNextLowConfidence={focusNextLowConfidenceQueueItem}
              onToggleLowConfidenceTag={() => {
                void toggleLowConfidenceTagForSelectedItem();
              }}
            />

          <Card as="section" className="workspace-inspector-card">
            <div className="stack tight">
              <div className="row between gap wrap align-center">
                <h3>{t('Review actions')}</h3>
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
              <small className="muted">{t('Approve or reject only after the selected annotation enters review.')}</small>
            </div>
            {!selectedAnnotation ? (
              <StateBlock
                variant="empty"
                title={t('No review-ready annotation')}
                description={t('Create or update annotation first, then come back here to review it.')}
              />
            ) : selectedAnnotation.status !== 'in_review' ? (
              <StateBlock
                variant="empty"
                title={t('Waiting for review submission')}
                description={t('Submit the current annotation for review before using these actions.')}
              />
            ) : (
              <>
                <div className="annotation-action-groups">
                  <Panel as="section" className="annotation-action-group" tone="soft">
                    <div className="stack tight">
                      <strong>{t('Approve sample')}</strong>
                      <small className="muted">{t('Use this path when the current annotation is ready to pass review.')}</small>
                    </div>
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
                  </Panel>
                  <Panel as="section" className="annotation-action-group" tone="soft">
                    <div className="stack tight">
                      <strong>{t('Send back for fixes')}</strong>
                      <small className="muted">{t('Choose one reason before sending this sample back for another edit pass.')}</small>
                    </div>
                    <label>
                      {t('Reject Reason')}
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
                  </Panel>
                </div>
                <details className="review-optional-metadata">
                  <summary>{t('Review shortcuts and optional notes')}</summary>
                  <div className="stack">
                    <small className="muted">
                      {queueFilter === 'in_review' && shortcutAutoAdvance
                        ? t('Review shortcuts: A approve-next · R reject-next')
                        : t('Review shortcuts: A approve · R reject')}
                    </small>
                    <small className="muted">{t('Reject reason shortcut: Shift+1..6')}</small>
                    <small className="muted">{t('Reject reason is required for reject actions.')}</small>
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

          <Card as="section" className="workspace-inspector-card">
            <div className="stack tight">
              <h3>{t('More review context')}</h3>
              <small className="muted">
                {t('Open queue position, review history, and low-confidence triage only when you need more context.')}
              </small>
            </div>
            <div className="annotation-review-support-summary">
              <Panel as="section" className="annotation-review-support-card" tone="soft">
                <small className="muted">{t('Queue Focus')}</small>
                <strong>{queuePositionSummary}</strong>
              </Panel>
              <Panel as="section" className="annotation-review-support-card" tone="soft">
                <small className="muted">{t('Review Session History')}</small>
                <strong>{t('{count} reviewed in this session', { count: filteredReviewActionHistory.length })}</strong>
              </Panel>
              <Panel as="section" className="annotation-review-support-card" tone="soft">
                <small className="muted">{t('Low-confidence Radar')}</small>
                <strong>{t('{count} samples need attention', { count: lowConfidenceQueueRadarItems.length })}</strong>
              </Panel>
            </div>
            <details className="workspace-disclosure">
              <summary>
                <span>{t('Queue Focus')}</span>
                {queueProgressContext.total > 0 ? (
                  <Badge tone="neutral">
                    {queueProgressContext.current}/{queueProgressContext.total}
                  </Badge>
                ) : null}
              </summary>
              <div className="workspace-disclosure-content">
                <div className="row gap wrap">
                  <Badge tone="neutral">{t('Queue')}: {queueLabel(queueFilter)}</Badge>
                  {selectedItem ? <Badge tone="neutral">{t(selectedItem.split)}</Badge> : null}
                  {selectedAnnotation ? <Badge tone="info">{t(selectedAnnotation.status)}</Badge> : null}
                </div>
                <small className="muted">{queuePositionSummary}</small>
                {queueProgressContext.total > 0 ? (
                  <small className="muted">
                    {t('Remaining')}: {queueProgressContext.remaining}
                  </small>
                ) : null}
                <small className="muted">{selectedFilename}</small>
                <WorkspaceActionStack>
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
                </WorkspaceActionStack>
              </div>
            </details>
            <details className="workspace-disclosure">
              <summary>
                <span>{t('Review Session History')}</span>
                <Badge tone="neutral">{filteredReviewActionHistory.length}</Badge>
              </summary>
              <div className="workspace-disclosure-content">
                <small className="muted">{t('Session history is auto-saved per dataset/version on this browser.')}</small>
                <div className="row gap wrap align-center">
                  <Button
                    type="button"
                    size="sm"
                    variant={reviewHistoryFilter === 'all' ? 'secondary' : 'ghost'}
                    onClick={() => {
                      setReviewHistoryFilter('all');
                      setReviewHistoryCursor(0);
                    }}
                  >
                    {t('All items')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={reviewHistoryFilter === 'rejected' ? 'secondary' : 'ghost'}
                    onClick={() => {
                      setReviewHistoryFilter('rejected');
                      setReviewHistoryCursor(0);
                    }}
                  >
                    {t('Rejected')}
                  </Button>
                  <Badge tone="info">
                    {filteredReviewActionHistory.length > 0
                      ? t('History {current}/{total}', {
                          current: reviewHistoryCursor + 1,
                          total: filteredReviewActionHistory.length
                        })
                      : t('History 0/0')}
                  </Badge>
                </div>
                <label className="row gap align-center">
                  <Checkbox
                    checked={historyRestoreContextOnReopen}
                    onChange={(event) => setHistoryRestoreContextOnReopen(event.target.checked)}
                  />
                  <small className="muted">{t('Reopen with saved queue context')}</small>
                </label>
                {latestReviewAction ? (
                  <div className="stack tight">
                    <small className="muted">
                      {t('Latest')}: {latestReviewAction.filename} · {t(latestReviewAction.status)} ·{' '}
                      {formatSessionClock(latestReviewAction.timestamp, t('n/a'))}
                    </small>
                    <div className="row gap wrap">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => focusReviewHistoryByIndex(0)}
                      >
                        {t('Reopen Last Reviewed')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => focusReviewHistoryByIndex(0, { restoreQueueContext: true })}
                      >
                        {t('Reopen + Context')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => focusReviewHistoryByIndex(reviewHistoryCursor + 1)}
                        disabled={filteredReviewActionHistory.length === 0}
                      >
                        {t('Previous Reviewed')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => focusReviewHistoryByIndex(reviewHistoryCursor - 1)}
                        disabled={filteredReviewActionHistory.length === 0}
                      >
                        {t('Next Reviewed')}
                      </Button>
                    </div>
                    <small className="muted">{t('History shortcuts: Alt+, previous · Alt+. next')}</small>
                  </div>
                ) : (
                  <small className="muted">{t('No reviewed samples in current session yet.')}</small>
                )}
                {filteredReviewActionHistory.length > 0 ? (
                  <ul className="workspace-record-list compact">
                    {filteredReviewActionHistory.slice(0, 6).map((entry, index) => (
                      <Panel
                        key={entry.id}
                        as="li"
                        className={`workspace-record-item compact stack tight${index === reviewHistoryCursor ? ' selected' : ''}`}
                        tone="soft"
                      >
                        <div className="row between gap wrap align-center">
                          <strong className="line-clamp-1">{entry.filename}</strong>
                          <Badge tone={entry.status === 'approved' ? 'info' : 'warning'}>
                            {t(entry.status)}
                          </Badge>
                        </div>
                        <small className="muted">
                          {formatSessionClock(entry.timestamp, t('n/a'))} · {t('from')} {queueLabel(entry.queueAtAction)}
                          {entry.reasonCode ? ` · ${t(entry.reasonCode)}` : ''}
                        </small>
                        <div className="row gap wrap">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setReviewHistoryCursor(index);
                              focusReviewedItem(entry);
                            }}
                          >
                            {t('Reopen')}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setReviewHistoryCursor(index);
                              focusReviewedItem(entry, { restoreQueueContext: true });
                            }}
                          >
                            {t('Reopen + Context')}
                          </Button>
                        </div>
                      </Panel>
                    ))}
                  </ul>
                ) : null}
              </div>
            </details>
            <details className="workspace-disclosure">
              <summary>
                <span>{t('Low-confidence Radar')}</span>
                <Badge tone={lowConfidenceQueueRadarItems.length > 0 ? 'warning' : 'neutral'}>
                  {lowConfidenceQueueRadarItems.length}
                </Badge>
              </summary>
              <div className="workspace-disclosure-content">
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
                            <Badge tone="warning">{t('Low-confidence item count')}: {count}</Badge>
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
              </div>
            </details>
          </Card>
          </div>
        }
      />
      </section>
    </WorkspacePage>
  );
}
