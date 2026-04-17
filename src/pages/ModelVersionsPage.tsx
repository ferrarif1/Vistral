import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModelRecord, ModelVersionRecord, TrainingJobRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import {
  DetailDrawer,
  DetailList,
  FilterToolbar,
  InlineAlert,
  PageHeader,
  SectionCard,
  StatusTable,
  type StatusTableColumn
} from '../components/ui/ConsolePage';
import { Input, Select } from '../components/ui/Field';
import { Card } from '../components/ui/Surface';
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
  const [versionDetailOpen, setVersionDetailOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareVersions, setCompareVersions] = useState<ModelVersionRecord[]>([]);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState('');
  const [versionToolMode, setVersionToolMode] = useState<'compare' | 'register'>('register');
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
      setVersionDetailOpen(false);
      return;
    }
    if (selectedVersionId && !filteredVersions.some((version) => version.id === selectedVersionId)) {
      setSelectedVersionId('');
      setVersionDetailOpen(false);
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

  const comparisonColumns = useMemo<StatusTableColumn<string>[]>(() => {
    const columns: StatusTableColumn<string>[] = [
      {
        key: 'metric',
        header: t('Metric'),
        width: compareVersions.length > 1 ? '26%' : '32%',
        cell: (metricKey) => <strong>{metricKey}</strong>
      }
    ];

    compareVersions.forEach((version) => {
      columns.push({
        key: version.id,
        header: (
          <div className="stack tight">
            <strong>{version.version_name}</strong>
            <small className="muted">{t(version.framework)}</small>
          </div>
        ),
        cell: (metricKey) => <span>{version.metrics_summary[metricKey] ?? '—'}</span>
      });
    });

    return columns;
  }, [compareVersions, t]);

  const selectedVersion = useMemo(
    () => filteredVersions.find((version) => version.id === selectedVersionId) ?? null,
    [filteredVersions, selectedVersionId]
  );
  const selectedVersionJob = selectedVersion?.training_job_id
    ? jobsById.get(selectedVersion.training_job_id) ?? null
    : null;
  const selectedVersionJobInsight = selectedVersionJob ? jobExecutionInsights[selectedVersionJob.id] ?? null : null;
  const selectedVersionMetricsPreview = selectedVersion ? buildMetricsPreview(selectedVersion.metrics_summary, 4) : null;
  const describeJobExecutionReality = useCallback(
    (job?: TrainingJobRecord | null, insight?: TrainingExecutionInsight | null) => {
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
    },
    [jobInsightsLoading, t]
  );
  const openVersionDetail = useCallback((versionId: string) => {
    setSelectedVersionId(versionId);
    setVersionDetailOpen(true);
  }, []);
  const toggleCompareVersion = (versionId: string) => {
    setCompareError('');
    setVersionToolMode('compare');
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
  const selectedVersionDetailItems = selectedVersion
    ? [
        { label: t('Model'), value: modelsById.get(selectedVersion.model_id)?.name ?? t('Model record unavailable') },
        { label: t('Task'), value: t(selectedVersion.task_type) },
        { label: t('Framework'), value: t(selectedVersion.framework) },
        { label: t('Training job'), value: selectedVersion.training_job_id || t('manual') },
        { label: t('Created'), value: formatCompactTimestamp(selectedVersion.created_at) },
        {
          label: t('Artifact'),
          value: selectedVersion.artifact_attachment_id ? t('Ready') : t('Pending')
        }
      ]
    : [];
  const versionTableColumns = useMemo<StatusTableColumn<ModelVersionRecord>[]>(
    () => [
      {
        key: 'version',
        header: t('Version'),
        width: '24%',
        cell: (version) => (
          <div className="stack tight">
            <strong>{version.version_name}</strong>
            <small className="muted">{formatCompactTimestamp(version.created_at)}</small>
          </div>
        )
      },
      {
        key: 'lineage',
        header: t('Lineage'),
        width: '22%',
        cell: (version) => {
          const linkedModel = modelsById.get(version.model_id);
          const linkedJob = version.training_job_id ? jobsById.get(version.training_job_id) : null;
          return (
            <div className="stack tight">
              <small className="muted">{linkedModel?.name ?? t('Model record unavailable')}</small>
              <small className="muted">
                {linkedJob?.name ?? (version.training_job_id ? t('Job record unavailable') : t('manual'))}
              </small>
            </div>
          );
        }
      },
      {
        key: 'status',
        header: t('Status'),
        width: '18%',
        cell: (version) => {
          const linkedJob = version.training_job_id ? jobsById.get(version.training_job_id) : null;
          const linkedJobInsight = linkedJob ? jobExecutionInsights[linkedJob.id] ?? null : null;
          return (
            <div className="stack tight">
              <StatusTag status={version.status}>{t(version.status)}</StatusTag>
              <div className="row gap wrap">
                <Badge tone={version.artifact_attachment_id ? 'success' : 'warning'}>
                  {version.artifact_attachment_id ? t('Ready') : t('Pending')}
                </Badge>
                {linkedJob ? (
                  <Badge tone={linkedJobInsight?.reality === 'real' ? 'success' : 'warning'}>
                    {describeJobExecutionReality(linkedJob, linkedJobInsight)}
                  </Badge>
                ) : null}
              </div>
            </div>
          );
        }
      },
      {
        key: 'metrics',
        header: t('Metrics'),
        width: '24%',
        cell: (version) => {
          const metricsPreview = buildMetricsPreview(version.metrics_summary);
          return (
            <div className="stack tight">
              <small className="muted">
                {metricsPreview.preview
                  ? `${metricsPreview.preview}${metricsPreview.hiddenCount > 0 ? ` · +${metricsPreview.hiddenCount}` : ''}`
                  : t('Metrics summary unavailable.')}
              </small>
            </div>
          );
        }
      },
      {
        key: 'actions',
        header: t('Actions'),
        width: '12%',
        cell: (version) => (
          <div className="workspace-record-actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                openVersionDetail(version.id);
              }}
            >
              {selectedVersionId === version.id ? t('Selected') : t('Details')}
            </Button>
            <Button
              type="button"
              variant={compareIdSet.has(version.id) ? 'secondary' : 'ghost'}
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                toggleCompareVersion(version.id);
              }}
            >
              {compareIdSet.has(version.id) ? t('Compared') : t('Compare')}
            </Button>
          </div>
        )
      }
    ],
    [compareIdSet, describeJobExecutionReality, jobExecutionInsights, jobsById, modelsById, openVersionDetail, selectedVersionId, t]
  );

  const formatFallbackReasonLabel = (reason: string | null | undefined): string =>
    t(runtimeFallbackReasonLabelKey(bucketRuntimeFallbackReason(reason)));

  const registerVersion = async () => {
    if (!modelId || !jobId || !versionName.trim()) {
      setError(t('Select a model, job, and version name first.'));
      setSuccess('');
      return;
    }

    if (!registerableJobs.some((job) => job.id === jobId)) {
      setError(t('The selected job has not passed authenticity verification.'));
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

      setSuccess(t('Version registered and ready for validation and comparison.'));
      setVersionName('');
      await load('manual');
    } catch (registerError) {
      setError((registerError as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const registrationBlocked = models.length === 0 || registerableJobs.length === 0;
  const hasActiveFilters =
    searchText.trim().length > 0 || taskFilter !== 'all' || frameworkFilter !== 'all' || statusFilter !== 'all';
  const versionsSummary = {
    total: sortedVersions.length,
    visible: filteredVersions.length,
    registerable: registerableJobs.length,
    compared: compareIds.length
  };

  const resetFilters = () => {
    setSearchText('');
    setTaskFilter('all');
    setFrameworkFilter('all');
    setStatusFilter('all');
  };

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Version Registry')}
        title={t('Model Versions')}
        description={t('Compare or register verified versions.')}
        meta={
          <div className="row gap wrap align-center">
            <Badge tone="neutral">
              {t('Total')}: {versionsSummary.total}
            </Badge>
            <Badge tone={versionsSummary.registerable > 0 ? 'success' : 'warning'}>
              {t('Registerable')}: {versionsSummary.registerable}
            </Badge>
            <Badge tone="info">
              {t('Compared')}: {versionsSummary.compared}
            </Badge>
          </div>
        }
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
                    placeholder={t('Search version name, ID, or model')}
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
            summary={
              hasActiveFilters
                ? t('{count} versions visible after filters.', { count: versionsSummary.visible })
                : t('Read the list first, then use the sidebar.')
            }
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
                {hasActiveFilters ? (
                  <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
                    {t('Clear filters')}
                  </Button>
                ) : null}
              </div>
            }
          />
        }
        main={
          <div className="workspace-main-stack">
            <Card as="article">
              <WorkspaceSectionHeader
                title={t('Inventory')}
                description={t('Select one row to view details.')}
              />

              {loading ? (
                <StateBlock
                  variant="loading"
                  title={t('Loading Versions')}
                  description={t('Loading version list.')}
                />
              ) : filteredVersions.length === 0 ? (
                <StateBlock
                  variant="empty"
                  title={t('No Versions')}
                  description={
                    hasActiveFilters
                      ? t('No versions match the current filter.')
                      : t('Training versions will appear here.')
                  }
                  extra={
                    hasActiveFilters ? (
                      <small className="muted">
                        {t('Relax the search or filter.')}
                      </small>
                    ) : (
                      <ButtonLink to="/training/jobs" variant="secondary" size="sm">
                        {t('Open Training Jobs')}
                      </ButtonLink>
                    )
                  }
                />
              ) : (
                <StatusTable
                  rows={filteredVersions}
                  columns={versionTableColumns}
                  getRowKey={(version) => version.id}
                  onRowClick={(version) => openVersionDetail(version.id)}
                  rowClassName={(version) => (selectedVersionId === version.id ? 'selected' : undefined)}
                  emptyTitle={t('No Versions')}
                  emptyDescription={t('No versions match the current filter.')}
                />
              )}
            </Card>
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <SectionCard
              title={versionToolMode === 'compare' ? t('Compare versions') : t('Register version')}
              description={
                versionToolMode === 'compare'
                  ? t('Select up to two versions.')
                  : t('Register a verified job.')
              }
              actions={
                versionToolMode === 'compare' && compareIds.length > 0 ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setCompareIds([])}>
                    {t('Clear compare')}
                  </Button>
                ) : versionToolMode === 'register' ? (
                  <ButtonLink to="/training/jobs" variant="ghost" size="sm">
                    {t('Open Training Jobs')}
                  </ButtonLink>
                ) : null
              }
            >
              {versionToolMode === 'compare' ? (
                <div className="stack">
                  {compareIds.length > 0 ? (
                    <div className="row gap wrap">
                      {compareVersions.map((version) => (
                        <Badge key={version.id} tone="info">
                          {version.version_name}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  {compareError ? (
                    <StateBlock variant="error" title={t('Comparison unavailable')} description={compareError} />
                  ) : compareLoading ? (
                    <StateBlock
                      variant="loading"
                      title={t('Loading comparison')}
                      description={t('Loading details.')}
                    />
                  ) : compareVersions.length === 0 ? (
                    <StateBlock
                      variant="empty"
                      title={t('Select versions to compare')}
                      description={t('Use Compare in the table.')}
                    />
                  ) : comparisonMetricKeys.length > 0 ? (
                    <StatusTable
                      rows={comparisonMetricKeys}
                      columns={comparisonColumns}
                      getRowKey={(metricKey) => metricKey}
                      emptyTitle={t('No comparable metrics')}
                      emptyDescription={t('The selected versions do not have comparable metrics yet.')}
                    />
                  ) : (
                    <small className="muted">{t('No comparable metrics yet.')}</small>
                  )}
                </div>
              ) : registrationBlocked ? (
                <StateBlock
                  variant="empty"
                  title={
                    models.length === 0
                      ? t('There are no available models.')
                      : completedJobs.length === 0
                        ? t('There are no completed jobs.')
                        : t('There are no verified jobs.')
                  }
                  description={
                    models.length === 0
                      ? t('Create or import a model draft first.')
                      : completedJobs.length === 0
                        ? t('Complete one training job first.')
                        : t('Only verified jobs can be registered.')
                  }
                  extra={
                    models.length === 0 ? (
                      <ButtonLink to="/models/create" variant="secondary" size="sm">
                        {t('Create model draft')}
                      </ButtonLink>
                    ) : completedJobs.length === 0 ? (
                      <ButtonLink to="/training/jobs/new" variant="secondary" size="sm">
                        {t('Create training job')}
                      </ButtonLink>
                    ) : null
                  }
                />
              ) : (
                <div className="stack">
                  {blockedCompletedJobs.length > 0 ? (
                    <Badge tone="warning">
                      {t('{count} completed jobs are hidden because they did not pass local verification.', {
                        count: blockedCompletedJobs.length
                      })}
                    </Badge>
                  ) : null}
                  {jobInsightsLoading ? <small className="muted">{t('Checking job authenticity...')}</small> : null}
                  {blockedLocalCommandJobs.length > 0 ? (
                    <StateBlock
                      variant="empty"
                      title={t('Blocked degraded jobs')}
                      description={t(
                        '{count} completed jobs are excluded because execution evidence is incomplete.',
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
                      placeholder={t('For example: v2026.04.02')}
                      />
                    </label>
                  </div>

                  <small className="muted">
                    {t('Only use verified jobs.')}
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

      <DetailDrawer
        open={versionDetailOpen && Boolean(selectedVersion)}
        onClose={() => setVersionDetailOpen(false)}
        title={selectedVersion ? selectedVersion.version_name : t('Version detail')}
        description={
          selectedVersion
            ? t('Lineage, metrics, and artifacts.')
            : t('Pick one version from the list.')
        }
        actions={
          selectedVersion?.training_job_id ? (
            <ButtonLink
              to={buildScopedTrainingJobDetailPath(
                selectedVersion.training_job_id,
                jobsById.get(selectedVersion.training_job_id) ?? null
              )}
              variant="secondary"
              size="sm"
            >
              {t('Open Training Job')}
            </ButtonLink>
          ) : null
        }
      >
        {selectedVersion ? (
          <>
            <div className="row gap wrap">
              <StatusTag status={selectedVersion.status}>{t(selectedVersion.status)}</StatusTag>
              <Badge tone="neutral">
                {modelsById.get(selectedVersion.model_id)?.name ?? t('Model record unavailable')}
              </Badge>
              <Badge tone="info">{t(selectedVersion.task_type)}</Badge>
              <Badge tone="info">{t(selectedVersion.framework)}</Badge>
            </div>
            <DetailList items={selectedVersionDetailItems} />
              {selectedVersionJob && selectedVersionJob.execution_mode === 'local_command' && selectedVersionJobInsight?.reality !== 'real' ? (
              <StateBlock
                variant="empty"
                title={t('Version linked to non-real output')}
                description={
                  selectedVersionJobInsight?.fallbackReason
                    ? t(
                        'The linked training job shows fallback evidence. Check training details first. Reason: {reason}',
                        { reason: formatFallbackReasonLabel(selectedVersionJobInsight.fallbackReason) }
                      )
                    : t(
                        'The linked training job contains non-real execution evidence. Check training details first.'
                      )
                }
              />
            ) : null}
            <div className="stack tight">
              <strong>{t('Metrics')}</strong>
              <small className="muted">
                {selectedVersionMetricsPreview?.preview
                  ? `${selectedVersionMetricsPreview.preview}${
                      selectedVersionMetricsPreview.hiddenCount > 0 ? ` · +${selectedVersionMetricsPreview.hiddenCount}` : ''
                    }`
                  : t('No metrics summary yet.')}
              </small>
              <details className="workspace-details">
                <summary>{t('View raw metrics')}</summary>
                <pre className="code-block">{JSON.stringify(selectedVersion.metrics_summary, null, 2)}</pre>
              </details>
            </div>
          </>
        ) : (
          <StateBlock
            variant="empty"
            title={t('No selection')}
            description={t('Select one version to view details.')}
          />
        )}
      </DetailDrawer>
    </WorkspacePage>
  );
}
