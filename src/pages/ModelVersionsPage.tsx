import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModelRecord, ModelVersionRecord, TrainingJobRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import VirtualList from '../components/VirtualList';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { Input, Select } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const versionsVirtualizationThreshold = 14;
const versionsVirtualRowHeight = 186;
const versionsVirtualViewportHeight = 640;
const backgroundRefreshIntervalMs = 6000;
type LoadMode = 'initial' | 'manual' | 'background';

const formatTimestamp = (iso: string): string => {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) {
    return iso;
  }

  return new Date(value).toLocaleString();
};

const buildVersionSignature = (items: ModelVersionRecord[]): string =>
  JSON.stringify(
    [...items]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => ({
        id: item.id,
        model_id: item.model_id,
        status: item.status,
        version_name: item.version_name,
        created_at: item.created_at,
        training_job_id: item.training_job_id,
        artifact_attachment_id: item.artifact_attachment_id
      }))
  );

const buildModelSignature = (items: ModelRecord[]): string =>
  JSON.stringify(
    [...items]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => ({
        id: item.id,
        name: item.name,
        model_type: item.model_type,
        status: item.status,
        updated_at: item.updated_at
      }))
  );

const buildJobSignature = (items: TrainingJobRecord[]): string =>
  JSON.stringify(
    [...items]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => ({
        id: item.id,
        status: item.status,
        framework: item.framework,
        updated_at: item.updated_at
      }))
  );

