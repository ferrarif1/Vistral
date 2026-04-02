import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DatasetRecord,
  FileAttachment,
  InferenceRunRecord,
  ModelVersionRecord
} from '../../shared/domain';
import AttachmentUploader from '../components/AttachmentUploader';
import PredictionVisualizer from '../components/PredictionVisualizer';
import StateBlock from '../components/StateBlock';
import StepIndicator from '../components/StepIndicator';
import { api } from '../services/api';

const STEPS = ['Input', 'Run', 'Feedback'];

export default function InferenceValidationPage() {
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

  const step = useMemo(() => {
    if (!selectedRun) {
      return 0;
    }

    if (selectedRun.feedback_dataset_id) {
      return 2;
    }

    return 1;
  }, [selectedRun]);

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
      setFeedback({ variant: 'error', text: 'Select model version and ready attachment first.' });
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

      setFeedback({ variant: 'success', text: `Inference run ${created.id} completed.` });
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
      setFeedback({ variant: 'error', text: 'Run inference and select dataset before feedback.' });
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

      setFeedback({ variant: 'success', text: 'Sample feedback sent to dataset.' });
      await loadAll();
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <h2>Inference Validation</h2>
      <StepIndicator steps={STEPS} current={step} />

      {loading ? (
        <StateBlock variant="loading" title="Loading Validation Workspace" description="Preparing resources." />
      ) : null}

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? 'Action Completed' : 'Action Failed'}
          description={feedback.text}
        />
      ) : null}

      <AttachmentUploader
        title="Inference Inputs"
        items={attachments}
        onUpload={uploadInput}
        onDelete={removeInput}
        emptyDescription="Upload image inputs for inference validation."
        uploadButtonLabel="Upload Inference Input"
        disabled={busy}
      />

      <section className="card stack">
        <h3>Run Inference</h3>
        <label>
          Model Version
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
          Input Attachment
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
          Run Inference
        </button>
      </section>

      <section className="card stack">
        <h3>Latest Inference Output</h3>
        {!selectedRun ? (
          <StateBlock variant="empty" title="No Runs Yet" description="Run inference to inspect outputs." />
        ) : (
          <>
            <label>
              Select Run
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
            <PredictionVisualizer output={selectedRun.normalized_output} />
            <h4>Raw Output</h4>
            <pre className="code-block">{JSON.stringify(selectedRun.raw_output, null, 2)}</pre>
            <h4>Normalized Output</h4>
            <pre className="code-block">{JSON.stringify(selectedRun.normalized_output, null, 2)}</pre>
          </>
        )}
      </section>

      <section className="card stack">
        <h3>Feedback to Dataset</h3>
        <label>
          Target Dataset
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
          Feedback Reason
          <input
            value={feedbackReason}
            onChange={(event) => setFeedbackReason(event.target.value)}
            placeholder="missed_detection"
          />
        </label>
        <button onClick={sendFeedback} disabled={busy || !selectedRun || !selectedDatasetId}>
          Send to Dataset
        </button>
      </section>
    </div>
  );
}
