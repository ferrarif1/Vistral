import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type {
  DatasetRecord,
  InferenceRunRecord,
  ModelRecord,
  ModelVersionRecord,
  RuntimeDeviceAccessIssueResult,
  RuntimeDeviceAccessRecord,
  RuntimeDeviceLifecycleSnapshot,
  TrainingJobRecord
} from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import WorkspaceNextStepCard from '../components/onboarding/WorkspaceNextStepCard';
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
const toTime = (value: string | null | undefined): number => {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
        artifact_attachment_id: item.artifact_attachment_id,
        registration_evidence_mode: item.registration_evidence_mode ?? '',
        registration_gate_exempted: item.registration_gate_exempted ?? null
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

const buildInferenceRunSignature = (items: InferenceRunRecord[]): string =>
  JSON.stringify(
    [...items]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => ({
        id: item.id,
        model_version_id: item.model_version_id,
        task_type: item.task_type,
        execution_source: item.execution_source,
        feedback_dataset_id: item.feedback_dataset_id,
        created_at: item.created_at,
        updated_at: item.updated_at
      }))
  );

const buildDatasetSignature = (items: DatasetRecord[]): string =>
  JSON.stringify(
    [...items]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => ({
        id: item.id,
        name: item.name,
        task_type: item.task_type,
        status: item.status,
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

const buildScopedInferenceValidationPath = (versionId: string): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('modelVersion', versionId);
  return `/inference/validate?${searchParams.toString()}`;
};

const buildScopedClosurePath = (job?: TrainingJobRecord | null): string => {
  const searchParams = new URLSearchParams();
  if (job?.dataset_id) {
    searchParams.set('dataset', job.dataset_id);
  }
  if (job?.dataset_version_id) {
    searchParams.set('version', job.dataset_version_id);
  }
  const query = searchParams.toString();
  return query ? `/workflow/closure?${query}` : '/workflow/closure';
};

const buildCreateModelDraftPath = (
  taskType?: string,
  options?: {
    jobId?: string;
    versionName?: string;
  }
): string => {
  const searchParams = new URLSearchParams();
  if (taskType?.trim()) {
    searchParams.set('task_type', taskType.trim());
  }
  if (options?.jobId?.trim()) {
    searchParams.set('job', options.jobId.trim());
  }
  if (options?.versionName?.trim()) {
    searchParams.set('version_name', options.versionName.trim());
  }
  const query = searchParams.toString();
  return query ? `/models/create?${query}` : '/models/create';
};

export default function ModelVersionsPage() {
  const { t } = useI18n();
  const [searchParams] = useSearchParams();
  const [versions, setVersions] = useState<ModelVersionRecord[]>([]);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [jobs, setJobs] = useState<TrainingJobRecord[]>([]);
  const [inferenceRuns, setInferenceRuns] = useState<InferenceRunRecord[]>([]);
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
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
  const [deviceAccessRecords, setDeviceAccessRecords] = useState<RuntimeDeviceAccessRecord[]>([]);
  const [deviceAccessLoading, setDeviceAccessLoading] = useState(false);
  const [deviceAccessBusy, setDeviceAccessBusy] = useState(false);
  const [deviceAccessError, setDeviceAccessError] = useState('');
  const [deviceLifecycle, setDeviceLifecycle] = useState<RuntimeDeviceLifecycleSnapshot | null>(null);
  const [deviceLifecycleLoading, setDeviceLifecycleLoading] = useState(false);
  const [deviceLifecycleError, setDeviceLifecycleError] = useState('');
  const [deviceAccessName, setDeviceAccessName] = useState('');
  const [deviceAccessExpireDays, setDeviceAccessExpireDays] = useState('');
  const [deviceAccessMaxCalls, setDeviceAccessMaxCalls] = useState('');
  const [latestIssuedDeviceAccess, setLatestIssuedDeviceAccess] = useState<RuntimeDeviceAccessIssueResult | null>(
    null
  );
  const prefillModelId = (searchParams.get('model') ?? '').trim();
  const prefillJobId = (searchParams.get('job') ?? '').trim();
  const prefillVersionName = (searchParams.get('version_name') ?? searchParams.get('versionName') ?? '').trim();
  const prefillSelectedVersionId = (searchParams.get('selectedVersion') ?? searchParams.get('versionId') ?? '').trim();
  const modelTouchedRef = useRef(false);
  const jobTouchedRef = useRef(false);
  const versionNameTouchedRef = useRef(false);
  const selectedVersionPrefillAppliedRef = useRef(false);
  const versionsSignatureRef = useRef('');
  const modelsSignatureRef = useRef('');
  const jobsSignatureRef = useRef('');
  const inferenceRunsSignatureRef = useRef('');
  const datasetsSignatureRef = useRef('');

  const load = useCallback(async (mode: LoadMode = 'initial') => {
    if (mode === 'initial') {
      setLoading(true);
    }

    if (mode === 'manual') {
      setRefreshing(true);
    }
    try {
      const [versionResult, modelResult, jobResult, inferenceResult, datasetResult] = await Promise.all([
        api.listModelVersions(),
        api.listMyModels(),
        api.listTrainingJobs(),
        api.listInferenceRuns(),
        api.listDatasets()
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

      const nextInferenceSignature = buildInferenceRunSignature(inferenceResult);
      if (inferenceRunsSignatureRef.current !== nextInferenceSignature) {
        inferenceRunsSignatureRef.current = nextInferenceSignature;
        setInferenceRuns(inferenceResult);
      }

      const nextDatasetSignature = buildDatasetSignature(datasetResult);
      if (datasetsSignatureRef.current !== nextDatasetSignature) {
        datasetsSignatureRef.current = nextDatasetSignature;
        setDatasets(datasetResult);
      }

      const prefilledModel = prefillModelId
        ? modelResult.find((model) => model.id === prefillModelId) ?? null
        : null;
      const prefilledJob = prefillJobId ? jobResult.find((job) => job.id === prefillJobId) ?? null : null;

      setModelId((current) => {
        const currentModel = current ? modelResult.find((model) => model.id === current) ?? null : null;
        if (prefilledModel) {
          return prefilledModel.id;
        }
        if (prefilledJob && !modelTouchedRef.current) {
          const matchingModel = modelResult.find((model) => model.model_type === prefilledJob.task_type);
          if (currentModel?.model_type === prefilledJob.task_type) {
            return current;
          }
          if (matchingModel) {
            return matchingModel.id;
          }
          return '';
        }
        if (current && currentModel) {
          return current;
        }
        if (prefilledJob) {
          return '';
        }
        return modelResult[0]?.id || '';
      });

      setJobId((current) => {
        if (prefilledJob && !jobTouchedRef.current) {
          return prefilledJob.id;
        }
        return current && completed.some((job) => job.id === current) ? current : completed[0]?.id || '';
      });

      if (!versionNameTouchedRef.current) {
        if (prefillVersionName) {
          setVersionName(prefillVersionName);
        } else if (prefilledJob) {
          setVersionName((current) => current || prefilledJob.name);
        }
      }
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
  }, [prefillJobId, prefillModelId, prefillVersionName]);

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

  const registrationPrefillJob = useMemo(
    () => (prefillJobId ? jobs.find((job) => job.id === prefillJobId) ?? null : null),
    [jobs, prefillJobId]
  );
  const registrationPrefillMatchingModel = useMemo(() => {
    if (!registrationPrefillJob) {
      return null;
    }

    return models.find((model) => model.model_type === registrationPrefillJob.task_type) ?? null;
  }, [models, registrationPrefillJob]);
  const hasRegistrationPrefill = Boolean(prefillModelId || prefillJobId || prefillVersionName);
  const prefilledJobRegisterable =
    Boolean(registrationPrefillJob) &&
    registerableJobs.some((job) => job.id === registrationPrefillJob?.id);
  const registrationPrefillNeedsMatchingModel =
    Boolean(registrationPrefillJob) && !registrationPrefillMatchingModel && !modelTouchedRef.current;
  const registrationPrefillCreateModelPath = registrationPrefillJob
    ? buildCreateModelDraftPath(registrationPrefillJob.task_type, {
        jobId: registrationPrefillJob.id,
        versionName: registrationPrefillJob.name
      })
    : '/models/create';
  const registrationPrefillJobPath = registrationPrefillJob
    ? buildScopedTrainingJobDetailPath(registrationPrefillJob.id, registrationPrefillJob)
    : '';

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
    if (selectedVersionPrefillAppliedRef.current || !prefillSelectedVersionId) {
      return;
    }
    if (!versions.some((version) => version.id === prefillSelectedVersionId)) {
      return;
    }

    selectedVersionPrefillAppliedRef.current = true;
    setSelectedVersionId(prefillSelectedVersionId);
    setVersionDetailOpen(true);
  }, [prefillSelectedVersionId, versions]);

  useEffect(() => {
    if (!registerableJobs.length) {
      if (jobId && !localCommandCompletedJobs.some((job) => job.id === jobId)) {
        setJobId('');
      }
      return;
    }
    if (prefillJobId && !jobTouchedRef.current) {
      if (registerableJobs.some((job) => job.id === prefillJobId)) {
        setJobId(prefillJobId);
        return;
      }
      setJobId(registerableJobs[0].id);
      return;
    }
    if (!jobId || !registerableJobs.some((job) => job.id === jobId)) {
      setJobId(registerableJobs[0].id);
    }
  }, [jobId, localCommandCompletedJobs, prefillJobId, registerableJobs]);

  const modelsById = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);
  const jobsById = useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs]);
  const datasetsById = useMemo(() => new Map(datasets.map((dataset) => [dataset.id, dataset])), [datasets]);
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
    () => versions.find((version) => version.id === selectedVersionId) ?? null,
    [selectedVersionId, versions]
  );
  const selectedVersionRelatedRuns = useMemo(() => {
    if (!selectedVersion) {
      return [];
    }
    return inferenceRuns
      .filter((run) => run.model_version_id === selectedVersion.id)
      .sort((left, right) => {
        const leftTime = Date.parse(left.created_at);
        const rightTime = Date.parse(right.created_at);
        return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
      });
  }, [inferenceRuns, selectedVersion]);
  const selectedModel = selectedVersion ? modelsById.get(selectedVersion.model_id) ?? null : null;
  const selectedVersionFeedbackDatasetIds = useMemo(
    () =>
      Array.from(
        new Set(
          selectedVersionRelatedRuns
            .map((run) => run.feedback_dataset_id)
            .filter((datasetId): datasetId is string => Boolean(datasetId))
        )
      ),
    [selectedVersionRelatedRuns]
  );
  const selectedVersionLatestRun = selectedVersionRelatedRuns[0] ?? null;
  const selectedVersionJob = selectedVersion?.training_job_id
    ? jobsById.get(selectedVersion.training_job_id) ?? null
    : null;
  const selectedVersionJobInsight = selectedVersionJob ? jobExecutionInsights[selectedVersionJob.id] ?? null : null;
  const selectedVersionMetricsPreview = selectedVersion ? buildMetricsPreview(selectedVersion.metrics_summary, 4) : null;
  const selectedVersionSupportsDeviceAccess = Boolean(
    selectedVersion && selectedVersion.status === 'registered'
  );
  const selectedVersionInferencePath = useMemo(() => {
    const searchParams = new URLSearchParams();
    if (selectedVersion?.id) {
      searchParams.set('modelVersion', selectedVersion.id);
    }
    if (selectedVersionJob?.dataset_id) {
      searchParams.set('dataset', selectedVersionJob.dataset_id);
    }
    if (selectedVersionJob?.dataset_version_id) {
      searchParams.set('version', selectedVersionJob.dataset_version_id);
    }
    const query = searchParams.toString();
    return query ? `/inference/validate?${query}` : '/inference/validate';
  }, [selectedVersion?.id, selectedVersionJob?.dataset_id, selectedVersionJob?.dataset_version_id]);
  const selectedVersionClosurePath = useMemo(
    () => buildScopedClosurePath(selectedVersionJob),
    [selectedVersionJob]
  );
  const latestPublicInferenceInvocation =
    deviceLifecycle?.public_inference_invocations[0] ?? null;
  const latestModelPackageDelivery =
    deviceLifecycle?.model_package_deliveries[0] ?? null;
  const deviceLifecycleTimeline = useMemo(() => {
    const credentialEvents = deviceAccessRecords.map((record) => ({
      id: `credential-${record.binding_key}`,
      title: t('Credential ready for device {device}', { device: record.device_name }),
      subtitle: `${record.binding_key} · ${record.api_key_masked}`,
      detail:
        `${t('remaining calls')}: ${record.remaining_calls ?? 'unlimited'} · ` +
        `${t('last used')}: ${
          record.last_used_at ? formatCompactTimestamp(record.last_used_at) : '-'
        }`,
      timestamp: record.issued_at ?? record.last_used_at ?? '',
      badgeTone: record.is_expired ? 'danger' : 'success',
      badgeLabel: record.is_expired ? t('expired') : t('active')
    }));
    const inferenceEvents =
      deviceLifecycle?.public_inference_invocations.map((record) => ({
        id: record.id,
        title: t('Public inference invoked'),
        subtitle: `${record.request_id} · ${record.runtime_auth_binding_key}`,
        detail: `${record.filename} · ${record.execution_source}`,
        timestamp: record.created_at,
        badgeTone: 'neutral' as const,
        badgeLabel: record.framework
      })) ?? [];
    const deliveryEvents =
      deviceLifecycle?.model_package_deliveries.map((record) => ({
        id: record.id,
        title: t('Encrypted model package delivered'),
        subtitle: `${record.delivery_id} · ${record.runtime_auth_binding_key}`,
        detail: `${record.source_filename} · ${record.source_byte_size} bytes`,
        timestamp: record.generated_at,
        badgeTone: 'info' as const,
        badgeLabel: record.framework
      })) ?? [];

    return [...credentialEvents, ...inferenceEvents, ...deliveryEvents]
      .sort((left, right) => toTime(right.timestamp) - toTime(left.timestamp))
      .slice(0, 6);
  }, [deviceAccessRecords, deviceLifecycle, t]);

  const loadDeviceSurface = useCallback(async (versionId: string, options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setDeviceAccessLoading(true);
      setDeviceLifecycleLoading(true);
    }
    setDeviceAccessError('');
    setDeviceLifecycleError('');

    const [deviceAccessResult, lifecycleResult] = await Promise.allSettled([
      api.listRuntimeDeviceAccess(versionId),
      api.getRuntimeDeviceLifecycle(versionId)
    ]);

    if (deviceAccessResult.status === 'fulfilled') {
      setDeviceAccessRecords(
        [...deviceAccessResult.value].sort(
          (left, right) => toTime(right.last_used_at ?? right.issued_at) - toTime(left.last_used_at ?? left.issued_at)
        )
      );
    } else {
      setDeviceAccessRecords([]);
      setDeviceAccessError(
        deviceAccessResult.reason instanceof Error
          ? deviceAccessResult.reason.message
          : String(deviceAccessResult.reason)
      );
    }

    if (lifecycleResult.status === 'fulfilled') {
      setDeviceLifecycle(lifecycleResult.value);
    } else {
      setDeviceLifecycle(null);
      setDeviceLifecycleError(
        lifecycleResult.reason instanceof Error
          ? lifecycleResult.reason.message
          : String(lifecycleResult.reason)
      );
    }

    if (!options?.silent) {
      setDeviceAccessLoading(false);
      setDeviceLifecycleLoading(false);
    }
  }, []);

  const refreshDeviceAccessForSelectedVersion = useCallback(async () => {
    if (!selectedVersion || selectedVersion.status !== 'registered') {
      return;
    }
    try {
      await loadDeviceSurface(selectedVersion.id);
    } catch (loadError) {
      setDeviceAccessError((loadError as Error).message);
    }
  }, [loadDeviceSurface, selectedVersion]);

  useEffect(() => {
    if (!selectedVersionSupportsDeviceAccess || !selectedVersion) {
      setDeviceAccessRecords([]);
      setDeviceAccessLoading(false);
      setDeviceAccessBusy(false);
      setDeviceAccessError('');
      setDeviceLifecycle(null);
      setDeviceLifecycleLoading(false);
      setDeviceLifecycleError('');
      setLatestIssuedDeviceAccess(null);
      setDeviceAccessName('');
      setDeviceAccessExpireDays('');
      setDeviceAccessMaxCalls('');
      return;
    }

    let active = true;
    loadDeviceSurface(selectedVersion.id)
      .catch((loadError) => {
        if (!active) {
          return;
        }
        setDeviceAccessError((loadError as Error).message);
      });

    return () => {
      active = false;
    };
  }, [loadDeviceSurface, selectedVersion, selectedVersionSupportsDeviceAccess]);

  useBackgroundPolling(
    () => {
      if (!selectedVersionSupportsDeviceAccess || !selectedVersion) {
        return;
      }
      loadDeviceSurface(selectedVersion.id, { silent: true }).catch(() => {
        // no-op
      });
    },
    {
      intervalMs: backgroundRefreshIntervalMs,
      enabled: selectedVersionSupportsDeviceAccess
    }
  );

  const issueDeviceAccessForSelectedVersion = useCallback(async () => {
    if (!selectedVersion || selectedVersion.status !== 'registered') {
      return;
    }

    const trimmedName = deviceAccessName.trim();
    if (!trimmedName) {
      setDeviceAccessError(t('Device name is required.'));
      return;
    }

    let maxCalls: number | null = null;
    if (deviceAccessMaxCalls.trim()) {
      const parsed = Number.parseInt(deviceAccessMaxCalls.trim(), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setDeviceAccessError(t('max_calls must be a positive integer.'));
        return;
      }
      maxCalls = parsed;
    }

    let expiresAt: string | null = null;
    if (deviceAccessExpireDays.trim()) {
      const parsed = Number.parseInt(deviceAccessExpireDays.trim(), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setDeviceAccessError(t('Expire days must be a positive integer.'));
        return;
      }
      expiresAt = new Date(Date.now() + parsed * 24 * 60 * 60 * 1000).toISOString();
    }

    setDeviceAccessBusy(true);
    setDeviceAccessError('');
    try {
      const issued = await api.issueRuntimeDeviceAccess({
        model_version_id: selectedVersion.id,
        device_name: trimmedName,
        max_calls: maxCalls,
        expires_at: expiresAt
      });
      setLatestIssuedDeviceAccess(issued);
      setDeviceAccessName('');
      await loadDeviceSurface(selectedVersion.id);
      setSuccess(
        t('Device access key issued for {device}. Keep this key in your device secret manager.', {
          device: issued.record.device_name
        })
      );
    } catch (issueError) {
      setDeviceAccessError((issueError as Error).message);
    } finally {
      setDeviceAccessBusy(false);
    }
  }, [
    deviceAccessExpireDays,
    deviceAccessMaxCalls,
    deviceAccessName,
    loadDeviceSurface,
    selectedVersion,
    t
  ]);

  const rotateDeviceAccessForSelectedVersion = useCallback(
    async (bindingKey: string) => {
      if (!selectedVersion || selectedVersion.status !== 'registered') {
        return;
      }
      setDeviceAccessBusy(true);
      setDeviceAccessError('');
      try {
        const rotated = await api.rotateRuntimeDeviceAccess({
          model_version_id: selectedVersion.id,
          binding_key: bindingKey
        });
        setLatestIssuedDeviceAccess(rotated);
        await loadDeviceSurface(selectedVersion.id);
        setSuccess(
          t('Device key rotated for {device}. Distribute the new key to the device now.', {
            device: rotated.record.device_name
          })
        );
      } catch (rotateError) {
        setDeviceAccessError((rotateError as Error).message);
      } finally {
        setDeviceAccessBusy(false);
      }
    },
    [loadDeviceSurface, selectedVersion, t]
  );

  const revokeDeviceAccessForSelectedVersion = useCallback(
    async (bindingKey: string) => {
      if (!selectedVersion || selectedVersion.status !== 'registered') {
        return;
      }
      setDeviceAccessBusy(true);
      setDeviceAccessError('');
      try {
        const nextRecords = await api.revokeRuntimeDeviceAccess({
          model_version_id: selectedVersion.id,
          binding_key: bindingKey
        });
        setDeviceAccessRecords(
          [...nextRecords].sort(
            (left, right) => toTime(right.last_used_at ?? right.issued_at) - toTime(left.last_used_at ?? left.issued_at)
          )
        );
        await loadDeviceSurface(selectedVersion.id, { silent: true });
        setSuccess(t('Device access revoked.'));
      } catch (revokeError) {
        setDeviceAccessError((revokeError as Error).message);
      } finally {
        setDeviceAccessBusy(false);
      }
    },
    [loadDeviceSurface, selectedVersion, t]
  );

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
  const formatRegistrationEvidenceMode = useCallback(
    (value: ModelVersionRecord['registration_evidence_mode']) => {
      if (value === 'real') {
        return t('real');
      }
      if (value === 'real_probe') {
        return t('real_probe');
      }
      if (value === 'non_real_local_command') {
        return t('non_real_local_command');
      }
      return t('unknown');
    },
    [t]
  );
  const formatRegistrationGateStatus = useCallback(
    (version: ModelVersionRecord) => {
      if (version.registration_gate_exempted === true) {
        return t('exempted');
      }
      if (
        version.registration_gate_exempted === false ||
        version.registration_evidence_mode === 'real' ||
        version.registration_evidence_mode === 'real_probe'
      ) {
        return t('strict');
      }
      return t('unknown');
    },
    [t]
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
        { label: t('Evidence mode'), value: formatRegistrationEvidenceMode(selectedVersion.registration_evidence_mode) },
        { label: t('Gate status'), value: formatRegistrationGateStatus(selectedVersion) },
        { label: t('Inference runs'), value: String(selectedVersionRelatedRuns.length) },
        { label: t('Feedback datasets'), value: String(selectedVersionFeedbackDatasetIds.length) },
        { label: t('Created'), value: formatCompactTimestamp(selectedVersion.created_at) },
        {
          label: t('Artifact'),
          value: selectedVersion.artifact_attachment_id ? t('Ready') : t('Pending')
        }
      ]
    : [];
  type GuidanceAction = {
    label: string;
    to?: string;
    onClick?: () => void;
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  };
  type VersionNextStepState = {
    current: number;
    total: number;
    title: string;
    detail: string;
    badgeTone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
    badgeLabel: string;
    actions: GuidanceAction[];
  };

  const selectedVersionNextStep = useMemo<VersionNextStepState>(() => {
    if (versions.length === 0) {
      return {
        current: 1,
        total: 5,
        title: t('Register the first verified model version'),
        detail: t('Start from a completed real training job, then come back here to register and compare versions.'),
        badgeTone: 'warning',
        badgeLabel: t('No versions'),
        actions: [
          { label: t('Open Training Jobs'), to: '/training/jobs' },
          { label: t('Create model draft'), to: '/models/create', variant: 'ghost' }
        ]
      };
    }

    if (!selectedVersion) {
      return {
        current: 2,
        total: 5,
        title: t('Select one version to continue'),
        detail: t('Open a row from the inventory table so validation, feedback, and device delivery status stay anchored to one concrete version.'),
        badgeTone: 'info',
        badgeLabel: t('Selection needed'),
        actions: filteredVersions.length > 0
          ? [
              {
                label: t('Open first visible version'),
                onClick: () => openVersionDetail(filteredVersions[0].id)
              }
            ]
          : [
              {
                label: t('Clear filters'),
                onClick: () => {
                  setSearchText('');
                  setTaskFilter('all');
                  setFrameworkFilter('all');
                  setStatusFilter('all');
                }
              }
            ]
      };
    }

    if (selectedVersion.status === 'deprecated') {
      return {
        current: 3,
        total: 5,
        title: t('Switch away from deprecated delivery targets'),
        detail: t('This version is deprecated. Compare it against a current registered version before using it for validation or device rollout.'),
        badgeTone: 'warning',
        badgeLabel: t('Deprecated'),
        actions: [
          { label: t('Compare versions'), onClick: () => setVersionToolMode('compare') },
          {
            label: t('Open training job'),
            to: selectedVersion.training_job_id
              ? buildScopedTrainingJobDetailPath(
                  selectedVersion.training_job_id,
                  jobsById.get(selectedVersion.training_job_id) ?? null
                )
              : '/training/jobs',
            variant: 'ghost'
          }
        ]
      };
    }

    if (
      selectedVersionJob &&
      selectedVersionJob.execution_mode === 'local_command' &&
      selectedVersionJobInsight?.reality !== 'real'
    ) {
      return {
        current: 3,
        total: 5,
        title: t('Review linked training evidence first'),
        detail: t('The linked training job still shows non-real or degraded evidence. Confirm the training record before using this version as a trusted external delivery target.'),
        badgeTone: 'warning',
        badgeLabel: t('Evidence review'),
        actions: [
          {
            label: t('Open training job'),
            to: buildScopedTrainingJobDetailPath(selectedVersionJob.id, selectedVersionJob)
          },
          {
            label: t('Open version detail'),
            onClick: () => setVersionDetailOpen(true),
            variant: 'ghost'
          }
        ]
      };
    }

    if (selectedModel && (selectedModel.status === 'draft' || selectedModel.status === 'rejected')) {
      return {
        current: 3,
        total: 5,
        title: t('Finish model governance before wider rollout'),
        detail: t('The parent model is still in draft or rework state. Keep governance aligned before you hand the version to other teams or devices.'),
        badgeTone: 'info',
        badgeLabel: t('Governance pending'),
        actions: [
          { label: t('Open My Models'), to: '/models/my-models?lane=draft_rework' },
          { label: t('Open version detail'), onClick: () => setVersionDetailOpen(true), variant: 'ghost' }
        ]
      };
    }

    if (selectedModel && selectedModel.status === 'pending_approval') {
      return {
        current: 3,
        total: 5,
        title: t('Track approval before broader delivery'),
        detail: t('The parent model is waiting for approval. Keep watching model governance while you continue controlled validation work on this version.'),
        badgeTone: 'info',
        badgeLabel: t('Pending approval'),
        actions: [
          { label: t('Open My Models'), to: '/models/my-models?lane=pending' },
          { label: t('Validate inference'), to: selectedVersionInferencePath, variant: 'ghost' }
        ]
      };
    }

    if (selectedVersionRelatedRuns.length === 0) {
      return {
        current: 4,
        total: 5,
        title: t('Run the first validation inference'),
        detail: t('This version is registered, but no inference run has been recorded yet. Validate once before you move to device delivery or iterative feedback.'),
        badgeTone: 'success',
        badgeLabel: t('Ready to validate'),
        actions: [
          { label: t('Validate inference'), to: selectedVersionInferencePath },
          { label: t('Open version detail'), onClick: () => setVersionDetailOpen(true), variant: 'ghost' }
        ]
      };
    }

    if (selectedVersionFeedbackDatasetIds.length === 0) {
      return {
        current: 4,
        total: 5,
        title: t('Send one validation result back to feedback'),
        detail: t('Inference has started, but no feedback dataset is linked yet. Use the validation page once more to capture iterative data for the next round.'),
        badgeTone: 'info',
        badgeLabel: t('Feedback needed'),
        actions: [
          { label: t('Open validation page'), to: selectedVersionInferencePath },
          { label: t('Open closure lane'), to: selectedVersionClosurePath, variant: 'ghost' }
        ]
      };
    }

    if (selectedVersionSupportsDeviceAccess && deviceAccessRecords.length === 0) {
      return {
        current: 5,
        total: 5,
        title: t('Issue the first device credential'),
        detail: t('The version already has validation evidence. Open the detail drawer and issue a scoped credential before the robot or edge client starts using it.'),
        badgeTone: 'success',
        badgeLabel: t('Ready for device'),
        actions: [
          { label: t('Open version detail'), onClick: () => setVersionDetailOpen(true) },
          { label: t('Open console'), to: '/workspace/console', variant: 'ghost' }
        ]
      };
    }

    if (selectedVersionSupportsDeviceAccess && deviceAccessRecords.length > 0 && !latestPublicInferenceInvocation) {
      return {
        current: 5,
        total: 5,
        title: t('Verify remote inference from the target device'),
        detail: t('A credential exists, but no public inference call has been observed yet. Distribute the key and run one authorized inference from the device now.'),
        badgeTone: 'info',
        badgeLabel: t('Remote verify'),
        actions: [
          { label: t('Open version detail'), onClick: () => setVersionDetailOpen(true) },
          { label: t('Open validation page'), to: selectedVersionInferencePath, variant: 'ghost' }
        ]
      };
    }

    if (selectedVersionSupportsDeviceAccess && latestPublicInferenceInvocation && !latestModelPackageDelivery) {
      return {
        current: 5,
        total: 5,
        title: t('Verify encrypted package delivery'),
        detail: t('Public inference is already proven. Finish one encrypted model package pull so remote deployment is also evidenced.'),
        badgeTone: 'info',
        badgeLabel: t('Package verify'),
        actions: [
          { label: t('Open version detail'), onClick: () => setVersionDetailOpen(true) },
          { label: t('Open console'), to: '/workspace/console', variant: 'ghost' }
        ]
      };
    }

    return {
      current: 5,
      total: 5,
      title: t('Version is ready for iterative use and controlled delivery'),
      detail: t('Validation, feedback, and device-delivery evidence are all visible. Continue from the closure lane or monitor ongoing usage from the version detail drawer.'),
      badgeTone: 'success',
      badgeLabel: t('Closed loop visible'),
      actions: [
        { label: t('Open closure lane'), to: selectedVersionClosurePath },
        { label: t('Open version detail'), onClick: () => setVersionDetailOpen(true), variant: 'secondary' },
        { label: t('Validate inference'), to: selectedVersionInferencePath, variant: 'ghost' }
      ]
    };
  }, [
    deviceAccessRecords.length,
    filteredVersions,
    jobsById,
    latestModelPackageDelivery,
    latestPublicInferenceInvocation,
    openVersionDetail,
    selectedModel,
    selectedVersion,
    selectedVersionClosurePath,
    selectedVersionFeedbackDatasetIds.length,
    selectedVersionInferencePath,
    selectedVersionJob,
    selectedVersionJobInsight?.reality,
    selectedVersionRelatedRuns.length,
    selectedVersionSupportsDeviceAccess,
    t,
    versions.length
  ]);
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
          const runCount = inferenceRuns.filter((run) => run.model_version_id === version.id).length;
          const feedbackDatasetCount = new Set(
            inferenceRuns
              .filter((run) => run.model_version_id === version.id)
              .map((run) => run.feedback_dataset_id)
              .filter((datasetId): datasetId is string => Boolean(datasetId))
          ).size;
          return (
            <div className="stack tight">
              <small className="muted">{linkedModel?.name ?? t('Model record unavailable')}</small>
              <small className="muted">
                {linkedJob?.name ?? (version.training_job_id ? t('Job record unavailable') : t('manual'))}
              </small>
              <small className="muted">
                {t('Runs')}: {runCount} · {t('Feedback datasets')}: {feedbackDatasetCount}
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
                <Badge
                  tone={
                    version.registration_evidence_mode === 'non_real_local_command'
                      ? 'warning'
                      : version.registration_evidence_mode === 'real_probe'
                        ? 'info'
                        : 'success'
                  }
                >
                  {t('Evidence')}: {formatRegistrationEvidenceMode(version.registration_evidence_mode)}
                </Badge>
                <Badge tone={version.registration_gate_exempted ? 'warning' : 'success'}>
                  {t('Gate')}: {formatRegistrationGateStatus(version)}
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
    [
      compareIdSet,
      describeJobExecutionReality,
      formatRegistrationEvidenceMode,
      formatRegistrationGateStatus,
      inferenceRuns,
      jobExecutionInsights,
      jobsById,
      modelsById,
      openVersionDetail,
      selectedVersionId,
      t
    ]
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
      const created = await api.registerModelVersion({
        model_id: modelId,
        training_job_id: jobId,
        version_name: versionName.trim()
      });

      setSuccess(t('Version registered and ready for validation and comparison.'));
      setVersionName('');
      await load('manual');
      setSelectedVersionId(created.id);
      setVersionDetailOpen(true);
    } catch (registerError) {
      setError((registerError as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const registrationBlocked = models.length === 0 || registerableJobs.length === 0;
  const registrationBlockedTitle = useMemo(() => {
    if (models.length === 0) {
      return t('There are no available models.');
    }
    if (registerableJobs.length === 0) {
      return hasRegistrationPrefill && registrationPrefillJob
        ? t('This run still needs a model draft.')
        : t('There are no verified jobs.');
    }
    return t('There are no verified jobs.');
  }, [hasRegistrationPrefill, models.length, registerableJobs.length, registrationPrefillJob, t]);
  const registrationBlockedDescription = useMemo(() => {
    if (models.length === 0) {
      return hasRegistrationPrefill && registrationPrefillJob
        ? t('Create or import a model draft from the completed run before registering.')
        : t('Create or import a model draft first.');
    }
    if (registerableJobs.length === 0) {
      return hasRegistrationPrefill && registrationPrefillJob
        ? t('This completed run is still the anchor. Open it or create a matching model draft first.')
        : t('Only verified jobs can be registered.');
    }
    return t('Only verified jobs can be registered.');
  }, [hasRegistrationPrefill, models.length, registerableJobs.length, registrationPrefillJob, t]);
  const canSubmitRegistration =
    !submitting && Boolean(modelId && jobId && versionName.trim() && registerableJobs.some((job) => job.id === jobId));
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
      {success ? (
        <InlineAlert
          tone="success"
          title={t('Action Completed')}
          description={success}
          actions={
            selectedVersion ? (
              <div className="row gap wrap">
                <ButtonLink
                  to={buildScopedInferenceValidationPath(selectedVersion.id)}
                  variant="secondary"
                  size="sm"
                >
                  {t('Validate inference')}
                </ButtonLink>
                {selectedVersion.training_job_id ? (
                  <ButtonLink
                    to={buildScopedTrainingJobDetailPath(
                      selectedVersion.training_job_id,
                      jobsById.get(selectedVersion.training_job_id) ?? null
                    )}
                    variant="ghost"
                    size="sm"
                  >
                    {t('Open training job')}
                  </ButtonLink>
                ) : null}
              </div>
            ) : null
          }
        />
      ) : null}

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
            <WorkspaceNextStepCard
              title={t('Next step')}
              description={t('Keep validation, governance, and device delivery aligned to one selected version.')}
              stepLabel={selectedVersionNextStep.title}
              stepDetail={selectedVersionNextStep.detail}
              current={selectedVersionNextStep.current}
              total={selectedVersionNextStep.total}
              badgeLabel={selectedVersionNextStep.badgeLabel}
              badgeTone={selectedVersionNextStep.badgeTone}
              actions={selectedVersionNextStep.actions.map((action) =>
                action.to ? (
                  <ButtonLink key={action.label} to={action.to} variant={action.variant ?? 'primary'} size="sm">
                    {action.label}
                  </ButtonLink>
                ) : (
                  <Button key={action.label} type="button" variant={action.variant ?? 'primary'} size="sm" onClick={action.onClick}>
                    {action.label}
                  </Button>
                )
              )}
            />

            <SectionCard
              title={t('Version snapshot')}
              description={t('Keep the selected version, feedback state, and remote-delivery proof visible in one place.')}
            >
              <DetailList
                items={[
                  { label: t('Selected version'), value: selectedVersion?.version_name ?? t('Not selected') },
                  { label: t('Model status'), value: selectedModel ? t(selectedModel.status) : '-' },
                  {
                    label: t('Evidence mode'),
                    value: selectedVersion ? formatRegistrationEvidenceMode(selectedVersion.registration_evidence_mode) : '-'
                  },
                  {
                    label: t('Gate status'),
                    value: selectedVersion ? formatRegistrationGateStatus(selectedVersion) : '-'
                  },
                  { label: t('Inference runs'), value: selectedVersionRelatedRuns.length },
                  { label: t('Feedback datasets'), value: selectedVersionFeedbackDatasetIds.length },
                  { label: t('Device credentials'), value: deviceAccessRecords.length },
                  {
                    label: t('Public inference'),
                    value: deviceLifecycle?.public_inference_invocations.length ?? 0
                  },
                  {
                    label: t('Package deliveries'),
                    value: deviceLifecycle?.model_package_deliveries.length ?? 0
                  }
                ]}
              />
              <div className="row gap wrap">
                {selectedVersion ? (
                  <ButtonLink to={selectedVersionInferencePath} variant="ghost" size="sm">
                    {t('Validate inference')}
                  </ButtonLink>
                ) : null}
                {selectedVersionJob ? (
                  <ButtonLink
                    to={buildScopedTrainingJobDetailPath(selectedVersionJob.id, selectedVersionJob)}
                    variant="ghost"
                    size="sm"
                  >
                    {t('Open training job')}
                  </ButtonLink>
                ) : null}
                <ButtonLink to="/models/my-models" variant="ghost" size="sm">
                  {t('Open My Models')}
                </ButtonLink>
              </div>
            </SectionCard>

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
                  title={registrationBlockedTitle}
                  description={registrationBlockedDescription}
                  extra={
                    <div className="row gap wrap">
                      {registrationPrefillJob ? (
                        <ButtonLink
                          to={buildCreateModelDraftPath(registrationPrefillJob.task_type, {
                            jobId: registrationPrefillJob.id,
                            versionName: registrationPrefillJob.name
                          })}
                          variant="secondary"
                          size="sm"
                        >
                          {t('Create model draft')}
                        </ButtonLink>
                      ) : models.length === 0 ? (
                        <ButtonLink to={registrationPrefillCreateModelPath} variant="secondary" size="sm">
                          {t('Create model draft')}
                        </ButtonLink>
                      ) : completedJobs.length === 0 ? (
                        <ButtonLink to="/training/jobs/new" variant="secondary" size="sm">
                          {t('Create training job')}
                        </ButtonLink>
                      ) : null}
                      {registrationPrefillJobPath ? (
                        <ButtonLink to={registrationPrefillJobPath} variant="ghost" size="sm">
                          {t('Open training job')}
                        </ButtonLink>
                      ) : null}
                    </div>
                  }
                />
              ) : (
                <div className="stack">
                  {registrationPrefillNeedsMatchingModel ? (
                    <InlineAlert
                      tone="warning"
                      title={t('No matching owned model yet')}
                      description={
                        registrationPrefillJob
                          ? t(
                              'This completed run is ready, but none of your owned models match the selected task type yet.'
                            )
                          : t('Choose a model that matches the completed run before registering.')
                      }
                      actions={
                        <div className="row gap wrap">
                          {registrationPrefillJob ? (
                            <ButtonLink
                              to={buildCreateModelDraftPath(registrationPrefillJob.task_type, {
                                jobId: registrationPrefillJob.id,
                                versionName: registrationPrefillJob.name
                              })}
                              variant="secondary"
                              size="sm"
                            >
                              {t('Create model draft')}
                            </ButtonLink>
                          ) : null}
                          {registrationPrefillJobPath ? (
                            <ButtonLink to={registrationPrefillJobPath} variant="ghost" size="sm">
                              {t('Open training job')}
                            </ButtonLink>
                          ) : null}
                        </div>
                      }
                    />
                  ) : null}
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
                  {hasRegistrationPrefill && registrationPrefillJob ? (
                    <InlineAlert
                      tone="info"
                      title={t('Training run prefilled')}
                      description={
                        prefilledJobRegisterable
                          ? t('Use the completed run as the registration anchor.')
                          : t('This run is kept for reference; choose a verified job below.')
                      }
                      actions={
                        <div className="row gap wrap">
                          {registrationPrefillJobPath ? (
                            <ButtonLink to={registrationPrefillJobPath} variant="ghost" size="sm">
                              {t('Open training job')}
                            </ButtonLink>
                          ) : null}
                          {prefillJobId ? (
                            <ButtonLink to="/models/versions" variant="ghost" size="sm">
                              {t('Clear prefill')}
                            </ButtonLink>
                          ) : null}
                        </div>
                      }
                    />
                  ) : null}
                  <div className="workspace-form-grid">
                    <label>
                      {t('Model')}
                      <Select
                        value={modelId}
                        onChange={(event) => {
                          modelTouchedRef.current = true;
                          setModelId(event.target.value);
                        }}
                      >
                        <option value="">{t('Select a model')}</option>
                        {models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name} ({t(model.model_type)})
                          </option>
                        ))}
                      </Select>
                    </label>
                    <label>
                      {t('Completed Training Job')}
                      <Select
                        value={jobId}
                        onChange={(event) => {
                          jobTouchedRef.current = true;
                          setJobId(event.target.value);
                        }}
                      >
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
                        onChange={(event) => {
                          versionNameTouchedRef.current = true;
                          setVersionName(event.target.value);
                        }}
                        placeholder={t('For example: v2026.04.02')}
                      />
                    </label>
                  </div>

                  <small className="muted">
                    {t('Only use verified jobs.')}
                  </small>

                  <Button type="button" onClick={registerVersion} disabled={!canSubmitRegistration} block>
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
          <div className="row gap wrap">
            {selectedVersion ? (
              <ButtonLink to={buildScopedInferenceValidationPath(selectedVersion.id)} variant="secondary" size="sm">
                {t('Validate inference')}
              </ButtonLink>
            ) : null}
            {selectedVersion?.training_job_id ? (
              <ButtonLink
                to={buildScopedTrainingJobDetailPath(
                  selectedVersion.training_job_id,
                  jobsById.get(selectedVersion.training_job_id) ?? null
                )}
                variant="ghost"
                size="sm"
              >
                {t('Open Training Job')}
              </ButtonLink>
            ) : null}
          </div>
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
            {selectedVersionJob &&
            selectedVersionJob.execution_mode === 'local_command' &&
            selectedVersionJobInsight?.reality !== 'real' ? (
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
            <div className="stack tight">
              <strong>{t('Closed-loop objects')}</strong>
              <small className="muted">
                {t('Training job')}:
                {' '}
                {selectedVersion.training_job_id || t('manual')}
                {' · '}
                {t('Model version')}: {selectedVersion.id}
              </small>
              {selectedVersionLatestRun ? (
                <small className="muted">
                  {t('Latest inference run')}: {selectedVersionLatestRun.id}
                  {' · '}
                  {t('Execution source')}: {selectedVersionLatestRun.execution_source}
                  {' · '}
                  {t('Created')}: {formatCompactTimestamp(selectedVersionLatestRun.created_at)}
                </small>
              ) : (
                <small className="muted">{t('No inference runs linked yet.')}</small>
              )}
              {selectedVersionFeedbackDatasetIds.length > 0 ? (
                <small className="muted">
                  {t('Feedback datasets')}:
                  {' '}
                  {selectedVersionFeedbackDatasetIds
                    .map((datasetId) => datasetsById.get(datasetId)?.name ?? datasetId)
                    .join(', ')}
                </small>
              ) : (
                <small className="muted">{t('No feedback dataset linked yet.')}</small>
              )}
            </div>
            <div className="stack tight">
              <strong>{t('Device API authorization')}</strong>
              <small className="muted">
                {t(
                  'Issue scoped credentials so robots and edge clients can call runtime inference and pull model packages.'
                )}
              </small>
              {!selectedVersionSupportsDeviceAccess ? (
                <small className="muted">
                  {t('Only registered model versions support device authorization.')}
                </small>
              ) : (
                <>
                  {deviceAccessError ? (
                    <StateBlock
                      variant="error"
                      title={t('Device authorization failed')}
                      description={deviceAccessError}
                    />
                  ) : null}
                  <div className="workspace-form-grid">
                    <label>
                      {t('Device name')}
                      <Input
                        value={deviceAccessName}
                        onChange={(event) => setDeviceAccessName(event.target.value)}
                        placeholder={t('e.g. robot-dog-unit-01')}
                        disabled={deviceAccessBusy}
                      />
                    </label>
                    <label>
                      {t('Expire days (optional)')}
                      <Input
                        value={deviceAccessExpireDays}
                        onChange={(event) => setDeviceAccessExpireDays(event.target.value)}
                        placeholder={t('e.g. 30')}
                        disabled={deviceAccessBusy}
                      />
                    </label>
                    <label>
                      {t('Max calls (optional)')}
                      <Input
                        value={deviceAccessMaxCalls}
                        onChange={(event) => setDeviceAccessMaxCalls(event.target.value)}
                        placeholder={t('e.g. 5000')}
                        disabled={deviceAccessBusy}
                      />
                    </label>
                  </div>
                  <div className="row gap wrap">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        void issueDeviceAccessForSelectedVersion();
                      }}
                      disabled={deviceAccessBusy || deviceAccessLoading}
                    >
                      {deviceAccessBusy ? t('Working...') : t('Issue device credential')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        void refreshDeviceAccessForSelectedVersion();
                      }}
                      disabled={deviceAccessBusy || deviceAccessLoading}
                    >
                      {deviceAccessLoading ? t('Refreshing...') : t('Refresh')}
                    </Button>
                  </div>

                  {deviceAccessLoading ? (
                    <small className="muted">{t('Loading device credentials...')}</small>
                  ) : deviceAccessRecords.length > 0 ? (
                    <div className="stack tight">
                      {deviceAccessRecords.map((record) => (
                        <div key={record.binding_key} className="workspace-record-item compact stack tight">
                          <div className="row gap wrap align-center">
                            <strong>{record.device_name}</strong>
                            <Badge tone={record.is_expired ? 'danger' : 'success'}>
                              {record.is_expired ? t('expired') : t('active')}
                            </Badge>
                          </div>
                          <small className="muted">{record.binding_key}</small>
                          <small className="muted">
                            {t('key')}: {record.api_key_masked}
                          </small>
                          <small className="muted">
                            {t('issued at')}: {record.issued_at ? formatCompactTimestamp(record.issued_at) : '-'} ·{' '}
                            {t('remaining calls')}: {record.remaining_calls ?? 'unlimited'}
                          </small>
                          <small className="muted">
                            {t('last used')}: {record.last_used_at ? formatCompactTimestamp(record.last_used_at) : '-'}
                          </small>
                          <div className="row gap wrap">
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              disabled={deviceAccessBusy}
                              onClick={() => {
                                void rotateDeviceAccessForSelectedVersion(record.binding_key);
                              }}
                            >
                              {t('Rotate key')}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={deviceAccessBusy}
                              onClick={() => {
                                void revokeDeviceAccessForSelectedVersion(record.binding_key);
                              }}
                            >
                              {t('Revoke')}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <small className="muted">{t('No device credential yet.')}</small>
                  )}

                  <Card as="section" tone="soft" className="stack tight">
                    <div className="row gap wrap align-center">
                      <strong>{t('Device delivery lifecycle')}</strong>
                      <ButtonLink to={selectedVersionInferencePath} variant="ghost" size="sm">
                        {t('Open Validation')}
                      </ButtonLink>
                      <ButtonLink to="/workspace/console" variant="ghost" size="sm">
                        {t('Open Console')}
                      </ButtonLink>
                    </div>
                    <small className="muted">
                      {t(
                        'Check whether the issued credential has already been used for public inference and encrypted package delivery.'
                      )}
                    </small>
                    {deviceLifecycleLoading ? (
                      <small className="muted">{t('Loading device lifecycle...')}</small>
                    ) : deviceLifecycleError ? (
                      <InlineAlert tone="danger" title={t('Load Failed')} description={deviceLifecycleError} />
                    ) : (
                      <>
                        <div className="row gap wrap">
                          <Badge tone={deviceAccessRecords.length > 0 ? 'success' : 'warning'}>
                            {t('Credentials')}: {deviceAccessRecords.length}
                          </Badge>
                          <Badge
                            tone={
                              (deviceLifecycle?.public_inference_invocations.length ?? 0) > 0
                                ? 'success'
                                : 'warning'
                            }
                          >
                            {t('Public inference')}: {deviceLifecycle?.public_inference_invocations.length ?? 0}
                          </Badge>
                          <Badge
                            tone={
                              (deviceLifecycle?.model_package_deliveries.length ?? 0) > 0
                                ? 'success'
                                : 'warning'
                            }
                          >
                            {t('Package deliveries')}: {deviceLifecycle?.model_package_deliveries.length ?? 0}
                          </Badge>
                        </div>
                        <small className="muted">
                          {latestPublicInferenceInvocation
                            ? `${t('Latest public inference')}: ${latestPublicInferenceInvocation.request_id} · ${latestPublicInferenceInvocation.runtime_auth_binding_key} · ${formatCompactTimestamp(latestPublicInferenceInvocation.created_at)}`
                            : deviceAccessRecords.length > 0
                              ? t('No device has invoked public inference yet. Copy the inference curl below and verify once from the target device.')
                              : t('Issue a device credential first, then this lifecycle view will start to populate.')}
                        </small>
                        <small className="muted">
                          {latestModelPackageDelivery
                            ? `${t('Latest package delivery')}: ${latestModelPackageDelivery.delivery_id} · ${latestModelPackageDelivery.source_filename} · ${formatCompactTimestamp(latestModelPackageDelivery.generated_at)}`
                            : deviceAccessRecords.length > 0
                              ? t('No encrypted model package has been delivered yet. Copy the model package curl below when the device is ready to pull.')
                              : t('After issuing a credential, model package deliveries will be listed here.')}
                        </small>
                        {deviceLifecycleTimeline.length > 0 ? (
                          <div className="stack tight">
                            {deviceLifecycleTimeline.map((event) => (
                              <div key={event.id} className="workspace-record-item compact stack tight">
                                <div className="row gap wrap align-center">
                                  <strong>{event.title}</strong>
                                  <Badge
                                    tone={
                                      event.badgeTone as 'neutral' | 'info' | 'success' | 'warning' | 'danger'
                                    }
                                  >
                                    {event.badgeLabel}
                                  </Badge>
                                </div>
                                <small className="muted">{event.subtitle}</small>
                                <small className="muted">{event.detail}</small>
                                <small className="muted">
                                  {t('Timestamp')}: {event.timestamp ? formatCompactTimestamp(event.timestamp) : '-'}
                                </small>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </>
                    )}
                  </Card>

                  {latestIssuedDeviceAccess ? (
                    <details className="workspace-details">
                      <summary>{t('Latest issued credential (copy once)')}</summary>
                      <div className="stack tight">
                        <small className="muted">
                          {latestIssuedDeviceAccess.record.device_name} · {latestIssuedDeviceAccess.record.api_key_masked}
                        </small>
                        <pre className="code-block">{latestIssuedDeviceAccess.api_key}</pre>
                        <small className="muted">{t('Inference API sample')}</small>
                        <pre className="code-block">{latestIssuedDeviceAccess.snippets.sample_inference_curl}</pre>
                        <small className="muted">{t('Model package API sample')}</small>
                        <pre className="code-block">{latestIssuedDeviceAccess.snippets.sample_model_package_curl}</pre>
                      </div>
                    </details>
                  ) : null}
                </>
              )}
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
