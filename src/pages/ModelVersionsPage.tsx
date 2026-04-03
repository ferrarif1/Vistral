import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ModelRecord, ModelVersionRecord, TrainingJobRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

export default function ModelVersionsPage() {
  const { t } = useI18n();
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
      setFeedback({ variant: 'error', text: t('Select model/job and fill version name.') });
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

      setFeedback({
        variant: 'success',
        text: t('Model version {versionId} registered.', { versionId: created.id })
      });
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
      <h2>{t('Model Versions')}</h2>
      <p className="muted">{t('Register and inspect model versions linked to training outputs.')}</p>

      <section className="card stack">
        <h3>{t('Register New Version')}</h3>
        <label>
          {t('Model')}
          <select value={modelId} onChange={(event) => setModelId(event.target.value)}>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name} ({t(model.model_type)})
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('Completed Training Job')}
          <select value={jobId} onChange={(event) => setJobId(event.target.value)}>
            {completedJobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.name} ({t(job.framework)})
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('Version Name')}
          <input
            value={versionName}
            onChange={(event) => setVersionName(event.target.value)}
            placeholder={t('for example: v2026.04.02')}
          />
        </label>
        <button onClick={registerVersion} disabled={submitting || completedJobs.length === 0}>
          {submitting ? t('Registering...') : t('Register Model Version')}
        </button>
      </section>

      {loading ? (
        <StateBlock variant="loading" title={t('Loading Versions')} description={t('Fetching model version list.')} />
      ) : null}

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}

      {!loading && versions.length === 0 ? (
        <StateBlock variant="empty" title={t('No Versions')} description={t('Register first model version from completed job.')} />
      ) : null}

      {!loading && versions.length > 0 ? (
        <ul className="list">
          {versions.map((version) => (
            <li key={version.id} className="card stack">
              <div className="row between gap">
                <strong>{version.version_name}</strong>
                <span className="chip">
                  {t(version.task_type)} · {t(version.framework)}
                </span>
              </div>
              <small className="muted">
                {t('model')} {version.model_id} · {t('job')} {version.training_job_id ?? t('manual')} · {t('status')} {t(version.status)}
              </small>
              <small className="muted">
                {t('metrics')}: {Object.entries(version.metrics_summary)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(', ') || t('N/A')}
              </small>
              <small className="muted">
                {t('artifact')}: {version.artifact_attachment_id ?? t('pending')}
              </small>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
