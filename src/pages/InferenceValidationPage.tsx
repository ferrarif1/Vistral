import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Button } from '../components/ui/Button';
import { Input, Select } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

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

export default function InferenceValidationPage() {
  const { t } = useI18n();
  const steps = useMemo(() => [t('Input'), t('Run'), t('Feedback')], [t]);
  const [versions, setVersions] = useState<ModelVersionRecord[]>([]);
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [runs, setRuns] = useState<InferenceRunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [selectedDatasetId, setSelectedDatasetId] = useState('');
  const [selectedAttachmentId, setSelectedAttachmentId] = useState('');
  const [feedbackReason, setFeedbackReason] = useState('missing_detection');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState('');
  const [runtimeChecks, setRuntimeChecks] = useState<RuntimeConnectivityRecord[]>([]);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
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
        setVersions(versionResult);
        setDatasets(datasetResult);
        setAttachments(attachmentResult);
        setRuns(runResult);
        setSelectedRunId((prev) => (prev && runResult.some((run) => run.id === prev) ? prev : runResult[0]?.id || ''));
        setSelectedVersionId((prev) =>
          prev && versionResult.some((version) => version.id === prev) ? prev : versionResult[0]?.id || ''
        );
        setSelectedDatasetId((prev) =>
          prev && datasetResult.some((dataset) => dataset.id === prev) ? prev : datasetResult[0]?.id || ''
        );
        setSelectedAttachmentId((prev) => {
          const readyAttachments = attachmentResult.filter((attachment) => attachment.status === 'ready');
          return prev && readyAttachments.some((attachment) => attachment.id === prev)
            ? prev
            : readyAttachments[0]?.id || '';
        });
      }
    } finally {
      if (mode === 'initial') {
        setLoading(false);
      }

      if (mode === 'manual') {
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    loadAll('initial')
      .then(() => setFeedback(null))
      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }));
  }, [loadAll]);

  const selectedVersion = useMemo(
    () => versions.find((version) => version.id === selectedVersionId) ?? null,
    [versions, selectedVersionId]
  );

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId]
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
        text: t('Inference run {runId} completed.', { runId: created.id })
      });
      await loadAll('manual');
      setSelectedRunId(created.id);
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
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const heroSection = (
    <>
      <Card className="workspace-overview-hero">
        <div className="workspace-overview-hero-grid">
          <div className="workspace-overview-copy stack">
            <small className="workspace-eyebrow">{t('Validation Lane')}</small>
            <div className="workspace-section-header">
              <div className="stack tight">
                <h1>{t('Inference Validation')}</h1>
                <p className="muted">
                  {t('Run validation, inspect normalized output, and route failure samples back into dataset workflows.')}
                </p>
              </div>
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
          <div className="workspace-overview-badges">
            <div className="workspace-overview-badge">
              <span>{t('Ready inputs')}</span>
              <strong>{readyAttachmentCount}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Model versions')}</span>
              <strong>{versions.length}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Recorded runs')}</span>
              <strong>{runs.length}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Feedback sent')}</span>
              <strong>{feedbackRunCount}</strong>
            </div>
          </div>
        </div>
      </Card>

      <StepIndicator steps={steps} current={step} />
    </>
  );

  if (loading) {
    return (
      <div className="workspace-overview-page stack">
        {heroSection}
        <StateBlock variant="loading" title={t('Loading Validation Workspace')} description={t('Preparing resources.')} />
      </div>
    );
  }

  return (
    <div className="workspace-overview-page stack">
      {heroSection}

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}

      <section className="workspace-overview-signal-grid">
        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Ready inputs')}</h3>
            <small className="muted">{t('Attachments that can be selected immediately for validation runs.')}</small>
          </div>
          <strong className="metric">{readyAttachmentCount}</strong>
        </Card>
        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Model versions')}</h3>
            <small className="muted">{t('Registered versions available for validation in the current workspace.')}</small>
          </div>
          <strong className="metric">{versions.length}</strong>
        </Card>
        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Datasets')}</h3>
            <small className="muted">{t('Target datasets available for failure-sample feedback routing.')}</small>
          </div>
          <strong className="metric">{datasets.length}</strong>
        </Card>
        <Card as="article" className={`workspace-signal-card${reachableRuntimeCount === 0 ? ' attention' : ''}`}>
          <div className="workspace-signal-top">
            <h3>{t('Reachable runtimes')}</h3>
            <small className="muted">{t('Framework bridges currently reachable from the validation workspace.')}</small>
          </div>
          <strong className="metric">{runtimeChecks.length === 0 && runtimeLoading ? t('Checking...') : reachableRuntimeCount}</strong>
        </Card>
      </section>

      <section className="workspace-overview-panel-grid">
        <div className="workspace-overview-main">
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
            <div className="workspace-section-header">
              <div className="stack tight">
                <h3>{t('Run Inference')}</h3>
                <small className="muted">
                  {t('Pick one registered version and one ready attachment, then execute a validation run.')}
                </small>
              </div>
            </div>

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
            <div className="row gap wrap">
              <Button onClick={runInference} disabled={busy || !selectedVersionId || !selectedAttachmentId}>
                {t('Run Inference')}
              </Button>
            </div>
          </Card>

          <Card as="article">
            <div className="workspace-section-header">
              <div className="stack tight">
                <h3>{t('Latest Inference Output')}</h3>
                <small className="muted">
                  {t('Review runtime source, preview image, normalized output, and raw payload from the selected run.')}
                </small>
              </div>
            </div>

            {!selectedRun ? (
              <StateBlock variant="empty" title={t('No Runs Yet')} description={t('Run inference to inspect outputs.')} />
            ) : (
              <>
                <label>
                  {t('Select Run')}
                  <Select value={selectedRun.id} onChange={(event) => setSelectedRunId(event.target.value)}>
                    {runs.map((run) => (
                      <option key={run.id} value={run.id}>
                        {run.id} ({t(run.task_type)} / {t(run.framework)} / {t(run.status)})
                      </option>
                    ))}
                  </Select>
                </label>
                <small className="muted">
                  {t('Run {runId} · Task {task} · Framework {framework}', {
                    runId: selectedRun.id,
                    task: t(selectedRun.task_type),
                    framework: t(selectedRun.framework)
                  })}
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
        </div>

        <div className="workspace-overview-side">
          <Card as="article">
            <div className="workspace-section-header">
              <div className="stack tight">
                <h3>{t('Runtime Connectivity')}</h3>
                <small className="muted">
                  {t('Refresh framework diagnostics on demand without interrupting the validation lane.')}
                </small>
              </div>
              <Button type="button" variant="secondary" size="sm" onClick={loadRuntimeConnectivity} disabled={runtimeLoading || busy}>
                {runtimeLoading ? t('Checking...') : t('Refresh Runtime Status')}
              </Button>
            </div>
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
                    <small className="muted">{item?.message ?? t('No check data yet.')}</small>
                    <small className="muted">{sourceDescription}</small>
                  </Panel>
                );
              })}
            </ul>
          </Card>

          <Card as="article">
            <div className="workspace-section-header">
              <div className="stack tight">
                <h3>{t('Feedback to Dataset')}</h3>
                <small className="muted">
                  {t('Push the selected failure sample back into a dataset so the next training loop can absorb it.')}
                </small>
              </div>
            </div>

            {datasets.length === 0 ? (
              <StateBlock
                variant="empty"
                title={t('No Datasets Yet')}
                description={t('Create or import a dataset before sending failure samples back.')}
              />
            ) : null}
            {datasets.length > 0 && feedbackDatasets.length === 0 ? (
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
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}
