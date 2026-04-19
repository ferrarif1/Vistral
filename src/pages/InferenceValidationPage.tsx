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
import StateBlock from '../components/StateBlock';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { ActionBar, InlineAlert, PageHeader, SectionCard } from '../components/ui/ConsolePage';
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
  const [runtimeChecks, setRuntimeChecks] = useState<RuntimeConnectivityRecord[]>([]);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const preferredDatasetId = (searchParams.get('dataset') ?? '').trim();
  const preferredDatasetVersionId = (searchParams.get('version') ?? '').trim();
  const preferredModelVersionId = (searchParams.get('modelVersion') ?? searchParams.get('model_version') ?? '').trim();
  const preferredContextAppliedRef = useRef(false);
  const resourcesSignatureRef = useRef('');
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
        const requestedModelVersion =
          preferredModelVersionId && versionResult.find((version) => version.id === preferredModelVersionId)
            ? preferredModelVersionId
            : '';
        const legacyRequestedModelVersion =
          !requestedModelVersion &&
          preferredDatasetVersionId &&
          versionResult.find((version) => version.id === preferredDatasetVersionId)
            ? preferredDatasetVersionId
            : '';
        setVersions(versionResult);
        setDatasets(datasetResult);
        setAttachments(attachmentResult);
        setRuns(runResult);
        setSelectedRunId((prev) => (prev && runResult.some((run) => run.id === prev) ? prev : runResult[0]?.id || ''));
        setSelectedVersionId((prev) =>
          requestedModelVersion ||
          legacyRequestedModelVersion ||
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
        if (preferredDataset || requestedModelVersion || legacyRequestedModelVersion) {
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
  }, [preferredDatasetId, preferredDatasetVersionId, preferredModelVersionId]);

  useEffect(() => {
    loadAll('initial')
      .then(() => setFeedback(null))
      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }));
  }, [loadAll]);

  const selectedVersion = useMemo(
    () => versions.find((version) => version.id === selectedVersionId) ?? null,
    [versions, selectedVersionId]
  );
  const prefilledModelVersion = useMemo(
    () => (preferredModelVersionId ? versions.find((version) => version.id === preferredModelVersionId) ?? null : null),
    [preferredModelVersionId, versions]
  );
  const versionsById = useMemo(() => new Map(versions.map((version) => [version.id, version])), [versions]);

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
  const scopedVersionId = preferredDatasetVersionId;
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
        ? t('Runtime output active')
        : sourceKind === 'local_command' && runnerMode === 'real'
          ? t('Local runner active')
          : sourceKind === 'local_command'
            ? t('Local fallback output')
            : t('Fallback output active');
    const description =
      sourceKind === 'runtime'
        ? t('Output comes from the configured runtime endpoint.')
        : sourceKind === 'local_command' && runnerMode === 'real'
          ? t('Output comes from the local runner and version artifact.')
          : sourceKind === 'local_command'
            ? fallbackReason
              ? t('Built-in fallback runner used: {reason}', {
                  reason: formatFallbackReasonLabel(fallbackReason)
                })
              : t('Built-in fallback runner used.')
              : fallbackReason
                ? t('Fallback output used: {reason}', {
                    reason: formatFallbackReasonLabel(fallbackReason)
                  })
                : t('Fallback output used.');
    const variant: 'success' | 'error' | 'empty' =
      sourceKind === 'runtime' || (sourceKind === 'local_command' && runnerMode === 'real')
        ? 'success'
        : sourceKind === 'fallback'
          ? 'error'
          : 'empty';

    return {
      displaySourceLabel: inferredReality.fallback ? t('Fallback output') : t('Real output'),
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

  const selectedRunNotice = useMemo(() => {
    if (selectedRunFallbackWarning) {
      return {
        tone: 'danger' as const,
        title: t('Current result is not real output'),
        description: selectedRunFallbackWarning.reason
          ? `${t('Fallback reason')}: ${formatFallbackReasonLabel(selectedRunFallbackWarning.reason)}`
          : t('Fix Runtime or local command settings first.')
      };
    }

    if (selectedRunHasEmptyOcrResult) {
      return {
        tone: 'warning' as const,
        title: t('No OCR text recognized'),
        description: t('Check Runtime or the local command and try again.')
      };
    }

    return null;
  }, [formatFallbackReasonLabel, selectedRunFallbackWarning, selectedRunHasEmptyOcrResult, t]);
  const modelVersionPrefillBanner = useMemo(() => {
    if (!preferredModelVersionId) {
      return null;
    }

    if (!prefilledModelVersion) {
      return {
        tone: 'warning' as const,
        title: t('Model version prefill missing'),
        description: t('The requested model version is no longer available. Choose another one.'),
        actionLabel: t('Open model versions')
      };
    }

    return {
      tone: 'info' as const,
      title: t('Model version prefilled'),
      description: t('{name} is already selected.', { name: prefilledModelVersion.version_name }),
      actionLabel: t('Clear prefill')
    };
  }, [prefilledModelVersion, preferredModelVersionId, t]);

  const readyAttachmentCount = useMemo(
    () => attachments.filter((attachment) => attachment.status === 'ready').length,
    [attachments]
  );

  const runtimeSummary = useMemo(() => {
    const reachableCount = runtimeChecks.filter((check) => check.configured && check.reachable).length;
    const configuredCount = runtimeChecks.filter((check) => check.configured).length;

    if (runtimeLoading) {
      return {
        tone: 'info' as const,
        title: t('Checking Runtime'),
        description: t('Checking readiness.')
      };
    }

    if (reachableCount > 0) {
      return {
        tone: 'success' as const,
        title: t('Runtime ready'),
        description: t('At least one framework is available.')
      };
    }

    if (configuredCount > 0) {
      return {
        tone: 'warning' as const,
        title: t('Runtime configured'),
        description: t('Configured, but not reachable yet.')
      };
    }

    return {
      tone: 'warning' as const,
      title: t('Runtime not configured'),
      description: t('Choose local mode or an endpoint first.')
    };
  }, [runtimeChecks, runtimeLoading, t]);

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

  const loadRuntimeConnectivity = useCallback(async () => {
    setRuntimeLoading(true);
    try {
      const result = await api.getRuntimeConnectivity();
      setRuntimeChecks(result);
    } catch {
      setRuntimeChecks([]);
    } finally {
      setRuntimeLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRuntimeConnectivity();
  }, [loadRuntimeConnectivity]);

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
      setFeedback({ variant: 'error', text: t('Select a version and a ready input first.') });
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

      setFeedback({ variant: 'success', text: t('Inference complete.') });
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
      setFeedback({ variant: 'error', text: t('Run inference first, then choose a dataset.') });
      return;
    }

    if (!selectedFeedbackDataset || selectedFeedbackDataset.task_type !== selectedRun.task_type) {
      setFeedback({
        variant: 'error',
        text: t('Feedback dataset task type must match.')
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

      setFeedback({ variant: 'success', text: t('Sample routed back.') });
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
        eyebrow={t('Validation')}
        title={t('Inference Validation')}
        description={t('Run once, then route failures back.')}
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
        <StateBlock variant="loading" title={t('Loading Validation Workspace')} description={t('Preparing resources.')} />
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Validation')}
        title={t('Inference Validation')}
        description={t('Run one sample, inspect the result, then route it back.')}
        meta={
          <div className="row gap wrap align-center">
            <Badge tone="neutral">{t('Ready inputs')}: {readyAttachmentCount}</Badge>
          </div>
        }
        primaryAction={{
          label: busy ? t('Running...') : t('Run Inference'),
          onClick: () => {
            void runInference();
          },
          disabled: busy || refreshing || !selectedVersionId || !selectedAttachmentId
        }}
        />

      {feedback ? (
        <InlineAlert
          tone={feedback.variant === 'success' ? 'success' : 'danger'}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}

      {runtimeSummary.tone === 'success' ? null : (
        <InlineAlert
          tone={runtimeSummary.tone}
          title={runtimeSummary.title}
          description={runtimeSummary.description}
          actions={
            <ButtonLink to="/settings/runtime" variant="secondary" size="sm">
              {t('Open Runtime')}
            </ButtonLink>
          }
        />
      )}

      {modelVersionPrefillBanner ? (
        <InlineAlert
          tone={modelVersionPrefillBanner.tone}
          title={modelVersionPrefillBanner.title}
          description={modelVersionPrefillBanner.description}
          actions={
            modelVersionPrefillBanner.actionLabel === t('Clear prefill') ? (
              <ButtonLink to="/inference/validate" variant="ghost" size="sm">
                {modelVersionPrefillBanner.actionLabel}
              </ButtonLink>
            ) : (
              <ButtonLink to="/models/versions" variant="secondary" size="sm">
                {modelVersionPrefillBanner.actionLabel}
              </ButtonLink>
            )
          }
        />
      ) : null}

      <WorkspaceWorkbench
        toolbar={
          <Card as="section" className="workspace-toolbar-card">
            <div className="workspace-toolbar-head">
              <div className="workspace-toolbar-copy">
                <h3>{t('Inputs')}</h3>
                <small className="muted">{t('Select a version and a ready input.')}</small>
              </div>
            </div>
            <div className="workspace-filter-grid">
              {versions.length > 0 ? (
                <label className="stack tight">
                  <small className="muted">{t('Model Version')}</small>
                  <Select value={selectedVersionId} onChange={(event) => setSelectedVersionId(event.target.value)}>
                    {versions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {version.version_name} ({t(version.task_type)} / {t(version.framework)})
                      </option>
                    ))}
                  </Select>
                </label>
              ) : null}
              {readyAttachmentCount > 0 ? (
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
              ) : null}
              {versions.length === 0 || readyAttachmentCount === 0 ? (
                <small className="muted">
                  {t('Add a version and one ready input to enable validation.')}
                </small>
              ) : null}
            </div>
          </Card>
        }
        main={
          <div className="workspace-main-stack">
            {versions.length === 0 ? (
              <StateBlock
                variant="empty"
                title={t('No versions yet')}
                description={t('Add a version first.')}
                extra={
                  <ButtonLink to="/models/versions" variant="secondary" size="sm">
                    {t('Open Versions')}
                  </ButtonLink>
                }
              />
            ) : readyAttachmentCount === 0 ? (
              <StateBlock
                variant="empty"
                title={t('No ready inputs yet')}
                description={t('Upload one ready input first.')}
                extra={<small className="muted">{t('Try again after upload.')}</small>}
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
                emptyDescription={t('Upload an image to validate it.')}
                uploadButtonLabel={t('Upload Inference Input')}
                disabled={busy}
              />
            </div>

            <div ref={latestOutputRef}>
              <Card as="article">
                <WorkspaceSectionHeader
                  title={t('Run result')}
                  description={t('Review status and normalized output.')}
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
                    title={t('No runs yet')}
                    description={t('Run once to see a result.')}
                    extra={<small className="muted">{t('Choose a version and input above first.')}</small>}
                  />
                ) : (
                  <>
                    {selectedRunError ? (
                      <StateBlock variant="error" title={t('Run detail unavailable')} description={selectedRunError} />
                    ) : null}
                    <div className="row gap wrap">
                      <Badge tone="neutral">
                        {t('Run')}: {selectedRunVersion?.version_name ?? t('Recent run')}
                      </Badge>
                      <Badge tone="neutral">
                        {t('Updated')}: {formatCompactTimestamp(selectedRun.updated_at, t('n/a'))}
                      </Badge>
                      <Badge tone="neutral">
                        {t('Task')}: {t(selectedRun.task_type)}
                      </Badge>
                      <Badge tone="neutral">
                        {t('Framework')}: {t(selectedRun.framework)}
                      </Badge>
                      <Badge tone="info">
                        {t('Execution')}: {runtimeInsight?.displaySourceLabel ?? t('Unknown execution')}
                      </Badge>
                    </div>
                    <StateBlock
                      variant={runtimeInsight?.variant ?? 'empty'}
                      title={runtimeInsight?.title ?? t('Fallback output active')}
                      description={
                        runtimeInsight?.description ??
                        t('Runtime is unavailable, showing fallback output.')
                      }
                    />
                    {selectedRunNotice ? (
                      <InlineAlert
                        tone={selectedRunNotice.tone}
                        title={selectedRunNotice.title}
                        description={selectedRunNotice.description}
                      />
                    ) : null}
                    <Suspense
                      fallback={
                        <StateBlock
                          variant="loading"
                          title={t('Loading')}
                          description={t('Preparing result preview.')}
                        />
                      }
                    >
                      <PredictionVisualizer output={selectedRun.normalized_output} imageUrl={selectedRunPreviewUrl} />
                    </Suspense>
                    <details className="workspace-details">
                      <summary>{t('Raw output (advanced)')}</summary>
                      <pre className="code-block">
                        {JSON.stringify(
                          {
                            raw_output: selectedRun.raw_output,
                            normalized_output: selectedRun.normalized_output
                          },
                          null,
                          2
                        )}
                      </pre>
                    </details>
                  </>
                )}
              </Card>
            </div>
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <div ref={feedbackPanelRef}>
              <SectionCard
                title={t('Feedback')}
                description={t('Route the sample back to a matching dataset.')}
              >
                {!selectedRun ? (
                  <StateBlock
                    variant="empty"
                    title={t('No runs yet')}
                    description={t('Run inference first.')}
                  />
                ) : datasets.length === 0 ? (
                  <StateBlock
                    variant="empty"
                    title={t('No datasets yet')}
                    description={t('Create or import a dataset first.')}
                  />
                ) : feedbackDatasets.length === 0 ? (
                  <StateBlock
                    variant="empty"
                    title={t('No matching datasets')}
                    description={t('Create a dataset with the same task type first.')}
                  />
                ) : feedbackTaskType ? (
                  <small className="muted">
                    {t('Only datasets with task type {taskType} are shown.', {
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
                </div>

                <details className="workspace-details">
                  <summary>{t('Feedback reason')}</summary>
                  <label>
                    {t('Reason')}
                    <Input
                      value={feedbackReason}
                      onChange={(event) => setFeedbackReason(event.target.value)}
                      placeholder={t('For example: missing_detection')}
                    />
                  </label>
                </details>

                <ActionBar
                  primary={
                    <Button onClick={sendFeedback} disabled={busy || !selectedRun || !selectedDatasetId}>
                      {t('Send to Dataset')}
                    </Button>
                  }
                  secondary={
                    <ButtonLink to={scopedAnnotationPath} variant="ghost" size="sm">
                      {t('Open Annotation Workspace')}
                    </ButtonLink>
                  }
                />
                {selectedRun ? (
                  <small className="muted">
                    {t('The link includes queue and run metadata.')}
                  </small>
                ) : null}
              </SectionCard>

              <details className="workspace-details">
                <summary>
                  <span>{t('Recent runs')}</span>
                  <Badge tone="neutral">{runs.length}</Badge>
                </summary>
                <div className="workspace-disclosure-content">
                  <label className="stack tight">
                    <small className="muted">{t('Select run')}</small>
                    <Select
                      value={selectedRun?.id ?? ''}
                      onChange={(event) => setSelectedRunId(event.target.value)}
                      disabled={runs.length === 0}
                    >
                      {runs.length === 0 ? (
                        <option value="">{t('No runs yet')}</option>
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
              </details>
            </div>
          </div>
        }
      />
    </WorkspacePage>
  );
}