export default function ModelVersionsPage() {
  const { t } = useI18n();
  const [versions, setVersions] = useState<ModelVersionRecord[]>([]);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [jobs, setJobs] = useState<TrainingJobRecord[]>([]);
  const [modelId, setModelId] = useState('');
  const [jobId, setJobId] = useState('');
  const [versionName, setVersionName] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const versionsSignatureRef = useRef('');
  const modelsSignatureRef = useRef('');
  const jobsSignatureRef = useRef('');

  const load = useCallback(async (mode: LoadMode = 'initial') => {
    if (mode === 'initial') {
      setLoading(true);
    }

    if (mode === 'manual') {
      setRefreshing(true);
    }
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

      const nextVersionSignature = buildVersionSignature(versionResult);
      if (versionsSignatureRef.current !== nextVersionSignature) {
        versionsSignatureRef.current = nextVersionSignature;
        setVersions(versionResult);
      }

      const nextModelSignature = buildModelSignature(modelResult);
      if (modelsSignatureRef.current !== nextModelSignature) {
        modelsSignatureRef.current = nextModelSignature;
        setModels(modelResult);
      }

      const nextJobSignature = buildJobSignature(jobResult);
      if (jobsSignatureRef.current !== nextJobSignature) {
        jobsSignatureRef.current = nextJobSignature;
        setJobs(jobResult);
      }
      setModelId((prev) => (prev && modelResult.some((model) => model.id === prev) ? prev : modelResult[0]?.id || ''));
      setJobId((prev) => (prev && completed.some((job) => job.id === prev) ? prev : completed[0]?.id || ''));
      setError('');
    } catch (loadError) {
      setError((loadError as Error).message);
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
    load('initial').catch(() => {
      // no-op
    });
  }, [load]);

  const hasTransientJobState = useMemo(
    () => jobs.some((job) => ['queued', 'preparing', 'running', 'evaluating'].includes(job.status)),
    [jobs]
  );

  useBackgroundPolling(
    () => {
      load('background').catch(() => {
        // no-op
      });
    },
    {
      intervalMs: backgroundRefreshIntervalMs,
      enabled: hasTransientJobState
    }
  );

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
      await load('manual');
    } catch (registerError) {
      setError((registerError as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const registrationBlocked = models.length === 0 || completedJobs.length === 0;
  const shouldVirtualizeVersions = sortedVersions.length > versionsVirtualizationThreshold;

  return (
    <div className="workspace-overview-page stack">
      <Card className="workspace-overview-hero">
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
      </Card>

      {error ? <StateBlock variant="error" title={t('Action Failed')} description={error} /> : null}
      {success ? <StateBlock variant="success" title={t('Action Completed')} description={success} /> : null}

      <section className="workspace-overview-signal-grid">
        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Registered versions')}</h3>
            <small className="muted">
              {t('Versions already available for inference or deployment follow-up.')}
            </small>
          </div>
          <strong className="metric">{summary.registered}</strong>
        </Card>
        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Jobs ready to register')}</h3>
            <small className="muted">
              {t('Completed training jobs that can be turned into model versions.')}
            </small>
          </div>
          <strong className="metric">{summary.registerableJobs}</strong>
        </Card>
        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Artifacts linked')}</h3>
            <small className="muted">
              {t('Versions with stored artifact attachment references.')}
            </small>
          </div>
          <strong className="metric">{summary.linkedArtifacts}</strong>
        </Card>
        <Card as="article" className={`workspace-signal-card${summary.deprecated > 0 ? ' attention' : ''}`}>
          <div className="workspace-signal-top">
            <h3>{t('Deprecated count')}</h3>
            <small className="muted">{t('Versions marked deprecated but kept for traceability.')}</small>
          </div>
          <strong className="metric">{summary.deprecated}</strong>
        </Card>
      </section>

      <section className="workspace-overview-panel-grid">
        <Card as="article" className="workspace-overview-main">
          <div className="workspace-section-header">
            <div className="stack tight">
              <h3>{t('Version Inventory')}</h3>
              <small className="muted">
                {t('Review registered outputs, linked metrics, and training provenance in one place.')}
              </small>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                load('manual').catch(() => {
                  // no-op
                });
              }}
              disabled={loading || refreshing}
            >
              {loading ? t('Loading') : refreshing ? t('Refreshing...') : t('Refresh')}
            </Button>
          </div>

          {loading ? (
            <StateBlock variant="loading" title={t('Loading Versions')} description={t('Fetching model version list.')} />
          ) : sortedVersions.length === 0 ? (
            <StateBlock
              variant="empty"
              title={t('No Versions')}
              description={t('Latest registered versions will appear here after the first successful registration.')}
            />
          ) : shouldVirtualizeVersions ? (
            <VirtualList
              items={sortedVersions}
              itemHeight={versionsVirtualRowHeight}
              height={versionsVirtualViewportHeight}
              itemKey={(version) => version.id}
              listClassName="workspace-record-list"
              rowClassName="workspace-record-row"
              ariaLabel={t('Version Inventory')}
              renderItem={(version) => {
                const linkedModel = modelsById.get(version.model_id);
                const metricsSummary = Object.entries(version.metrics_summary)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(', ');

                return (
                  <Panel className="workspace-record-item virtualized" tone="soft">
                    <div className="workspace-record-item-top">
                      <div className="workspace-record-summary stack tight">
                        <strong>{version.version_name}</strong>
                        <small className="muted">
                          {linkedModel?.name ?? version.model_id} · {t(version.task_type)} · {t(version.framework)} · {t('Created')}:{' '}
                          {formatTimestamp(version.created_at)}
                        </small>
                      </div>
                      <div className="workspace-record-actions">
                        <StatusTag status={version.status}>{t(version.status)}</StatusTag>
                        {version.training_job_id ? (
                          <ButtonLink to={`/training/jobs/${version.training_job_id}`} variant="secondary" size="sm">
                            {t('Open Job')}
                          </ButtonLink>
                        ) : null}
                      </div>
                    </div>
                    <p className="line-clamp-2">
                      {metricsSummary ? `${t('metrics')}: ${metricsSummary}` : t('Metrics summary unavailable.')}
                    </p>
                    <div className="row gap wrap">
                      <Badge tone="neutral">
                        {t('model')}: {linkedModel?.name ?? version.model_id}
                      </Badge>
                      <Badge tone="info">
                        {t('job')}: {version.training_job_id ?? t('manual')}
                      </Badge>
                      <Badge tone={version.artifact_attachment_id ? 'success' : 'warning'}>
                        {version.artifact_attachment_id
                          ? `${t('artifact')}: ${version.artifact_attachment_id}`
                          : t('No artifact yet')}
                      </Badge>
                    </div>
                  </Panel>
                );
              }}
            />
          ) : (
            <ul className="workspace-record-list">
              {sortedVersions.map((version) => {
                const linkedModel = modelsById.get(version.model_id);
                const metricsSummary = Object.entries(version.metrics_summary)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(', ');

                return (
                  <Panel key={version.id} as="li" className="workspace-record-item" tone="soft">
                    <div className="workspace-record-item-top">
                      <div className="workspace-record-summary stack tight">
                        <strong>{version.version_name}</strong>
                        <small className="muted">
                          {linkedModel?.name ?? version.model_id} · {t(version.task_type)} · {t(version.framework)} · {t('Created')}:{' '}
                          {formatTimestamp(version.created_at)}
                        </small>
                      </div>
                      <div className="workspace-record-actions">
                        <StatusTag status={version.status}>{t(version.status)}</StatusTag>
                        {version.training_job_id ? (
                          <ButtonLink to={`/training/jobs/${version.training_job_id}`} variant="secondary" size="sm">
                            {t('Open Job')}
                          </ButtonLink>
                        ) : null}
                      </div>
                    </div>
                    <p className="line-clamp-2">
                      {metricsSummary ? `${t('metrics')}: ${metricsSummary}` : t('Metrics summary unavailable.')}
                    </p>
                    <div className="row gap wrap">
                      <Badge tone="neutral">
                        {t('model')}: {linkedModel?.name ?? version.model_id}
                      </Badge>
                      <Badge tone="info">
                        {t('job')}: {version.training_job_id ?? t('manual')}
                      </Badge>
                      <Badge tone={version.artifact_attachment_id ? 'success' : 'warning'}>
                        {version.artifact_attachment_id
                          ? `${t('artifact')}: ${version.artifact_attachment_id}`
                          : t('No artifact yet')}
                      </Badge>
                    </div>
                  </Panel>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="workspace-overview-side">
          <Card as="article">
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
                    <Select value={modelId} onChange={(event) => setModelId(event.target.value)}>
                      {models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name} ({t(model.model_type)})
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label>
                    {t('Completed Training Job')}
                    <Select value={jobId} onChange={(event) => setJobId(event.target.value)}>
                      {completedJobs.map((job) => (
                        <option key={job.id} value={job.id}>
                          {job.name} ({t(job.framework)})
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label className="workspace-form-span-2">
                    {t('Version Name')}
                    <Input
                      value={versionName}
                      onChange={(event) => setVersionName(event.target.value)}
                      placeholder={t('for example: v2026.04.02')}
                    />
                  </label>
                </div>

                <Button type="button" onClick={registerVersion} disabled={submitting}>
                  {submitting ? t('Registering...') : t('Register Model Version')}
                </Button>
              </>
            )}
          </Card>

          <Card as="article">
            <div className="stack tight">
              <h3>{t('Ready sources')}</h3>
              <small className="muted">
                {t('Pick from completed training outputs and keep artifact-linked versions organized.')}
              </small>
            </div>

            <ul className="workspace-record-list compact">
              <Panel as="li" className="workspace-record-item compact" tone="soft">
                <div className="row between gap wrap">
                  <strong>{t('Available models')}</strong>
                  <Badge tone="neutral">{summary.availableModels}</Badge>
                </div>
                <small className="muted">
                  {summary.availableModels > 0
                    ? t('Manage the model side of version registration from your owned inventory.')
                    : t('Create or import a model draft first.')}
                </small>
              </Panel>
              <Panel as="li" className="workspace-record-item compact" tone="soft">
                <div className="row between gap wrap">
                  <strong>{t('Completed jobs')}</strong>
                  <Badge tone={summary.registerableJobs > 0 ? 'success' : 'warning'}>
                    {summary.registerableJobs}
                  </Badge>
                </div>
                <small className="muted">
                  {summary.registerableJobs > 0
                    ? t('Finished runs stay visible for version registration and follow-up review.')
                    : t('Complete a training job first, then return here to register a version.')}
                </small>
              </Panel>
            </ul>

            <div className="workspace-button-stack">
              <ButtonLink to="/models/my-models" variant="secondary" size="sm">
                {t('Manage My Models')}
              </ButtonLink>
              <ButtonLink to="/training/jobs" variant="secondary" size="sm">
                {t('Open Training Jobs')}
              </ButtonLink>
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}
