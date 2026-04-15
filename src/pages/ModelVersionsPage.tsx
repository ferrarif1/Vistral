import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModelRecord, ModelVersionRecord, TrainingJobRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import VirtualList from '../components/VirtualList';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { FilterToolbar, InlineAlert, PageHeader, SectionCard } from '../components/ui/ConsolePage';
import { Input, Select } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import { deriveTrainingExecutionInsight, type TrainingExecutionInsight } from '../features/trainingExecutionInsight';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';
import { bucketRuntimeFallbackReason, runtimeFallbackReasonLabelKey } from '../utils/runtimeFallbackReason';

const versionsVirtualizationThreshold = 14;
const versionsVirtualRowHeight = 214;
const versionsVirtualViewportHeight = 640;
const backgroundRefreshIntervalMs = 6000;
type LoadMode = 'initial' | 'manual' | 'background';

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
        execution_mode: item.execution_mode,
        framework: item.framework,
        updated_at: item.updated_at
      }))
  );

const buildMetricsPreview = (
  metrics: ModelVersionRecord['metrics_summary'],
  maxItems = 3
): { preview: string; hiddenCount: number } => {
  const entries = Object.entries(metrics);
  const preview = entries
    .slice(0, maxItems)
    .map(([key, value]) => `${key}=${value}`)
    .join(' · ');

  return {
    preview,
    hiddenCount: Math.max(0, entries.length - maxItems)
  };
};

const buildScopedTrainingJobDetailPath = (jobId: string, job?: TrainingJobRecord | null): string => {
  const searchParams = new URLSearchParams();
  if (job?.dataset_id) {
    searchParams.set('dataset', job.dataset_id);
  }
  if (job?.dataset_version_id) {
    searchParams.set('version', job.dataset_version_id);
  }
  const query = searchParams.toString();
  return query ? `/training/jobs/${jobId}?${query}` : `/training/jobs/${jobId}`;
};

