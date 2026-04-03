import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DatasetRecord,
  FileAttachment,
  InferenceRunRecord,
  ModelVersionRecord,
  RuntimeConnectivityRecord
} from '../../shared/domain';
import AttachmentUploader from '../components/AttachmentUploader';
import PredictionVisualizer from '../components/PredictionVisualizer';
import StateBlock from '../components/StateBlock';
import StepIndicator from '../components/StepIndicator';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

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
  const [feedbackReason, setFeedbackReason] = useState('missed_detection');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState('');
  const [runtimeChecks, setRuntimeChecks] = useState<RuntimeConnectivityRecord[]>([]);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);

  const loadAll = useCallback(async () => {
    const [versionResult, datasetResult, attachmentResult, runResult] = await Promise.all([
      api.listModelVersions(),
      api.listDatasets(),
      api.listConversationAttachments(),
      api.listInferenceRuns()
    ]);

    setVersions(versionResult);
    setDatasets(datasetResult);
    setAttachments(attachmentResult);
    setRuns(runResult);
    setSelectedRunId((prev) => prev || runResult[0]?.id || '');

    if (versionResult.length > 0 && !selectedVersionId) {
      setSelectedVersionId(versionResult[0].id);
    }

    if (datasetResult.length > 0 && !selectedDatasetId) {
      setSelectedDatasetId(datasetResult[0].id);
    }

    const ready = attachmentResult.find((attachment) => attachment.status === 'ready');
    if (ready && !selectedAttachmentId) {
      setSelectedAttachmentId(ready.id);
    }
  }, [selectedAttachmentId, selectedDatasetId, selectedVersionId]);

  useEffect(() => {
    setLoading(true);
    loadAll()
      .then(() => setFeedback(null))
      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }))
      .finally(() => setLoading(false));
  }, [loadAll]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      loadAll().catch(() => {
        // no-op
      });
    }, 900);

    return () => window.clearInterval(timer);
  }, [loadAll]);

  const selectedVersion = useMemo(
    () => versions.find((version) => version.id === selectedVersionId) ?? null,
    [versions, selectedVersionId]
  );

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId]
  );

  const runtimeInsight = useMemo(() => {
    if (!selectedRun) {
      return null;
    }

    const normalizedMeta = selectedRun.normalized_output.normalized_output as Record<string, unknown>;
    const source =
      typeof normalizedMeta.source === 'string' && normalizedMeta.source.trim()
        ? normalizedMeta.source
        : 'mock_default';

    const fallbackReason =
      typeof selectedRun.raw_output.runtime_fallback_reason === 'string'
        ? selectedRun.raw_output.runtime_fallback_reason
        : '';
    const runtimeFramework =
      typeof selectedRun.raw_output.runtime_framework === 'string'
        ? selectedRun.raw_output.runtime_framework
        : selectedRun.framework;

    return {
      source,
      runtimeFramework,
      fallbackReason,
      isFallback: source === 'mock_fallback'
    };
  }, [selectedRun]);

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

  const uploadInput = async (filename: string) => {
    await api.uploadConversationAttachment(filename);
    await loadAll();
  };

  const removeInput = async (attachmentId: string) => {
    await api.removeAttachment(attachmentId);
    await loadAll();
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
      await loadAll();
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

    setBusy(true);
    setFeedback(null);

    try {
      await api.sendInferenceFeedback({
        run_id: selectedRun.id,
        dataset_id: selectedDatasetId,
        reason: feedbackReason
      });

      setFeedback({ variant: 'success', text: t('Sample feedback sent to dataset.') });
      await loadAll();
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <h2>{t('Inference Validation')}</h2>
      <StepIndicator steps={steps} current={step} />

      {loading ? (
        <StateBlock variant="loading" title={t('Loading Validation Workspace')} description={t('Preparing resources.')} />
      ) : null}

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}

      <AttachmentUploader
        title={t('Inference Inputs')}
        items={attachments}
        onUpload={uploadInput}
        onDelete={removeInput}
        emptyDescription={t('Upload image inputs for inference validation.')}
        uploadButtonLabel={t('Upload Inference Input')}
        disabled={busy}
      />

      <section className="card stack">
        <h3>{t('Run Inference')}</h3>
        <label>
          {t('Model Version')}
          <select
            value={selectedVersionId}
            onChange={(event) => setSelectedVersionId(event.target.value)}
          >
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.version_name} ({version.task_type} / {version.framework})
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('Input Attachment')}
          <select
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
          </select>
        </label>
        <button onClick={runInference} disabled={busy || !selectedVersionId || !selectedAttachmentId}>
          {t('Run Inference')}
        </button>
      </section>

      <section className="card stack">
        <div className="row between gap align-center">
          <h3>{t('Runtime Connectivity')}</h3>
          <button onClick={loadRuntimeConnectivity} disabled={runtimeLoading || busy}>
            {runtimeLoading ? t('Checking...') : t('Refresh Runtime Status')}
          </button>
        </div>
        {runtimeError ? (
          <StateBlock variant="error" title={t('Runtime Check Failed')} description={runtimeError} />
        ) : null}
        <div className="three-col">
          {(['paddleocr', 'doctr', 'yolo'] as const).map((framework) => {
            const item = runtimeByFramework.get(framework);
            const source = item?.source ?? 'not_configured';
            const isReady = item?.source === 'reachable';

            return (
              <article key={framework} className="card stack tight">
                <strong>{framework}</strong>
                <span className="chip">
                  {source === 'reachable'
                    ? 'reachable'
                    : source === 'unreachable'
                      ? 'unreachable'
                      : 'not configured'}
                </span>
                <small className="muted">endpoint: {item?.endpoint ?? 'not set'}</small>
                <small className="muted">error kind: {item?.error_kind ?? 'none'}</small>
                <small className="muted">{item?.message ?? 'No check data yet.'}</small>
                {isReady ? (
                  <StateBlock
                    variant="success"
                    title={t('Runtime Ready')}
                    description={t('This framework can serve runtime prediction calls.')}
                  />
                ) : source === 'unreachable' ? (
                  <StateBlock
                    variant="error"
                    title={t('Runtime Unreachable')}
                    description={t('Inference will use mock fallback until runtime endpoint is reachable.')}
                  />
                ) : (
                  <StateBlock
                    variant="empty"
                    title={t('Fallback Mode')}
                    description={t('Inference will use mock fallback until runtime endpoint is reachable.')}
                  />
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section className="card stack">
        <h3>{t('Latest Inference Output')}</h3>
        {!selectedRun ? (
          <StateBlock variant="empty" title={t('No Runs Yet')} description={t('Run inference to inspect outputs.')} />
        ) : (
          <>
            <label>
              {t('Select Run')}
              <select value={selectedRun.id} onChange={(event) => setSelectedRunId(event.target.value)}>
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.id} ({run.task_type} / {run.framework} / {run.status})
                  </option>
                ))}
              </select>
            </label>
            <small className="muted">
              run {selectedRun.id} · task {selectedRun.task_type} · framework {selectedRun.framework}
            </small>
            <div className="row gap wrap">
              <span className="chip">runtime source: {runtimeInsight?.source ?? 'unknown'}</span>
              <span className="chip">runtime framework: {runtimeInsight?.runtimeFramework ?? 'unknown'}</span>
            </div>
            {runtimeInsight?.isFallback ? (
              <StateBlock
                variant="empty"
                title={t('Runtime Fallback Active')}
                description={
                  runtimeInsight.fallbackReason
                    ? t('Using mock fallback because runtime call failed: {reason}', {
                        reason: runtimeInsight.fallbackReason
                      })
                    : t('Using mock fallback because runtime endpoint is unavailable.')
                }
              />
            ) : (
              <StateBlock
                variant="success"
                title={t('Runtime Bridge Active')}
                description={t('Prediction output is coming from configured runtime endpoint.')}
              />
            )}
            <PredictionVisualizer output={selectedRun.normalized_output} />
            <h4>{t('Raw Output')}</h4>
            <pre className="code-block">{JSON.stringify(selectedRun.raw_output, null, 2)}</pre>
            <h4>{t('Normalized Output')}</h4>
            <pre className="code-block">{JSON.stringify(selectedRun.normalized_output, null, 2)}</pre>
          </>
        )}
      </section>

      <section className="card stack">
        <h3>{t('Feedback to Dataset')}</h3>
        <label>
          {t('Target Dataset')}
          <select
            value={selectedDatasetId}
            onChange={(event) => setSelectedDatasetId(event.target.value)}
          >
            {datasets.map((dataset) => (
              <option key={dataset.id} value={dataset.id}>
                {dataset.name} ({dataset.task_type})
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('Feedback Reason')}
          <input
            value={feedbackReason}
            onChange={(event) => setFeedbackReason(event.target.value)}
            placeholder="missed_detection"
          />
        </label>
        <button onClick={sendFeedback} disabled={busy || !selectedRun || !selectedDatasetId}>
          {t('Send to Dataset')}
        </button>
      </section>
    </div>
  );
}
