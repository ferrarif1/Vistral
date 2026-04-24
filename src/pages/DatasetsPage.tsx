import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import type {
  AnnotationWithReview,
  DatasetItemRecord,
  DatasetRecord,
  DatasetVersionRecord,
  FileAttachment
} from '../../shared/domain';
import WorkspaceNextStepCard from '../components/onboarding/WorkspaceNextStepCard';
import TrainingLaunchContextPills from '../components/onboarding/TrainingLaunchContextPills';
import StateBlock from '../components/StateBlock';
import VirtualList from '../components/VirtualList';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { DetailList, InlineAlert, PageHeader } from '../components/ui/ConsolePage';
import { Input, Select, Textarea } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import { summarizeAnnotationQueues, type AnnotationQueueFilter } from '../features/annotationQueue';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';

const taskTypeOptions = ['ocr', 'detection', 'classification', 'segmentation', 'obb'] as const;
const datasetStatusOptions = ['draft', 'ready', 'archived'] as const;
const datasetVirtualizationThreshold = 14;
const datasetVirtualRowHeight = 176;
const datasetVirtualViewportHeight = 620;
type LoadMode = 'initial' | 'manual';
type LaunchContext = {
  taskType?: string | null;
  framework?: string | null;
  executionTarget?: string | null;
  workerId?: string | null;
  returnTo?: string | null;
};

const formatTimestamp = (iso: string): string => formatCompactTimestamp(iso);

const getClassPreview = (classes: string[], limit = 2) => ({
  visible: classes.slice(0, limit),
  hiddenCount: Math.max(0, classes.length - limit)
});

const buildDatasetSignature = (items: DatasetRecord[]): string =>
  JSON.stringify(
    [...items]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => ({
        id: item.id,
        name: item.name,
        task_type: item.task_type,
        status: item.status,
        updated_at: item.updated_at,
        class_count: item.label_schema.classes.length
      }))
  );

