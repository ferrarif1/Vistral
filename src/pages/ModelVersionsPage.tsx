import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ModelRecord, ModelVersionRecord, TrainingJobRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const formatTimestamp = (iso: string): string => {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) {
    return iso;
  }

  return new Date(value).toLocaleString();
};

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
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [versionResult, modelResult, jobResult] = await Promise.all([
        api.listModelVersions(),
        api.listMyModels(),
        api.listTrainingJobs()
      ]);

      const completed = jobResult
        .filter((job) => job.status === 'completed')
        .sort((left, right) => {
          const leftTime = Date.parse(left.updated_at);
          const rightTime = Date.parse(right.updated_at);
          return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
        });

      setVersions(versionResult);
      setModels(modelResult);
      setJobs(jobResult);
      setModelId((prev) => (prev && modelResult.some((model) => model.id === prev) ? prev : modelResult[0]?.id || ''));
      setJobId((prev) => (prev && completed.some((job) => job.id === prev) ? prev : completed[0]?.id || ''));
      setError('');
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load().catch(() => {
      // no-op
    });
  }, [load]);

  const completedJobs = useMemo(
    () =>
      jobs
        .filter((job) => job.status === 'completed')
        .sort((left, right) => {
          const leftTime = Date.parse(left.updated_at);
          const rightTime = Date.parse(right.updated_at);
          return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
        }),
    [jobs]
  );

  const sortedVersions = useMemo(
    () =>
      [...versions].sort((left, right) => {
        const leftTime = Date.parse(left.created_at);
        const rightTime = Date.parse(right.created_at);
        return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
      }),
    [versions]
  );

  const modelsById = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);

  const summary = useMemo(
    () => ({
      total: versions.length,
      registered: versions.filter((version) => version.status === 'registered').length,
      deprecated: versions.filter((version) => version.status === 'deprecated').length,
      linkedArtifacts: versions.filter((version) => Boolean(version.artifact_attachment_id)).length,
      registerableJobs: completedJobs.length,
      availableModels: models.length
    }),
    [completedJobs.length, models.length, versions]
  );

  const registerVersion = async () => {
    if (!modelId || !jobId || !versionName.trim()) {
      setError(t('Select model/job and fill version name.'));
      setSuccess('');
      return;
    }

    setSubmitting(true);
    setError('');
    setSuccess('');

    try {
      const created = await api.registerModelVersion({
        model_id: modelId,
        training_job_id: jobId,
        version_name: versionName.trim()
      });

      setSuccess(t('Model version {versionId} registered.', { versionId: created.id }));
      setVersionName('');
      await load();
    } catch (registerError) {
      setError((registerError as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const registrationBlocked = models.length === 0 || completedJobs.length === 0;

  return (
    <div className="workspace-overview-page stack">
      <section className="card workspace-overview-hero">
        <div className="workspace-overview-hero-grid">
          <div className="workspace-overview-copy stack">
            <small className="workspace-eyebrow">{t('Version Registry')}</small>
            <h1>{t('Model Versions')}</h1>
            <p className="muted">{t('Register versions and keep training outputs traceable.')}</p>
          </div>
          <div className="workspace-overview-badges">
            <div className="workspace-overview-badge">
              <span>{t('Total')}</span>
              <strong>{summary.total}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Jobs ready to register')}</span>
              <strong>{summary.registerableJobs}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Artifacts linked')}</span>
              <strong>{summary.linkedArtifacts}</strong>
            </div>
          </div>
        </div>
      </section>

      {error ? <StateBlock variant="error" title={t('Action Failed')} description={error} /> : null}
      {success ? <StateBlock variant="success" title={t('Action Completed')} description={success} /> : null}

      <section className="workspace-overview-signal-grid">
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Registered versions')}</h3>
            <small className="muted">
              {t('Versions already available for inference or deployment follow-up.')}
            </small>
          </div>
          <strong className="metric">{summary.registered}</strong>
        </article>
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Jobs ready to register')}</h3>
            <small className="muted">
              {t('Completed training jobs that can be turned into model versions.')}
            </small>
          </div>
          <strong className="metric">{summary.registerableJobs}</strong>
        </article>
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Artifacts linked')}</h3>
            <small className="muted">
              {t('Versions with stored artifact attachment references.')}
            </small>
          </div>
          <strong className="metric">{summary.linkedArtifacts}</strong>
        </article>
        <article className={`card stack workspace-signal-card${summary.deprecated > 0 ? ' attention' : ''}`}>
          <div className="workspace-signal-top">
            <h3>{t('Deprecated count')}</h3>
            <small className="muted">{t('Versions marked deprecated but kept for traceability.')}</small>
          </div>
          <strong className="metric">{summary.deprecated}</strong>
        </article>
      </section>

      <section className="workspace-overview-panel-grid">
        <article className="card stack workspace-overview-main">
          <div className="workspace-section-header">
            <div className="stack tight">
              <h3>{t('Version Inventory')}</h3>
              <small className="muted">
                {t('Review registered outputs, linked metrics, and training provenance in one place.')}
              </small>
            </div>
            <button
              type="button"
              className="workspace-inline-button"
              onClick={() => {
                load().catch(() => {
                  // no-op
                });
              }}
              disabled={loading}
            >
              {loading ? t('Loading') : t('Refresh')}
            </button>
          </div>

          {loading ? (
            <StateBlock variant="loading" title={t('Loading Versions')} description={t('Fetching model version list.')} />
          ) : sortedVersions.length === 0 ? (
            <StateBlock
              variant="empty"
              title={t('No Versions')}
              description={t('Latest registered versions will appear here after the first successful registration.')}
            />
          ) : (
            <ul className="workspace-record-list">
              {sortedVersions.map((version) => {
                const linkedModel = modelsById.get(version.model_id);
                const metricsSummary = Object.entries(version.metrics_summary)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(', ');

                return (
                  <li key={version.id} className="workspace-record-item">
                    <div className="workspace-record-item-top">
                      <div className="workspace-record-summary stack tight">
                        <strong>{version.version_name}</strong>
                        <small className="muted">
                          {linkedModel?.name ?? version.model_id} · {t(version.task_type)} · {t(version.framework)} · {t('Created')}:{' '}
                          {formatTimestamp(version.created_at)}
                        </small>
                      </div>
                      <div className="workspace-record-actions">
                        <span className={`workspace-status-pill ${version.status}`}>{t(version.status)}</span>
                        {version.training_job_id ? (
                          <Link className="workspace-inline-link" to={`/training/jobs/${version.training_job_id}`}>
                            {t('Open Job')}
                          </Link>
                        ) : null}
                      </div>
                    </div>
                    <p>{metricsSummary ? `${t('metrics')}: ${metricsSummary}` : t('Metrics summary unavailable.')}</p>
                    <div className="row gap wrap">
                      <span className="chip">
                        {t('model')}: {linkedModel?.name ?? version.model_id}
                      </span>
                      <span className="chip">
                        {t('job')}: {version.training_job_id ?? t('manual')}
                      </span>
                      <span className="chip">
                        {version.artifact_attachment_id
                          ? `${t('artifact')}: ${version.artifact_attachment_id}`
                          : t('No artifact yet')}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </article>

        <div className="workspace-overview-side">
          <article className="card stack">
            <div className="stack tight">
              <h3>{t('Registration Lane')}</h3>
              <small className="muted">
                {t('Keep version registration visible while reviewing completed runs.')}
              </small>
            </div>

            {registrationBlocked ? (
              <StateBlock
                variant="empty"
                title={models.length === 0 ? t('No owned models available.') : t('No completed jobs yet.')}
                description={
                  models.length === 0
                    ? t('Create or import a model draft first.')
                    : t('Complete a training job first, then return here to register a version.')
                }
              />
            ) : (
              <>
                <div className="workspace-form-grid">
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
                  <label className="workspace-form-span-2">
                    {t('Version Name')}
                    <input
                      value={versionName}
                      onChange={(event) => setVersionName(event.target.value)}
                      placeholder={t('for example: v2026.04.02')}
                    />
                  </label>
                </div>

                <button type="button" onClick={registerVersion} disabled={submitting}>
                  {submitting ? t('Registering...') : t('Register Model Version')}
                </button>
              </>
            )}
          </article>

          <article className="card stack">
            <div className="stack tight">
              <h3>{t('Ready sources')}</h3>
              <small className="muted">
                {t('Pick from completed training outputs and keep artifact-linked versions organized.')}
              </small>
            </div>

            <ul className="workspace-record-list compact">
              <li className="workspace-record-item compact">
                <div className="row between gap wrap">
                  <strong>{t('Available models')}</strong>
                  <span className="chip">{summary.availableModels}</span>
                </div>
                <small className="muted">
                  {summary.availableModels > 0
                    ? t('Manage the model side of version registration from your owned inventory.')
                    : t('Create or import a model draft first.')}
                </small>
              </li>
              <li className="workspace-record-item compact">
                <div className="row between gap wrap">
                  <strong>{t('Completed jobs')}</strong>
                  <span className="chip">{summary.registerableJobs}</span>
                </div>
                <small className="muted">
                  {summary.registerableJobs > 0
                    ? t('Finished runs stay visible for version registration and follow-up review.')
                    : t('Complete a training job first, then return here to register a version.')}
                </small>
              </li>
            </ul>

            <div className="stack tight">
              <Link to="/models/my-models" className="workspace-inline-link">
                {t('Manage My Models')}
              </Link>
              <Link to="/training/jobs" className="workspace-inline-link">
                {t('Open Training Jobs')}
              </Link>
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}