export default function ModelVersionsPage() {
  const { t } = useI18n();
  const [versions, setVersions] = useState<ModelVersionRecord[]>([]);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [jobs, setJobs] = useState<TrainingJobRecord[]>([]);
  const [modelId, setModelId] = useState('');
  const [jobId, setJobId] = useState('');
  const [versionName, setVersionName] = useState('');
  const [searchText, setSearchText] = useState('');
  const [taskFilter, setTaskFilter] = useState<'all' | 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'>(
    'all'
  );
  const [frameworkFilter, setFrameworkFilter] = useState<'all' | 'yolo' | 'paddleocr' | 'doctr'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'registered' | 'deprecated'>('all');
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareVersions, setCompareVersions] = useState<ModelVersionRecord[]>([]);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState('');
  const [versionToolMode, setVersionToolMode] = useState<'compare' | 'register'>('compare');
  const [jobExecutionInsights, setJobExecutionInsights] = useState<Record<string, TrainingExecutionInsight>>({});
  const [jobInsightsLoading, setJobInsightsLoading] = useState(false);
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
        .filter((job) => job.status === 'completed' && job.execution_mode === 'local_command')
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

  const localCommandCompletedJobs = useMemo(
    () => completedJobs.filter((job) => job.execution_mode === 'local_command'),
    [completedJobs]
  );

  const localCommandInsightSignature = useMemo(
    () =>
      localCommandCompletedJobs
        .map((job) => `${job.id}:${job.updated_at}`)
        .sort((left, right) => left.localeCompare(right))
        .join('|'),
    [localCommandCompletedJobs]
  );

  useEffect(() => {
    if (!localCommandCompletedJobs.length) {
      setJobExecutionInsights({});
      setJobInsightsLoading(false);
      return;
    }

    let active = true;
    setJobInsightsLoading(true);

    Promise.all(
      localCommandCompletedJobs.map(async (job) => {
        try {
          const detail = await api.getTrainingJobDetail(job.id);
          return [
            job.id,
            deriveTrainingExecutionInsight({
              status: detail.job.status,
              executionMode: detail.job.execution_mode,
              artifactSummary: detail.artifact_summary
            })
          ] as const;
        } catch {
          return [
            job.id,
            deriveTrainingExecutionInsight({
              status: job.status,
              executionMode: job.execution_mode,
              artifactSummary: null
            })
          ] as const;
        }
      })
    )
      .then((entries) => {
        if (!active) {
          return;
        }
        const next: Record<string, TrainingExecutionInsight> = {};
        entries.forEach(([id, insight]) => {
          next[id] = insight;
        });
        setJobExecutionInsights(next);
      })
      .finally(() => {
        if (!active) {
          return;
        }
        setJobInsightsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [localCommandInsightSignature, localCommandCompletedJobs]);

  const registerableJobs = useMemo(
    () =>
      localCommandCompletedJobs.filter((job) => {
        const insight = jobExecutionInsights[job.id];
        return Boolean(insight) && insight.reality === 'real';
      }),
    [jobExecutionInsights, localCommandCompletedJobs]
  );

  const blockedLocalCommandJobs = useMemo(
    () =>
      localCommandCompletedJobs
        .map((job) => {
          const insight = jobExecutionInsights[job.id];
          return {
            job,
            insight:
              insight ??
              deriveTrainingExecutionInsight({
                status: job.status,
                executionMode: job.execution_mode,
                artifactSummary: null
              })
          };
        })
        .filter(({ insight }) => insight.reality !== 'real'),
    [jobExecutionInsights, localCommandCompletedJobs]
  );

  const blockedCompletedJobs = useMemo(
    () => completedJobs.filter((job) => job.execution_mode !== 'local_command'),
    [completedJobs]
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

  const filteredVersions = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return sortedVersions.filter((version) => {
      if (taskFilter !== 'all' && version.task_type !== taskFilter) {
        return false;
      }
      if (frameworkFilter !== 'all' && version.framework !== frameworkFilter) {
        return false;
      }
      if (statusFilter !== 'all' && version.status !== statusFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        version.version_name.toLowerCase().includes(query) ||
        version.id.toLowerCase().includes(query) ||
        version.model_id.toLowerCase().includes(query)
      );
    });
  }, [frameworkFilter, searchText, sortedVersions, statusFilter, taskFilter]);

  useEffect(() => {
    if (!filteredVersions.length) {
      setSelectedVersionId('');
      return;
    }
    if (!selectedVersionId || !filteredVersions.some((version) => version.id === selectedVersionId)) {
      setSelectedVersionId(filteredVersions[0].id);
    }
  }, [filteredVersions, selectedVersionId]);

  useEffect(() => {
    if (!registerableJobs.length) {
      if (jobId && !localCommandCompletedJobs.some((job) => job.id === jobId)) {
        setJobId('');
      }
      return;
    }
    if (!jobId || !registerableJobs.some((job) => job.id === jobId)) {
      setJobId(registerableJobs[0].id);
    }
  }, [jobId, localCommandCompletedJobs, registerableJobs]);

  const modelsById = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);
  const jobsById = useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs]);
  const compareIdSet = useMemo(() => new Set(compareIds), [compareIds]);

  useEffect(() => {
    const nextCompareIds = compareIds.filter((id) => versions.some((version) => version.id === id));
    if (nextCompareIds.length !== compareIds.length) {
      setCompareIds(nextCompareIds);
    }
  }, [compareIds, versions]);

  useEffect(() => {
    if (compareIds.length === 0) {
      setCompareVersions([]);
      setCompareError('');
      setCompareLoading(false);
      return;
    }

    let active = true;
    setCompareLoading(true);
    setCompareError('');

    Promise.all(compareIds.map((versionId) => api.getModelVersion(versionId)))
      .then((results) => {
        if (!active) {
          return;
        }
        setCompareVersions(results);
      })
      .catch((compareLoadError) => {
        if (!active) {
          return;
        }
        setCompareError((compareLoadError as Error).message);
      })
      .finally(() => {
        if (!active) {
          return;
        }
        setCompareLoading(false);
      });

    return () => {
      active = false;
    };
  }, [compareIds]);

  const comparisonMetricKeys = useMemo(() => {
    const keys = new Set<string>();
    compareVersions.forEach((version) => {
      Object.keys(version.metrics_summary).forEach((key) => keys.add(key));
    });
    return Array.from(keys).sort((left, right) => left.localeCompare(right));
  }, [compareVersions]);

  const selectedVersion = useMemo(
    () => filteredVersions.find((version) => version.id === selectedVersionId) ?? null,
    [filteredVersions, selectedVersionId]
  );
  const selectedVersionJob = selectedVersion?.training_job_id
    ? jobsById.get(selectedVersion.training_job_id) ?? null
    : null;
  const selectedVersionJobInsight = selectedVersionJob ? jobExecutionInsights[selectedVersionJob.id] ?? null : null;

  const describeJobExecutionReality = (job?: TrainingJobRecord | null, insight?: TrainingExecutionInsight | null) => {
    if (!job) {
      return t('No training linkage');
    }
    if (job.execution_mode !== 'local_command') {
      return t('Not registerable');
    }
    if (!insight) {
      return jobInsightsLoading ? t('Checking authenticity') : t('Authenticity unknown');
    }
    if (insight.reality === 'real') {
      return t('Real');
    }
    if (insight.reality === 'template') {
      return t('Degraded output');
    }
    if (insight.reality === 'simulated') {
      return t('Degraded output');
    }
    return t('Needs verification');
  };
  const formatFallbackReasonLabel = (reason: string | null | undefined): string =>
    t(runtimeFallbackReasonLabelKey(bucketRuntimeFallbackReason(reason)));

  const toggleCompareVersion = (versionId: string) => {
    setCompareError('');
    setCompareIds((current) => {
      if (current.includes(versionId)) {
        return current.filter((item) => item !== versionId);
      }
      if (current.length >= 2) {
        return [current[1], versionId];
      }
      return [...current, versionId];
    });
  };

  const registerVersion = async () => {
    if (!modelId || !jobId || !versionName.trim()) {
      setError(t('Select model/job and fill version name.'));
      setSuccess('');
      return;
    }

    if (!registerableJobs.some((job) => job.id === jobId)) {
      setError(t('Selected training job is not authenticity-verified for version registration.'));
      setSuccess('');
      return;
    }

    setSubmitting(true);
    setError('');
    setSuccess('');

    try {
      await api.registerModelVersion({
        model_id: modelId,
        training_job_id: jobId,
        version_name: versionName.trim()
      });

      setSuccess(t('Model version registered. It is now available for validation and comparison.'));
      setVersionName('');
      await load('manual');
    } catch (registerError) {
      setError((registerError as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const registrationBlocked = models.length === 0 || registerableJobs.length === 0;
  const shouldVirtualizeVersions = filteredVersions.length > versionsVirtualizationThreshold;
  const hasActiveFilters =
    searchText.trim().length > 0 || taskFilter !== 'all' || frameworkFilter !== 'all' || statusFilter !== 'all';

  const resetFilters = () => {
    setSearchText('');
    setTaskFilter('all');
    setFrameworkFilter('all');
    setStatusFilter('all');
  };

  const renderVersionRow = (version: ModelVersionRecord, as: 'div' | 'li' = 'li') => {
    const linkedModel = modelsById.get(version.model_id);
    const linkedJob = version.training_job_id ? jobsById.get(version.training_job_id) : null;
    const linkedJobInsight = linkedJob ? jobExecutionInsights[linkedJob.id] ?? null : null;
    const metricsPreview = buildMetricsPreview(version.metrics_summary);
    const selected = selectedVersionId === version.id;

    return (
      <Panel
        key={version.id}
        as={as}
        className={`workspace-record-item${as === 'div' ? ' virtualized' : ''}${selected ? ' selected' : ''}`}
        tone={selected ? 'accent' : 'soft'}
      >
        <div className="workspace-record-item-top">
          <div className="workspace-record-summary stack tight">
            <strong>{version.version_name}</strong>
            <small className="muted">
              {linkedModel?.name ?? t('Unavailable model record')} · {t(version.task_type)} · {t(version.framework)} ·{' '}
              {t('Created')}: {formatCompactTimestamp(version.created_at)}
            </small>
          </div>
          <div className="workspace-record-actions">
            <StatusTag status={version.status}>{t(version.status)}</StatusTag>
            <Button
              type="button"
              variant={selected ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setSelectedVersionId(version.id)}
            >
              {selected ? t('Selected') : t('Select')}
            </Button>
            <Button
              type="button"
              variant={compareIdSet.has(version.id) ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => toggleCompareVersion(version.id)}
            >
              {compareIdSet.has(version.id) ? t('Compared') : t('Compare')}
            </Button>
            {version.training_job_id ? (
              <ButtonLink
                to={buildScopedTrainingJobDetailPath(version.training_job_id, linkedJob)}
                variant="secondary"
                size="sm"
              >
                {t('Open Job')}
              </ButtonLink>
            ) : null}
          </div>
        </div>
        <p className="line-clamp-2">
          {metricsPreview.preview
            ? `${t('metrics')}: ${metricsPreview.preview}${
                metricsPreview.hiddenCount > 0 ? ` · +${metricsPreview.hiddenCount}` : ''
              }`
            : t('Metrics summary unavailable.')}
        </p>
        <div className="row gap wrap">
          <Badge tone="neutral">
            {t('model')}: {linkedModel?.name ?? t('Unavailable model record')}
          </Badge>
          <Badge tone="info">
            {t('job')}: {linkedJob?.name ?? (version.training_job_id ? t('Training job record unavailable') : t('manual'))}
          </Badge>
          <Badge tone={version.artifact_attachment_id ? 'success' : 'warning'}>
            {version.artifact_attachment_id ? `${t('artifact')}: ${t('Ready')}` : t('No artifact yet')}
          </Badge>
          {linkedJob ? (
            <Badge tone={linkedJobInsight?.reality === 'real' ? 'success' : 'warning'}>
              {t('authenticity')}: {describeJobExecutionReality(linkedJob, linkedJobInsight)}
            </Badge>
          ) : null}
        </div>
      </Panel>
    );
  };

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Version Registry')}
        title={t('Model Versions')}
        description={t('Review version inventory first. Comparison and registration stay as secondary tools.')}
        primaryAction={{
          label: loading ? t('Loading') : refreshing ? t('Refreshing...') : t('Refresh'),
          onClick: () => {
            load('manual').catch(() => {
              // no-op
            });
          },
          disabled: loading || refreshing
        }}
      />

      {error ? <InlineAlert tone="danger" title={t('Action Failed')} description={error} /> : null}
      {success ? <InlineAlert tone="success" title={t('Action Completed')} description={success} /> : null}

      <WorkspaceWorkbench
        toolbar={
          <FilterToolbar
            filters={
              <>
                <label className="stack tight">
                  <small className="muted">{t('Search')}</small>
                  <Input
                    value={searchText}
                    onChange={(event) => setSearchText(event.target.value)}
                    placeholder={t('Search by version name, id, or model')}
                  />
                </label>
                <label className="stack tight">
                  <small className="muted">{t('Task')}</small>
                  <Select
                    value={taskFilter}
                    onChange={(event) =>
                      setTaskFilter(
                        event.target.value as
                          | 'all'
                          | 'ocr'
                          | 'detection'
                          | 'classification'
                          | 'segmentation'
                          | 'obb'
                      )
                    }
                  >
                    <option value="all">{t('all')}</option>
                    <option value="ocr">{t('ocr')}</option>
                    <option value="detection">{t('detection')}</option>
                    <option value="classification">{t('classification')}</option>
                    <option value="segmentation">{t('segmentation')}</option>
                    <option value="obb">{t('obb')}</option>
                  </Select>
                </label>
                <label className="stack tight">
                  <small className="muted">{t('Framework')}</small>
                  <Select
                    value={frameworkFilter}
                    onChange={(event) =>
                      setFrameworkFilter(event.target.value as 'all' | 'yolo' | 'paddleocr' | 'doctr')
                    }
                  >
                    <option value="all">{t('all')}</option>
                    <option value="yolo">{t('yolo')}</option>
                    <option value="paddleocr">{t('paddleocr')}</option>
                    <option value="doctr">{t('doctr')}</option>
                  </Select>
                </label>
                <label className="stack tight">
                  <small className="muted">{t('Status')}</small>
                  <Select
                    value={statusFilter}
                    onChange={(event) =>
                      setStatusFilter(event.target.value as 'all' | 'registered' | 'deprecated')
                    }
                  >
                    <option value="all">{t('all')}</option>
                    <option value="registered">{t('registered')}</option>
                    <option value="deprecated">{t('deprecated')}</option>
                  </Select>
                </label>
              </>
            }
            actions={
              hasActiveFilters ? (
                <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
                  {t('Clear filters')}
                </Button>
              ) : undefined
            }
          />
        }
        main={
          <div className="workspace-main-stack">
            <Card as="article">
              <WorkspaceSectionHeader
                title={t('Version Inventory')}
                description={t('Review registered outputs, metrics, and provenance in one list.')}
              />

              {loading ? (
                <StateBlock variant="loading" title={t('Loading Versions')} description={t('Fetching model version list.')} />
              ) : filteredVersions.length === 0 ? (
                <StateBlock
                  variant="empty"
                  title={t('No Versions')}
                  description={
                    hasActiveFilters
                      ? t('No versions match current filters.')
                      : t('Registered versions appear here after a completed training job passes authenticity checks and is recorded.')
                  }
                  extra={
                    hasActiveFilters ? (
                      <small className="muted">
                        {t('Broaden search or filter conditions to restore matching versions.')}
                      </small>
                    ) : (
                      <ButtonLink to="/training/jobs" variant="secondary" size="sm">
                        {t('Open Training Jobs')}
                      </ButtonLink>
                    )
                  }
                />
              ) : shouldVirtualizeVersions ? (
                <VirtualList
                  items={filteredVersions}
                  itemHeight={versionsVirtualRowHeight}
                  height={versionsVirtualViewportHeight}
                  itemKey={(version) => version.id}
                  listClassName="workspace-record-list"
                  rowClassName="workspace-record-row"
                  ariaLabel={t('Version Inventory')}
                  renderItem={(version) => renderVersionRow(version, 'div')}
                />
              ) : (
                <ul className="workspace-record-list">
                  {filteredVersions.map((version) => renderVersionRow(version))}
                </ul>
              )}
            </Card>
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <Card as="article" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Selected Version')}
                description={t('Inspector panel for the selected version lineage and status.')}
              />
              {!selectedVersion ? (
                <StateBlock
                  variant="empty"
                  title={t('No selection')}
                  description={t('Select one version from the inventory to inspect details.')}
                />
              ) : (
                <>
                  <Panel as="section" className="stack tight" tone="soft">
                    <div className="row between gap wrap align-center">
                      <strong>{selectedVersion.version_name}</strong>
                      <StatusTag status={selectedVersion.status}>{t(selectedVersion.status)}</StatusTag>
                    </div>
                    <div className="row gap wrap">
                      <Badge tone="neutral">
                        {modelsById.get(selectedVersion.model_id)?.name ?? t('Unavailable model record')}
                      </Badge>
                      <Badge tone="info">{t(selectedVersion.framework)}</Badge>
                      <Badge tone="neutral">{t(selectedVersion.task_type)}</Badge>
                    </div>
                    <small className="muted">
                      {t('Created')}: {formatCompactTimestamp(selectedVersion.created_at)}
                    </small>
                  </Panel>
                  <div className="workspace-keyline-list">
                    <div className="workspace-keyline-item">
                      <span>{t('Model')}</span>
                      <small>{modelsById.get(selectedVersion.model_id)?.name ?? '—'}</small>
                    </div>
                    <div className="workspace-keyline-item">
                      <span>{t('Training job')}</span>
                      <small>{selectedVersion.training_job_id || '—'}</small>
                    </div>
                    <div className="workspace-keyline-item">
                      <span>{t('Authenticity')}</span>
                      <strong>{describeJobExecutionReality(selectedVersionJob, selectedVersionJobInsight)}</strong>
                    </div>
                    <div className="workspace-keyline-item">
                      <span>{t('Artifact')}</span>
                      <strong>{selectedVersion.artifact_attachment_id ? t('Ready') : t('Pending')}</strong>
                    </div>
                  </div>
                  {selectedVersionJob && selectedVersionJob.execution_mode === 'local_command' && selectedVersionJobInsight?.reality !== 'real' ? (
                    <StateBlock
                      variant="empty"
                      title={t('Version linked to non-real training output')}
                      description={
                        selectedVersionJobInsight?.fallbackReason
                          ? t(
                              'Linked training run contains degraded-output evidence. Review training job detail before production usage. Reason: {reason}',
                              { reason: formatFallbackReasonLabel(selectedVersionJobInsight.fallbackReason) }
                            )
                          : t(
                              'Linked training run contains non-real execution evidence. Review training job detail before production usage.'
                            )
                      }
                    />
                  ) : null}
                  <div className="workspace-action-cluster">
                    {selectedVersion.training_job_id ? (
                      <ButtonLink
                        to={buildScopedTrainingJobDetailPath(
                          selectedVersion.training_job_id,
                          jobsById.get(selectedVersion.training_job_id) ?? null
                        )}
                        variant="secondary"
                        size="sm"
                        block
                      >
                        {t('Open Training Job')}
                      </ButtonLink>
                    ) : null}
                  </div>
                </>
              )}
            </Card>

            <SectionCard
              title={t('Version tools')}
              description={t('Switch between comparison and registration without mixing their workflows.')}
              actions={
                <div className="row gap wrap">
                  <Button
                    type="button"
                    variant={versionToolMode === 'compare' ? 'secondary' : 'ghost'}
                    size="sm"
                    onClick={() => setVersionToolMode('compare')}
                  >
                    {t('Compare')}
                  </Button>
                  <Button
                    type="button"
                    variant={versionToolMode === 'register' ? 'secondary' : 'ghost'}
                    size="sm"
                    onClick={() => setVersionToolMode('register')}
                  >
                    {t('Register')}
                  </Button>
                </div>
              }
            >
              {versionToolMode === 'compare' ? (
                <div className="stack">
                  <small className="muted">
                    {t('Pick up to two versions from inventory, then inspect metrics and lineage here.')}
                  </small>
                  {compareError ? (
                    <StateBlock variant="error" title={t('Comparison unavailable')} description={compareError} />
                  ) : compareLoading ? (
                    <StateBlock
                      variant="loading"
                      title={t('Loading comparison')}
                      description={t('Fetching selected version details.')}
                    />
                  ) : compareVersions.length === 0 ? (
                    <StateBlock
                      variant="empty"
                      title={t('Select versions to compare')}
                      description={t('Use the Compare action in the inventory list.')}
                    />
                  ) : (
                    <div className="stack">
                      <div className="row gap wrap">
                        {compareVersions.map((version) => (
                          <Badge key={version.id} tone="info">
                            {version.version_name}
                          </Badge>
                        ))}
                      </div>
                      {comparisonMetricKeys.length > 0 ? (
                        <div className="workspace-record-list compact">
                          {comparisonMetricKeys.map((metricKey) => (
                            <Panel key={metricKey} as="div" className="workspace-record-item compact" tone="soft">
                              <div className="row between gap wrap align-center">
                                <strong>{metricKey}</strong>
                                {compareVersions.length === 2 ? (
                                  <Badge tone="neutral">
                                    {t('delta')}: {compareVersions[0].metrics_summary[metricKey] ?? '—'} vs{' '}
                                    {compareVersions[1].metrics_summary[metricKey] ?? '—'}
                                  </Badge>
                                ) : null}
                              </div>
                              <div className="row gap wrap">
                                {compareVersions.map((version) => (
                                  <Badge key={`${version.id}-${metricKey}`} tone="info">
                                    {version.version_name}: {version.metrics_summary[metricKey] ?? '—'}
                                  </Badge>
                                ))}
                              </div>
                            </Panel>
                          ))}
                        </div>
                      ) : (
                        <small className="muted">{t('Selected versions do not expose comparable metric keys yet.')}</small>
                      )}
                    </div>
                  )}
                </div>
              ) : registrationBlocked ? (
                <StateBlock
                  variant="empty"
                  title={
                    models.length === 0
                      ? t('No owned models available.')
                      : completedJobs.length === 0
                      ? t('No completed jobs yet.')
                      : t('No authenticity-verified jobs yet.')
                  }
                  description={
                    models.length === 0
                      ? t('Create or import a model draft first.')
                      : completedJobs.length === 0
                      ? t('Complete a training job first, then return here to register a version.')
                      : t('Only completed jobs with verified real execution can be registered as model versions.')
                  }
                  extra={
                    models.length === 0 ? (
                      <ButtonLink to="/models/create" variant="secondary" size="sm">
                        {t('Create Model Draft')}
                      </ButtonLink>
                    ) : completedJobs.length === 0 ? (
                      <ButtonLink to="/training/jobs/new" variant="secondary" size="sm">
                        {t('Create Training Job')}
                      </ButtonLink>
                    ) : null
                  }
                />
              ) : (
                <div className="stack">
                  {blockedCompletedJobs.length > 0 ? (
                    <Badge tone="warning">
                      {t(
                        '{count} completed jobs are hidden because they were not completed through local execution path.',
                        { count: blockedCompletedJobs.length }
                      )}
                    </Badge>
                  ) : null}
                  {jobInsightsLoading ? <small className="muted">{t('Checking training job authenticity...')}</small> : null}
                  {blockedLocalCommandJobs.length > 0 ? (
                    <StateBlock
                      variant="empty"
                      title={t('Jobs with degraded output are blocked')}
                      description={t(
                        '{count} completed jobs are excluded because execution evidence is degraded or incomplete.',
                        { count: blockedLocalCommandJobs.length }
                      )}
                    />
                  ) : null}
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
                        {registerableJobs.map((job) => (
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

                  <small className="muted">
                    {t('Registration keeps authenticity checks on. Jobs with degraded output are blocked by default.')}
                  </small>

                  <Button type="button" onClick={registerVersion} disabled={submitting} block>
                    {submitting ? t('Registering...') : t('Register Model Version')}
                  </Button>
                </div>
              )}
            </SectionCard>
          </div>
        }
      />
    </WorkspacePage>
  );
}
