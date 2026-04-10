import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type {
  AnnotationReviewReasonCode,
  AnnotationWithReview,
  DatasetItemRecord,
  DatasetRecord,
  DatasetVersionRecord,
  FileAttachment
} from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import AttachmentUploader from '../components/AttachmentUploader';
import BulkActionBar from '../components/datasets/BulkActionBar';
import DatasetItemBrowser from '../components/datasets/DatasetItemBrowser';
import DatasetVersionRail from '../components/datasets/DatasetVersionRail';
import StateBlock from '../components/StateBlock';
import StepIndicator from '../components/StepIndicator';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { Input, Select, Textarea } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import {
  filterItemsByAnnotationQueue,
  getItemAnnotationStatus,
  matchesAnnotationQueue,
  getAnnotationByItemId,
  summarizeAnnotationQueues,
  type AnnotationQueueFilter
} from '../features/annotationQueue';
import { matchesMetadataFilter } from '../features/metadataFilter';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';

const metadataToText = (metadata: Record<string, string>): string =>
  Object.entries(metadata)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

const parseMetadataText = (source: string): Record<string, string> =>
  Object.fromEntries(
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separatorIndex = line.indexOf('=');
        if (separatorIndex <= 0) {
          return [line.trim(), 'true'] as const;
        }
        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim();
        return [key, value || 'true'] as const;
      })
      .filter(([key]) => key.length > 0)
  );

const reviewReasonFilterOptions: AnnotationReviewReasonCode[] = [
  'box_mismatch',
  'label_error',
  'text_error',
  'missing_object',
  'polygon_issue',
  'other'
];

const buildAnnotationWorkspacePath = (
  datasetId: string,
  queue: AnnotationQueueFilter,
  itemId?: string,
  options?: {
    versionId?: string;
    searchText?: string;
    splitFilter?: 'all' | 'train' | 'val' | 'test' | 'unassigned';
    itemStatusFilter?: 'all' | 'uploading' | 'processing' | 'ready' | 'error';
    metadataFilter?: string;
  }
): string => {
  const searchParams = new URLSearchParams();
  if (queue !== 'all') {
    searchParams.set('queue', queue);
  }
  if (itemId) {
    searchParams.set('item', itemId);
  }
  const normalizedVersionId = options?.versionId?.trim() ?? '';
  if (normalizedVersionId) {
    searchParams.set('version', normalizedVersionId);
  }
  const normalizedSearchText = options?.searchText?.trim() ?? '';
  if (normalizedSearchText) {
    searchParams.set('q', normalizedSearchText);
  }
  if (options?.splitFilter && options.splitFilter !== 'all') {
    searchParams.set('split', options.splitFilter);
  }
  if (options?.itemStatusFilter && options.itemStatusFilter !== 'all') {
    searchParams.set('item_status', options.itemStatusFilter);
  }
  const normalizedMetadataFilter = options?.metadataFilter?.trim() ?? '';
  if (normalizedMetadataFilter) {
    searchParams.set('meta', normalizedMetadataFilter);
  }
  const query = searchParams.toString();
  return query ? `/datasets/${datasetId}/annotate?${query}` : `/datasets/${datasetId}/annotate`;
};

const buildTrainingJobCreatePath = (datasetId: string, versionId: string): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('dataset', datasetId);
  searchParams.set('version', versionId);
  return `/training/jobs/new?${searchParams.toString()}`;
};

const buildTrainingJobsPath = (datasetId: string, versionId: string): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('dataset', datasetId);
  searchParams.set('version', versionId);
  return `/training/jobs?${searchParams.toString()}`;
};

const buildInferenceValidationPath = (datasetId: string, versionId?: string): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('dataset', datasetId);
  if (versionId) {
    searchParams.set('version', versionId);
  }
  return `/inference/validate?${searchParams.toString()}`;
};

const backgroundRefreshIntervalMs = 5000;

type LoadMode = 'initial' | 'manual' | 'background';
type DatasetDetailSnapshot = {
  dataset: DatasetRecord;
  attachments: FileAttachment[];
  items: DatasetItemRecord[];
  versions: DatasetVersionRecord[];
  annotations: AnnotationWithReview[];
};
type ReviewReasonFilter = AnnotationReviewReasonCode | 'all';
type SavedSampleView = {
  id: string;
  name: string;
  searchText: string;
  splitFilter: 'all' | 'train' | 'val' | 'test' | 'unassigned';
  statusFilter: 'all' | 'uploading' | 'processing' | 'ready' | 'error';
  queueFilter: AnnotationQueueFilter;
  reviewReasonFilter: ReviewReasonFilter;
  metadataFilter: string;
  viewMode: 'list' | 'grid';
};
type ErrorPatternSlice = {
  id: string;
  label: string;
  description: string;
  count: number;
  queueFilter: AnnotationQueueFilter;
  splitFilter: 'all' | 'train' | 'val' | 'test' | 'unassigned';
  reviewReasonFilter: ReviewReasonFilter;
  metadataFilter: string;
};
type MetadataSignalSlice = {
  id: string;
  label: string;
  description: string;
  count: number;
  metadataFilter: string;
  queueFilter: AnnotationQueueFilter;
};

const buildDatasetDetailSignature = (detail: {
  dataset: DatasetRecord;
  attachments: FileAttachment[];
  items: DatasetItemRecord[];
  versions: DatasetVersionRecord[];
  annotations: AnnotationWithReview[];
}): string =>
  JSON.stringify({
    dataset: detail.dataset,
    attachments: [...detail.attachments].sort((left, right) => left.id.localeCompare(right.id)),
    items: [...detail.items].sort((left, right) => left.id.localeCompare(right.id)),
    versions: [...detail.versions].sort((left, right) => left.id.localeCompare(right.id)),
    annotations: [...detail.annotations].sort((left, right) => left.id.localeCompare(right.id))
  });