const appendTrainingLaunchContext = (
  searchParams: URLSearchParams,
  launchContext?: LaunchContext
) => {
  if (!launchContext) {
    return;
  }
  if (launchContext.taskType?.trim() && !searchParams.has('task_type')) {
    searchParams.set('task_type', launchContext.taskType.trim());
  }
  if (launchContext.framework?.trim() && !searchParams.has('framework')) {
    searchParams.set('framework', launchContext.framework.trim());
  }
  if (
    launchContext.executionTarget?.trim() &&
    launchContext.executionTarget.trim() !== 'auto' &&
    !searchParams.has('execution_target')
  ) {
    searchParams.set('execution_target', launchContext.executionTarget.trim());
  }
  if (launchContext.workerId?.trim() && !searchParams.has('worker')) {
    searchParams.set('worker', launchContext.workerId.trim());
  }
  const returnTo = launchContext.returnTo?.trim() ?? '';
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

const buildDatasetDetailPath = (
  datasetId: string,
  options?: {
    versionId?: string;
    focus?: string;
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

const buildAnnotationWorkspacePath = (
  datasetId: string,
  queue: AnnotationQueueFilter,
  versionId?: string,
  launchContext?: LaunchContext
): string => {
  const searchParams = new URLSearchParams();
  if (queue !== 'all') {
    searchParams.set('queue', queue);
  }
  if (versionId?.trim()) {
    searchParams.set('version', versionId.trim());
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  const query = searchParams.toString();
  return query ? `/datasets/${datasetId}/annotate?${query}` : `/datasets/${datasetId}/annotate`;
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

const buildInferenceValidationPath = (
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

type SelectedDatasetSummary = {
  attachments: FileAttachment[];
  items: DatasetItemRecord[];
  versions: DatasetVersionRecord[];
  annotations: AnnotationWithReview[];
};

type DatasetInventoryGuidanceAction = {
  label: string;
  to?: string;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
};

type DatasetInventoryGuidanceState = {
  current: number;
  total: number;
  title: string;
  detail: string;
  badgeTone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  badgeLabel: string;
  actions: DatasetInventoryGuidanceAction[];
};

export default function DatasetsPage() {
  const { t } = useI18n();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const requestedReturnTo = sanitizeReturnToPath(searchParams.get('return_to'));
  const currentTaskPath = useMemo(
    () => `${location.pathname}${location.search || ''}`,
    [location.pathname, location.search]
  );
  const outboundReturnTo = requestedReturnTo ?? currentTaskPath;
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [taskType, setTaskType] = useState<'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'>('ocr');
  const [classesText, setClassesText] = useState('text_line,table,stamp');
  const [searchText, setSearchText] = useState('');
  const [taskFilter, setTaskFilter] = useState<'all' | 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'draft' | 'ready' | 'archived'>('all');
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [selectedDatasetId, setSelectedDatasetId] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectedDatasetSummary, setSelectedDatasetSummary] = useState<SelectedDatasetSummary | null>(null);
  const [selectedDatasetSummaryLoading, setSelectedDatasetSummaryLoading] = useState(false);
  const [selectedDatasetSummaryError, setSelectedDatasetSummaryError] = useState('');
  const [preferredDatasetFilterHint, setPreferredDatasetFilterHint] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const datasetsSignatureRef = useRef('');
  const createPanelRef = useRef<HTMLDetailsElement | null>(null);
  const datasetNameInputRef = useRef<HTMLInputElement | null>(null);
  const selectedDatasetSummaryRequestRef = useRef(0);
  const focusAppliedRef = useRef('');
  const preferredDatasetFilterRecoveryAppliedRef = useRef(false);
  const deferredSearchText = useDeferredValue(searchText);
  const preferredDatasetId = (searchParams.get('dataset') ?? '').trim();
  const preferredFocus = (searchParams.get('focus') ?? '').trim();
  const preferredTaskType = (searchParams.get('task_type') ?? '').trim();
  const preferredFramework = (searchParams.get('framework') ?? searchParams.get('profile') ?? '').trim().toLowerCase();
  const preferredExecutionTarget = (searchParams.get('execution_target') ?? '').trim().toLowerCase();
  const preferredWorkerId = (searchParams.get('worker') ?? '').trim();
  const launchContextForDatasetsFlow: LaunchContext = {
    taskType: preferredTaskType || null,
    framework: preferredFramework || null,
    executionTarget: preferredExecutionTarget || null,
    workerId: preferredWorkerId || null,
    returnTo: outboundReturnTo
  };
  const hasTrainingLaunchContext = Boolean(
    launchContextForDatasetsFlow.taskType ||
      launchContextForDatasetsFlow.framework ||
      (launchContextForDatasetsFlow.executionTarget &&
        launchContextForDatasetsFlow.executionTarget !== 'auto') ||
      launchContextForDatasetsFlow.workerId
  );

  const load = useCallback(async (mode: LoadMode = 'initial') => {
    if (mode === 'initial') {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    try {
      const result = await api.listDatasets();
      const nextSignature = buildDatasetSignature(result);
      if (datasetsSignatureRef.current !== nextSignature) {
        datasetsSignatureRef.current = nextSignature;
        setDatasets(result);
      }
      setError('');
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      if (mode === 'initial') {
        setLoading(false);
      } else {
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    load('initial').catch(() => {
      // no-op
    });
  }, [load]);

  const sortedDatasets = useMemo(
    () =>
      [...datasets].sort((left, right) => {
        const leftTime = Date.parse(left.updated_at);
        const rightTime = Date.parse(right.updated_at);
        return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
      }),
    [datasets]
  );

  const filteredDatasets = useMemo(() => {
    const query = deferredSearchText.trim().toLowerCase();
    return sortedDatasets.filter((dataset) => {
      if (taskFilter !== 'all' && dataset.task_type !== taskFilter) {
        return false;
      }
      if (statusFilter !== 'all' && dataset.status !== statusFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      const classNames = dataset.label_schema.classes.join(' ').toLowerCase();
      return (
        dataset.name.toLowerCase().includes(query) ||
        dataset.description.toLowerCase().includes(query) ||
        classNames.includes(query)
      );
    });
  }, [deferredSearchText, sortedDatasets, statusFilter, taskFilter]);

  const preferredDatasetRecord = useMemo(
    () => (preferredDatasetId ? sortedDatasets.find((dataset) => dataset.id === preferredDatasetId) ?? null : null),
    [preferredDatasetId, sortedDatasets]
  );
  const preferredDatasetMissing = useMemo(
    () => Boolean(preferredDatasetId && sortedDatasets.length > 0 && !preferredDatasetRecord),
    [preferredDatasetId, preferredDatasetRecord, sortedDatasets.length]
  );
  const clearPreferredDatasetPath = useMemo(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('dataset');
    next.delete('version');
    const query = next.toString();
    return query ? `${location.pathname}?${query}` : location.pathname;
  }, [location.pathname, searchParams]);

  useEffect(() => {
    preferredDatasetFilterRecoveryAppliedRef.current = false;
    setPreferredDatasetFilterHint('');
  }, [preferredDatasetId]);

  useEffect(() => {
    if (preferredDatasetFilterRecoveryAppliedRef.current || !preferredDatasetId || !preferredDatasetRecord) {
      return;
    }
    if (filteredDatasets.some((dataset) => dataset.id === preferredDatasetId)) {
      return;
    }

    preferredDatasetFilterRecoveryAppliedRef.current = true;
    if (taskFilter !== preferredDatasetRecord.task_type) {
      setTaskFilter(preferredDatasetRecord.task_type);
    }
    if (statusFilter !== preferredDatasetRecord.status) {
      setStatusFilter(preferredDatasetRecord.status);
    }
    if (searchText.trim()) {
      setSearchText('');
    }
    setPreferredDatasetFilterHint(
      t('Adjusted filters to show the requested dataset {datasetId}.', { datasetId: preferredDatasetRecord.id })
    );
  }, [
    filteredDatasets,
    preferredDatasetId,
    preferredDatasetRecord,
    searchText,
    statusFilter,
    t,
    taskFilter
  ]);

  useEffect(() => {
    if (!preferredDatasetFilterHint || selectedDatasetId !== preferredDatasetId) {
      return;
    }
    setPreferredDatasetFilterHint('');
  }, [preferredDatasetFilterHint, preferredDatasetId, selectedDatasetId]);

  useEffect(() => {
    if (!filteredDatasets.length) {
      setSelectedDatasetId('');
      return;
    }
    const preferredSelectedDatasetId =
      preferredDatasetId && filteredDatasets.some((dataset) => dataset.id === preferredDatasetId)
        ? preferredDatasetId
        : '';
    if (
      preferredSelectedDatasetId &&
      preferredSelectedDatasetId !== selectedDatasetId
    ) {
      setSelectedDatasetId(preferredSelectedDatasetId);
      return;
    }
    if (!selectedDatasetId || !filteredDatasets.some((dataset) => dataset.id === selectedDatasetId)) {
      setSelectedDatasetId(filteredDatasets[0].id);
    }
  }, [filteredDatasets, preferredDatasetId, selectedDatasetId]);

  const selectedDataset = useMemo(
    () => filteredDatasets.find((dataset) => dataset.id === selectedDatasetId) ?? null,
    [filteredDatasets, selectedDatasetId]
  );

  const shouldVirtualizeDatasets =
    viewMode === 'list' && filteredDatasets.length > datasetVirtualizationThreshold;
  const hasActiveFilters =
    deferredSearchText.trim().length > 0 || taskFilter !== 'all' || statusFilter !== 'all';

  const resetFilters = () => {
    setSearchText('');
    setTaskFilter('all');
    setStatusFilter('all');
  };

  const focusCreatePanel = () => {
    if (createPanelRef.current) {
      createPanelRef.current.open = true;
    }
    createPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => {
      datasetNameInputRef.current?.focus();
    }, 180);
  };

  const refreshSelectedDatasetSummary = useCallback(
    async (datasetId: string, options?: { preserveLoading?: boolean }) => {
      const requestId = selectedDatasetSummaryRequestRef.current + 1;
      selectedDatasetSummaryRequestRef.current = requestId;
      if (!options?.preserveLoading) {
        setSelectedDatasetSummaryLoading(true);
      }
      setSelectedDatasetSummaryError('');
      try {
        const [detail, annotations] = await Promise.all([
          api.getDatasetDetail(datasetId),
          api.listDatasetAnnotations(datasetId)
        ]);
        if (selectedDatasetSummaryRequestRef.current !== requestId) {
          return;
        }
        setSelectedDatasetSummary({
          attachments: detail.attachments,
          items: detail.items,
          versions: detail.versions,
          annotations
        });
      } catch (loadError) {
        if (selectedDatasetSummaryRequestRef.current !== requestId) {
          return;
        }
        setSelectedDatasetSummary(null);
        setSelectedDatasetSummaryError((loadError as Error).message);
      } finally {
        if (selectedDatasetSummaryRequestRef.current === requestId) {
          setSelectedDatasetSummaryLoading(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    if (!selectedDatasetId) {
      setSelectedDatasetSummary(null);
      setSelectedDatasetSummaryError('');
      setSelectedDatasetSummaryLoading(false);
      return;
    }
    refreshSelectedDatasetSummary(selectedDatasetId).catch(() => {
      // no-op
    });
  }, [refreshSelectedDatasetSummary, selectedDatasetId]);

  useEffect(() => {
    if (
      preferredTaskType === 'ocr' ||
      preferredTaskType === 'detection' ||
      preferredTaskType === 'classification' ||
      preferredTaskType === 'segmentation' ||
      preferredTaskType === 'obb'
    ) {
      setTaskType(preferredTaskType);
    }
  }, [preferredTaskType]);

  useEffect(() => {
    if (!preferredFocus) {
      return;
    }
    const focusKey = `${preferredFocus}:${selectedDatasetId}:${preferredTaskType}`;
    if (focusAppliedRef.current === focusKey) {
      return;
    }
    const focusMap: Record<string, () => void> = {
      create: focusCreatePanel
    };
    const action = focusMap[preferredFocus];
    if (!action) {
      return;
    }
    focusAppliedRef.current = focusKey;
    window.setTimeout(() => {
      action();
    }, 120);
  }, [preferredFocus, preferredTaskType, selectedDatasetId]);

  const createDataset = async () => {
    if (!name.trim() || !description.trim()) {
      setError(t('Dataset name and description are required.'));
      return;
    }

    setSubmitting(true);
    setError('');
    setSuccess('');

    try {
      const classes = classesText
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

      const created = await api.createDataset({
        name: name.trim(),
        description: description.trim(),
        task_type: taskType,
        label_schema: {
          classes
        }
      });

      setSuccess(t('Dataset created. Open it from the inventory to continue upload and annotation setup.'));
      setName('');
      setDescription('');
      await load('manual');
      setSelectedDatasetId(created.id);
      await refreshSelectedDatasetSummary(created.id, { preserveLoading: true });
    } catch (createError) {
      setError((createError as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const selectedAnnotationSummary = useMemo(
    () =>
      selectedDatasetSummary
        ? summarizeAnnotationQueues(selectedDatasetSummary.items, selectedDatasetSummary.annotations)
        : null,
    [selectedDatasetSummary]
  );

  const selectedReadyFileCount = useMemo(
    () =>
      selectedDatasetSummary
        ? selectedDatasetSummary.attachments.filter((attachment) => attachment.status === 'ready').length
        : 0,
    [selectedDatasetSummary]
  );

  const selectedLaunchReadyVersions = useMemo(
    () =>
      selectedDatasetSummary?.versions.filter(
        (version) =>
          (version.split_summary.train ?? 0) > 0 && (version.annotation_coverage ?? 0) > 0
      ) ?? [],
    [selectedDatasetSummary]
  );

  const preferredLaunchReadyVersion = selectedLaunchReadyVersions[0] ?? null;
  const preferredTrainingVersion = preferredLaunchReadyVersion ?? selectedDatasetSummary?.versions[0] ?? null;
  const preferredReviewQueue = useMemo<AnnotationQueueFilter>(() => {
    if (!selectedAnnotationSummary) {
      return 'all';
    }
    if (selectedAnnotationSummary.needs_work > 0) {
      return 'needs_work';
    }
    if (selectedAnnotationSummary.rejected > 0) {
      return 'rejected';
    }
    if (selectedAnnotationSummary.in_review > 0) {
      return 'in_review';
    }
    if (selectedAnnotationSummary.approved > 0) {
      return 'approved';
    }
    return 'all';
  }, [selectedAnnotationSummary]);

  const selectedDatasetDetailPath = selectedDataset
    ? buildDatasetDetailPath(selectedDataset.id, { launchContext: launchContextForDatasetsFlow })
    : '/datasets';
  const selectedDatasetUploadPath =
    selectedDataset && preferredTrainingVersion
      ? buildDatasetDetailPath(selectedDataset.id, {
          versionId: preferredTrainingVersion.id,
          focus: 'upload',
          launchContext: launchContextForDatasetsFlow
        })
      : selectedDataset
        ? buildDatasetDetailPath(selectedDataset.id, { focus: 'upload', launchContext: launchContextForDatasetsFlow })
        : '/datasets';
  const selectedDatasetWorkflowPath =
    selectedDataset && preferredTrainingVersion
      ? buildDatasetDetailPath(selectedDataset.id, {
          versionId: preferredTrainingVersion.id,
          focus: 'workflow',
          launchContext: launchContextForDatasetsFlow
        })
      : selectedDataset
        ? buildDatasetDetailPath(selectedDataset.id, { focus: 'workflow', launchContext: launchContextForDatasetsFlow })
        : '/datasets';
  const selectedDatasetAnnotationPath =
    selectedDataset && preferredTrainingVersion
      ? buildAnnotationWorkspacePath(
          selectedDataset.id,
          preferredReviewQueue,
          preferredTrainingVersion.id,
          launchContextForDatasetsFlow
        )
      : selectedDataset
        ? buildAnnotationWorkspacePath(selectedDataset.id, preferredReviewQueue, undefined, launchContextForDatasetsFlow)
        : '/datasets';
  const selectedDatasetTrainingPath =
    selectedDataset && preferredLaunchReadyVersion
      ? buildTrainingJobCreatePath(selectedDataset.id, preferredLaunchReadyVersion.id, launchContextForDatasetsFlow)
      : selectedDatasetWorkflowPath;
  const selectedDatasetValidationPath =
    selectedDataset && preferredTrainingVersion
      ? buildInferenceValidationPath(selectedDataset.id, preferredTrainingVersion.id, launchContextForDatasetsFlow)
      : selectedDataset
        ? buildInferenceValidationPath(selectedDataset.id, undefined, launchContextForDatasetsFlow)
        : '/inference/validate';
  const selectedDatasetClosurePath =
    selectedDataset && preferredTrainingVersion
      ? buildClosureWizardPath(selectedDataset.id, preferredTrainingVersion.id, launchContextForDatasetsFlow)
      : selectedDataset
        ? buildClosureWizardPath(selectedDataset.id, undefined, launchContextForDatasetsFlow)
        : '/workflow/closure';

  const datasetInventoryGuidance = useMemo<DatasetInventoryGuidanceState>(() => {
    if (datasets.length === 0) {
      return {
        current: 1,
        total: 4,
        title: t('Create your first dataset in one place'),
        detail: t('Start with a dataset shell here, then continue into upload, annotation, and versioning with the same context.'),
        badgeTone: 'warning',
        badgeLabel: t('No datasets'),
        actions: [{ label: t('Create Dataset'), onClick: focusCreatePanel }]
      };
    }

    if (!selectedDataset) {
      return {
        current: 1,
        total: 4,
        title: t('Inspect one dataset and keep the next operational step obvious'),
        detail: t('Choose one dataset from the inventory first, then this rail will point to the exact next page.'),
        badgeTone: 'info',
        badgeLabel: t('Pick dataset'),
        actions: []
      };
    }

    if (selectedDatasetSummaryLoading && !selectedDatasetSummary) {
      return {
        current: 1,
        total: 4,
        title: t('Loading selected dataset summary'),
        detail: t('Fetching files, annotation state, and version readiness for the current dataset.'),
        badgeTone: 'info',
        badgeLabel: t('Loading'),
        actions: [{ label: t('Open Dataset Detail'), to: selectedDatasetDetailPath, variant: 'ghost' }]
      };
    }

    if (selectedDatasetSummaryError) {
      return {
        current: 1,
        total: 4,
        title: t('Open the selected dataset and recover context'),
        detail: t('The quick summary could not be loaded from the inventory view. Open dataset detail directly to continue.'),
        badgeTone: 'warning',
        badgeLabel: t('Need detail'),
        actions: [{ label: t('Open Dataset Detail'), to: selectedDatasetDetailPath }]
      };
    }

    if (!selectedDatasetSummary || !selectedAnnotationSummary) {
      return {
        current: 1,
        total: 4,
        title: t('Open the selected dataset and recover context'),
        detail: t('Open dataset detail directly when summary data is not ready yet.'),
        badgeTone: 'warning',
        badgeLabel: t('Need detail'),
        actions: [{ label: t('Open Dataset Detail'), to: selectedDatasetDetailPath }]
      };
    }

    if (selectedReadyFileCount === 0 || selectedDatasetSummary.items.length === 0) {
      return {
        current: 1,
        total: 4,
        title: t('Upload files into the selected dataset'),
        detail: t('No ready files are attached yet. Open the dataset detail page at the upload section first.'),
        badgeTone: 'warning',
        badgeLabel: t('Need upload'),
        actions: [{ label: t('Open upload section'), to: selectedDatasetUploadPath }]
      };
    }

    if (selectedDatasetSummary.annotations.length === 0) {
      return {
        current: 2,
        total: 4,
        title: t('Start annotation from the selected dataset'),
        detail: t('Files are ready, but annotation records have not been created yet. Open the annotation workspace and begin with the current queue.'),
        badgeTone: 'info',
        badgeLabel: t('Need annotation'),
        actions: [
          { label: t('Open annotation queue'), to: selectedDatasetAnnotationPath },
          { label: t('Open Dataset Detail'), to: selectedDatasetDetailPath, variant: 'ghost' }
        ]
      };
    }

    if (
      selectedAnnotationSummary.needs_work > 0 ||
      selectedAnnotationSummary.rejected > 0 ||
      selectedAnnotationSummary.in_review > 0
    ) {
      return {
        current: 2,
        total: 4,
        title: t('Resolve outstanding annotation work'),
        detail: t('This dataset still has samples in needs-work, rejected, or in-review state. Clear those before freezing a reusable version.'),
        badgeTone: 'warning',
        badgeLabel: t('Queue pending'),
        actions: [
          { label: t('Open annotation queue'), to: selectedDatasetAnnotationPath },
          { label: t('Open Dataset Detail'), to: selectedDatasetDetailPath, variant: 'ghost' }
        ]
      };
    }

    if (selectedDatasetSummary.versions.length === 0) {
      return {
        current: 3,
        total: 4,
        title: t('Create the first version snapshot from this dataset'),
        detail: t('The annotation set is stable. Freeze one version so training, validation, and feedback reuse the same snapshot.'),
        badgeTone: 'info',
        badgeLabel: t('Need version'),
        actions: [{ label: t('Open workflow controls'), to: selectedDatasetWorkflowPath }]
      };
    }

    if (!preferredLaunchReadyVersion) {
      return {
        current: 3,
        total: 4,
        title: t('Promote one version to launch-ready from the dataset lane'),
        detail: t('Use dataset detail to apply split and create a version with train coverage before training or validation.'),
        badgeTone: 'info',
        badgeLabel: t('Version check'),
        actions: [
          { label: t('Open workflow controls'), to: selectedDatasetWorkflowPath },
          { label: t('Open annotation queue'), to: selectedDatasetAnnotationPath, variant: 'ghost' }
        ]
      };
    }

    return {
      current: 4,
      total: 4,
      title: t('Launch training from the ready dataset snapshot'),
      detail: t('This dataset already has a launch-ready version. Move straight into training, closure verification, or inference validation.'),
      badgeTone: 'success',
      badgeLabel: t('Ready to launch'),
      actions: [
        { label: t('Open training lane'), to: selectedDatasetTrainingPath },
        { label: t('Validate inference'), to: selectedDatasetValidationPath, variant: 'secondary' },
        { label: t('Open closure wizard'), to: selectedDatasetClosurePath, variant: 'ghost' }
      ]
    };
  }, [
    datasets.length,
    focusCreatePanel,
    preferredLaunchReadyVersion,
    selectedAnnotationSummary,
    selectedDataset,
    selectedDatasetAnnotationPath,
    selectedDatasetClosurePath,
    selectedDatasetDetailPath,
    selectedDatasetSummary,
    selectedDatasetSummaryError,
    selectedDatasetSummaryLoading,
    selectedDatasetTrainingPath,
    selectedDatasetUploadPath,
    selectedDatasetValidationPath,
    selectedDatasetWorkflowPath,
    selectedReadyFileCount,
    t
  ]);

  const refreshAll = useCallback(() => {
    load('manual').catch(() => {
      // no-op
    });
    if (selectedDatasetId) {
      refreshSelectedDatasetSummary(selectedDatasetId, { preserveLoading: true }).catch(() => {
        // no-op
      });
    }
  }, [load, refreshSelectedDatasetSummary, selectedDatasetId]);

  const renderDatasetRecord = (dataset: DatasetRecord, as: 'div' | 'li' = 'li') => {
    const classPreview = getClassPreview(dataset.label_schema.classes);
    const selected = selectedDatasetId === dataset.id;

    return (
      <Panel
        as={as}
        key={dataset.id}
        className={`workspace-record-item dataset-inventory-record${as === 'div' ? ' virtualized' : ''}${
          selected ? ' selected' : ''
        }`}
        tone={selected ? 'accent' : 'soft'}
      >
        <button
          type="button"
          className="dataset-inventory-record-btn"
          onClick={() => setSelectedDatasetId(dataset.id)}
        >
          <div className="workspace-record-item-top">
            <div className="workspace-record-summary stack tight">
              <strong>{dataset.name}</strong>
              <small className="muted">
                {t(dataset.task_type)} · {t('Last updated')}: {formatTimestamp(dataset.updated_at)}
              </small>
            </div>
            <div className="workspace-record-actions">
              <StatusTag status={dataset.status}>{t(dataset.status)}</StatusTag>
            </div>
          </div>
          <p className="line-clamp-2">{dataset.description}</p>
          <div className="row gap wrap">
            <Badge tone="neutral">{t(dataset.task_type)}</Badge>
            <Badge tone="info">
              {t('Classes')}: {dataset.label_schema.classes.length}
            </Badge>
            {classPreview.visible.map((label) => (
              <Badge key={`${dataset.id}-${label}`} tone="neutral">
                {label}
              </Badge>
            ))}
            {classPreview.hiddenCount > 0 ? <Badge tone="neutral">+{classPreview.hiddenCount}</Badge> : null}
          </div>
        </button>
      </Panel>
    );
  };

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Dataset Workbench')}
        title={t('Datasets')}
        description={t('Browse one dataset at a time.')}
        meta={
          <div className="stack tight">
            <div className="row gap wrap align-center">
              <Badge tone="neutral">{t('Datasets')}: {filteredDatasets.length}</Badge>
              {hasTrainingLaunchContext ? (
                <Badge tone="info">{t('Context linked')}</Badge>
              ) : (
                <Badge tone="neutral">{t('Context open')}</Badge>
              )}
            </div>
            <TrainingLaunchContextPills
              taskType={launchContextForDatasetsFlow.taskType}
              framework={launchContextForDatasetsFlow.framework}
              executionTarget={launchContextForDatasetsFlow.executionTarget}
              workerId={launchContextForDatasetsFlow.workerId}
              t={t}
            />
          </div>
        }
        primaryAction={{
          label: t('Create Dataset'),
          onClick: focusCreatePanel
        }}
        secondaryActions={
          <div className="row gap wrap">
            {requestedReturnTo ? (
              <ButtonLink to={requestedReturnTo} variant="secondary" size="sm">
                {t('Return to current task')}
              </ButtonLink>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={refreshAll}
              disabled={loading || refreshing}
            >
              {loading ? t('Loading') : refreshing ? t('Refreshing...') : t('Refresh')}
            </Button>
          </div>
        }
      />

      {error ? <StateBlock variant="error" title={t('Dataset Action Failed')} description={error} /> : null}
      {success ? <StateBlock variant="success" title={t('Completed')} description={success} /> : null}
      {preferredDatasetFilterHint ? (
        <InlineAlert
          tone="info"
          title={t('Focused on requested dataset')}
          description={preferredDatasetFilterHint}
        />
      ) : null}
      {preferredDatasetMissing ? (
        <InlineAlert
          tone="warning"
          title={t('Requested dataset not found')}
          description={t('The dataset from the incoming link is unavailable. Showing available datasets instead.')}
          actions={
            <ButtonLink to={clearPreferredDatasetPath} variant="ghost" size="sm">
              {t('Clear context')}
            </ButtonLink>
          }
        />
      ) : null}

      <WorkspaceWorkbench
        toolbar={
          <Card as="section" className="workspace-toolbar-card">
            <div className="workspace-toolbar-head">
              <div className="workspace-toolbar-copy">
                <h3>{t('Filters')}</h3>
                <small className="muted">{t('Search and narrow the inventory.')}</small>
              </div>
              <div className="workspace-toolbar-actions">
                <Button
                  type="button"
                  variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setViewMode('list')}
                >
                  {t('List')}
                </Button>
                <Button
                  type="button"
                  variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setViewMode('grid')}
                >
                  {t('Grid')}
                </Button>
                {hasActiveFilters ? (
                  <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
                    {t('Clear filters')}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={refreshAll}
                  disabled={loading || refreshing}
                >
                  {loading ? t('Loading') : refreshing ? t('Refreshing...') : t('Refresh')}
                </Button>
              </div>
            </div>

            <div className="workspace-filter-grid">
              <label className="stack tight">
                <small className="muted">{t('Search')}</small>
                <Input
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                  placeholder={t('Search by name, description, or class')}
                />
              </label>
              <label className="stack tight">
                <small className="muted">{t('Task')}</small>
                <Select
                  value={taskFilter}
                  onChange={(event) =>
                    setTaskFilter(
                      event.target.value as
                        | 'all'
                        | 'ocr'
                        | 'detection'
                        | 'classification'
                        | 'segmentation'
                        | 'obb'
                    )
                  }
                >
                  <option value="all">{t('all')}</option>
                  {taskTypeOptions.map((option) => (
                    <option key={option} value={option}>
                      {t(option)}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="stack tight">
                <small className="muted">{t('Status')}</small>
                <Select
                  value={statusFilter}
                  onChange={(event) =>
                    setStatusFilter(event.target.value as 'all' | 'draft' | 'ready' | 'archived')
                  }
                >
                  <option value="all">{t('all')}</option>
                  {datasetStatusOptions.map((option) => (
                    <option key={option} value={option}>
                      {t(option)}
                    </option>
                  ))}
                </Select>
              </label>
            </div>

            <small className="muted">
              {t('Showing {count} datasets in inventory.', { count: filteredDatasets.length })}
            </small>
          </Card>
        }
        main={
          <div className="workspace-main-stack">
            <Card as="article">
              <WorkspaceSectionHeader
              title={t('Dataset Inventory')}
                description={t('Select one dataset to inspect it.')}
              />

              {loading ? (
                <StateBlock variant="loading" title={t('Loading Datasets')} description={t('Fetching dataset inventory.')} />
              ) : filteredDatasets.length === 0 ? (
                  <StateBlock
                    variant="empty"
                    title={t('No Datasets')}
                    description={
                      hasActiveFilters
                      ? t('No datasets match the current filters.')
                      : t('Create your first dataset to start upload and versioning.')
                    }
                    extra={
                      hasActiveFilters ? (
                        <small className="muted">
                        {t('Clear filters to see the full inventory.')}
                        </small>
                      ) : (
                        <small className="muted">
                        {t('Use the create panel on the right.')}
                        </small>
                      )
                    }
                />
              ) : viewMode === 'grid' ? (
                <div className="dataset-catalog-grid">
                  {filteredDatasets.map((dataset) => renderDatasetRecord(dataset, 'div'))}
                </div>
              ) : shouldVirtualizeDatasets ? (
                <VirtualList
                  items={filteredDatasets}
                  itemHeight={datasetVirtualRowHeight}
                  height={datasetVirtualViewportHeight}
                  itemKey={(dataset) => dataset.id}
                  listClassName="workspace-record-list"
                  rowClassName="workspace-record-row"
                  ariaLabel={t('Dataset Inventory')}
                  renderItem={(dataset) => renderDatasetRecord(dataset, 'div')}
                />
              ) : (
                <ul className="workspace-record-list">
                  {filteredDatasets.map((dataset) => renderDatasetRecord(dataset))}
                </ul>
              )}
            </Card>
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <WorkspaceNextStepCard
              title={t('Dataset handoff')}
              description={t('Keep the selected dataset on one obvious path from upload to versioning and training.')}
              stepLabel={datasetInventoryGuidance.title}
              stepDetail={datasetInventoryGuidance.detail}
              current={datasetInventoryGuidance.current}
              total={datasetInventoryGuidance.total}
              badgeLabel={datasetInventoryGuidance.badgeLabel}
              badgeTone={datasetInventoryGuidance.badgeTone}
              actions={datasetInventoryGuidance.actions.map((action) =>
                action.to ? (
                  <ButtonLink key={`${action.label}:${action.to}`} to={action.to} variant={action.variant ?? 'primary'} size="sm">
                    {action.label}
                  </ButtonLink>
                ) : (
                  <Button key={action.label} type="button" variant={action.variant ?? 'primary'} size="sm" onClick={action.onClick}>
                    {action.label}
                  </Button>
                )
              )}
            />

            <Card as="article" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Selected Dataset')}
                description={t('Current dataset summary.')}
              />

              {!selectedDataset ? (
                <StateBlock
                  variant="empty"
                  title={t('No selection')}
                  description={t('Select a dataset from the inventory.')}
                />
              ) : (
                <>
                  <Panel as="section" tone="soft" className="stack tight">
                    <div className="row between gap wrap align-center">
                      <strong>{selectedDataset.name}</strong>
                      <StatusTag status={selectedDataset.status}>{t(selectedDataset.status)}</StatusTag>
                    </div>
                    <small className="muted">{selectedDataset.description}</small>
                    <div className="row gap wrap">
                      <Badge tone="neutral">{t(selectedDataset.task_type)}</Badge>
                      <Badge tone="info">
                        {t('Classes')}: {selectedDataset.label_schema.classes.length}
                      </Badge>
                    </div>
                    <small className="muted">
                      {t('Last updated')}: {formatTimestamp(selectedDataset.updated_at)}
                    </small>
                  </Panel>
                  {selectedDatasetSummaryLoading && !selectedDatasetSummary ? (
                    <StateBlock
                      variant="loading"
                      title={t('Loading selected dataset summary')}
                      description={t('Fetching files, annotation state, and version readiness for the current dataset.')}
                    />
                  ) : selectedDatasetSummaryError ? (
                    <StateBlock
                      variant="error"
                      title={t('Selected dataset summary unavailable')}
                      description={selectedDatasetSummaryError}
                    />
                  ) : selectedDatasetSummary && selectedAnnotationSummary ? (
                    <>
                      <DetailList
                        items={[
                          { label: t('Ready files'), value: selectedReadyFileCount },
                          { label: t('Items'), value: selectedDatasetSummary.items.length },
                          { label: t('Needs work'), value: selectedAnnotationSummary.needs_work },
                          { label: t('In review'), value: selectedAnnotationSummary.in_review },
                          { label: t('Approved'), value: selectedAnnotationSummary.approved },
                          { label: t('Versions'), value: selectedDatasetSummary.versions.length },
                          { label: t('Launch-ready versions'), value: selectedLaunchReadyVersions.length },
                          {
                            label: t('Preferred version'),
                            value: preferredTrainingVersion?.version_name ?? t('Version pending')
                          }
                        ]}
                      />
                      <div className="workspace-action-cluster">
                        <ButtonLink to={selectedDatasetDetailPath} variant="secondary" size="sm" block>
                          {t('Open Dataset Detail')}
                        </ButtonLink>
                        <ButtonLink to={selectedDatasetAnnotationPath} variant="ghost" size="sm" block>
                          {t('Open annotation queue')}
                        </ButtonLink>
                        <ButtonLink to={selectedDatasetWorkflowPath} variant="ghost" size="sm" block>
                          {t('Open workflow controls')}
                        </ButtonLink>
                        {preferredLaunchReadyVersion ? (
                          <>
                            <ButtonLink to={selectedDatasetTrainingPath} variant="ghost" size="sm" block>
                              {t('Open training lane')}
                            </ButtonLink>
                            <ButtonLink to={selectedDatasetValidationPath} variant="ghost" size="sm" block>
                              {t('Validate inference')}
                            </ButtonLink>
                          </>
                        ) : null}
                      </div>
                    </>
                  ) : null}
                  {!selectedDatasetSummary || !selectedAnnotationSummary ? (
                    <div className="workspace-action-cluster">
                      <ButtonLink to={selectedDatasetDetailPath} variant="secondary" size="sm" block>
                        {t('Open Dataset Detail')}
                      </ButtonLink>
                    </div>
                  ) : null}
                </>
              )}
            </Card>

            <details ref={createPanelRef} className="workspace-disclosure workspace-inspector-card">
              <summary className="row between gap wrap align-center">
                <span>{t('Create Dataset')}</span>
              </summary>
              <div className="workspace-disclosure-content">
                <WorkspaceSectionHeader
                  title={t('Create Dataset')}
                  description={t('Create a new dataset here.')}
                />

                <div className="workspace-form-grid">
                  <label>
                    {t('Name')}
                    <Input ref={datasetNameInputRef} value={name} onChange={(event) => setName(event.target.value)} />
                  </label>
                  <label>
                    {t('Task Type')}
                    <Select
                      value={taskType}
                      onChange={(event) =>
                        setTaskType(
                          event.target.value as 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'
                        )
                      }
                    >
                      {taskTypeOptions.map((option) => (
                        <option key={option} value={option}>
                          {t(option)}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label className="workspace-form-span-2">
                    {t('Description')}
                    <Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} />
                  </label>
                  <label className="workspace-form-span-2">
                    {t('Classes')}
                    <Input
                      value={classesText}
                      onChange={(event) => setClassesText(event.target.value)}
                      placeholder={t('Comma-separated label classes')}
                    />
                  </label>
                </div>

                <Button onClick={createDataset} disabled={submitting} block>
                  {submitting ? t('Creating...') : t('Create Dataset')}
                </Button>
              </div>
            </details>
          </div>
        }
      />
    </WorkspacePage>
  );
}
