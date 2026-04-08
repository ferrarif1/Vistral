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
import { Input, Select } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceSplit
} from '../components/ui/WorkspacePage';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';

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

const buildScopedDatasetDetailPath = (datasetId: string, versionId?: string): string => {
  if (!versionId?.trim()) {
    return `/datasets/${datasetId}`;
  }

  const searchParams = new URLSearchParams();
  searchParams.set('version', versionId.trim());
  return `/datasets/${datasetId}?${searchParams.toString()}`;
};

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

const buildScopedTrainingJobsPath = (datasetId: string, versionId?: string): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('dataset', datasetId);
  if (versionId?.trim()) {
    searchParams.set('version', versionId.trim());
  }
  return `/training/jobs?${searchParams.toString()}`;
};

export default function InferenceValidationPage() {
  const { t } = useI18n();
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
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const preferredDatasetId = (searchParams.get('dataset') ?? '').trim();
  const preferredVersionId = (searchParams.get('version') ?? '').trim();
  const preferredContextAppliedRef = useRef(false);
  const resourcesSignatureRef = useRef('');

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
  const scopedTrainingJobsPath = scopedDatasetId
    ? buildScopedTrainingJobsPath(scopedDatasetId, scopedVersionId)
    : '/training/jobs';
  const scopedDatasetDetailPath = scopedDatasetId
    ? buildScopedDatasetDetailPath(scopedDatasetId, scopedVersionId)
    : '/datasets';
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
        metadataFilter: selectedRun?.id
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

    const normalizedMeta = selectedRun.normalized_output.normalized_output as Record<string, unknown>;
    const rawMeta =
      selectedRun.raw_output.meta && typeof selectedRun.raw_output.meta === 'object' && !Array.isArray(selectedRun.raw_output.meta)
        ? (selectedRun.raw_output.meta as Record<string, unknown>)
        : null;
    const source =
      typeof normalizedMeta.source === 'string' && normalizedMeta.source.trim()
        ? normalizedMeta.source
        : 'mock_default';
    const runnerMode =
      rawMeta && typeof rawMeta.mode === 'string' && rawMeta.mode.trim() ? rawMeta.mode.trim() : '';

    const fallbackReason =
      (rawMeta && typeof rawMeta.fallback_reason === 'string' ? rawMeta.fallback_reason : '') ||
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
    const sourceKind =
      source === 'mock_fallback'
        ? 'mock_fallback'
        : source.endsWith('_runtime')
          ? 'runtime'
          : source.endsWith('_local_command')
            ? 'local_command'
            : source.endsWith('_local')
              ? 'local'
              : 'unknown';

    const title =
      sourceKind === 'runtime'
        ? t('Runtime Bridge Active')
        : sourceKind === 'local_command' && runnerMode === 'real'
          ? t('Local Runner Active')
          : sourceKind === 'local_command'
            ? t('Template Runner Fallback')
            : sourceKind === 'local'
              ? t('Deterministic Local Fallback')
              : t('Runtime Fallback Active');
    const description =
      sourceKind === 'runtime'
        ? t('Prediction output is coming from configured runtime endpoint.')
        : sourceKind === 'local_command' && runnerMode === 'real'
          ? t('Prediction output is coming from local framework runner and version-bound artifact when available.')
          : sourceKind === 'local_command'
            ? fallbackReason
              ? t('Prediction output is coming from bundled template runner because real framework execution is unavailable: {reason}', {
                  reason: fallbackReason
                })
              : t('Prediction output is coming from bundled template runner because real framework execution is unavailable.')
            : sourceKind === 'local'
              ? fallbackReason
                ? t('Prediction output is coming from deterministic local fallback: {reason}', {
                    reason: fallbackReason
                  })
                : t('Prediction output is coming from deterministic local fallback, not framework runtime.')
              : fallbackReason
                ? t('Using mock fallback because runtime call failed: {reason}', {
                    reason: fallbackReason
                  })
                : t('Using mock fallback because runtime endpoint is unavailable.');
    const variant: 'success' | 'error' | 'empty' =
      sourceKind === 'runtime' || (sourceKind === 'local_command' && runnerMode === 'real')
        ? 'success'
        : sourceKind === 'mock_fallback'
          ? 'error'
          : 'empty';

    return {
      source,
      runtimeFramework,
      fallbackReason,
      runnerMode,
      sourceKind,
      title,
      description,
      variant
    };
  }, [selectedRun, t]);

  const runtimeByFramework = useMemo(
    () => new Map(runtimeChecks.map((item) => [item.framework, item])),
    [runtimeChecks]
  );

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

  const heroSection = (
    <WorkspaceHero
      eyebrow={t('Validation Lane')}
      title={t('Inference Validation')}
      description={t('Run validation, inspect normalized output, and route failure samples back into dataset workflows.')}
      actions={
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
      stats={[
        { label: t('Ready inputs'), value: readyAttachmentCount },
        { label: t('Model versions'), value: versions.length },
        { label: t('Recorded runs'), value: runs.length },
        { label: t('Feedback sent'), value: feedbackRunCount }
      ]}
    />
  );

  if (loading) {
    return (
      <WorkspacePage>
        {heroSection}
        <StepIndicator steps={steps} current={step} />
        <StateBlock variant="loading" title={t('Loading Validation Workspace')} description={t('Preparing resources.')} />
      </WorkspacePage>
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
            title: t('Ready inputs'),
            description: t('Attachments that can be selected immediately for validation runs.'),
            value: readyAttachmentCount
          },
          {
            title: t('Model versions'),
            description: t('Registered versions available for validation in the current workspace.'),
            value: versions.length
          },
          {
            title: t('Datasets'),
            description: t('Target datasets available for failure-sample feedback routing.'),
            value: datasets.length
          },
          {
            title: t('Reachable runtimes'),
            description: t('Framework bridges currently reachable from the validation workspace.'),
            value: runtimeChecks.length === 0 && runtimeLoading ? t('Checking...') : reachableRuntimeCount,
            tone: reachableRuntimeCount === 0 ? 'attention' : 'default'
          },
          {
            title: t('Context prefill'),
            description: t('Dataset/version context provided from dataset detail actions.'),
            value: hasPrefilledContext ? t('Ready') : t('N/A')
          }
        ]}
      />

      {hasPrefilledContext ? (
        <StateBlock
          variant="success"
          title={t('Validation context preselected')}
          description={selectedDataset
            ? t('Dataset context is prefilled from dataset detail. You can run and feed back quickly in the same lane.')
            : t('Dataset context was requested from dataset detail.')}
          extra={
            <div className="row gap wrap">
              {selectedDataset ? <Badge tone="info">{selectedDataset.name}</Badge> : null}
              {selectedVersion ? <Badge tone="info">{selectedVersion.version_name}</Badge> : null}
            </div>
          }
        />
      ) : null}

      <WorkspaceSplit
        main={
          <>
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

            <Card as="article">
              <WorkspaceSectionHeader
                title={t('Run Inference')}
                description={t('Pick one registered version and one ready attachment, then execute a validation run.')}
              />

            {versions.length === 0 ? (
              <StateBlock
                variant="empty"
                title={t('No Model Versions Yet')}
                description={t('Register or train a model version before running validation.')}
              />
            ) : null}

            {readyAttachmentCount === 0 ? (
              <StateBlock
                variant="empty"
                title={t('No Ready Inputs Yet')}
                description={t('Upload at least one ready input attachment before running inference.')}
              />
            ) : null}

            <div className="workspace-form-grid">
              <label>
                {t('Model Version')}
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
              <label>
                {t('Input Attachment')}
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
            </div>
            {selectedDataset ? (
              <small className="muted">
                {t('Scoped dataset context')}: {selectedDataset.name} ({t(selectedDataset.task_type)})
              </small>
            ) : null}
            <div className="row gap wrap">
              <Button onClick={runInference} disabled={busy || !selectedVersionId || !selectedAttachmentId}>
                {t('Run Inference')}
              </Button>
            </div>
          </Card>

            <Card as="article">
              <WorkspaceSectionHeader
                title={t('Latest Inference Output')}
                description={t('Review runtime source, preview image, normalized output, and raw payload from the selected run.')}
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
              <StateBlock variant="empty" title={t('No Runs Yet')} description={t('Run inference to inspect outputs.')} />
            ) : (
              <>
                {selectedRunError ? (
                  <StateBlock variant="error" title={t('Run detail unavailable')} description={selectedRunError} />
                ) : null}
                <label>
                  {t('Select Run')}
                  <Select value={selectedRun.id} onChange={(event) => setSelectedRunId(event.target.value)}>
                    {runs.map((run) => (
                    <option key={run.id} value={run.id}>
                        {describeRun(run) +
                          ' · ' +
                          formatCompactTimestamp(run.updated_at, t('n/a')) +
                          ' · ' +
                          t(run.status)}
                      </option>
                    ))}
                  </Select>
                </label>
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
                    {t('runtime source')}: {runtimeInsight?.source ? t(runtimeInsight.source) : t('unknown')}
                  </Badge>
                  <Badge tone="info">
                    {t('runtime framework')}: {runtimeInsight?.runtimeFramework ? t(runtimeInsight.runtimeFramework) : t('unknown')}
                  </Badge>
                  <Badge tone="neutral">
                    {t('runner mode')}: {runtimeInsight?.runnerMode ? t(runtimeInsight.runnerMode) : t('n/a')}
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
                  title={runtimeInsight?.title ?? t('Runtime Fallback Active')}
                  description={runtimeInsight?.description ?? t('Using mock fallback because runtime endpoint is unavailable.')}
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
          </>
        }
        side={
          <>
            <Card as="article">
              <WorkspaceSectionHeader
                title={t('Current status')}
                description={t(
                  'Run validation, inspect normalized output, and route failure samples back into dataset workflows.'
                )}
              />
              <ul className="workspace-record-list compact">
                <Panel as="li" className="workspace-record-item compact" tone="soft">
                  <div className="row between gap wrap">
                    <strong>{t('Model Version')}</strong>
                    <Badge tone="neutral">{selectedVersion?.version_name ?? t('n/a')}</Badge>
                  </div>
                  <small className="muted">
                    {selectedVersion ? `${t(selectedVersion.task_type)} · ${t(selectedVersion.framework)}` : t('No Model Versions Yet')}
                  </small>
                </Panel>
                <Panel as="li" className="workspace-record-item compact" tone="soft">
                  <div className="row between gap wrap">
                    <strong>{t('Input Attachment')}</strong>
                    <Badge tone={selectedAttachment ? 'info' : 'neutral'}>
                      {selectedAttachment?.filename ?? t('n/a')}
                    </Badge>
                  </div>
                  <small className="muted">{t('Ready files')}: {readyAttachmentCount}</small>
                </Panel>
                <Panel as="li" className="workspace-record-item compact" tone="soft">
                  <div className="row between gap wrap">
                    <strong>{t('Target Dataset')}</strong>
                    <Badge tone={selectedFeedbackDataset ? 'neutral' : 'warning'}>
                      {selectedFeedbackDataset?.name ?? t('n/a')}
                    </Badge>
                  </div>
                  <small className="muted">
                    {feedbackTaskType
                      ? t('Only datasets with task {taskType} are shown for feedback.', {
                          taskType: t(feedbackTaskType)
                        })
                      : t('No Runs Yet')}
                  </small>
                </Panel>
              </ul>
            </Card>

            <Card as="article">
              <WorkspaceSectionHeader
                title={t('Runtime Connectivity')}
                description={t('Refresh framework diagnostics on demand without interrupting the validation lane.')}
                actions={
                  <Button type="button" variant="secondary" size="sm" onClick={loadRuntimeConnectivity} disabled={runtimeLoading || busy}>
                    {runtimeLoading ? t('Checking...') : t('Refresh Runtime Status')}
                  </Button>
                }
              />
            {runtimeError ? (
              <StateBlock variant="error" title={t('Runtime Check Failed')} description={runtimeError} />
            ) : null}
            <ul className="workspace-record-list compact">
              {(['paddleocr', 'doctr', 'yolo'] as const).map((framework) => {
                const item = runtimeByFramework.get(framework);
                const source = item?.source ?? 'not_configured';
                const tone = source === 'reachable' ? 'success' : source === 'unreachable' ? 'warning' : 'neutral';
                const sourceLabel =
                  source === 'reachable'
                    ? t('reachable')
                    : source === 'unreachable'
                      ? t('unreachable')
                      : t('not configured');
                const sourceDescription =
                  source === 'reachable'
                    ? t('Runtime endpoint is healthy and can serve prediction calls.')
                    : source === 'unreachable'
                      ? t('Runtime endpoint is configured but currently unreachable. Inference falls back until recovered.')
                      : t('Runtime endpoint is not configured. Inference uses fallback mode by default.');

                return (
                  <Panel key={framework} as="li" className="workspace-record-item compact" tone="soft">
                    <div className="row between gap wrap">
                      <strong>{t(framework)}</strong>
                      <Badge tone={tone}>{sourceLabel}</Badge>
                    </div>
                    <div className="row gap wrap">
                      <Badge tone="neutral">{t('endpoint')}: {item?.endpoint ?? t('not set')}</Badge>
                      <Badge tone={item?.error_kind ? 'warning' : 'neutral'}>
                        {t('error kind')}: {item?.error_kind ? t(item.error_kind) : t('none')}
                      </Badge>
                    </div>
                    <small className="muted">
                      {t('checked at')}: {formatCompactTimestamp(item?.checked_at ?? null, t('n/a'))}
                    </small>
                    <small className="muted">{item?.message ?? t('No check data yet.')}</small>
                    <small className="muted">{sourceDescription}</small>
                  </Panel>
                );
              })}
            </ul>
            </Card>

            <Card as="article">
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
            <div className="row gap wrap">
              <Button onClick={sendFeedback} disabled={busy || !selectedRun || !selectedDatasetId}>
                {t('Send to Dataset')}
              </Button>
              <ButtonLink to={scopedDatasetDetailPath} variant="ghost" size="sm">
                {t('Open scoped dataset')}
              </ButtonLink>
              <ButtonLink to={scopedAnnotationPath} variant="ghost" size="sm">
                {t('Open scoped annotation')}
              </ButtonLink>
              <ButtonLink to={scopedTrainingJobsPath} variant="ghost" size="sm">
                {t('Open scoped jobs')}
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
          </>
        }
      />
    </WorkspacePage>
  );
}
