import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type {
  DatasetRecord,
  FileAttachment,
  InferenceRunRecord,
  ModelVersionRecord,
  RuntimeConnectivityRecord
} from '../../shared/domain';
import AttachmentUploader from '../components/AttachmentUploader';
import WorkspaceFollowUpHint from '../components/onboarding/WorkspaceFollowUpHint';
import WorkspaceOnboardingCard from '../components/onboarding/WorkspaceOnboardingCard';
import WorkspaceNextStepCard from '../components/onboarding/WorkspaceNextStepCard';
import StateBlock from '../components/StateBlock';
import StepIndicator from '../components/StepIndicator';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { InlineAlert, KPIStatRow, PageHeader } from '../components/ui/ConsolePage';
import { Input, Select } from '../components/ui/Field';
import { Card } from '../components/ui/Surface';
import {
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';
import { detectInferenceRunReality, resolveInferenceRunSource } from '../utils/inferenceSource';
import { bucketRuntimeFallbackReason, runtimeFallbackReasonLabelKey } from '../utils/runtimeFallbackReason';

const backgroundRefreshIntervalMs = 5000;
const PredictionVisualizer = lazy(() => import('../components/PredictionVisualizer'));
const inferenceValidationOnboardingDismissedStorageKey = 'vistral-inference-validation-onboarding-dismissed';

type LoadMode = 'initial' | 'manual' | 'background';

const buildInferenceWorkspaceSignature = (payload: {
  versions: ModelVersionRecord[];
  datasets: DatasetRecord[];
  attachments: FileAttachment[];
  runs: InferenceRunRecord[];
}): string =>
  JSON.stringify({
    versions: [...payload.versions].sort((left, right) => left.id.localeCompare(right.id)),
    datasets: [...payload.datasets].sort((left, right) => left.id.localeCompare(right.id)),
    attachments: [...payload.attachments].sort((left, right) => left.id.localeCompare(right.id)),
    runs: [...payload.runs].sort((left, right) => left.id.localeCompare(right.id))
  });

const buildScopedAnnotationPath = (
  datasetId: string,
  queue: 'all' | 'needs_work' | 'in_review' | 'rejected' | 'approved',
  versionId?: string,
  options?: {
    metadataFilter?: string;
  }
): string => {
  const searchParams = new URLSearchParams();
  if (queue !== 'all') {
    searchParams.set('queue', queue);
  }
  if (versionId?.trim()) {
    searchParams.set('version', versionId.trim());
  }
  const normalizedMetadataFilter = options?.metadataFilter?.trim() ?? '';
  if (normalizedMetadataFilter) {
    searchParams.set('meta', normalizedMetadataFilter);
  }
  const query = searchParams.toString();
  return query ? `/datasets/${datasetId}/annotate?${query}` : `/datasets/${datasetId}/annotate`;
};

export default function InferenceValidationPage() {
  const { t } = useI18n();
  const formatFallbackReasonLabel = useCallback(
    (reason: string | null | undefined): string => t(runtimeFallbackReasonLabelKey(bucketRuntimeFallbackReason(reason))),
    [t]
  );
  const [searchParams] = useSearchParams();
  const steps = useMemo(() => [t('Input'), t('Run'), t('Feedback')], [t]);
  const [versions, setVersions] = useState<ModelVersionRecord[]>([]);
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [runs, setRuns] = useState<InferenceRunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [selectedRunDetail, setSelectedRunDetail] = useState<InferenceRunRecord | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [selectedDatasetId, setSelectedDatasetId] = useState('');
  const [selectedAttachmentId, setSelectedAttachmentId] = useState('');
  const [feedbackReason, setFeedbackReason] = useState('missing_detection');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedRunLoading, setSelectedRunLoading] = useState(false);
  const [selectedRunError, setSelectedRunError] = useState('');
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState('');
  const [runtimeChecks, setRuntimeChecks] = useState<RuntimeConnectivityRecord[]>([]);
  const [runtimeSettingsLoading, setRuntimeSettingsLoading] = useState(true);
  const [runtimeSettingsError, setRuntimeSettingsError] = useState('');
  const [runtimeDisableSimulatedTrainFallback, setRuntimeDisableSimulatedTrainFallback] = useState(false);
  const [runtimeDisableInferenceFallback, setRuntimeDisableInferenceFallback] = useState(false);
  const [runtimePythonBin, setRuntimePythonBin] = useState('');
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const preferredDatasetId = (searchParams.get('dataset') ?? '').trim();
  const preferredVersionId = (searchParams.get('version') ?? '').trim();
  const preferredContextAppliedRef = useRef(false);
  const resourcesSignatureRef = useRef('');
  const validationControlsRef = useRef<HTMLDivElement | null>(null);
  const inputUploaderRef = useRef<HTMLDivElement | null>(null);
  const latestOutputRef = useRef<HTMLDivElement | null>(null);
  const feedbackPanelRef = useRef<HTMLDivElement | null>(null);

  const loadAll = useCallback(async (mode: LoadMode) => {
    if (mode === 'initial') {
      setLoading(true);
    }

    if (mode === 'manual') {
      setRefreshing(true);
    }

    try {
      const [versionResult, datasetResult, attachmentResult, runResult] = await Promise.all([
        api.listModelVersions(),
        api.listDatasets(),
        api.listInferenceAttachments(),
        api.listInferenceRuns()
      ]);
      const nextSignature = buildInferenceWorkspaceSignature({
        versions: versionResult,
        datasets: datasetResult,
        attachments: attachmentResult,
        runs: runResult
      });

      if (resourcesSignatureRef.current !== nextSignature) {
        resourcesSignatureRef.current = nextSignature;
        const preferredDataset =
          preferredDatasetId && !preferredContextAppliedRef.current
            ? datasetResult.find((dataset) => dataset.id === preferredDatasetId) ?? null
            : null;
        const preferredTaskType = preferredDataset?.task_type ?? null;
        const preferredTaskVersion = preferredTaskType
          ? versionResult.find((version) => version.task_type === preferredTaskType) ?? null
          : null;
        const requestedVersion =
          preferredVersionId && versionResult.find((version) => version.id === preferredVersionId)
            ? preferredVersionId
            : '';
        setVersions(versionResult);
        setDatasets(datasetResult);
        setAttachments(attachmentResult);
        setRuns(runResult);
        setSelectedRunId((prev) => (prev && runResult.some((run) => run.id === prev) ? prev : runResult[0]?.id || ''));
        setSelectedVersionId((prev) =>
          requestedVersion ||
          (preferredTaskVersion?.id ?? '') ||
          (prev && versionResult.some((version) => version.id === prev) ? prev : versionResult[0]?.id || '')
        );
        setSelectedDatasetId((prev) =>
          (preferredDataset?.id ?? '') ||
          (prev && datasetResult.some((dataset) => dataset.id === prev) ? prev : datasetResult[0]?.id || '')
        );
        setSelectedAttachmentId((prev) => {
          const readyAttachments = attachmentResult.filter((attachment) => attachment.status === 'ready');
          return prev && readyAttachments.some((attachment) => attachment.id === prev)
            ? prev
            : readyAttachments[0]?.id || '';
        });
        if (preferredDataset || requestedVersion) {
          preferredContextAppliedRef.current = true;
        }
      }
    } finally {
      if (mode === 'initial') {
        setLoading(false);
      }

      if (mode === 'manual') {
        setRefreshing(false);
      }
    }
  }, [preferredDatasetId, preferredVersionId]);

  useEffect(() => {
    loadAll('initial')
      .then(() => setFeedback(null))
      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }));
  }, [loadAll]);

  const selectedVersion = useMemo(
    () => versions.find((version) => version.id === selectedVersionId) ?? null,
    [versions, selectedVersionId]
  );
  const versionsById = useMemo(() => new Map(versions.map((version) => [version.id, version])), [versions]);
  const datasetsById = useMemo(() => new Map(datasets.map((dataset) => [dataset.id, dataset])), [datasets]);
  const attachmentById = useMemo(
    () => new Map(attachments.map((attachment) => [attachment.id, attachment])),
    [attachments]
  );
  const selectedAttachment = useMemo(
    () => attachments.find((attachment) => attachment.id === selectedAttachmentId) ?? null,
    [attachments, selectedAttachmentId]
  );

  const selectedRunSummary = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId]
  );
  const describeRun = useCallback(
    (run: InferenceRunRecord) => versionsById.get(run.model_version_id)?.version_name ?? t('Recent run'),
    [t, versionsById]
  );
  const selectedRun = selectedRunDetail && selectedRunDetail.id === selectedRunId ? selectedRunDetail : selectedRunSummary;
  const selectedRunVersion = useMemo(
    () => (selectedRun ? versionsById.get(selectedRun.model_version_id) ?? null : null),
    [selectedRun, versionsById]
  );
  const selectedRunInputAttachment = useMemo(
    () => (selectedRun ? attachmentById.get(selectedRun.input_attachment_id) ?? null : null),
    [attachmentById, selectedRun]
  );
  const feedbackTaskType = useMemo(
    () => selectedRun?.task_type ?? selectedVersion?.task_type ?? null,
    [selectedRun?.task_type, selectedVersion?.task_type]
  );
  const feedbackDatasets = useMemo(
    () =>
      feedbackTaskType
        ? datasets.filter((dataset) => dataset.task_type === feedbackTaskType)
        : datasets,
    [datasets, feedbackTaskType]
  );
  const selectedFeedbackDataset = useMemo(
    () => feedbackDatasets.find((dataset) => dataset.id === selectedDatasetId) ?? null,
    [feedbackDatasets, selectedDatasetId]
  );
  const selectedDataset = useMemo(
    () => datasets.find((dataset) => dataset.id === selectedDatasetId) ?? null,
    [datasets, selectedDatasetId]
  );
  const scopedDatasetId = selectedDataset?.id ?? preferredDatasetId;
  const scopedVersionId = selectedVersion?.id ?? preferredVersionId;
  const scopedAnnotationQueue = useMemo<'all' | 'needs_work' | 'in_review' | 'rejected' | 'approved'>(() => {
    if (!selectedRun) {
      return 'needs_work';
    }
    if (selectedRun.feedback_dataset_id) {
      return 'needs_work';
    }
    return 'in_review';
  }, [selectedRun]);
  const scopedAnnotationPath = scopedDatasetId
    ? buildScopedAnnotationPath(scopedDatasetId, scopedAnnotationQueue, scopedVersionId, {
        metadataFilter: selectedRun ? `inference_run_id=${selectedRun.id}` : ''
      })
    : '/datasets';
  const hasPrefilledContext = Boolean(preferredDatasetId || preferredVersionId);
  const selectedRunPreviewUrl = useMemo(() => {
    if (!selectedRun) {
      return null;
    }

    const sourceAttachmentId =
      selectedRun.normalized_output.image.source_attachment_id ?? selectedRun.input_attachment_id;
    return sourceAttachmentId ? api.attachmentContentUrl(sourceAttachmentId) : null;
  }, [selectedRun]);

  const runtimeInsight = useMemo(() => {
    if (!selectedRun) {
      return null;
    }

    const inferredSource = resolveInferenceRunSource(selectedRun);
    const inferredReality = detectInferenceRunReality(selectedRun);
    const rawMeta =
      selectedRun.raw_output.meta && typeof selectedRun.raw_output.meta === 'object' && !Array.isArray(selectedRun.raw_output.meta)
        ? (selectedRun.raw_output.meta as Record<string, unknown>)
        : null;
    const source = inferredSource;
    const runnerMode =
      rawMeta && typeof rawMeta.mode === 'string' && rawMeta.mode.trim() ? rawMeta.mode.trim() : '';

    const fallbackReason =
      inferredReality.reason ||
      (typeof selectedRun.raw_output.runtime_fallback_reason === 'string'
        ? selectedRun.raw_output.runtime_fallback_reason
        : '') ||
      (typeof selectedRun.raw_output.local_command_fallback_reason === 'string'
        ? selectedRun.raw_output.local_command_fallback_reason
        : '');
    const runtimeFramework =
      typeof selectedRun.raw_output.runtime_framework === 'string'
        ? selectedRun.raw_output.runtime_framework
        : selectedRun.framework;
    const normalizedSource = source.toLowerCase();
    const sourceKind =
      normalizedSource.includes('template')
        ? 'template'
        : normalizedSource.endsWith('_runtime') && !inferredReality.fallback
          ? 'runtime'
          : normalizedSource.endsWith('_local_command') && !inferredReality.fallback
            ? 'local_command'
            : normalizedSource.includes('fallback') || normalizedSource.includes('mock') || normalizedSource.includes('base_empty')
        ? 'fallback'
            : inferredReality.fallback
              ? 'fallback'
              : 'unknown';

    const title =
      sourceKind === 'runtime'
        ? t('Runtime Bridge Active')
        : sourceKind === 'local_command' && runnerMode === 'real'
          ? t('Local Runner Active')
          : sourceKind === 'local_command'
            ? t('Local runner degraded mode')
              : t('Degraded output active');
    const description =
      sourceKind === 'runtime'
        ? t('Prediction output is coming from configured runtime endpoint.')
        : sourceKind === 'local_command' && runnerMode === 'real'
          ? t('Prediction output is coming from local framework runner and version-bound artifact when available.')
          : sourceKind === 'local_command'
            ? fallbackReason
              ? t('Prediction output is coming from built-in degraded runner because real framework execution is unavailable: {reason}', {
                  reason: formatFallbackReasonLabel(fallbackReason)
                })
              : t('Prediction output is coming from built-in degraded runner because real framework execution is unavailable.')
              : fallbackReason
                ? t('Using degraded output because runtime or local execution failed: {reason}', {
                    reason: formatFallbackReasonLabel(fallbackReason)
                  })
                : t('Using degraded output because runtime endpoint is unavailable.');
    const variant: 'success' | 'error' | 'empty' =
      sourceKind === 'runtime' || (sourceKind === 'local_command' && runnerMode === 'real')
        ? 'success'
        : sourceKind === 'fallback'
          ? 'error'
          : 'empty';

    return {
      source,
      displaySourceLabel: inferredReality.fallback ? t('Degraded mode') : t('Real execution'),
      runtimeFramework,
      fallbackReason,
      runnerMode,
      sourceKind,
      title,
      description,
      variant
    };
  }, [selectedRun, formatFallbackReasonLabel, t]);

  const selectedRunFallbackWarning = useMemo(() => {
    if (!selectedRun) {
      return null;
    }

    const normalizedMeta = selectedRun.normalized_output.normalized_output as Record<string, unknown>;
    const rawMeta =
      selectedRun.raw_output.meta && typeof selectedRun.raw_output.meta === 'object' && !Array.isArray(selectedRun.raw_output.meta)
        ? (selectedRun.raw_output.meta as Record<string, unknown>)
        : null;
    const source =
      typeof normalizedMeta.source === 'string' && normalizedMeta.source.trim()
        ? normalizedMeta.source.toLowerCase()
        : '';
    const sourceIndicatesFallback =
      source.includes('mock') || source.includes('template') || source.includes('fallback');
    const templateMode =
      rawMeta && typeof rawMeta.mode === 'string' ? rawMeta.mode.toLowerCase() === 'template' : false;
    const localFallbackReason =
      typeof selectedRun.raw_output.local_command_fallback_reason === 'string'
        ? selectedRun.raw_output.local_command_fallback_reason
        : '';
    const runtimeFallbackReason =
      typeof selectedRun.raw_output.runtime_fallback_reason === 'string'
        ? selectedRun.raw_output.runtime_fallback_reason
        : '';
    const templateFallbackReason =
      rawMeta && typeof rawMeta.fallback_reason === 'string' ? rawMeta.fallback_reason : '';

    if (!sourceIndicatesFallback && !localFallbackReason && !runtimeFallbackReason && !templateMode) {
      return null;
    }

    return {
      reason: localFallbackReason || runtimeFallbackReason || templateFallbackReason
    };
  }, [selectedRun]);

  const selectedRunHasEmptyOcrResult = useMemo(() => {
    if (!selectedRun || selectedRun.task_type !== 'ocr') {
      return false;
    }

    return (selectedRun.normalized_output.ocr?.lines ?? []).length === 0;
  }, [selectedRun]);

  const step = useMemo(() => {
    if (!selectedRun) {
      return 0;
    }

    if (selectedRun.feedback_dataset_id) {
      return 2;
    }

    return 1;
  }, [selectedRun]);

  const readyAttachmentCount = useMemo(
    () => attachments.filter((attachment) => attachment.status === 'ready').length,
    [attachments]
  );

  const feedbackRunCount = useMemo(
    () => runs.filter((run) => Boolean(run.feedback_dataset_id)).length,
    [runs]
  );
  const hasTransientInferenceState = useMemo(
    () =>
      attachments.some((attachment) => attachment.status === 'uploading' || attachment.status === 'processing') ||
      runs.some((run) => run.status === 'queued' || run.status === 'running'),
    [attachments, runs]
  );

  useBackgroundPolling(
    () => {
      loadAll('background').catch(() => {
        // no-op
      });
    },
    {
      intervalMs: backgroundRefreshIntervalMs,
      enabled: hasTransientInferenceState
    }
  );

  const reachableRuntimeCount = useMemo(
    () => runtimeChecks.filter((item) => item.source === 'reachable').length,
    [runtimeChecks]
  );
  const unreachableRuntimeCount = useMemo(
    () => runtimeChecks.filter((item) => item.source === 'unreachable').length,
    [runtimeChecks]
  );
  const notConfiguredRuntimeCount = useMemo(
    () => runtimeChecks.filter((item) => item.source === 'not_configured').length,
    [runtimeChecks]
  );
  const onboardingSteps = useMemo(
    () => [
      {
        key: 'runtime',
        label: t('Confirm runtime and model version'),
        detail: t('Start by checking runtime connectivity and selecting one model version for this validation round.'),
        done: Boolean(selectedVersion) && reachableRuntimeCount > 0,
        to: '/settings/runtime',
        cta: t('Open Runtime Settings')
      },
      {
        key: 'run',
        label: t('Upload input and run validation'),
        detail: t('Keep at least one ready input attachment, then run inference and inspect normalized output.'),
        done: readyAttachmentCount > 0 && Boolean(selectedRun),
        to: '/inference/validate',
        cta: t('Run Inference')
      },
      {
        key: 'feedback',
        label: t('Route failure sample back to dataset'),
        detail: t('Send low-quality predictions back into dataset queues so annotation and retraining can continue.'),
        done: feedbackRunCount > 0,
        to: scopedAnnotationPath,
        cta: t('Open scoped annotation')
      }
    ],
    [
      feedbackRunCount,
      readyAttachmentCount,
      reachableRuntimeCount,
      scopedAnnotationPath,
      selectedRun,
      selectedVersion,
      t
    ]
  );
  const nextOnboardingStep = useMemo(
    () => onboardingSteps.find((stepItem) => !stepItem.done) ?? null,
    [onboardingSteps]
  );
  const nextOnboardingStepIndex = useMemo(
    () => (nextOnboardingStep ? onboardingSteps.findIndex((stepItem) => stepItem.key === nextOnboardingStep.key) + 1 : 0),
    [nextOnboardingStep, onboardingSteps]
  );

  const focusValidationControls = useCallback(() => {
    validationControlsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const focusInputUploader = useCallback(() => {
    inputUploaderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const focusLatestOutput = useCallback(() => {
    latestOutputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const focusFeedbackPanel = useCallback(() => {
    feedbackPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const renderValidationNextAction = useCallback(
    (
      stepItem: (typeof onboardingSteps)[number],
      options?: {
        variant?: 'secondary' | 'ghost';
      }
    ) => {
      const variant = options?.variant ?? 'secondary';

      if (stepItem.key === 'runtime') {
        if (versions.length === 0) {
          return (
            <ButtonLink to="/models/versions" variant={variant} size="sm">
              {t('Open Model Versions')}
            </ButtonLink>
          );
        }

        if (reachableRuntimeCount === 0) {
          return (
            <ButtonLink to="/settings/runtime" variant={variant} size="sm">
              {t('Open Runtime Settings')}
            </ButtonLink>
          );
        }

        return (
          <Button type="button" variant={variant} size="sm" onClick={focusValidationControls}>
            {t('Open validation controls')}
          </Button>
        );
      }

      if (stepItem.key === 'run') {
        if (readyAttachmentCount === 0) {
          return (
            <Button type="button" variant={variant} size="sm" onClick={focusInputUploader}>
              {t('Open inference inputs')}
            </Button>
          );
        }

        return (
          <Button type="button" variant={variant} size="sm" onClick={focusValidationControls}>
            {t('Open validation controls')}
          </Button>
        );
      }

      if (stepItem.key === 'feedback') {
        if (selectedRun) {
          return (
            <Button type="button" variant={variant} size="sm" onClick={focusFeedbackPanel}>
              {t('Open feedback routing')}
            </Button>
          );
        }

        return (
          <Button type="button" variant={variant} size="sm" onClick={focusLatestOutput}>
            {t('Open latest output')}
          </Button>
        );
      }

      return (
        <ButtonLink to={stepItem.to} variant={variant} size="sm">
          {stepItem.cta}
        </ButtonLink>
      );
    },
    [
      focusFeedbackPanel,
      focusInputUploader,
      focusLatestOutput,
      focusValidationControls,
      readyAttachmentCount,
      reachableRuntimeCount,
      selectedRun,
      t,
      versions.length
    ]
  );

  const loadRuntimeConnectivity = useCallback(async () => {
    setRuntimeLoading(true);
    setRuntimeError('');
    try {
      const result = await api.getRuntimeConnectivity();
      setRuntimeChecks(result);
    } catch (error) {
      setRuntimeError((error as Error).message);
    } finally {
      setRuntimeLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRuntimeConnectivity();
  }, [loadRuntimeConnectivity]);

  useEffect(() => {
    let active = true;
    setRuntimeSettingsLoading(true);
    setRuntimeSettingsError('');
    api
      .getRuntimeSettings()
      .then((view) => {
        if (!active) {
          return;
        }
        setRuntimeDisableSimulatedTrainFallback(view.controls.disable_simulated_train_fallback);
        setRuntimeDisableInferenceFallback(view.controls.disable_inference_fallback);
        setRuntimePythonBin(view.controls.python_bin.trim());
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        setRuntimeSettingsError((error as Error).message);
      })
      .finally(() => {
        if (active) {
          setRuntimeSettingsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (feedbackDatasets.length === 0) {
      if (selectedDatasetId) {
        setSelectedDatasetId('');
      }
      return;
    }

    if (!feedbackDatasets.some((dataset) => dataset.id === selectedDatasetId)) {
      setSelectedDatasetId(feedbackDatasets[0].id);
    }
  }, [feedbackDatasets, selectedDatasetId]);

  const refreshSelectedRunDetail = useCallback(async (runId: string) => {
    if (!runId) {
      setSelectedRunDetail(null);
      setSelectedRunError('');
      return;
    }

    setSelectedRunLoading(true);
    setSelectedRunError('');
    try {
      const detail = await api.getInferenceRun(runId);
      setSelectedRunDetail(detail);
      setRuns((prev) => {
        const exists = prev.some((run) => run.id === detail.id);
        const next = exists ? prev.map((run) => (run.id === detail.id ? detail : run)) : [detail, ...prev];
        return [...next].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
      });
    } catch (error) {
      setSelectedRunError((error as Error).message);
    } finally {
      setSelectedRunLoading(false);
    }
  }, []);

  useEffect(() => {
    const targetRunId = selectedRunSummary?.id ?? '';
    if (!targetRunId) {
      setSelectedRunDetail(null);
      setSelectedRunError('');
      return;
    }

    const summaryUpdatedAt = selectedRunSummary?.updated_at ?? '';
    const detailUpdatedAt = selectedRunDetail?.updated_at ?? '';

    if (selectedRunDetail?.id === targetRunId && summaryUpdatedAt === detailUpdatedAt) {
      return;
    }

    void refreshSelectedRunDetail(targetRunId);
  }, [
    refreshSelectedRunDetail,
    selectedRunDetail?.id,
    selectedRunDetail?.updated_at,
    selectedRunSummary?.id,
    selectedRunSummary?.updated_at
  ]);

  const uploadInput = async (filename: string) => {
    await api.uploadInferenceAttachment(filename);
    await loadAll('manual');
  };

  const uploadInputFiles = async (files: File[]) => {
    for (const file of files) {
      await api.uploadInferenceFile(file);
    }
    await loadAll('manual');
  };

  const removeInput = async (attachmentId: string) => {
    await api.removeAttachment(attachmentId);
    await loadAll('manual');
  };

  const runInference = async () => {
    if (!selectedVersion || !selectedAttachmentId) {
      setFeedback({ variant: 'error', text: t('Select model version and ready attachment first.') });
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      const created = await api.runInference({
        model_version_id: selectedVersion.id,
        input_attachment_id: selectedAttachmentId,
        task_type: selectedVersion.task_type
      });

      setFeedback({
        variant: 'success',
        text: t('Inference completed. The latest run is now selected below.')
      });
      await loadAll('manual');
      setSelectedRunId(created.id);
      await refreshSelectedRunDetail(created.id);
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const sendFeedback = async () => {
    if (!selectedRun || !selectedDatasetId) {
      setFeedback({ variant: 'error', text: t('Run inference and select dataset before feedback.') });
      return;
    }

    if (!selectedFeedbackDataset || selectedFeedbackDataset.task_type !== selectedRun.task_type) {
      setFeedback({
        variant: 'error',
        text: t('Feedback target dataset task type must match inference task type.')
      });
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      await api.sendInferenceFeedback({
        run_id: selectedRun.id,
        dataset_id: selectedDatasetId,
        reason: feedbackReason
      });

      setFeedback({ variant: 'success', text: t('Sample feedback sent to dataset.') });
      await loadAll('manual');
      await refreshSelectedRunDetail(selectedRun.id);
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <WorkspacePage>
        <PageHeader
          eyebrow={t('Validation Lane')}
          title={t('Inference Validation')}
          description={t('Run validation, inspect normalized output, and route failure samples back into dataset workflows.')}
          primaryAction={{
            label: refreshing ? t('Refreshing...') : t('Refresh'),
            onClick: () => {
              loadAll('manual').catch((error) => {
                setFeedback({ variant: 'error', text: (error as Error).message });
              });
            },
            disabled: busy || refreshing
          }}
        />
        <StepIndicator steps={steps} current={step} />
        <StateBlock variant="loading" title={t('Loading Validation Workspace')} description={t('Preparing resources.')} />
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Validation Lane')}
        title={t('Inference Validation')}
        description={t('Run validation, inspect normalized output, and route failure samples back into dataset workflows.')}
        meta={
          <div className="row gap wrap align-center">
            <Badge tone="neutral">{t('Ready inputs')}: {readyAttachmentCount}</Badge>
            <Badge tone="neutral">{t('Model versions')}: {versions.length}</Badge>
            <Badge tone="info">{t('Recorded runs')}: {runs.length}</Badge>
            <Badge tone="neutral">{t('Feedback sent')}: {feedbackRunCount}</Badge>
          </div>
        }
        primaryAction={{
          label: refreshing ? t('Refreshing...') : t('Refresh'),
          onClick: () => {
            loadAll('manual').catch((error) => {
              setFeedback({ variant: 'error', text: (error as Error).message });
            });
          },
          disabled: busy || refreshing
        }}
      />
      <StepIndicator steps={steps} current={step} />

      {feedback ? (
        <InlineAlert
          tone={feedback.variant === 'success' ? 'success' : 'danger'}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}
      {!runtimeSettingsLoading ? (
        runtimeSettingsError ? (
          <InlineAlert
            tone="warning"
            title={t('Runtime safety status unavailable')}
            description={t('Unable to load runtime settings: {reason}', { reason: runtimeSettingsError })}
            actions={
              <ButtonLink to="/settings/runtime" variant="secondary" size="sm">
                {t('Open Runtime Settings')}
              </ButtonLink>
            }
          />
        ) : runtimeDisableInferenceFallback ? (
          <InlineAlert
            tone="success"
            title={t('Inference safety guard is active')}
            description={t(
              'Degraded inference output is blocked. Built-in runner Python: {pythonBin}.',
              { pythonBin: runtimePythonBin || t('platform default (python3 / python)') }
            )}
          />
        ) : (
          <InlineAlert
            tone="danger"
            title={t('Inference safety guard is off')}
            description={t(
              'Inference may still return degraded output when runtime or local execution fails. Enable the safety guard in Runtime settings before production validation.'
            )}
            actions={
              <div className="row gap wrap">
                <Badge tone={runtimeDisableSimulatedTrainFallback ? 'success' : 'warning'}>
                  {t('Training safety guard')}: {runtimeDisableSimulatedTrainFallback ? t('yes') : t('no')}
                </Badge>
                <ButtonLink to="/settings/runtime" variant="secondary" size="sm">
                  {t('Open Runtime Settings')}
                </ButtonLink>
              </div>
            }
          />
        )
      ) : null}
      {selectedRunFallbackWarning ? (
        <InlineAlert
          tone="danger"
          title={t('Current output is degraded and not from real OCR recognition')}
          description={
            selectedRunFallbackWarning.reason
              ? `${t('Degradation reason')}: ${formatFallbackReasonLabel(selectedRunFallbackWarning.reason)}`
              : t('Fix runtime or local prediction command configuration before using this result for business decisions.')
          }
        />
      ) : null}
      {selectedRunHasEmptyOcrResult ? (
        <InlineAlert
          tone="warning"
          title={t('No text recognized or this run produced no real OCR output')}
          description={t('Check runtime or local command configuration and retry.')}
        />
      ) : null}

      <KPIStatRow
        items={[
          {
            label: t('Ready inputs'),
            value: readyAttachmentCount,
            tone: readyAttachmentCount > 0 ? 'success' : 'neutral',
            hint: t('Attachments that can be selected immediately for validation runs.')
          },
          {
            label: t('Model versions'),
            value: versions.length,
            tone: versions.length > 0 ? 'info' : 'warning',
            hint: t('Registered versions available for validation in the current workspace.')
          },
          {
            label: t('Datasets'),
            value: datasets.length,
            tone: datasets.length > 0 ? 'neutral' : 'warning',
            hint: t('Target datasets available for failure-sample feedback routing.')
          },
          {
            label: t('Reachable runtimes'),
            value: runtimeChecks.length === 0 && runtimeLoading ? t('Checking...') : reachableRuntimeCount,
            tone: reachableRuntimeCount === 0 ? 'warning' : 'success',
            hint: t('Framework bridges currently reachable from the validation workspace.')
          },
          {
            label: t('Context prefill'),
            value: hasPrefilledContext ? t('Ready') : t('N/A'),
            tone: hasPrefilledContext ? 'info' : 'neutral',
            hint: t('Dataset/version context provided from dataset detail actions.')
          }
        ]}
      />

      {hasPrefilledContext ? (
        <InlineAlert
          tone="success"
          title={t('Validation context preselected')}
          description={selectedDataset
            ? t('Dataset context is prefilled from dataset detail. You can run and feed back quickly in the same lane.')
            : t('Dataset context was requested from dataset detail.')}
          actions={
            <div className="row gap wrap">
              {selectedDataset ? <Badge tone="info">{selectedDataset.name}</Badge> : null}
              {selectedVersion ? <Badge tone="info">{selectedVersion.version_name}</Badge> : null}
            </div>
          }
        />
      ) : null}

      <WorkspaceWorkbench
        toolbar={
          <div ref={validationControlsRef}>
          <Card as="section" className="workspace-toolbar-card">
            <div className="workspace-toolbar-head">
              <div className="workspace-toolbar-copy">
                <h3>{t('Validation Controls')}</h3>
                <small className="muted">
                  {t('Pick a version and input, run one validation pass, and keep feedback routing in the same lane.')}
                </small>
              </div>
              <div className="workspace-toolbar-actions">
              <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    loadAll('manual').catch((error) => {
                      setFeedback({ variant: 'error', text: (error as Error).message });
                    });
                  }}
                  disabled={busy || refreshing}
                >
                  {refreshing ? t('Refreshing...') : t('Refresh')}
                </Button>
                <Button onClick={runInference} disabled={busy || !selectedVersionId || !selectedAttachmentId}>
                  {t('Run Inference')}
                </Button>
              </div>
            </div>

            {versions.length === 0 ? (
              <StateBlock
                variant="empty"
                title={t('No Model Versions Yet')}
                description={t('Register or train a model version before running validation.')}
                extra={
                  nextOnboardingStep ? (
                    <WorkspaceFollowUpHint
                      actions={renderValidationNextAction(nextOnboardingStep)}
                      detail={nextOnboardingStep.detail}
                    />
                  ) : (
                    <ButtonLink to="/models/versions" variant="secondary" size="sm">
                      {t('Open Model Versions')}
                    </ButtonLink>
                  )
                }
              />
            ) : readyAttachmentCount === 0 ? (
              <StateBlock
                variant="empty"
                title={t('No Ready Inputs Yet')}
                description={t('Upload at least one ready input attachment before running inference.')}
                extra={
                  nextOnboardingStep ? (
                    <WorkspaceFollowUpHint
                      actions={renderValidationNextAction(nextOnboardingStep)}
                      detail={nextOnboardingStep.detail}
                    />
                  ) : (
                    <small className="muted">
                      {t('Use the Inference Inputs uploader below to add an image or document, then rerun validation from this same page.')}
                    </small>
                  )
                }
              />
            ) : (
              <div className="workspace-filter-grid">
                <label className="stack tight">
                  <small className="muted">{t('Model Version')}</small>
                  <Select
                    value={selectedVersionId}
                    onChange={(event) => setSelectedVersionId(event.target.value)}
                  >
                    {versions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {version.version_name} ({t(version.task_type)} / {t(version.framework)})
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="stack tight">
                  <small className="muted">{t('Input Attachment')}</small>
                  <Select
                    value={selectedAttachmentId}
                    onChange={(event) => setSelectedAttachmentId(event.target.value)}
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
                <label className="stack tight">
                  <small className="muted">{t('Select Run')}</small>
                  <Select
                    value={selectedRun?.id ?? ''}
                    onChange={(event) => setSelectedRunId(event.target.value)}
                    disabled={runs.length === 0}
                  >
                    {runs.length === 0 ? (
                      <option value="">{t('No Runs Yet')}</option>
                    ) : (
                      runs.map((run) => (
                        <option key={run.id} value={run.id}>
                          {describeRun(run)} · {formatCompactTimestamp(run.updated_at, t('n/a'))} · {t(run.status)}
                        </option>
                      ))
                    )}
                  </Select>
                </label>
              </div>
            )}

            <div className="workspace-toolbar-meta">
              <div className="workspace-segmented-actions">
                <Badge tone="neutral">{t('Version')}: {selectedVersion?.version_name ?? t('n/a')}</Badge>
                <Badge tone="info">{t('Dataset')}: {selectedDataset?.name ?? t('n/a')}</Badge>
                <Badge tone="neutral">{t('Ready inputs')}: {readyAttachmentCount}</Badge>
                <Badge tone={selectedRun ? 'info' : 'neutral'}>
                  {t('Selected run')}: {selectedRun ? formatCompactTimestamp(selectedRun.updated_at, t('n/a')) : t('No Runs Yet')}
                </Badge>
              </div>
            </div>
          </Card>
          </div>
        }
        main={
          <div className="workspace-main-stack">
            <WorkspaceOnboardingCard
              title={t('Validation first-run guide')}
              description={t('This page closes the loop: validate output quality, then feed bad samples back for the next training cycle.')}
              summary={t('Guide status is computed from runtime checks, run records, and feedback history.')}
              storageKey={inferenceValidationOnboardingDismissedStorageKey}
              steps={onboardingSteps.map((stepItem) => ({
                key: stepItem.key,
                label: stepItem.label,
                detail: stepItem.detail,
                done: stepItem.done,
                primaryAction: {
                  to:
                    stepItem.key === 'runtime'
                      ? versions.length === 0
                        ? '/models/versions'
                        : reachableRuntimeCount === 0
                          ? '/settings/runtime'
                          : undefined
                      : undefined,
                  label:
                    stepItem.key === 'runtime'
                      ? versions.length === 0
                        ? t('Open Model Versions')
                        : reachableRuntimeCount === 0
                          ? t('Open Runtime Settings')
                          : t('Open validation controls')
                      : stepItem.key === 'run'
                        ? readyAttachmentCount === 0
                          ? t('Open inference inputs')
                          : t('Open validation controls')
                        : stepItem.key === 'feedback'
                          ? selectedRun
                            ? t('Open feedback routing')
                            : t('Open latest output')
                          : stepItem.cta,
                  onClick:
                    stepItem.key === 'runtime'
                      ? versions.length === 0
                        ? undefined
                        : reachableRuntimeCount === 0
                          ? undefined
                          : focusValidationControls
                      : stepItem.key === 'run'
                        ? readyAttachmentCount === 0
                          ? focusInputUploader
                          : focusValidationControls
                        : stepItem.key === 'feedback'
                          ? selectedRun
                            ? focusFeedbackPanel
                            : focusLatestOutput
                          : undefined
                }
              }))}
	            />

	            {nextOnboardingStep ? (
	              <WorkspaceNextStepCard
	                title={t('Next validation step')}
	                description={t('Finish one clear validation action here before switching datasets or sending feedback.')}
	                stepLabel={nextOnboardingStep.label}
	                stepDetail={nextOnboardingStep.detail}
	                current={nextOnboardingStepIndex}
	                total={onboardingSteps.length}
	                actions={
	                  renderValidationNextAction(nextOnboardingStep)
	                }
	              />
	            ) : null}

            <div ref={inputUploaderRef}>
            <AttachmentUploader
              title={t('Inference Inputs')}
              items={attachments}
              onUpload={uploadInput}
              onUploadFiles={uploadInputFiles}
              contentUrlBuilder={api.attachmentContentUrl}
              onDelete={removeInput}
              emptyDescription={t('Upload image inputs for inference validation.')}
              uploadButtonLabel={t('Upload Inference Input')}
              disabled={busy}
            />
            </div>

            <div ref={latestOutputRef}>
            <Card as="article">
              <WorkspaceSectionHeader
                title={t('Latest Inference Output')}
                description={t('Review execution status, preview image, normalized output, and detailed diagnostics from the selected run.')}
                actions={
                  selectedRun ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void refreshSelectedRunDetail(selectedRun.id)}
                      disabled={selectedRunLoading}
                    >
                      {selectedRunLoading ? t('Refreshing...') : t('Refresh selected run')}
                    </Button>
                  ) : null
                }
              />

              {!selectedRun ? (
                <StateBlock
                  variant="empty"
                  title={t('No Runs Yet')}
                description={t('Run inference once to inspect normalized output, execution status, and feedback routing options.')}
                extra={
                  nextOnboardingStep ? (
                    <WorkspaceFollowUpHint
                      actions={renderValidationNextAction(nextOnboardingStep)}
                      detail={nextOnboardingStep.detail}
                    />
                  ) : (
                    <small className="muted">
                      {t('Choose a model version and a ready input above, then click Run Inference.')}
                      </small>
                    )
                  }
                />
              ) : (
                <>
                  {selectedRunError ? (
                    <StateBlock variant="error" title={t('Run detail unavailable')} description={selectedRunError} />
                  ) : null}
                  <small className="muted">
                    {t('Run {runId} · Task {task} · Framework {framework}', {
                      runId: selectedRunVersion?.version_name ?? t('Recent run'),
                      task: t(selectedRun.task_type),
                      framework: t(selectedRun.framework)
                    })}
                  </small>
                  <small className="muted">
                    {t('Last updated')}: {formatCompactTimestamp(selectedRun.updated_at, t('n/a'))}
                  </small>
                  <div className="row gap wrap">
                    <Badge tone="neutral">
                      {t('Execution Status')}: {runtimeInsight?.displaySourceLabel ?? t('Unknown execution')}
                    </Badge>
                    <Badge tone="info">
                      {t('runtime framework')}: {runtimeInsight?.runtimeFramework ? t(runtimeInsight.runtimeFramework) : t('unknown')}
                    </Badge>
                    {attachmentById.get(selectedRun.input_attachment_id) ? (
                      <Badge tone="info">
                        {t('Input Attachment')}: {selectedRunInputAttachment?.filename}
                      </Badge>
                    ) : null}
                    {selectedRun.feedback_dataset_id ? (
                      <Badge tone="neutral">
                        {t('Target Dataset')}:{' '}
                        {datasetsById.get(selectedRun.feedback_dataset_id)?.name ??
                          t('Selected dataset record unavailable')}
                      </Badge>
                    ) : null}
                  </div>
                  <StateBlock
                    variant={runtimeInsight?.variant ?? 'empty'}
                    title={runtimeInsight?.title ?? t('Degraded output active')}
                    description={runtimeInsight?.description ?? t('Using degraded output because runtime endpoint is unavailable.')}
                  />
                  <Suspense
                    fallback={
                      <StateBlock
                        variant="loading"
                        title={t('Loading')}
                        description={t('Preparing prediction visualization.')}
                      />
                    }
                  >
                    <PredictionVisualizer
                      output={selectedRun.normalized_output}
                      imageUrl={selectedRunPreviewUrl}
                    />
                  </Suspense>
                  <details className="workspace-details">
                    <summary>{t('Raw Output')}</summary>
                    <pre className="code-block">{JSON.stringify(selectedRun.raw_output, null, 2)}</pre>
                  </details>
                  <details className="workspace-details">
                    <summary>{t('Normalized Output')}</summary>
                    <pre className="code-block">{JSON.stringify(selectedRun.normalized_output, null, 2)}</pre>
                  </details>
                </>
              )}
            </Card>
            </div>
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <Card as="article" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Current status')}
                description={t(
                  'Run validation, inspect normalized output, and route failure samples back into dataset workflows.'
                )}
              />
              <div className="workspace-keyline-list">
                <div className="workspace-keyline-item">
                  <span>{t('Model Version')}</span>
                  <small>{selectedVersion?.version_name ?? t('n/a')}</small>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Input Attachment')}</span>
                  <small>{selectedAttachment?.filename ?? t('n/a')}</small>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Target Dataset')}</span>
                  <small>{selectedFeedbackDataset?.name ?? t('n/a')}</small>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Reachable runtimes')}</span>
                  <strong>{runtimeChecks.length === 0 && runtimeLoading ? t('Checking...') : reachableRuntimeCount}</strong>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Feedback sent')}</span>
                  <strong>{feedbackRunCount}</strong>
                </div>
              </div>
            </Card>

            <Card as="article" className="workspace-inspector-card">
                <WorkspaceSectionHeader
                  title={t('Runtime summary')}
                  description={t('Show only current runtime readiness in this lane. Open Runtime settings for full diagnostics and configuration.')}
                  actions={
                    <ButtonLink to="/settings/runtime" variant="ghost" size="sm">
                      {t('Open Runtime Settings')}
                    </ButtonLink>
                  }
                />
                {runtimeError ? (
                  <InlineAlert
                    tone="warning"
                    title={t('Runtime Check Failed')}
                    description={runtimeError}
                  />
                ) : null}
                <div className="workspace-keyline-list">
                  <div className="workspace-keyline-item">
                    <span>{t('reachable')}</span>
                    <strong>{reachableRuntimeCount}</strong>
                  </div>
                  <div className="workspace-keyline-item">
                    <span>{t('unreachable')}</span>
                    <strong>{unreachableRuntimeCount}</strong>
                  </div>
                  <div className="workspace-keyline-item">
                    <span>{t('not configured')}</span>
                    <strong>{notConfiguredRuntimeCount}</strong>
                  </div>
                </div>
                <small className="muted">
                  {t('Use Runtime settings for endpoint details, error kinds, and advanced diagnostics.')}
                </small>
            </Card>

            <div ref={feedbackPanelRef}>
            <Card as="article" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Feedback to Dataset')}
                description={t('Push the selected failure sample back into a dataset so the next training loop can absorb it.')}
              />

              {!selectedRun ? (
                <StateBlock
                  variant="empty"
                  title={t('No Runs Yet')}
                  description={t('Run inference to inspect outputs.')}
                />
              ) : null}
              {selectedRun && datasets.length === 0 ? (
                <StateBlock
                  variant="empty"
                  title={t('No Datasets Yet')}
                  description={t('Create or import a dataset before sending failure samples back.')}
                />
              ) : null}
              {selectedRun && datasets.length > 0 && feedbackDatasets.length === 0 ? (
                <StateBlock
                  variant="empty"
                  title={t('No Matching Datasets')}
                  description={t('Create a dataset with task type {taskType} before sending feedback from this run.', {
                    taskType: feedbackTaskType ? t(feedbackTaskType) : t('unknown')
                  })}
                />
              ) : null}
              {feedbackTaskType ? (
                <small className="muted">
                  {t('Only datasets with task {taskType} are shown for feedback.', {
                    taskType: t(feedbackTaskType)
                  })}
                </small>
              ) : null}

              <div className="workspace-form-grid">
                <label>
                  {t('Target Dataset')}
                  <Select
                    value={selectedDatasetId}
                    onChange={(event) => setSelectedDatasetId(event.target.value)}
                  >
                    {feedbackDatasets.map((dataset) => (
                      <option key={dataset.id} value={dataset.id}>
                        {dataset.name} ({t(dataset.task_type)})
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  {t('Feedback Reason')}
                  <Input
                    value={feedbackReason}
                    onChange={(event) => setFeedbackReason(event.target.value)}
                    placeholder={t('for example: missing_detection')}
                  />
                </label>
              </div>
              <div className="workspace-action-cluster">
                <Button onClick={sendFeedback} disabled={busy || !selectedRun || !selectedDatasetId}>
                  {t('Send to Dataset')}
                </Button>
                <ButtonLink to={scopedAnnotationPath} variant="ghost" size="sm">
                  {t('Open scoped annotation')}
                </ButtonLink>
              </div>
              {selectedRun ? (
                <small className="muted">
                  {t('Annotation quick link keeps queue scope and applies metadata filter for run {runId}.', {
                    runId: selectedRun.id
                  })}
                </small>
              ) : null}
            </Card>
            </div>
          </div>
        }
      />
    </WorkspacePage>
  );
}
