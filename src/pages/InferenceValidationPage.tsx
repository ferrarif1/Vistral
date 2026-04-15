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
import StepIndicator from '../components/StepIndicator';
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
  const [runtimeChecks, setRuntimeChecks] = useState<RuntimeConnectivityRecord[]>([]);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const preferredDatasetId = (searchParams.get('dataset') ?? '').trim();
  const preferredVersionId = (searchParams.get('version') ?? '').trim();
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
      displaySourceLabel: inferredReality.fallback ? t('Degraded mode') : t('Real execution'),
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

  const runtimeConnectivityTone = runtimeLoading
    ? 'neutral'
    : runtimeChecks.some((check) => check.configured && check.reachable)
      ? 'success'
      : 'warning';
  const runtimeConnectivityLabel = runtimeLoading
    ? t('Checking runtime')
    : runtimeChecks.some((check) => check.configured && check.reachable)
      ? t('Runtime checked')
      : t('Runtime not confirmed');

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
          description={t('Run one validation pass, inspect the result, and route failures back into dataset workflows.')}
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
        description={t('Validate one input, inspect the result, and route failure samples back into dataset workflows.')}
        meta={
          <div className="row gap wrap align-center">
            <Badge tone="neutral">{t('Ready inputs')}: {readyAttachmentCount}</Badge>
            <Badge tone="neutral">{t('Model versions')}: {versions.length}</Badge>
            <Badge tone="info">{t('Recorded runs')}: {runs.length}</Badge>
            <Badge tone={runtimeConnectivityTone}>{runtimeConnectivityLabel}</Badge>
          </div>
        }
        primaryAction={{
          label: busy ? t('Running...') : t('Run Inference'),
          onClick: () => {
            void runInference();
          },
          disabled: busy || refreshing || !selectedVersionId || !selectedAttachmentId
        }}
        secondaryActions={
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
        }
        />
      <StepIndicator steps={steps} current={step} />

      {feedback ? (
        <InlineAlert
          tone={feedback.variant === 'success' ? 'success' : 'danger'}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
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

      <WorkspaceWorkbench
        toolbar={
          <Card as="section" className="workspace-toolbar-card">
            <div className="workspace-toolbar-head">
              <div className="workspace-toolbar-copy">
                <h3>{t('Validation Controls')}</h3>
                <small className="muted">
                  {t('Pick one version and one ready input, then run the validation pass.')}
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
              </div>
            </div>

            {versions.length === 0 ? (
              <StateBlock
                variant="empty"
                title={t('No Model Versions Yet')}
                description={t('Register or train a model version before running validation.')}
                extra={
                  <ButtonLink to="/models/versions" variant="secondary" size="sm">
                    {t('Open Model Versions')}
                  </ButtonLink>
                }
              />
            ) : readyAttachmentCount === 0 ? (
              <StateBlock
                variant="empty"
                title={t('No Ready Inputs Yet')}
                description={t('Upload at least one ready input attachment before running inference.')}
                extra={
                  <small className="muted">
                    {t('Use the Inference Inputs uploader below to add an image or document, then rerun validation from this same page.')}
                  </small>
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

          </Card>
        }
        main={
          <div className="workspace-main-stack">
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
                  description={t('Review execution status, preview image, and normalized output for the selected run.')}
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
                      <small className="muted">
                        {t('Choose a model version and a ready input above, then click Run Inference.')}
                      </small>
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
                      description={
                        runtimeInsight?.description ??
                        t('Using degraded output because runtime endpoint is unavailable.')
                      }
                    />
                    <div className="row gap wrap">
                      <ButtonLink to="/settings/runtime" variant="ghost" size="sm">
                        {t('Open Runtime Settings')}
                      </ButtonLink>
                    </div>
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
                      <summary>{t('Technical output')}</summary>
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
                description={t('Send one failed sample to a matching dataset. Keep annotation for manual review in the dataset workspace.')}
              >
                {!selectedRun ? (
                  <StateBlock
                    variant="empty"
                    title={t('No Runs Yet')}
                    description={t('Run inference to inspect outputs.')}
                  />
                ) : datasets.length === 0 ? (
                  <StateBlock
                    variant="empty"
                    title={t('No Datasets Yet')}
                    description={t('Create or import a dataset before sending failure samples back.')}
                  />
                ) : feedbackDatasets.length === 0 ? (
                  <StateBlock
                    variant="empty"
                    title={t('No Matching Datasets')}
                    description={t('Create a dataset with task type {taskType} before sending feedback from this run.', {
                      taskType: feedbackTaskType ? t(feedbackTaskType) : t('unknown')
                    })}
                  />
                ) : feedbackTaskType ? (
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
                </div>

                <details className="workspace-details">
                  <summary>{t('Advanced feedback options')}</summary>
                  <label>
                    {t('Feedback Reason')}
                    <Input
                      value={feedbackReason}
                      onChange={(event) => setFeedbackReason(event.target.value)}
                      placeholder={t('for example: missing_detection')}
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
                    {t('Annotation link keeps queue scope and run metadata in sync.')}
                  </small>
                ) : null}
              </SectionCard>
            </div>
          </div>
        }
      />
    </WorkspacePage>
  );
}
