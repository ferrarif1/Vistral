import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import {
  DetailDrawer,
  DetailList,
  FilterToolbar,
  InlineAlert,
  PageHeader,
  SectionCard
} from '../components/ui/ConsolePage';
import { Input, Select, Textarea } from '../components/ui/Field';
import { WorkspacePage, WorkspaceWorkbench } from '../components/ui/WorkspacePage';
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

const buildTrainingJobsPath = (datasetId: string, versionId?: string): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('dataset', datasetId);
  if (versionId) {
    searchParams.set('version', versionId);
  }
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

const buildClosureWizardPath = (datasetId: string, versionId?: string): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('dataset', datasetId);
  if (versionId) {
    searchParams.set('version', versionId);
  }
  return `/workflow/closure?${searchParams.toString()}`;
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
  const navigate = useNavigate();
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
  const [itemDrawerOpen, setItemDrawerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sectionRefreshing, setSectionRefreshing] = useState<'attachments' | 'items' | 'versions' | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const detailSignatureRef = useRef('');
  const uploadSectionRef = useRef<HTMLDivElement | null>(null);
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
  const launchReadyVersions = useMemo(
    () =>
      versions.filter(
        (version) =>
          (version.split_summary.train ?? 0) > 0 && (version.annotation_coverage ?? 0) > 0
      ),
    [versions]
  );
  const latestLaunchReadyVersion = launchReadyVersions[0] ?? null;
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
    setItemDrawerOpen(true);
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
      setItemDrawerOpen(false);
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

  if (!datasetId) {
    return (
      <WorkspacePage>
        <PageHeader
          eyebrow={t('Dataset Lane')}
          title={t('Dataset Detail')}
          description={t('Inspect dataset files, annotation readiness, and version snapshots in one place.')}
          secondaryActions={
            <ButtonLink to="/datasets" variant="ghost" size="sm">
              {t('Back to Datasets')}
            </ButtonLink>
          }
        />
        <StateBlock
          variant="error"
          title={t('Missing Dataset ID')}
          description={t('Open from dataset list page.')}
        />
      </WorkspacePage>
    );
  }

  if (loading) {
    return (
      <WorkspacePage>
        <PageHeader
          eyebrow={t('Dataset Lane')}
          title={t('Dataset Detail')}
          description={t('Inspect dataset files, annotation readiness, and version snapshots in one place.')}
          secondaryActions={
            <ButtonLink to="/datasets" variant="ghost" size="sm">
              {t('Back to Datasets')}
            </ButtonLink>
          }
        />
        <StateBlock
          variant="loading"
          title={t('Loading Dataset')}
          description={t('Loading dataset detail.')}
        />
      </WorkspacePage>
    );
  }

  if (!dataset) {
    return (
      <WorkspacePage>
        <PageHeader
          eyebrow={t('Dataset Lane')}
          title={t('Dataset Detail')}
          description={t('Inspect dataset files, annotation readiness, and version snapshots in one place.')}
          secondaryActions={
            <ButtonLink to="/datasets" variant="ghost" size="sm">
              {t('Back to Datasets')}
            </ButtonLink>
          }
        />
        <StateBlock
          variant="error"
          title={t('Dataset Not Found')}
          description={t('The requested dataset is unavailable.')}
        />
      </WorkspacePage>
    );
  }

  const focusUploadSection = () => {
    uploadSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const focusWorkflowPanel = () => {
    document.getElementById('dataset-workflow')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const preferredTrainingVersion = selectedVersion ?? versions[0] ?? null;
  const preferredLaunchReadyVersion =
    selectedVersionLaunchReady && selectedVersion ? selectedVersion : latestLaunchReadyVersion;
  const closureWizardPath = buildClosureWizardPath(
    dataset.id,
    preferredLaunchReadyVersion?.id ?? preferredTrainingVersion?.id
  );
  const inferenceValidationPath = buildInferenceValidationPath(
    dataset.id,
    preferredLaunchReadyVersion?.id ?? preferredTrainingVersion?.id ?? undefined
  );
  const nextDatasetAction =
    readyCount === 0
      ? {
          tone: 'warning' as const,
          title: t('Complete upload first'),
          description: t('Upload one ready file first.'),
          label: t('Jump to Upload Section'),
          onClick: focusUploadSection
        }
      : annotations.length === 0
        ? {
          tone: 'info' as const,
          title: t('Start annotation workflow'),
          description: t('Open the annotation workspace and review samples.'),
          label: t('Open Annotation Workspace'),
          to: prioritizedAnnotationWorkspacePath || `/datasets/${dataset.id}/annotate`
        }
      : versions.length === 0
        ? {
          tone: 'info' as const,
          title: t('Create first version snapshot'),
          description: t('Lock the current state as a version.'),
          label: t('Open Version Controls'),
          onClick: focusWorkflowPanel
        }
      : {
          tone: 'success' as const,
          title: t('Dataset is ready for downstream tasks'),
          description: t('Continue to training or validation.'),
          label: t('Open Training Jobs'),
          to: preferredTrainingVersion
            ? buildTrainingJobsPath(dataset.id, preferredTrainingVersion.id)
            : '/training/jobs'
        };
  const handleNextDatasetAction = () => {
    if ('to' in nextDatasetAction && nextDatasetAction.to) {
      navigate(nextDatasetAction.to);
      return;
    }

    nextDatasetAction.onClick?.();
  };

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Dataset Lane')}
        title={dataset.name}
        description={t('Check readiness first, then open samples or versions.')}
        meta={
          <div className="row gap wrap align-center">
            <StatusTag status={dataset.status}>{t(dataset.status)}</StatusTag>
            <Badge tone="neutral">{t('Attachments')}: {attachments.length}</Badge>
            <Badge tone="neutral">{t('Versions')}: {versions.length}</Badge>
          </div>
        }
        primaryAction={{
          label: nextDatasetAction.label,
          onClick: handleNextDatasetAction
        }}
        secondaryActions={
          <>
            <ButtonLink to="/datasets" variant="ghost" size="sm">
              {t('Back to Datasets')}
            </ButtonLink>
          </>
        }
      />

      {feedback ? (
        <InlineAlert
          tone={feedback.variant === 'success' ? 'success' : 'danger'}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}
      <WorkspaceWorkbench
        toolbar={
          <FilterToolbar
            filters={
              <label className="stack tight">
                <small className="muted">{t('Version')}</small>
                <Select
                  value={selectedVersionId}
                  onChange={(event) => setSelectedVersionId(event.target.value)}
                >
                  {versions.length === 0 ? <option value="">{t('No Versions')}</option> : null}
                  {versions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.version_name}
                    </option>
                  ))}
                </Select>
              </label>
            }
            actions={
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
            }
          />
        }
        main={
          <div className="workspace-main-stack">
            <SectionCard
              title={t('Current samples')}
              description={t('Search, narrow, and open the focused queue.')}
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
            >
              <small className="muted">
                {t('Ready files: {count}', { count: readyCount })} · {t('Visible samples')}: {filteredSampleItems.length}
              </small>
              {items.length === 0 ? (
                  <StateBlock
                    variant="empty"
                    title={t('No Items')}
                    description={t('Upload files first.')}
                  extra={
                    <Button type="button" variant="secondary" size="sm" onClick={focusUploadSection}>
                      {t('Jump to Files')}
                    </Button>
                  }
                />
              ) : (
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
              )}
            </SectionCard>

            <SectionCard
              title={t('Versions')}
              description={t('Choose one snapshot for training, review, or validation.')}
            >
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
            </SectionCard>

            <div ref={uploadSectionRef}>
              <AttachmentUploader
                title={t('Files')}
                items={attachments}
                onUpload={uploadDatasetFile}
                onUploadFiles={uploadDatasetFiles}
                contentUrlBuilder={api.attachmentContentUrl}
                onDelete={deleteAttachment}
                emptyDescription={t('Upload files. They stay visible here.')}
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
            </div>

            <div id="dataset-workflow">
              <AdvancedSection
                title={t('Advanced')}
                description={t('Split, import/export, and reference items stay collapsed.')}
              >
                <div className="stack">
                  <details className="workspace-details">
                    <summary>
                      <span>{t('Split and version')}</span>
                    </summary>
                    <div className="workspace-disclosure-content stack">
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
                    </div>
                  </details>

                  <details className="workspace-details">
                    <summary>
                      <span>{t('Annotation Import / Export')}</span>
                    </summary>
                    <div className="workspace-disclosure-content stack">
                      <label>
                        {t('Import format')}
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
                      <label>
                        {t('Export format')}
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
                    </div>
                  </details>

                  <details className="workspace-details">
                    <summary>
                      <span>{t('Reference items')}</span>
                    </summary>
                    <div className="workspace-disclosure-content stack">
                      <small className="muted">
                        {t('Create metadata-only items when needed.')}
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
                    </div>
                  </details>
                </div>
              </AdvancedSection>
            </div>
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <SectionCard
              title={t('Next step')}
              description={t('Readiness and next move.')}
            >
              <DetailList
                items={[
                  { label: t('Recommended next step'), value: nextDatasetAction.title },
                  {
                    label: t('Queue Focus'),
                    value:
                      sampleQueueFilter === 'all'
                        ? t('All items')
                        : sampleQueueFilter === 'needs_work'
                          ? t('Needs Work')
                          : t(sampleQueueFilter)
                  }
                ]}
              />
              <div className="stack tight">
                {dataset.description ? <small className="muted">{dataset.description}</small> : null}
                <small className="muted">{nextDatasetAction.description}</small>
              </div>
              <div className="row gap wrap">
                <Button type="button" size="sm" onClick={handleNextDatasetAction}>
                  {nextDatasetAction.label}
                </Button>
                <ButtonLink
                  to={prioritizedAnnotationWorkspacePath || `/datasets/${dataset.id}/annotate`}
                  variant="ghost"
                  size="sm"
                >
                  {t('Open Annotation Workspace')}
                </ButtonLink>
                <ButtonLink to={closureWizardPath} variant="ghost" size="sm">
                  {t('Training Closure Wizard')}
                </ButtonLink>
              </div>
            </SectionCard>

            <SectionCard
              title={t('Closure snapshot')}
              description={t('Keep the dataset-to-training handoff visible from this page.')}
            >
              <DetailList
                items={[
                  { label: t('Ready files'), value: readyCount },
                  { label: t('Needs work'), value: annotationSummary.needs_work },
                  { label: t('Approved'), value: annotationSummary.approved },
                  {
                    label: t('Launch-ready versions'),
                    value: launchReadyVersions.length
                  },
                  {
                    label: t('Preferred training version'),
                    value: preferredLaunchReadyVersion?.id ?? preferredTrainingVersion?.id ?? '-'
                  }
                ]}
              />
              <div className="stack tight">
                <small className="muted">
                  {preferredLaunchReadyVersion
                    ? t(
                        'A launch-ready version is available. You can move directly into training, closure verification, or inference validation.'
                      )
                    : t(
                        'No launch-ready version yet. Finish annotation and create a version snapshot with train split plus coverage first.'
                      )}
                </small>
              </div>
              <div className="row gap wrap">
                <ButtonLink
                  to={
                    preferredLaunchReadyVersion
                      ? buildTrainingJobCreatePath(dataset.id, preferredLaunchReadyVersion.id)
                      : buildTrainingJobsPath(dataset.id, preferredTrainingVersion?.id)
                  }
                  variant="secondary"
                  size="sm"
                >
                  {preferredLaunchReadyVersion ? t('Create Training Job') : t('Open Training Jobs')}
                </ButtonLink>
                <ButtonLink to={closureWizardPath} variant="ghost" size="sm">
                  {t('Open Closure Wizard')}
                </ButtonLink>
                <ButtonLink to={inferenceValidationPath} variant="ghost" size="sm">
                  {t('Validate Inference')}
                </ButtonLink>
              </div>
            </SectionCard>
          </div>
        }
      />

      <DetailDrawer
        open={itemDrawerOpen}
        onClose={() => setItemDrawerOpen(false)}
        title={selectedItem ? resolveItemFilename(selectedItem) : t('Edit Item')}
        description={
          selectedItem
            ? t('Update split, status, and metadata for the selected sample.')
            : t('Choose a sample to edit.')
        }
        actions={
          <div className="row gap wrap">
            <Button type="button" variant="ghost" size="sm" onClick={() => setItemDrawerOpen(false)}>
              {t('Close')}
            </Button>
            <Button onClick={saveItemUpdates} disabled={busy || !selectedItemId} size="sm">
              {t('Save Item Updates')}
            </Button>
          </div>
        }
      >
        {selectedItem ? (
          <div className="stack">
            <DetailList
              items={[
                { label: t('Filename'), value: resolveItemFilename(selectedItem) },
                { label: t('Current status'), value: t(selectedItem.status) },
                { label: t('Split'), value: t(selectedItem.split) },
                { label: t('Metadata keys'), value: Object.keys(selectedItem.metadata).length }
              ]}
            />
            <label>
              {t('Item Split')}
              <Select
                value={itemSplit}
                onChange={(event) => setItemSplit(event.target.value as 'train' | 'val' | 'test' | 'unassigned')}
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
                onChange={(event) => setItemStatus(event.target.value as 'uploading' | 'processing' | 'ready' | 'error')}
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
                value={itemMetadataText}
                onChange={(event) => setItemMetadataText(event.target.value)}
                placeholder={t('for example: source=import_reference')}
                rows={4}
              />
            </label>
            <small className="muted">
              {Object.keys(selectedItem.metadata).length > 0
                ? t('Current metadata: {metadata}', { metadata: metadataToText(selectedItem.metadata) })
                : t('No metadata')}
            </small>
          </div>
        ) : (
          <StateBlock
            variant="empty"
            title={t('No item selected')}
            description={t('Pick a sample from the browser to edit it here.')}
          />
        )}
      </DetailDrawer>
    </WorkspacePage>
  );
}
