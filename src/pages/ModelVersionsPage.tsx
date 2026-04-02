import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ModelRecord, ModelVersionRecord, TrainingJobRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { api } from '../services/api';

export default function ModelVersionsPage() {
  const [versions, setVersions] = useState<ModelVersionRecord[]>([]);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [jobs, setJobs] = useState<TrainingJobRecord[]>([]);
  const [modelId, setModelId] = useState('');
  const [jobId, setJobId] = useState('');
  const [versionName, setVersionName] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [versionResult, modelResult, jobResult] = await Promise.all([
        api.listModelVersions(),
        api.listMyModels(),
        api.listTrainingJobs()
      ]);

      setVersions(versionResult);
      setModels(modelResult);
      setJobs(jobResult);

      setModelId((prev) => prev || modelResult[0]?.id || '');

      const completed = jobResult.filter((job) => job.status === 'completed');
      setJobId((prev) => prev || completed[0]?.id || '');
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load().catch(() => {
      // no-op
    });
  }, [load]);

  const completedJobs = useMemo(() => jobs.filter((job) => job.status === 'completed'), [jobs]);

  const registerVersion = async () => {
    if (!modelId || !jobId || !versionName.trim()) {
      setFeedback({ variant: 'error', text: 'Select model/job and fill version name.' });
      return;
    }

    setSubmitting(true);
    setFeedback(null);

    try {
      const created = await api.registerModelVersion({
        model_id: modelId,
        training_job_id: jobId,
        version_name: versionName.trim()
      });

      setFeedback({ variant: 'success', text: `Model version ${created.id} registered.` });
      setVersionName('');
      await load();
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="stack">
      <h2>Model Versions</h2>
      <p className="muted">Register and inspect model versions linked to training outputs.</p>

      <section className="card stack">
        <h3>Register New Version</h3>
        <label>
          Model
          <select value={modelId} onChange={(event) => setModelId(event.target.value)}>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name} ({model.model_type})
              </option>
            ))}
          </select>
        </label>
        <label>
          Completed Training Job
          <select value={jobId} onChange={(event) => setJobId(event.target.value)}>
            {completedJobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.name} ({job.framework})
              </option>
            ))}
          </select>
        </label>
        <label>
          Version Name
          <input
            value={versionName}
            onChange={(event) => setVersionName(event.target.value)}
            placeholder="v2026.04.02"
          />
        </label>
        <button onClick={registerVersion} disabled={submitting || completedJobs.length === 0}>
          {submitting ? 'Registering...' : 'Register Model Version'}
        </button>
      </section>

      {loading ? (
        <StateBlock variant="loading" title="Loading Versions" description="Fetching model version list." />
      ) : null}

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? 'Action Completed' : 'Action Failed'}
          description={feedback.text}
        />
      ) : null}

      {!loading && versions.length === 0 ? (
        <StateBlock variant="empty" title="No Versions" description="Register first model version from completed job." />
      ) : null}

      {!loading && versions.length > 0 ? (
        <ul className="list">
          {versions.map((version) => (
            <li key={version.id} className="card stack">
              <div className="row between gap">
                <strong>{version.version_name}</strong>
                <span className="chip">
                  {version.task_type} · {version.framework}
                </span>
              </div>
              <small className="muted">
                model {version.model_id} · job {version.training_job_id ?? 'manual'} · status {version.status}
              </small>
              <small className="muted">
                metrics: {Object.entries(version.metrics_summary)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(', ') || 'N/A'}
              </small>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