export default function DatasetDetailPage() {
  const { t } = useI18n();
  const steps = useMemo(() => [t('Upload'), t('Split'), t('Version')], [t]);
  const { datasetId } = useParams<{ datasetId: string }>();
  const [searchParams] = useSearchParams();
  const [dataset, setDataset] = useState<DatasetRecord | null>(null);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [items, setItems] = useState<DatasetItemRecord[]>([]);
  const [versions, setVersions] = useState<DatasetVersionRecord[]>([]);
  const [annotations, setAnnotations] = useState<AnnotationWithReview[]>([]);
  const [splitTrain, setSplitTrain] = useState('0.7');
  const [splitVal, setSplitVal] = useState('0.2');
  const [splitTest, setSplitTest] = useState('0.1');
  const [versionName, setVersionName] = useState('');
  const [importFormat, setImportFormat] = useState<'yolo' | 'coco' | 'labelme' | 'ocr'>('yolo');
  const [exportFormat, setExportFormat] = useState<'yolo' | 'coco' | 'labelme' | 'ocr'>('yolo');
  const [importAttachmentId, setImportAttachmentId] = useState('');
  const [referenceFilename, setReferenceFilename] = useState('');
  const [referenceSplit, setReferenceSplit] = useState<'train' | 'val' | 'test' | 'unassigned'>('unassigned');
  const [referenceStatus, setReferenceStatus] = useState<'uploading' | 'processing' | 'ready' | 'error'>('ready');
  const [referenceMetadataText, setReferenceMetadataText] = useState('source=import_reference');
  const [selectedItemId, setSelectedItemId] = useState('');
  const [itemSplit, setItemSplit] = useState<'train' | 'val' | 'test' | 'unassigned'>('unassigned');
  const [itemStatus, setItemStatus] = useState<'uploading' | 'processing' | 'ready' | 'error'>('ready');
  const [itemMetadataText, setItemMetadataText] = useState('');
  const [sampleSearchText, setSampleSearchText] = useState('');
  const [sampleSplitFilter, setSampleSplitFilter] = useState<'all' | 'train' | 'val' | 'test' | 'unassigned'>('all');
  const [sampleStatusFilter, setSampleStatusFilter] = useState<'all' | 'uploading' | 'processing' | 'ready' | 'error'>('all');
  const [sampleQueueFilter, setSampleQueueFilter] = useState<AnnotationQueueFilter>('all');
  const [sampleReviewReasonFilter, setSampleReviewReasonFilter] = useState<ReviewReasonFilter>('all');
  const [sampleMetadataFilter, setSampleMetadataFilter] = useState('');
  const [sampleViewMode, setSampleViewMode] = useState<'list' | 'grid'>('list');
  const [savedSampleViews, setSavedSampleViews] = useState<SavedSampleView[]>([]);
  const [selectedSavedSampleViewId, setSelectedSavedSampleViewId] = useState('');
  const [savedSampleViewNameDraft, setSavedSampleViewNameDraft] = useState('');
  const [selectedSampleItemIds, setSelectedSampleItemIds] = useState<string[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [batchSplit, setBatchSplit] = useState<'keep' | 'train' | 'val' | 'test' | 'unassigned'>('keep');
  const [batchStatus, setBatchStatus] = useState<'keep' | 'uploading' | 'processing' | 'ready' | 'error'>('keep');
  const [batchTagsText, setBatchTagsText] = useState('');
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sectionRefreshing, setSectionRefreshing] = useState<'attachments' | 'items' | 'versions' | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const detailSignatureRef = useRef('');
  const preferredVersionId = (searchParams.get('version') ?? '').trim();
  const sampleViewStorageKey = datasetId ? `vistral:dataset:${datasetId}:sample-views` : '';

  const applyDetailSnapshot = useCallback((snapshot: DatasetDetailSnapshot) => {
    const nextSignature = buildDatasetDetailSignature(snapshot);
    if (detailSignatureRef.current !== nextSignature) {
      detailSignatureRef.current = nextSignature;
      setDataset(snapshot.dataset);
      setAttachments(snapshot.attachments);
      setItems(snapshot.items);
      setVersions(snapshot.versions);
      setAnnotations(snapshot.annotations);
    }
  }, []);

  const loadDetail = useCallback(async (mode: LoadMode) => {
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
      const [detail, attachmentList, itemList, versionList, annotationList] = await Promise.all([
        api.getDatasetDetail(datasetId),
        api.listDatasetAttachments(datasetId),
        api.listDatasetItems(datasetId),
        api.listDatasetVersions(datasetId),
        api.listDatasetAnnotations(datasetId)
      ]);

      applyDetailSnapshot({
        dataset: detail.dataset,
        attachments: attachmentList,
        items: itemList,
        versions: versionList,
        annotations: annotationList
      });
    } finally {
      if (mode === 'initial') {
        setLoading(false);
      }

      if (mode === 'manual') {
        setRefreshing(false);
      }
    }
  }, [applyDetailSnapshot, datasetId]);

  useEffect(() => {
    if (!datasetId) {
      setLoading(false);
      return;
    }

    loadDetail('initial')
      .then(() => setFeedback(null))
      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }));
  }, [datasetId, loadDetail]);

  useEffect(() => {
    if (!sampleViewStorageKey) {
      setSavedSampleViews([]);
      setSelectedSavedSampleViewId('');
      setSavedSampleViewNameDraft('');
      return;
    }

    try {
      const raw = localStorage.getItem(sampleViewStorageKey);
      if (!raw) {
        setSavedSampleViews([]);
        setSelectedSavedSampleViewId('');
        setSavedSampleViewNameDraft('');
        return;
      }
      const parsed = JSON.parse(raw) as SavedSampleView[];
      if (!Array.isArray(parsed)) {
        setSavedSampleViews([]);
        return;
      }
      const normalized = parsed
        .filter((item) => typeof item?.id === 'string' && typeof item?.name === 'string')
        .map((item) => ({
          ...item,
          reviewReasonFilter: item.reviewReasonFilter ?? 'all'
        }))
        .slice(0, 20);
      setSavedSampleViews(normalized);
      setSelectedSavedSampleViewId('');
      setSavedSampleViewNameDraft('');
    } catch {
      setSavedSampleViews([]);
      setSelectedSavedSampleViewId('');
      setSavedSampleViewNameDraft('');
    }
  }, [sampleViewStorageKey]);

  useEffect(() => {
    if (!sampleViewStorageKey) {
      return;
    }
    localStorage.setItem(sampleViewStorageKey, JSON.stringify(savedSampleViews));
  }, [sampleViewStorageKey, savedSampleViews]);

  const readyCount = useMemo(
    () => attachments.filter((attachment) => attachment.status === 'ready').length,
    [attachments]
  );
  const hasTransientDatasetState = useMemo(
    () =>
      attachments.some((attachment) => attachment.status === 'uploading' || attachment.status === 'processing') ||
      items.some((item) => item.status === 'uploading' || item.status === 'processing') ||
      annotations.some((annotation) => annotation.status === 'in_review'),
    [annotations, attachments, items]
  );
  const attachmentById = useMemo(
    () => new Map(attachments.map((attachment) => [attachment.id, attachment])),
    [attachments]
  );
  const resolveItemFilename = useCallback(
    (item: DatasetItemRecord) => attachmentById.get(item.attachment_id)?.filename ?? t('Attached file unavailable'),
    [attachmentById, t]
  );
  const annotationByItemId = useMemo(() => getAnnotationByItemId(annotations), [annotations]);
  const annotationSummary = useMemo(
    () => summarizeAnnotationQueues(items, annotations),
    [annotations, items]
  );
  const formatCoveragePercent = (value: number) => `${Math.round(value * 100)}%`;
  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedItemId) ?? null,
    [items, selectedItemId]
  );
  const selectedVersion = useMemo(
    () => versions.find((version) => version.id === selectedVersionId) ?? null,
    [selectedVersionId, versions]
  );
  const selectedVersionHasTrainSplit = (selectedVersion?.split_summary.train ?? 0) > 0;
  const selectedVersionHasCoverage = (selectedVersion?.annotation_coverage ?? 0) > 0;
  const selectedVersionLaunchReady = Boolean(
    dataset?.status === 'ready' &&
      selectedVersion &&
      selectedVersionHasTrainSplit &&
      selectedVersionHasCoverage
  );
  const preferredReviewQueueForSelectedVersion = useMemo(() => {
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
  const filteredSampleItems = useMemo(() => {
    const normalizedSearch = sampleSearchText.trim().toLowerCase();
    return items.filter((item) => {
      if (sampleSplitFilter !== 'all' && item.split !== sampleSplitFilter) {
        return false;
      }

      if (sampleStatusFilter !== 'all' && item.status !== sampleStatusFilter) {
        return false;
      }

      const annotationStatus = getItemAnnotationStatus(item.id, annotationByItemId);
      if (!matchesAnnotationQueue(annotationStatus, sampleQueueFilter)) {
        return false;
      }
      if (sampleReviewReasonFilter !== 'all') {
        const latestReview = annotationByItemId.get(item.id)?.latest_review;
        if (!latestReview || latestReview.review_reason_code !== sampleReviewReasonFilter) {
          return false;
        }
      }

      if (normalizedSearch) {
        const filename = resolveItemFilename(item).toLowerCase();
        if (!filename.includes(normalizedSearch)) {
          return false;
        }
      }

      if (!matchesMetadataFilter(item.metadata, sampleMetadataFilter)) {
        return false;
      }

      return true;
    });
  }, [
    annotationByItemId,
    items,
    resolveItemFilename,
    sampleMetadataFilter,
    sampleQueueFilter,
    sampleReviewReasonFilter,
    sampleSearchText,
    sampleSplitFilter,
    sampleStatusFilter
  ]);
  const selectedSampleItemIdSet = useMemo(
    () => new Set(selectedSampleItemIds),
    [selectedSampleItemIds]
  );
  const allFilteredItemsSelected =
    filteredSampleItems.length > 0 &&
    filteredSampleItems.every((item) => selectedSampleItemIdSet.has(item.id));
  const resolveItemPreviewUrl = useCallback(
    (item: DatasetItemRecord): string | null => {
      const attachmentId = item.attachment_id?.trim();
      if (!attachmentId || item.status !== 'ready') {
        return null;
      }

      const attachment = attachmentById.get(attachmentId);
      if (attachment && attachment.status !== 'ready') {
        return null;
      }

      return api.attachmentContentUrl(attachmentId);
    },
    [attachmentById]
  );
  const resolveAnnotationStatus = useCallback(
    (itemId: string): string => getItemAnnotationStatus(itemId, annotationByItemId),
    [annotationByItemId]
  );
  const queuePreviewEntries = useMemo(
    () => {
      const needsWorkItems = filterItemsByAnnotationQueue(items, annotations, 'needs_work');
      const inReviewItems = filterItemsByAnnotationQueue(items, annotations, 'in_review');
      const rejectedItems = filterItemsByAnnotationQueue(items, annotations, 'rejected');
      const approvedItems = filterItemsByAnnotationQueue(items, annotations, 'approved');

      return [
        {
          key: 'needs_work' as const,
          label: t('Needs Work'),
          count: annotationSummary.needs_work,
          description: t('Items that still need annotation or submit-review actions.'),
          items: needsWorkItems.slice(0, 3),
          firstItemId: needsWorkItems[0]?.id ?? ''
        },
        {
          key: 'in_review' as const,
          label: t('in_review'),
          count: annotationSummary.in_review,
          description: t('Items waiting for reviewer approval or rejection.'),
          items: inReviewItems.slice(0, 3),
          firstItemId: inReviewItems[0]?.id ?? ''
        },
        {
          key: 'rejected' as const,
          label: t('rejected'),
          count: annotationSummary.rejected,
          description: t('Rejected items keep the latest review reason visible for rework.'),
          items: rejectedItems.slice(0, 3),
          firstItemId: rejectedItems[0]?.id ?? ''
        },
        {
          key: 'approved' as const,
          label: t('approved'),
          count: annotationSummary.approved,
          description: t('Approved items are ready for downstream dataset versioning and training.'),
          items: approvedItems.slice(0, 3),
          firstItemId: approvedItems[0]?.id ?? ''
        }
      ];
    },
    [annotationSummary.approved, annotationSummary.in_review, annotationSummary.needs_work, annotationSummary.rejected, annotations, items, t]
  );
  const prioritizedAnnotationWorkspacePath = useMemo(() => {
    if (!datasetId) {
      return '';
    }

    const queuePriority: AnnotationQueueFilter[] = ['rejected', 'in_review', 'needs_work', 'approved'];
    for (const queue of queuePriority) {
      const entry = queuePreviewEntries.find((item) => item.key === queue);
      if (entry && entry.count > 0) {
        return buildAnnotationWorkspacePath(datasetId, queue, entry.firstItemId, {
          versionId: selectedVersionId
        });
      }
    }

    return buildAnnotationWorkspacePath(datasetId, 'all', undefined, {
      versionId: selectedVersionId
    });
  }, [datasetId, queuePreviewEntries, selectedVersionId]);
  const annotationWorkspaceFromSampleBrowserPath = useMemo(() => {
    if (!datasetId) {
      return '';
    }

    const nextItemId = selectedSampleItemIds[0] ?? filteredSampleItems[0]?.id ?? '';
    return buildAnnotationWorkspacePath(datasetId, sampleQueueFilter, nextItemId, {
      versionId: selectedVersionId,
      searchText: sampleSearchText,
      splitFilter: sampleSplitFilter,
      itemStatusFilter: sampleStatusFilter,
      metadataFilter: sampleMetadataFilter
    });
  }, [
    datasetId,
    filteredSampleItems,
    sampleMetadataFilter,
    sampleQueueFilter,
    sampleSearchText,
    sampleSplitFilter,
    sampleStatusFilter,
    selectedVersionId,
    selectedSampleItemIds
  ]);
  const errorPatternSlices = useMemo<ErrorPatternSlice[]>(() => {
    const slices: ErrorPatternSlice[] = [];
    const rejectedReasonCounts = new Map<AnnotationReviewReasonCode, number>();

    for (const annotation of annotations) {
      const latestReview = annotation.latest_review;
      if (!latestReview || latestReview.status !== 'rejected' || !latestReview.review_reason_code) {
        continue;
      }
      const reasonCode = latestReview.review_reason_code;
      rejectedReasonCounts.set(reasonCode, (rejectedReasonCounts.get(reasonCode) ?? 0) + 1);
    }

    for (const reasonCode of reviewReasonFilterOptions) {
      const count = rejectedReasonCounts.get(reasonCode) ?? 0;
      if (count <= 0) {
        continue;
      }
      slices.push({
        id: `rejected-${reasonCode}`,
        label: t('Rejected · {reason}', { reason: t(reasonCode) }),
        description: t('Rejected samples grouped by latest review reason.'),
        count,
        queueFilter: 'rejected',
        splitFilter: 'all',
        reviewReasonFilter: reasonCode,
        metadataFilter: ''
      });
    }

    const lowConfidenceTagCount = items.filter((item) =>
      Object.keys(item.metadata).some((key) => key.toLowerCase() === 'tag:low_confidence')
    ).length;
    if (lowConfidenceTagCount > 0) {
      slices.push({
        id: 'low-confidence-tag',
        label: t('Tag · low_confidence'),
        description: t('Samples already marked as low-confidence in metadata tags.'),
        count: lowConfidenceTagCount,
        queueFilter: 'all',
        splitFilter: 'all',
        reviewReasonFilter: 'all',
        metadataFilter: 'tag:low_confidence'
      });
    }

    const feedbackReturnCount = items.filter((item) => {
      const value = item.metadata.inference_run_id;
      return typeof value === 'string' && value.trim().length > 0;
    }).length;
    if (feedbackReturnCount > 0) {
      slices.push({
        id: 'feedback-return',
        label: t('Feedback Return Samples'),
        description: t('Samples returned from inference validation feedback loops.'),
        count: feedbackReturnCount,
        queueFilter: 'needs_work',
        splitFilter: 'all',
        reviewReasonFilter: 'all',
        metadataFilter: 'inference_run_id'
      });
    }

    const unassignedReadyCount = items.filter(
      (item) => item.split === 'unassigned' && item.status === 'ready'
    ).length;
    if (unassignedReadyCount > 0) {
      slices.push({
        id: 'unassigned-ready',
        label: t('Ready but Unassigned'),
        description: t('Ready samples still waiting for train/val/test assignment.'),
        count: unassignedReadyCount,
        queueFilter: 'all',
        splitFilter: 'unassigned',
        reviewReasonFilter: 'all',
        metadataFilter: ''
      });
    }

    return slices.sort((left, right) => right.count - left.count).slice(0, 6);
  }, [annotations, items, t]);
  const applyErrorPatternSlice = useCallback(
    (slice: ErrorPatternSlice) => {
      setSampleSearchText('');
      setSampleSplitFilter(slice.splitFilter);
      setSampleStatusFilter('all');
      setSampleQueueFilter(slice.queueFilter);
      setSampleReviewReasonFilter(slice.reviewReasonFilter);
      setSampleMetadataFilter(slice.metadataFilter);
      setSelectedSampleItemIds([]);
      setFeedback({
        variant: 'success',
        text: t('Sample browser focused on pattern: {pattern}', { pattern: slice.label })
      });
    },
    [t]
  );
  const metadataSignalSlices = useMemo<MetadataSignalSlice[]>(() => {
    const tagCounts = new Map<string, number>();
    const sourceCounts = new Map<string, number>();
    const feedbackReasonCounts = new Map<string, number>();

    for (const item of items) {
      const entries = Object.entries(item.metadata);
      if (entries.length === 0) {
        continue;
      }

      for (const [key, rawValue] of entries) {
        const normalizedKey = key.trim().toLowerCase();
        const value = String(rawValue).trim();
        if (!normalizedKey) {
          continue;
        }

        if (normalizedKey.startsWith('tag:')) {
          tagCounts.set(normalizedKey, (tagCounts.get(normalizedKey) ?? 0) + 1);
        }

        if (normalizedKey === 'source' && value) {
          const normalizedValue = value.toLowerCase();
          sourceCounts.set(normalizedValue, (sourceCounts.get(normalizedValue) ?? 0) + 1);
        }

        if (normalizedKey === 'feedback_reason' && value) {
          const normalizedValue = value.toLowerCase();
          feedbackReasonCounts.set(
            normalizedValue,
            (feedbackReasonCounts.get(normalizedValue) ?? 0) + 1
          );
        }
      }
    }

    const slices: MetadataSignalSlice[] = [];

    for (const [tagKey, count] of [...tagCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 4)) {
      slices.push({
        id: `tag-${tagKey}`,
        label: t('Tag · {tag}', { tag: tagKey.replace(/^tag:/, '') }),
        description: t('Metadata tag slice for quick sampling and queue focus.'),
        count,
        metadataFilter: tagKey,
        queueFilter: 'all'
      });
    }

    for (const [sourceValue, count] of [...sourceCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 2)) {
      slices.push({
        id: `source-${sourceValue}`,
        label: t('Source · {value}', { value: sourceValue }),
        description: t('Samples grouped by metadata source value.'),
        count,
        metadataFilter: `source=${sourceValue}`,
        queueFilter: 'all'
      });
    }

    for (const [reasonValue, count] of [...feedbackReasonCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 2)) {
      slices.push({
        id: `feedback-${reasonValue}`,
        label: t('Feedback reason · {value}', { value: reasonValue }),
        description: t('Inference feedback reason slice for active rework routing.'),
        count,
        metadataFilter: `feedback_reason=${reasonValue}`,
        queueFilter: 'needs_work'
      });
    }

    return slices.filter((slice) => slice.count > 0).sort((left, right) => right.count - left.count).slice(0, 8);
  }, [items, t]);
  const applyMetadataSignalSlice = useCallback(
    (slice: MetadataSignalSlice) => {
      setSampleSearchText('');
      setSampleSplitFilter('all');
      setSampleStatusFilter('all');
      setSampleQueueFilter(slice.queueFilter);
      setSampleReviewReasonFilter('all');
      setSampleMetadataFilter(slice.metadataFilter);
      setSelectedSampleItemIds([]);
      setFeedback({
        variant: 'success',
        text: t('Sample browser focused on metadata slice: {slice}', { slice: slice.label })
      });
    },
    [t]
  );
  const applySavedSampleView = useCallback(
    (viewId: string) => {
      setSelectedSavedSampleViewId(viewId);
      if (!viewId) {
        setSavedSampleViewNameDraft('');
        return;
      }
      const target = savedSampleViews.find((view) => view.id === viewId);
      if (!target) {
        return;
      }

      setSavedSampleViewNameDraft(target.name);
      setSampleSearchText(target.searchText);
      setSampleSplitFilter(target.splitFilter);
      setSampleStatusFilter(target.statusFilter);
      setSampleQueueFilter(target.queueFilter);
      setSampleReviewReasonFilter(target.reviewReasonFilter ?? 'all');
      setSampleMetadataFilter(target.metadataFilter);
      setSampleViewMode(target.viewMode);
      setSelectedSampleItemIds([]);
    },
    [savedSampleViews]
  );
  const persistSampleView = useCallback((input: Omit<SavedSampleView, 'id'> & { id?: string }) => {
    const nextId = input.id || `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const nextView: SavedSampleView = { ...input, id: nextId };
    setSavedSampleViews((previous) => {
      const withoutTarget = previous.filter((item) => item.id !== nextId);
      return [nextView, ...withoutTarget].slice(0, 20);
    });
    setSelectedSavedSampleViewId(nextId);
    setSavedSampleViewNameDraft(nextView.name);
    return nextView;
  }, []);
  const saveCurrentSampleView = useCallback(() => {
    const normalizedName = savedSampleViewNameDraft.trim() || t('View');
    persistSampleView({
      id: selectedSavedSampleViewId || undefined,
      name: normalizedName,
      searchText: sampleSearchText,
      splitFilter: sampleSplitFilter,
      statusFilter: sampleStatusFilter,
      queueFilter: sampleQueueFilter,
      reviewReasonFilter: sampleReviewReasonFilter,
      metadataFilter: sampleMetadataFilter,
      viewMode: sampleViewMode
    });
    setFeedback({ variant: 'success', text: t('Saved current filter view.') });
  }, [
    persistSampleView,
    sampleMetadataFilter,
    sampleQueueFilter,
    sampleReviewReasonFilter,
    sampleSearchText,
    sampleSplitFilter,
    sampleStatusFilter,
    sampleViewMode,
    savedSampleViewNameDraft,
    selectedSavedSampleViewId,
    t
  ]);
  const saveSliceAsSampleView = useCallback(
    (input: {
      name: string;
      splitFilter: 'all' | 'train' | 'val' | 'test' | 'unassigned';
      queueFilter: AnnotationQueueFilter;
      reviewReasonFilter: ReviewReasonFilter;
      metadataFilter: string;
    }) => {
      const normalizedName = input.name.trim() || t('View');
      const existingByName = savedSampleViews.find((view) => view.name === normalizedName);
      persistSampleView({
        id: existingByName?.id,
        name: normalizedName,
        searchText: '',
        splitFilter: input.splitFilter,
        statusFilter: 'all',
        queueFilter: input.queueFilter,
        reviewReasonFilter: input.reviewReasonFilter,
        metadataFilter: input.metadataFilter,
        viewMode: 'list'
      });
      setFeedback({
        variant: 'success',
        text: existingByName
          ? t('Updated saved view from slice: {name}', { name: normalizedName })
          : t('Saved new view from slice: {name}', { name: normalizedName })
      });
    },
    [persistSampleView, savedSampleViews, t]
  );
  const deleteSavedSampleView = useCallback(() => {
    if (!selectedSavedSampleViewId) {
      return;
    }
    setSavedSampleViews((previous) =>
      previous.filter((view) => view.id !== selectedSavedSampleViewId)
    );
    setSelectedSavedSampleViewId('');
    setSavedSampleViewNameDraft('');
    setFeedback({ variant: 'success', text: t('Saved view removed.') });
  }, [selectedSavedSampleViewId, t]);

  useBackgroundPolling(
    () => {
      loadDetail('background').catch(() => {
        // keep UI stable in polling loop
      });
    },
    {
      intervalMs: backgroundRefreshIntervalMs,
      enabled: Boolean(datasetId) && hasTransientDatasetState
    }
  );

  useEffect(() => {
    const readyAttachments = attachments.filter((attachment) => attachment.status === 'ready');

    if (readyAttachments.length === 0) {
      if (importAttachmentId) {
        setImportAttachmentId('');
      }
      return;
    }

    if (importAttachmentId && readyAttachments.some((attachment) => attachment.id === importAttachmentId)) {
      return;
    }

    setImportAttachmentId(readyAttachments[0]?.id ?? '');
  }, [attachments, importAttachmentId]);

  useEffect(() => {
    if (items.length === 0) {
      if (selectedItemId) {
        setSelectedItemId('');
      }
      return;
    }
    const existing = items.find((item) => item.id === selectedItemId);
    if (existing) {
      return;
    }

    const first = items[0];
    setSelectedItemId(first.id);
    setItemSplit(first.split);
    setItemStatus(first.status);
    setItemMetadataText(metadataToText(first.metadata));
  }, [items, selectedItemId]);

  useEffect(() => {
    setSelectedSampleItemIds((previous) => {
      if (previous.length === 0) {
        return previous;
      }

      const validItemIdSet = new Set(items.map((item) => item.id));
      const next = previous.filter((itemId) => validItemIdSet.has(itemId));
      return next.length === previous.length ? previous : next;
    });
  }, [items]);

  useEffect(() => {
    if (versions.length === 0) {
      if (selectedVersionId) {
        setSelectedVersionId('');
      }
      return;
    }

    if (preferredVersionId && versions.some((version) => version.id === preferredVersionId)) {
      if (selectedVersionId !== preferredVersionId) {
        setSelectedVersionId(preferredVersionId);
      }
      return;
    }

    const exists = versions.some((version) => version.id === selectedVersionId);
    if (!exists) {
      setSelectedVersionId(versions[0].id);
    }
  }, [preferredVersionId, selectedVersionId, versions]);

  const uploadDatasetFile = async (filename: string) => {
    if (!datasetId) {
      throw new Error(t('Missing Dataset ID'));
    }

    await api.uploadDatasetAttachment(datasetId, filename);
    await loadDetail('manual');
  };

  const uploadDatasetFiles = async (files: File[]) => {
    if (!datasetId) {
      throw new Error(t('Missing Dataset ID'));
    }

    for (const file of files) {
      await api.uploadDatasetFile(datasetId, file);
    }
    await loadDetail('manual');
  };

  const deleteAttachment = async (attachmentId: string) => {
    await api.removeAttachment(attachmentId);
    await loadDetail('manual');
  };

  const refreshAttachmentSection = useCallback(async () => {
    if (!datasetId || !dataset) {
      return;
    }

    setSectionRefreshing('attachments');
    try {
      const attachmentList = await api.listDatasetAttachments(datasetId);
      applyDetailSnapshot({
        dataset,
        attachments: attachmentList,
        items,
        versions,
        annotations
      });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setSectionRefreshing(null);
    }
  }, [annotations, applyDetailSnapshot, dataset, datasetId, items, versions]);

  const refreshItemSection = useCallback(async () => {
    if (!datasetId || !dataset) {
      return;
    }

    setSectionRefreshing('items');
    try {
      const itemList = await api.listDatasetItems(datasetId);
      applyDetailSnapshot({
        dataset,
        attachments,
        items: itemList,
        versions,
        annotations
      });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setSectionRefreshing(null);
    }
  }, [annotations, applyDetailSnapshot, attachments, dataset, datasetId, versions]);

  const refreshVersionSection = useCallback(async () => {
    if (!datasetId || !dataset) {
      return;
    }

    setSectionRefreshing('versions');
    try {
      const versionList = await api.listDatasetVersions(datasetId);
      applyDetailSnapshot({
        dataset,
        attachments,
        items,
        versions: versionList,
        annotations
      });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setSectionRefreshing(null);
    }
  }, [annotations, applyDetailSnapshot, attachments, dataset, datasetId, items]);

  const runSplit = async () => {
    if (!datasetId) {
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      const trainRatio = Number(splitTrain);
      const valRatio = Number(splitVal);
      const testRatio = Number(splitTest);
      const total = trainRatio + valRatio + testRatio;

      if (Math.abs(total - 1) > 0.0001) {
        throw new Error(t('Split ratios must sum to 1.0.'));
      }

      await api.splitDataset({
        dataset_id: datasetId,
        train_ratio: trainRatio,
        val_ratio: valRatio,
        test_ratio: testRatio,
        seed: 42
      });

      await loadDetail('manual');
      setStep(2);
      setFeedback({ variant: 'success', text: t('Dataset split updated successfully.') });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const createVersion = async () => {
    if (!datasetId) {
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      const created = await api.createDatasetVersion(datasetId, versionName.trim() || undefined);
      await loadDetail('manual');
      setFeedback({
        variant: 'success',
        text: t('Dataset version {versionName} created.', { versionName: created.version_name })
      });
      setVersionName('');
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const importAnnotations = async () => {
    if (!datasetId) {
      return;
    }

    if (!importAttachmentId) {
      setFeedback({ variant: 'error', text: t('Select a ready dataset attachment as import source.') });
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      const result = await api.importDatasetAnnotations({
        dataset_id: datasetId,
        format: importFormat,
        attachment_id: importAttachmentId
      });
      await loadDetail('manual');
      setFeedback({
        variant: 'success',
        text: t('Import finished ({format}). imported {imported}, updated {updated}, created items {createdItems}.', {
          format: result.format,
          imported: result.imported,
          updated: result.updated,
          createdItems: result.created_items
        })
      });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const exportAnnotations = async () => {
    if (!datasetId) {
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      const result = await api.exportDatasetAnnotations({
        dataset_id: datasetId,
        format: exportFormat
      });
      await loadDetail('manual');
      setFeedback({
        variant: 'success',
        text: t('Export ready ({format}). file {filename}, records {count}.', {
          format: result.format,
          filename: result.filename,
          count: result.exported
        })
      });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const createReferenceItem = async () => {
    if (!datasetId) {
      return;
    }
    const normalizedFilename = referenceFilename.trim();
    if (!normalizedFilename) {
      setFeedback({ variant: 'error', text: t('Reference filename is required.') });
      return;
    }

    const metadata = parseMetadataText(referenceMetadataText);

    setBusy(true);
    setFeedback(null);
    try {
      await api.createDatasetItem(datasetId, {
        filename: normalizedFilename,
        split: referenceSplit,
        status: referenceStatus,
        metadata
      });
      await loadDetail('manual');
      setFeedback({
        variant: 'success',
        text: t('Reference item created. Review it in the item list below.')
      });
      setReferenceFilename('');
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const selectItemForEditing = (item: DatasetItemRecord) => {
    setSelectedItemId(item.id);
    setItemSplit(item.split);
    setItemStatus(item.status);
    setItemMetadataText(metadataToText(item.metadata));
  };

  const saveItemUpdates = async () => {
    if (!datasetId || !selectedItemId) {
      setFeedback({ variant: 'error', text: t('Select item first.') });
      return;
    }

    const metadata = parseMetadataText(itemMetadataText);
    setBusy(true);
    setFeedback(null);
    try {
      await api.updateDatasetItem(datasetId, selectedItemId, {
        split: itemSplit,
        status: itemStatus,
        metadata
      });
      await loadDetail('manual');
      setFeedback({
        variant: 'success',
        text: t('Item updated. The latest dataset detail is now refreshed.')
      });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const toggleSampleItemSelection = useCallback((itemId: string) => {
    setSelectedSampleItemIds((previous) => {
      if (previous.includes(itemId)) {
        return previous.filter((id) => id !== itemId);
      }

      return [...previous, itemId];
    });
  }, []);

  const selectAllFilteredItems = useCallback(() => {
    if (filteredSampleItems.length === 0) {
      return;
    }

    setSelectedSampleItemIds(filteredSampleItems.map((item) => item.id));
  }, [filteredSampleItems]);

  const clearSelectedSampleItems = useCallback(() => {
    setSelectedSampleItemIds([]);
  }, []);
  const clearSampleFilters = useCallback(() => {
    setSampleSearchText('');
    setSampleSplitFilter('all');
    setSampleStatusFilter('all');
    setSampleQueueFilter('all');
    setSampleReviewReasonFilter('all');
    setSampleMetadataFilter('');
    setSelectedSavedSampleViewId('');
    setSavedSampleViewNameDraft('');
    setSelectedSampleItemIds([]);
  }, []);

  const applyBatchItemUpdates = useCallback(async () => {
    if (!datasetId) {
      return;
    }

    if (selectedSampleItemIds.length === 0) {
      setFeedback({ variant: 'error', text: t('Select at least one sample item first.') });
      return;
    }

    const normalizedTagList = batchTagsText
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    if (batchSplit === 'keep' && batchStatus === 'keep' && normalizedTagList.length === 0) {
      setFeedback({
        variant: 'error',
        text: t('Choose at least one batch update option (split, status, or tags).')
      });
      return;
    }

    const itemById = new Map(items.map((item) => [item.id, item]));
    const selectedItems = selectedSampleItemIds
      .map((itemId) => itemById.get(itemId))
      .filter((item): item is DatasetItemRecord => Boolean(item));

    if (selectedItems.length === 0) {
      setFeedback({ variant: 'error', text: t('Selected items are no longer available. Refresh and retry.') });
      return;
    }

    const batchTagEntries: Record<string, string> = {};
    for (const tag of normalizedTagList) {
      batchTagEntries[`tag:${tag}`] = 'true';
    }

    setBusy(true);
    setFeedback(null);
    try {
      let updatedCount = 0;
      await Promise.all(
        selectedItems.map(async (item) => {
          const nextPayload: {
            split?: 'train' | 'val' | 'test' | 'unassigned';
            status?: 'uploading' | 'processing' | 'ready' | 'error';
            metadata?: Record<string, string>;
          } = {};

          if (batchSplit !== 'keep' && item.split !== batchSplit) {
            nextPayload.split = batchSplit;
          }

          if (batchStatus !== 'keep' && item.status !== batchStatus) {
            nextPayload.status = batchStatus;
          }

          if (normalizedTagList.length > 0) {
            nextPayload.metadata = {
              ...item.metadata,
              ...batchTagEntries
            };
          }

          if (
            typeof nextPayload.split === 'undefined' &&
            typeof nextPayload.status === 'undefined' &&
            typeof nextPayload.metadata === 'undefined'
          ) {
            return;
          }

          await api.updateDatasetItem(datasetId, item.id, nextPayload);
          updatedCount += 1;
        })
      );

      await loadDetail('manual');
      setFeedback({
        variant: 'success',
        text: t('Batch update completed. Updated {count} items.', { count: updatedCount })
      });
      if (updatedCount > 0) {
        setSelectedSampleItemIds([]);
      }
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [batchSplit, batchStatus, batchTagsText, datasetId, items, loadDetail, selectedSampleItemIds, t]);

  const heroSection = (
    <WorkspaceHero
      eyebrow={t('Dataset Lane')}
      title={t('Dataset Detail')}
      description={
        dataset
          ? `${dataset.name} · ${t(dataset.task_type)} · ${t(dataset.status)}`
          : t('Inspect dataset files, annotation readiness, and version snapshots in one place.')
      }
      stats={[
        { label: t('Attachments'), value: attachments.length },
        { label: t('Items'), value: items.length },
        { label: t('Versions'), value: versions.length },
        { label: t('Ready files'), value: readyCount }
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
      <StateBlock variant="error" title={t('Missing Dataset ID')} description={t('Open from dataset list page.')} />
    );
  }

  if (loading) {
    return renderShell(
      <StateBlock variant="loading" title={t('Loading Dataset')} description={t('Preparing dataset detail view.')} />
    );
  }

  if (!dataset) {
    return renderShell(
      <StateBlock variant="error" title={t('Dataset Not Found')} description={t('The requested dataset is unavailable.')} />
    );
  }

  return (
    <WorkspacePage>
      {heroSection}

      <StepIndicator steps={steps} current={step} />

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
            description: t('Items that still require annotation or submit-review actions.'),
            value: annotationSummary.needs_work
          },
          {
            title: t('in_review'),
            description: t('Items currently waiting for reviewer decisions.'),
            value: annotationSummary.in_review,
            tone: annotationSummary.in_review > 0 ? 'attention' : 'default'
          },
          {
            title: t('rejected'),
            description: t('Rejected items retain latest review context for focused rework.'),
            value: annotationSummary.rejected,
            tone: annotationSummary.rejected > 0 ? 'attention' : 'default'
          },
          {
            title: t('approved'),
            description: t('Approved items are ready for versioning and training readiness checks.'),
            value: annotationSummary.approved
          }
        ]}
      />

      <WorkspaceWorkbench
        toolbar={
          <Card as="section" className="workspace-toolbar-card">
            <div className="workspace-toolbar-head">
              <div className="workspace-toolbar-copy">
                <h3>{t('Dataset Controls')}</h3>
                <small className="muted">
                  {t('Keep curation, queue entry, snapshot context, and downstream launch actions in one stable lane.')}
                </small>
              </div>
              <div className="workspace-toolbar-actions">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    loadDetail('manual')
                      .then(() => setFeedback(null))
                      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }));
                  }}
                  disabled={busy || refreshing}
                >
                  {refreshing ? t('Refreshing...') : t('Refresh')}
                </Button>
                <ButtonLink
                  size="sm"
                  variant="ghost"
                  to={prioritizedAnnotationWorkspacePath || `/datasets/${dataset.id}/annotate`}
                >
                  {t('Open Annotation Workspace')}
                </ButtonLink>
                {selectedVersion ? (
                  <>
                    <ButtonLink
                      size="sm"
                      variant="ghost"
                      to={buildInferenceValidationPath(dataset.id, selectedVersion.id)}
                    >
                      {t('Validate Inference')}
                    </ButtonLink>
                    <ButtonLink
                      size="sm"
                      variant="ghost"
                      to={buildTrainingJobCreatePath(dataset.id, selectedVersion.id)}
                    >
                      {t('Create Training Job')}
                    </ButtonLink>
                  </>
                ) : null}
              </div>
            </div>
            <div className="workspace-toolbar-meta">
              <div className="workspace-segmented-actions">
                <Badge tone="neutral">{t('Dataset')}: {dataset.name}</Badge>
                <Badge tone="info">{t('Task Type')}: {t(dataset.task_type)}</Badge>
                <Badge tone={selectedVersion ? 'info' : 'neutral'}>
                  {selectedVersion ? `${t('Version')}: ${selectedVersion.version_name}` : t('Version') + ': ' + t('Latest')}
                </Badge>
                <Badge tone="neutral">{t('Ready files')}: {readyCount}</Badge>
                <Badge tone="neutral">{t('Filtered samples')}: {filteredSampleItems.length}</Badge>
              </div>
            </div>
          </Card>
        }
        main={
          <div className="workspace-main-stack">
          <Card as="section">
            <WorkspaceSectionHeader
              title={t('Annotation Summary')}
              description={t('Review annotation progress and jump directly into the next focused queue.')}
            />
            {selectedVersion ? (
              <small className="muted">
                {t('Selected version split')}: train {selectedVersion.split_summary.train} / val {selectedVersion.split_summary.val} / test{' '}
                {selectedVersion.split_summary.test} · {t('coverage')} {formatCoveragePercent(selectedVersion.annotation_coverage)}
              </small>
            ) : (
              <small className="muted">
                {t('No explicit dataset version selected. Operations use current dataset context.')}
              </small>
            )}

            <div className="annotation-summary-grid">
              {queuePreviewEntries.map((entry) => (
                <Card key={entry.key} as="article" className="annotation-summary-card">
                  <div className="annotation-summary-card-top">
                    <div className="stack tight">
                      <small className="muted">{entry.label}</small>
                      <strong className="metric">{entry.count}</strong>
                    </div>
                    <ButtonLink
                      size="sm"
                      variant="secondary"
                      className="annotation-summary-action-link"
                      to={buildAnnotationWorkspacePath(dataset.id, entry.key, entry.firstItemId, {
                        versionId: selectedVersionId
                      })}
                    >
                      {t('Open Queue')}
                    </ButtonLink>
                  </div>
                  <small className="muted">{entry.description}</small>
                  {entry.items.length > 0 ? (
                    <ul className="workspace-record-list compact">
                      {entry.items.map((item) => {
                        const itemAnnotation = annotationByItemId.get(item.id) ?? null;
                        const itemFilename = resolveItemFilename(item);
                        return (
                          <Panel key={item.id} as="li" className="workspace-record-item compact" tone="soft">
                            <div className="row between gap wrap">
                              <strong>{itemFilename}</strong>
                              <StatusTag status={itemAnnotation?.status ?? 'draft'}>
                                {t(itemAnnotation?.status ?? 'unannotated')}
                              </StatusTag>
                            </div>
                            {itemAnnotation?.latest_review ? (
                              <div className="row gap wrap">
                                <Badge tone="neutral">
                                  {t('Latest Review')}: {t(itemAnnotation.latest_review.status)}
                                </Badge>
                                {itemAnnotation.latest_review.review_reason_code ? (
                                  <Badge tone="warning">
                                    {t(itemAnnotation.latest_review.review_reason_code)}
                                  </Badge>
                                ) : null}
                              </div>
                            ) : null}
                            {itemAnnotation?.latest_review?.review_comment ? (
                              <small className="muted">{itemAnnotation.latest_review.review_comment}</small>
                            ) : null}
                            <ButtonLink
                              size="sm"
                              variant="ghost"
                              to={buildAnnotationWorkspacePath(dataset.id, entry.key, item.id, {
                                versionId: selectedVersionId
                              })}
                            >
                              {t('Open Item')}
                            </ButtonLink>
                          </Panel>
                        );
                      })}
                    </ul>
                  ) : (
                    <small className="muted">{t('No items in this queue right now.')}</small>
                  )}
                </Card>
              ))}
            </div>
          </Card>

          <AttachmentUploader
            title={t('Step 1. Dataset File Upload')}
            items={attachments}
            onUpload={uploadDatasetFile}
            onUploadFiles={uploadDatasetFiles}
            contentUrlBuilder={api.attachmentContentUrl}
            onDelete={deleteAttachment}
            emptyDescription={t('Upload images or archives. Files stay visible for this dataset context.')}
            uploadButtonLabel={t('Upload Dataset File')}
            disabled={busy}
            headerActions={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void refreshAttachmentSection();
                }}
                disabled={busy || sectionRefreshing === 'attachments'}
              >
                {sectionRefreshing === 'attachments' ? t('Refreshing...') : t('Refresh')}
              </Button>
            }
          />

          <Card as="section">
            <WorkspaceSectionHeader
              title={t('Dataset Items')}
              actions={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void refreshItemSection();
                  }}
                  disabled={busy || sectionRefreshing === 'items'}
                >
                  {sectionRefreshing === 'items' ? t('Refreshing...') : t('Refresh')}
                </Button>
              }
            />
            <small className="muted">
              {t('Ready files: {count}', { count: readyCount })} · {t('Filtered samples')}: {filteredSampleItems.length}
            </small>
            {items.length === 0 ? (
              <StateBlock variant="empty" title={t('No Items')} description={t('Upload dataset files to generate items.')} />
            ) : (
              <div className="stack">
                <DatasetItemBrowser
                  t={t}
                  busy={busy}
                  filteredItems={filteredSampleItems}
                  selectedItemIdSet={selectedSampleItemIdSet}
                  allFilteredItemsSelected={allFilteredItemsSelected}
                  selectedCount={selectedSampleItemIds.length}
                  viewMode={sampleViewMode}
                  searchText={sampleSearchText}
                  splitFilter={sampleSplitFilter}
                  statusFilter={sampleStatusFilter}
                  queueFilter={sampleQueueFilter}
                  reviewReasonFilter={sampleReviewReasonFilter}
                  metadataFilter={sampleMetadataFilter}
                  savedViewNameDraft={savedSampleViewNameDraft}
                  selectedSavedViewId={selectedSavedSampleViewId}
                  savedViews={savedSampleViews.map((view) => ({ id: view.id, name: view.name }))}
                  openFilteredQueuePath={
                    annotationWorkspaceFromSampleBrowserPath ||
                    buildAnnotationWorkspacePath(dataset.id, sampleQueueFilter, undefined, {
                      versionId: selectedVersionId
                    })
                  }
                  batchActionBar={
                    <BulkActionBar
                      t={t}
                      busy={busy}
                      selectedCount={selectedSampleItemIds.length}
                      batchSplit={batchSplit}
                      batchStatus={batchStatus}
                      batchTagsText={batchTagsText}
                      onBatchSplitChange={setBatchSplit}
                      onBatchStatusChange={setBatchStatus}
                      onBatchTagsTextChange={setBatchTagsText}
                      onApplyBatchUpdates={() => {
                        void applyBatchItemUpdates();
                      }}
                    />
                  }
                  onSearchTextChange={setSampleSearchText}
                  onSplitFilterChange={setSampleSplitFilter}
                  onStatusFilterChange={setSampleStatusFilter}
                  onQueueFilterChange={(value) => setSampleQueueFilter(value as AnnotationQueueFilter)}
                  onReviewReasonFilterChange={setSampleReviewReasonFilter}
                  onMetadataFilterChange={setSampleMetadataFilter}
                  onSavedViewNameDraftChange={setSavedSampleViewNameDraft}
                  onSelectedSavedViewChange={applySavedSampleView}
                  onSaveCurrentView={saveCurrentSampleView}
                  onDeleteSavedView={deleteSavedSampleView}
                  onSelectAllFiltered={selectAllFilteredItems}
                  onClearSelected={clearSelectedSampleItems}
                  onClearFilters={clearSampleFilters}
                  onViewModeChange={setSampleViewMode}
                  onToggleSelection={toggleSampleItemSelection}
                  onEditItem={selectItemForEditing}
                  resolveItemFilename={resolveItemFilename}
                  resolvePreviewUrl={resolveItemPreviewUrl}
                  resolveAnnotationStatus={resolveAnnotationStatus}
                />

                <AdvancedSection
                  title={t('Item Editor')}
                  description={t('Collapsed by default for progressive disclosure.')}
                >
                  <Panel as="section" className="stack tight" tone="soft">
                    <label>
                      {t('Selected Item')}
                      <Select
                        value={selectedItemId}
                        onChange={(event) => {
                          const nextId = event.target.value;
                          const next = items.find((item) => item.id === nextId);
                          if (!next) {
                            return;
                          }
                          selectItemForEditing(next);
                        }}
                      >
                        {items.map((item) => (
                          <option key={item.id} value={item.id}>
                            {resolveItemFilename(item) + ' · ' + t(item.split)}
                          </option>
                        ))}
                      </Select>
                    </label>
                    {selectedItem ? (
                      <small className="muted">
                        {t('Current status')}: {t(selectedItem.status)}
                      </small>
                    ) : null}
                    <div className="three-col">
                      <label>
                        {t('Item Split')}
                        <Select
                          value={itemSplit}
                          onChange={(event) =>
                            setItemSplit(event.target.value as 'train' | 'val' | 'test' | 'unassigned')
                          }
                        >
                          <option value="unassigned">{t('unassigned')}</option>
                          <option value="train">{t('train')}</option>
                          <option value="val">{t('val')}</option>
                          <option value="test">{t('test')}</option>
                        </Select>
                      </label>
                      <label>
                        {t('Item Status')}
                        <Select
                          value={itemStatus}
                          onChange={(event) =>
                            setItemStatus(event.target.value as 'uploading' | 'processing' | 'ready' | 'error')
                          }
                        >
                          <option value="ready">{t('ready')}</option>
                          <option value="processing">{t('processing')}</option>
                          <option value="uploading">{t('uploading')}</option>
                          <option value="error">{t('error')}</option>
                        </Select>
                      </label>
                    </div>
                    <label>
                      {t('Metadata (key=value per line, optional)')}
                      <Textarea
                        value={itemMetadataText}
                        onChange={(event) => setItemMetadataText(event.target.value)}
                        placeholder={t('for example: source=import_reference')}
                        rows={3}
                      />
                    </label>
                    <Button onClick={saveItemUpdates} disabled={busy || !selectedItemId}>
                      {t('Save Item Updates')}
                    </Button>
                    <small className="muted">
                      {selectedItem && Object.keys(selectedItem.metadata).length > 0
                        ? t('Current metadata: {metadata}', { metadata: metadataToText(selectedItem.metadata) })
                        : t('No metadata')}
                    </small>
                  </Panel>
                </AdvancedSection>
              </div>
            )}
          </Card>
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
          <Card as="section" className="workspace-inspector-card">
            <WorkspaceSectionHeader
              title={t('Current status')}
              description={t('Inspect dataset files, annotation readiness, and version snapshots in one place.')}
            />
            <Panel as="section" className="stack tight" tone="soft">
              <div className="row between gap wrap align-center">
                <strong>{dataset.name}</strong>
                <StatusTag status={dataset.status}>{t(dataset.status)}</StatusTag>
              </div>
              <div className="row gap wrap">
                <Badge tone="neutral">{t('Task Type')}: {t(dataset.task_type)}</Badge>
                <Badge tone="neutral">{t('Classes')}: {dataset.label_schema.classes.length}</Badge>
                <Badge tone="info">{t('Ready files')}: {readyCount}</Badge>
              </div>
            </Panel>
            <div className="workspace-keyline-list">
              <div className="workspace-keyline-item">
                <span>{t('Last updated')}</span>
                <small>{formatCompactTimestamp(dataset.updated_at, t('n/a'))}</small>
              </div>
              <div className="workspace-keyline-item">
                <span>{t('Visible samples')}</span>
                <strong>{filteredSampleItems.length}</strong>
              </div>
              <div className="workspace-keyline-item">
                <span>{t('Queue focus')}</span>
                <strong>{sampleQueueFilter === 'all' ? t('All items') : sampleQueueFilter === 'needs_work' ? t('Needs Work') : t(sampleQueueFilter)}</strong>
              </div>
            </div>
            <small className="muted">
              {selectedVersion
                ? t('Selected version split') +
                  `: train ${selectedVersion.split_summary.train} / val ${selectedVersion.split_summary.val} / test ${selectedVersion.split_summary.test}`
                : t('No explicit dataset version selected. Operations use current dataset context.')}
            </small>
            {dataset.description ? <small className="muted">{dataset.description}</small> : null}
          </Card>

          <DatasetVersionRail
            t={t}
            dataset={dataset}
            versions={versions}
            selectedVersionId={selectedVersionId}
            selectedVersion={selectedVersion}
            selectedVersionLaunchReady={selectedVersionLaunchReady}
            selectedVersionHasTrainSplit={selectedVersionHasTrainSplit}
            selectedVersionHasCoverage={selectedVersionHasCoverage}
            preferredReviewQueueForSelectedVersion={preferredReviewQueueForSelectedVersion}
            busy={busy}
            isRefreshing={sectionRefreshing === 'versions'}
            onRefresh={() => {
              void refreshVersionSection();
            }}
            onSelectVersion={setSelectedVersionId}
            formatCoveragePercent={formatCoveragePercent}
            buildTrainingPath={(versionId) => buildTrainingJobCreatePath(dataset.id, versionId)}
            buildReviewPath={(versionId, queue) =>
              buildAnnotationWorkspacePath(dataset.id, queue, undefined, {
                versionId
              })
            }
            buildJobsPath={(versionId) => buildTrainingJobsPath(dataset.id, versionId)}
            buildInferencePath={(versionId) => buildInferenceValidationPath(dataset.id, versionId)}
          />

          <Card as="section" className="workspace-inspector-card">
            <WorkspaceSectionHeader
              title={t('Dataset Workflow')}
              description={t('Prepare split and snapshot actions without leaving the detail lane.')}
            />
            <div className="workspace-form-grid">
              <label>
                {t('Train Ratio')}
                <Input value={splitTrain} onChange={(event) => setSplitTrain(event.target.value)} />
              </label>
              <label>
                {t('Val Ratio')}
                <Input value={splitVal} onChange={(event) => setSplitVal(event.target.value)} />
              </label>
              <label className="workspace-form-span-2">
                {t('Test Ratio')}
                <Input value={splitTest} onChange={(event) => setSplitTest(event.target.value)} />
              </label>
            </div>
            <Button onClick={runSplit} disabled={busy || items.length === 0} block>
              {t('Apply Split')}
            </Button>
            <label>
              {t('Version Name (optional)')}
              <Input
                value={versionName}
                onChange={(event) => setVersionName(event.target.value)}
                placeholder={t('for example: v2')}
              />
            </label>
            <Button onClick={createVersion} disabled={busy || items.length === 0} block>
              {t('Create Version Snapshot')}
            </Button>
          </Card>

          <Card as="section" className="workspace-inspector-card">
            <WorkspaceSectionHeader
              title={t('Error Pattern Slices')}
              description={t('Quickly focus sample browser and review queue by frequent failure patterns.')}
            />
            {errorPatternSlices.length === 0 ? (
              <small className="muted">{t('No pattern slices detected yet. Keep annotating to accumulate signals.')}</small>
            ) : (
              <ul className="workspace-record-list compact">
                {errorPatternSlices.map((slice) => (
                  <Panel key={slice.id} as="li" className="workspace-record-item compact stack tight" tone="soft">
                    <div className="row between gap wrap align-center">
                      <strong>{slice.label}</strong>
                      <Badge tone={slice.count > 0 ? 'warning' : 'neutral'}>{slice.count}</Badge>
                    </div>
                    <small className="muted">{slice.description}</small>
                    <div className="row gap wrap">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => applyErrorPatternSlice(slice)}
                      >
                        {t('Focus in browser')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          saveSliceAsSampleView({
                            name: slice.label,
                            splitFilter: slice.splitFilter,
                            queueFilter: slice.queueFilter,
                            reviewReasonFilter: slice.reviewReasonFilter,
                            metadataFilter: slice.metadataFilter
                          })
                        }
                      >
                        {t('Save as view')}
                      </Button>
                      <ButtonLink
                        size="sm"
                        variant="ghost"
                        to={buildAnnotationWorkspacePath(dataset.id, slice.queueFilter, undefined, {
                          versionId: selectedVersionId,
                          metadataFilter: slice.metadataFilter
                        })}
                      >
                        {t('Open queue')}
                      </ButtonLink>
                    </div>
                  </Panel>
                ))}
              </ul>
            )}
          </Card>

          <Card as="section" className="workspace-inspector-card">
            <WorkspaceSectionHeader
              title={t('Metadata / Tag Slices')}
              description={t('One-click focus by high-frequency metadata and operational tags.')}
            />
            {metadataSignalSlices.length === 0 ? (
              <small className="muted">
                {t('No metadata slices detected yet. Add metadata/tags in item editing or feedback loops.')}
              </small>
            ) : (
              <ul className="workspace-record-list compact">
                {metadataSignalSlices.map((slice) => (
                  <Panel key={slice.id} as="li" className="workspace-record-item compact stack tight" tone="soft">
                    <div className="row between gap wrap align-center">
                      <strong>{slice.label}</strong>
                      <Badge tone={slice.count > 0 ? 'info' : 'neutral'}>{slice.count}</Badge>
                    </div>
                    <small className="muted">{slice.description}</small>
                    <small className="muted">
                      {t('Filter')}: {slice.metadataFilter}
                    </small>
                    <div className="row gap wrap">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => applyMetadataSignalSlice(slice)}
                      >
                        {t('Focus in browser')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          saveSliceAsSampleView({
                            name: slice.label,
                            splitFilter: 'all',
                            queueFilter: slice.queueFilter,
                            reviewReasonFilter: 'all',
                            metadataFilter: slice.metadataFilter
                          })
                        }
                      >
                        {t('Save as view')}
                      </Button>
                      <ButtonLink
                        size="sm"
                        variant="ghost"
                        to={buildAnnotationWorkspacePath(dataset.id, slice.queueFilter, undefined, {
                          versionId: selectedVersionId,
                          metadataFilter: slice.metadataFilter
                        })}
                      >
                        {t('Open queue')}
                      </ButtonLink>
                    </div>
                  </Panel>
                ))}
              </ul>
            )}
          </Card>

          <AdvancedSection
            title={t('Annotation Import / Export')}
            description={t('Use this section to import or export annotation files in selected format.')}
          >
            <Card as="section">
              <h4>{t('Import Annotations')}</h4>
              <label>
                {t('Format')}
                <Select
                  value={importFormat}
                  onChange={(event) =>
                    setImportFormat(event.target.value as 'yolo' | 'coco' | 'labelme' | 'ocr')
                  }
                >
                  <option value="yolo">{t('yolo')}</option>
                  <option value="coco">{t('coco')}</option>
                  <option value="labelme">{t('labelme')}</option>
                  <option value="ocr">{t('ocr')}</option>
                </Select>
              </label>
              <label>
                {t('Source Attachment')}
                <Select
                  value={importAttachmentId}
                  onChange={(event) => setImportAttachmentId(event.target.value)}
                >
                  {attachments
                    .filter((attachment) => attachment.status === 'ready')
                    .map((attachment) => (
                      <option key={attachment.id} value={attachment.id}>
                        {attachment.filename}
                      </option>
                    ))}
                </Select>
              </label>
              <Button onClick={importAnnotations} disabled={busy || !importAttachmentId}>
                {t('Run Import')}
              </Button>
            </Card>

            <Card as="section">
              <h4>{t('Export Annotations')}</h4>
              <label>
                {t('Format')}
                <Select
                  value={exportFormat}
                  onChange={(event) =>
                    setExportFormat(event.target.value as 'yolo' | 'coco' | 'labelme' | 'ocr')
                  }
                >
                  <option value="yolo">{t('yolo')}</option>
                  <option value="coco">{t('coco')}</option>
                  <option value="labelme">{t('labelme')}</option>
                  <option value="ocr">{t('ocr')}</option>
                </Select>
              </label>
              <Button onClick={exportAnnotations} disabled={busy}>
                {t('Run Export')}
              </Button>
            </Card>

            <Card as="section">
              <h4>{t('Reference Dataset Items')}</h4>
              <small className="muted">
                {t('Create metadata-only items when file binary is not uploaded yet.')}
              </small>
              <label>
                {t('Reference Filename')}
                <Input
                  value={referenceFilename}
                  onChange={(event) => setReferenceFilename(event.target.value)}
                  placeholder={t('for example: camera-A/frame-001.jpg')}
                />
              </label>
              <label>
                {t('Item Split')}
                <Select
                  value={referenceSplit}
                  onChange={(event) =>
                    setReferenceSplit(event.target.value as 'train' | 'val' | 'test' | 'unassigned')
                  }
                >
                  <option value="unassigned">{t('unassigned')}</option>
                  <option value="train">{t('train')}</option>
                  <option value="val">{t('val')}</option>
                  <option value="test">{t('test')}</option>
                </Select>
              </label>
              <label>
                {t('Item Status')}
                <Select
                  value={referenceStatus}
                  onChange={(event) =>
                    setReferenceStatus(event.target.value as 'uploading' | 'processing' | 'ready' | 'error')
                  }
                >
                  <option value="ready">{t('ready')}</option>
                  <option value="processing">{t('processing')}</option>
                  <option value="uploading">{t('uploading')}</option>
                  <option value="error">{t('error')}</option>
                </Select>
              </label>
              <label>
                {t('Metadata (key=value per line, optional)')}
                <Textarea
                  value={referenceMetadataText}
                  onChange={(event) => setReferenceMetadataText(event.target.value)}
                  placeholder={t('for example: source=import_reference')}
                  rows={3}
                />
              </label>
              <Button onClick={createReferenceItem} disabled={busy}>
                {t('Create Reference Item')}
              </Button>
            </Card>
          </AdvancedSection>

          </div>
        }
      />
    </WorkspacePage>
  );
}
