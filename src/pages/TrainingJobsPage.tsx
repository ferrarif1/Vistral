import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type {
  TrainingArtifactSummary,
  TrainingExecutionMode,
  ModelRecord,
  ModelVersionRecord,
  TrainingWorkerNodeView,
  TrainingJobRecord,
  TrainingJobStatus
} from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import AdvancedSection from '../components/AdvancedSection';
import TrainingLaunchContextPills from '../components/onboarding/TrainingLaunchContextPills';
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
import { Panel } from '../components/ui/Surface';
import { WorkspacePage, WorkspaceWorkbench } from '../components/ui/WorkspacePage';
import {
  deriveTrainingExecutionInsight,
  type TrainingExecutionInsight
} from '../features/trainingExecutionInsight';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';
import { bucketRuntimeFallbackReason, runtimeFallbackReasonLabelKey } from '../utils/runtimeFallbackReason';

const activeStatusSet = new Set<TrainingJobStatus>(['queued', 'preparing', 'running', 'evaluating']);
const terminalStatusSet = new Set<TrainingJobStatus>(['completed', 'failed', 'cancelled']);
const backgroundRefreshIntervalMs = 5000;
const adminAccessMessagePattern = /(forbidden|permission|unauthorized|not allowed|admin|管理员|权限)/i;
const cancelTransitionRacePattern = /Only queued\/preparing\/running job can be cancelled/i;

type LoadMode = 'initial' | 'manual' | 'background';
type QueueFilter = 'all' | 'active' | 'terminal';
type LaunchContext = {
  taskType?: string | null;
  framework?: string | null;
  executionTarget?: string | null;
  workerId?: string | null;
};

const formatTimestamp = (iso: string): string => formatCompactTimestamp(iso);

const appendTrainingLaunchContext = (searchParams: URLSearchParams, context?: LaunchContext) => {
  if (!context) {
    return;
  }
  if (context.taskType?.trim() && !searchParams.has('task_type')) {
    searchParams.set('task_type', context.taskType.trim());
  }
  if (context.framework?.trim() && !searchParams.has('framework')) {
    searchParams.set('framework', context.framework.trim());
  }
  if (
    context.executionTarget?.trim() &&
    context.executionTarget.trim() !== 'auto' &&
    !searchParams.has('execution_target')
  ) {
    searchParams.set('execution_target', context.executionTarget.trim());
  }
  if (context.workerId?.trim() && !searchParams.has('worker')) {
    searchParams.set('worker', context.workerId.trim());
  }
};

const sanitizeReturnToPath = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('://')) {
    return null;
  }
  return trimmed;
};

const appendReturnTo = (searchParams: URLSearchParams, returnTo?: string | null) => {
  const safeReturnTo = sanitizeReturnToPath(returnTo);
  if (safeReturnTo && !searchParams.has('return_to')) {
    searchParams.set('return_to', safeReturnTo);
  }
};

const buildScopedDatasetPath = (
  datasetId: string,
  versionId?: string | null,
  launchContext?: LaunchContext
): string => {
  const searchParams = new URLSearchParams();
  if (versionId?.trim()) {
    searchParams.set('version', versionId.trim());
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  const query = searchParams.toString();
  return query ? `/datasets/${datasetId}?${query}` : `/datasets/${datasetId}`;
};

const buildScopedClosurePath = (
  datasetId: string,
  versionId?: string | null,
  launchContext?: LaunchContext
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('dataset', datasetId);
  if (versionId?.trim()) {
    searchParams.set('version', versionId.trim());
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/workflow/closure?${searchParams.toString()}`;
};

const buildScopedJobDetailPath = (jobId: string, params?: URLSearchParams): string => {
  const query = params?.toString() ?? '';
  return query ? `/training/jobs/${jobId}?${query}` : `/training/jobs/${jobId}`;
};

type JobDetailPathOptions = {
  logEntryId?: string;
  evidenceView?: 'overview' | 'metrics' | 'logs';
  errorHint?: string;
};

const buildScopedModelVersionsPath = (
  job: TrainingJobRecord,
  versionName?: string,
  launchContext?: LaunchContext
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('job', job.id);
  if (versionName?.trim()) {
    searchParams.set('version_name', versionName.trim());
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/models/versions?${searchParams.toString()}`;
};

const buildScopedVersionDeliveryPath = (
  job: TrainingJobRecord,
  versionName?: string,
  selectedVersionId?: string | null,
  launchContext?: LaunchContext
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('job', job.id);
  if (versionName?.trim()) {
    searchParams.set('version_name', versionName.trim());
  }
  if (selectedVersionId?.trim()) {
    searchParams.set('selectedVersion', selectedVersionId.trim());
    searchParams.set('focus', 'device');
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/models/versions?${searchParams.toString()}`;
};

const buildScopedInferencePath = (
  datasetId: string,
  versionId?: string | null,
  modelVersionId?: string | null,
  launchContext?: LaunchContext
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('dataset', datasetId);
  if (versionId?.trim()) {
    searchParams.set('version', versionId.trim());
  }
  if (modelVersionId?.trim()) {
    searchParams.set('modelVersion', modelVersionId.trim());
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/inference/validate?${searchParams.toString()}`;
};

const buildRuntimeSettingsPath = (
  focus: 'setup' | 'readiness' | 'advanced' = 'readiness',
  framework?: string | null,
  launchContext?: LaunchContext,
  returnTo?: string | null
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('focus', focus);
  if (framework?.trim()) {
    searchParams.set('framework', framework.trim());
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  appendReturnTo(searchParams, returnTo);
  return `/settings/runtime?${searchParams.toString()}`;
};

const buildWorkerSettingsPath = (
  job?: TrainingJobRecord | null,
  launchContext?: LaunchContext,
  returnTo?: string | null
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('focus', 'inventory');
  if (job?.framework) {
    searchParams.set('profile', job.framework);
  }
  if (job?.scheduled_worker_id) {
    searchParams.set('worker', job.scheduled_worker_id);
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  appendReturnTo(searchParams, returnTo);
  return `/settings/workers?${searchParams.toString()}`;
};

const buildCreateModelDraftPath = (
  taskType?: string,
  options?: {
    jobId?: string;
    versionName?: string;
  },
  launchContext?: LaunchContext
): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
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

const buildJobsSignature = (jobs: TrainingJobRecord[]): string =>
  JSON.stringify(
    [...jobs]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((job) => ({
        id: job.id,
        name: job.name,
        status: job.status,
        updated_at: job.updated_at,
        log_excerpt: job.log_excerpt,
        task_type: job.task_type,
        framework: job.framework
      }))
  );

const describeRealityLabel = (
  t: (source: string, vars?: Record<string, string | number>) => string,
  insight: TrainingExecutionInsight
) => {
  if (insight.reality === 'standard') {
    return t('Standard output');
  }
  if (insight.reality === 'template') {
    return t('Fallback output');
  }
  if (insight.reality === 'simulated') {
    return t('Needs verification');
  }
  return t('Unknown execution');
};

const describeExecutionModeLabel = (
  t: (source: string, vars?: Record<string, string | number>) => string,
  mode: TrainingExecutionMode
) => {
  if (mode === 'local_command') {
    return t('Local command');
  }
  if (mode === 'simulated') {
    return t('Fallback execution');
  }
  return t('Unknown');
};

const describeExecutionTargetLabel = (
  t: (source: string, vars?: Record<string, string | number>) => string,
  target: TrainingJobRecord['execution_target']
) => (target === 'worker' ? t('Worker execution') : t('Local execution'));

const describeFallbackReasonLabel = (
  t: (source: string, vars?: Record<string, string | number>) => string,
  reason: string
) => t(runtimeFallbackReasonLabelKey(bucketRuntimeFallbackReason(reason)));

interface TrainingJobSummaryBlockProps {
  t: (source: string, vars?: Record<string, string | number>) => string;
  job: TrainingJobRecord;
  insight: TrainingExecutionInsight | null;
  realityLabel: string;
  variant: 'glance' | 'full';
}

type OperationLogEntry = {
  id: string;
  createdAt: string;
  tone: 'success' | 'warning' | 'danger' | 'info';
  title: string;
  detail: string;
  isBatch: boolean;
  hasFailure: boolean;
  errorSummary?: string;
  targetJobId?: string;
};

type OperationLogGroupKey = 'today' | 'yesterday' | 'earlier';

const OPERATION_LOG_GROUP_KEYS: OperationLogGroupKey[] = ['today', 'yesterday', 'earlier'];
const OPERATION_LOG_GROUP_COLLAPSE_STORAGE_KEY = 'vistral.trainingJobs.operationLogGroupCollapse';
const DEFAULT_OPERATION_LOG_GROUP_COLLAPSE: Record<OperationLogGroupKey, boolean> = {
  today: false,
  yesterday: false,
  earlier: false
};

const resolveOperationLogGroupKey = (createdAt: string): OperationLogGroupKey => {
  const timestamp = new Date(createdAt).getTime();
  if (!Number.isFinite(timestamp)) {
    return 'earlier';
  }
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  if (timestamp >= startOfToday) {
    return 'today';
  }
  if (timestamp >= startOfYesterday) {
    return 'yesterday';
  }
  return 'earlier';
};

const readOperationLogGroupCollapseState = (): Record<OperationLogGroupKey, boolean> => {
  if (typeof window === 'undefined') {
    return DEFAULT_OPERATION_LOG_GROUP_COLLAPSE;
  }
  try {
    const raw = window.localStorage.getItem(OPERATION_LOG_GROUP_COLLAPSE_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_OPERATION_LOG_GROUP_COLLAPSE;
    }
    const parsed = JSON.parse(raw) as Partial<Record<OperationLogGroupKey, boolean>>;
    return {
      today: typeof parsed.today === 'boolean' ? parsed.today : DEFAULT_OPERATION_LOG_GROUP_COLLAPSE.today,
      yesterday:
        typeof parsed.yesterday === 'boolean'
          ? parsed.yesterday
          : DEFAULT_OPERATION_LOG_GROUP_COLLAPSE.yesterday,
      earlier:
        typeof parsed.earlier === 'boolean' ? parsed.earlier : DEFAULT_OPERATION_LOG_GROUP_COLLAPSE.earlier
    };
  } catch {
    return DEFAULT_OPERATION_LOG_GROUP_COLLAPSE;
  }
};

function TrainingJobSummaryBlock({
  t,
  job,
  insight,
  realityLabel,
  variant
}: TrainingJobSummaryBlockProps) {
  const showMode = variant === 'full';
  return (
    <div className="stack">
      <div className="stack tight">
        <strong>{job.name}</strong>
        <div className="row gap wrap">
          <StatusTag status={job.status}>{t(job.status)}</StatusTag>
          <Badge tone="neutral">{t(job.task_type)}</Badge>
          <Badge tone="info">{t(job.framework)}</Badge>
          <Badge tone={insight?.reality === 'standard' ? 'success' : 'warning'}>
            {insight ? realityLabel : t('Unknown')}
          </Badge>
        </div>
        <small className="muted">
          {job.base_model} · {t('Last updated')}: {formatTimestamp(job.updated_at)}
        </small>
      </div>
      <DetailList
        items={[
          { label: t('Dataset'), value: job.dataset_id || '—' },
          { label: t('Version'), value: job.dataset_version_id || '—' },
          { label: t('Lane'), value: describeExecutionTargetLabel(t, job.execution_target) },
          ...(showMode
            ? [{ label: t('Mode:'), value: describeExecutionModeLabel(t, job.execution_mode) }]
            : [])
        ]}
      />
      {insight?.showWarning ? (
        <InlineAlert
          tone={insight.reality === 'simulated' ? 'danger' : 'warning'}
          title={t('Needs verification')}
          description={
            insight.fallbackReason
              ? t(
                  'The job does not have complete standard execution evidence. Review the detail first. Reason: {reason}',
                  { reason: describeFallbackReasonLabel(t, insight.fallbackReason) }
                )
              : t('The job does not have complete standard execution evidence. Review the detail first.')
          }
        />
      ) : null}
    </div>
  );
}

export default function TrainingJobsPage() {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedReturnTo = sanitizeReturnToPath(searchParams.get('return_to'));
  const currentTaskPath = useMemo(
    () => `${location.pathname}${location.search || ''}`,
    [location.pathname, location.search]
  );
  const outboundReturnTo = requestedReturnTo ?? currentTaskPath;
  const preferredJobId = (searchParams.get('job') ?? searchParams.get('selectedJob') ?? '').trim();
  const preferredTaskTypeContext = (searchParams.get('task_type') ?? searchParams.get('task') ?? '').trim();
  const preferredFrameworkContext = (searchParams.get('framework') ?? searchParams.get('profile') ?? '').trim().toLowerCase();
  const preferredExecutionTarget = (searchParams.get('execution_target') ?? '').trim().toLowerCase();
  const preferredWorkerId = (searchParams.get('worker') ?? '').trim();
  const focusedOperationLogId = (searchParams.get('op_log') ?? '').trim();
  const initialSearchText = (searchParams.get('q') ?? '').trim();
  const initialQueueFilter = (() => {
    const value = (searchParams.get('queue') ?? '').trim();
    return value === 'active' || value === 'terminal' ? value : 'all';
  })();
  const initialTaskFilter = (() => {
    const value = (
      searchParams.get('task_filter') ??
      searchParams.get('task') ??
      searchParams.get('task_type') ??
      ''
    ).trim();
    return value === 'ocr' ||
      value === 'detection' ||
      value === 'classification' ||
      value === 'segmentation' ||
      value === 'obb'
      ? value
      : 'all';
  })();
  const initialFrameworkFilter = (() => {
    const value = (searchParams.get('framework_filter') ?? searchParams.get('framework') ?? '').trim();
    return value === 'yolo' || value === 'paddleocr' || value === 'doctr' ? value : 'all';
  })();
  const initialDrawerOpen = (() => {
    const value = (searchParams.get('drawer') ?? '').trim().toLowerCase();
    if (value === 'open' || value === '1') {
      return true;
    }
    if (value === 'closed' || value === '0') {
      return false;
    }
    return preferredJobId.length > 0;
  })();
  const [jobs, setJobs] = useState<TrainingJobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [modelVersions, setModelVersions] = useState<ModelVersionRecord[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [searchText, setSearchText] = useState(initialSearchText);
  const [taskFilter, setTaskFilter] = useState<
    'all' | 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'
  >(initialTaskFilter);
  const [frameworkFilter, setFrameworkFilter] = useState<'all' | 'yolo' | 'paddleocr' | 'doctr'>(
    initialFrameworkFilter
  );
  const [queueFilter, setQueueFilter] = useState<QueueFilter>(initialQueueFilter);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(initialDrawerOpen);
  const [selectedArtifactSummary, setSelectedArtifactSummary] = useState<TrainingArtifactSummary | null>(
    null
  );
  const [workersLoading, setWorkersLoading] = useState(false);
  const [workers, setWorkers] = useState<TrainingWorkerNodeView[]>([]);
  const [workersAccessDenied, setWorkersAccessDenied] = useState(false);
  const [workersError, setWorkersError] = useState('');
  const [retryDispatchPreference, setRetryDispatchPreference] = useState<
    'auto' | 'control_plane' | 'worker'
  >('auto');
  const [retryWorkerId, setRetryWorkerId] = useState('');
  const [bulkRetryDispatchPreference, setBulkRetryDispatchPreference] = useState<
    'auto' | 'control_plane' | 'worker'
  >('auto');
  const [bulkRetryWorkerId, setBulkRetryWorkerId] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionProgressText, setActionProgressText] = useState('');
  const [actionFeedback, setActionFeedback] = useState<{
    variant: 'success' | 'error';
    text: string;
  } | null>(null);
  const [operationLogEntries, setOperationLogEntries] = useState<OperationLogEntry[]>([]);
  const [operationLogFilter, setOperationLogFilter] = useState<'all' | 'failures' | 'batch'>('all');
  const [collapsedOperationLogGroups, setCollapsedOperationLogGroups] = useState<
    Record<OperationLogGroupKey, boolean>
  >(() => readOperationLogGroupCollapseState());
  const [copiedOperationLogId, setCopiedOperationLogId] = useState('');
  const [operationLogCopyError, setOperationLogCopyError] = useState('');
  const [operationLogFocusMode, setOperationLogFocusMode] = useState(Boolean(focusedOperationLogId));
  const [preferredJobFilterHint, setPreferredJobFilterHint] = useState('');
  const [jobExecutionInsights, setJobExecutionInsights] = useState<Record<string, TrainingExecutionInsight>>(
    {}
  );
  const jobsSignatureRef = useRef('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const operationLogEntryRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const retryDispatchTouchedRef = useRef(false);
  const preferredJobAppliedRef = useRef(false);
  const preferredJobFilterRecoveryAppliedRef = useRef(false);
  const appendOperationLog = useCallback(
    (input: Omit<OperationLogEntry, 'id' | 'createdAt'>) => {
      const createdAt = new Date().toISOString();
      const entry: OperationLogEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        createdAt,
        tone: input.tone,
        title: input.title,
        detail: input.detail,
        isBatch: input.isBatch,
        hasFailure: input.hasFailure,
        errorSummary: input.errorSummary,
        targetJobId: input.targetJobId
      };
      setOperationLogEntries((previous) => [entry, ...previous].slice(0, 8));
    },
    []
  );
  const filteredOperationLogEntries = useMemo(() => {
    if (operationLogFilter === 'all') {
      return operationLogEntries;
    }
    if (operationLogFilter === 'failures') {
      return operationLogEntries.filter((entry) => entry.hasFailure);
    }
    return operationLogEntries.filter((entry) => entry.isBatch);
  }, [operationLogEntries, operationLogFilter]);
  const focusedOperationLogEntry = useMemo(
    () => filteredOperationLogEntries.find((entry) => entry.id === focusedOperationLogId) ?? null,
    [filteredOperationLogEntries, focusedOperationLogId]
  );
  const displayedOperationLogEntries = useMemo(() => {
    if (operationLogFocusMode && focusedOperationLogEntry) {
      return [focusedOperationLogEntry];
    }
    return filteredOperationLogEntries;
  }, [filteredOperationLogEntries, focusedOperationLogEntry, operationLogFocusMode]);
  const groupedOperationLogEntries = useMemo(() => {
    const grouped: Record<OperationLogGroupKey, OperationLogEntry[]> = {
      today: [],
      yesterday: [],
      earlier: []
    };
    displayedOperationLogEntries.forEach((entry) => {
      grouped[resolveOperationLogGroupKey(entry.createdAt)].push(entry);
    });
    return OPERATION_LOG_GROUP_KEYS
      .map((key) => ({
        key,
        label: key === 'today' ? t('Today') : key === 'yesterday' ? t('Yesterday') : t('Earlier'),
        entries: grouped[key]
      }))
      .filter((group) => group.entries.length > 0);
  }, [displayedOperationLogEntries, t]);
  const operationLogEntryCount = filteredOperationLogEntries.length;
  const failedOperationLogCount = useMemo(
    () => filteredOperationLogEntries.filter((entry) => entry.hasFailure).length,
    [filteredOperationLogEntries]
  );
  const firstFailedOperationLogEntry = useMemo(
    () => filteredOperationLogEntries.find((entry) => entry.hasFailure) ?? null,
    [filteredOperationLogEntries]
  );
  const hasCollapsedOperationLogGroup = useMemo(
    () => groupedOperationLogEntries.some((group) => collapsedOperationLogGroups[group.key]),
    [collapsedOperationLogGroups, groupedOperationLogEntries]
  );
  const hasExpandedOperationLogGroup = useMemo(
    () => groupedOperationLogEntries.some((group) => !collapsedOperationLogGroups[group.key]),
    [collapsedOperationLogGroups, groupedOperationLogEntries]
  );
  const focusedOperationLogGroupKey = useMemo(() => {
    const entry = displayedOperationLogEntries.find((item) => item.id === focusedOperationLogId);
    if (!entry) {
      return '';
    }
    return resolveOperationLogGroupKey(entry.createdAt);
  }, [displayedOperationLogEntries, focusedOperationLogId]);
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      window.localStorage.setItem(
        OPERATION_LOG_GROUP_COLLAPSE_STORAGE_KEY,
        JSON.stringify(collapsedOperationLogGroups)
      );
    } catch {
      // no-op
    }
  }, [collapsedOperationLogGroups]);
  useEffect(() => {
    if (focusedOperationLogId) {
      setOperationLogFocusMode(true);
      return;
    }
    setOperationLogFocusMode(false);
  }, [focusedOperationLogId]);
  useEffect(() => {
    if (!focusedOperationLogId) {
      return;
    }
    const hasFocusedEntry = filteredOperationLogEntries.some((entry) => entry.id === focusedOperationLogId);
    if (!hasFocusedEntry) {
      if (operationLogFilter !== 'all') {
        setOperationLogFilter('all');
      }
      return;
    }
    const targetNode = operationLogEntryRefs.current[focusedOperationLogId];
    if (!targetNode) {
      return;
    }
    targetNode.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth'
    });
  }, [
    collapsedOperationLogGroups,
    displayedOperationLogEntries,
    filteredOperationLogEntries,
    focusedOperationLogId,
    operationLogFilter
  ]);
  useEffect(() => {
    if (!focusedOperationLogGroupKey) {
      return;
    }
    setCollapsedOperationLogGroups((current) => {
      if (!current[focusedOperationLogGroupKey as OperationLogGroupKey]) {
        return current;
      }
      return {
        ...current,
        [focusedOperationLogGroupKey]: false
      };
    });
  }, [focusedOperationLogGroupKey]);
  const jumpToFirstFailedOperationLog = useCallback(() => {
    if (!firstFailedOperationLogEntry) {
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }
    const groupKey = resolveOperationLogGroupKey(firstFailedOperationLogEntry.createdAt);
    setOperationLogFocusMode(false);
    setCollapsedOperationLogGroups((current) => {
      if (!current[groupKey]) {
        return current;
      }
      return {
        ...current,
        [groupKey]: false
      };
    });
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const node = operationLogEntryRefs.current[firstFailedOperationLogEntry.id];
        if (!node) {
          return;
        }
        node.scrollIntoView({
          block: 'nearest',
          behavior: 'smooth'
        });
      });
    });
  }, [firstFailedOperationLogEntry]);
  const copyOperationLogErrorSummary = useCallback(
    async (entry: OperationLogEntry) => {
      const payload = entry.errorSummary?.trim() || entry.detail;
      setOperationLogCopyError('');
      try {
        if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
          throw new Error(t('Clipboard API unavailable.'));
        }
        await navigator.clipboard.writeText(payload);
        setCopiedOperationLogId(entry.id);
        setTimeout(() => {
          setCopiedOperationLogId((current) => (current === entry.id ? '' : current));
        }, 1800);
      } catch (error) {
        setOperationLogCopyError(
          t('Copy failed. Please copy manually. Error: {message}', {
            message: (error as Error).message || t('Unknown')
          })
        );
      }
    },
    [t]
  );

  const load = async (mode: LoadMode) => {
    if (mode === 'initial') {
      setLoading(true);
    }

    if (mode === 'manual') {
      setRefreshing(true);
    }

    try {
      const [result, modelResult, versionResult] = await Promise.all([
        api.listTrainingJobs(),
        api.listMyModels().catch(() => null),
        api.listModelVersions().catch(() => [] as ModelVersionRecord[])
      ]);
      const nextSignature = buildJobsSignature(result);
      if (jobsSignatureRef.current !== nextSignature) {
        jobsSignatureRef.current = nextSignature;
        setJobs(result);
      }
      setModelVersions(versionResult);
      if (modelResult) {
        setModels(modelResult);
        setModelsLoaded(true);
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
  };

  useEffect(() => {
    load('initial').catch(() => {
      // no-op
    });
  }, []);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const normalizedSearchText = searchText.trim();

    if (normalizedSearchText) {
      next.set('q', normalizedSearchText);
    } else {
      next.delete('q');
    }

    if (taskFilter === 'all') {
      next.set('task_filter', 'all');
    } else {
      next.set('task_filter', taskFilter);
    }
    // Backward compatibility cleanup for older list filter key.
    next.delete('task');

    if (frameworkFilter === 'all') {
      next.set('framework_filter', 'all');
    } else {
      next.set('framework_filter', frameworkFilter);
    }

    if (queueFilter === 'all') {
      next.delete('queue');
    } else {
      next.set('queue', queueFilter);
    }

    if (selectedJobId.trim()) {
      next.set('job', selectedJobId.trim());
    } else {
      next.delete('job');
    }
    // Backward compatibility cleanup for older selected job key.
    next.delete('selectedJob');

    if (selectedJobId.trim() && detailDrawerOpen) {
      next.set('drawer', 'open');
    } else {
      next.delete('drawer');
    }

    const currentQuery = searchParams.toString();
    const nextQuery = next.toString();
    if (nextQuery === currentQuery) {
      return;
    }

    navigate(nextQuery ? `${location.pathname}?${nextQuery}` : location.pathname, {
      replace: true
    });
  }, [
    detailDrawerOpen,
    frameworkFilter,
    location.pathname,
    navigate,
    queueFilter,
    searchParams,
    searchText,
    selectedJobId,
    taskFilter
  ]);

  useEffect(() => {
    let active = true;
    setWorkersLoading(true);
    setWorkersError('');
    setWorkersAccessDenied(false);
    api
      .listTrainingWorkers()
      .then((inventory) => {
        if (!active) {
          return;
        }
        setWorkers(inventory);
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        const message = (error as Error).message;
        setWorkers([]);
        if (adminAccessMessagePattern.test(message)) {
          setWorkersAccessDenied(true);
          setWorkersError('');
          return;
        }
        setWorkersError(message);
      })
      .finally(() => {
        if (active) {
          setWorkersLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useBackgroundPolling(
    () => {
      load('background').catch(() => {
        // no-op
      });
    },
    {
      intervalMs: backgroundRefreshIntervalMs,
      enabled: jobs.some((job) => activeStatusSet.has(job.status))
    }
  );

  const sortedJobs = useMemo(
    () =>
      [...jobs].sort((left, right) => {
        const leftPriority = activeStatusSet.has(left.status) ? 0 : terminalStatusSet.has(left.status) ? 2 : 1;
        const rightPriority = activeStatusSet.has(right.status) ? 0 : terminalStatusSet.has(right.status) ? 2 : 1;
        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }
        const leftTime = Date.parse(left.updated_at);
        const rightTime = Date.parse(right.updated_at);
        return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
      }),
    [jobs]
  );

  const terminalLocalCommandCandidates = useMemo(
    () =>
      [...jobs]
        .filter((job) => terminalStatusSet.has(job.status) && job.execution_mode === 'local_command')
        .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
        .slice(0, 36),
    [jobs]
  );

  const terminalInsightSignature = useMemo(
    () =>
      terminalLocalCommandCandidates
        .map((job) => `${job.id}:${job.updated_at}`)
        .sort((left, right) => left.localeCompare(right))
        .join('|'),
    [terminalLocalCommandCandidates]
  );

  useEffect(() => {
    if (!terminalLocalCommandCandidates.length) {
      setJobExecutionInsights({});
      return;
    }

    let active = true;

    Promise.all(
      terminalLocalCommandCandidates.map(async (job) => {
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
      });

    return () => {
      active = false;
    };
  }, [terminalInsightSignature, terminalLocalCommandCandidates]);

  const scopedDatasetId = (searchParams.get('dataset') ?? '').trim();
  const scopedVersionId = (searchParams.get('version') ?? '').trim();
  const trainingLaunchContext: LaunchContext = {
    taskType: preferredTaskTypeContext || null,
    framework: preferredFrameworkContext || null,
    executionTarget: preferredExecutionTarget || null,
    workerId: preferredWorkerId || null
  };
  const scopedJobs = useMemo(
    () =>
      sortedJobs.filter((job) => {
        if (scopedDatasetId && job.dataset_id !== scopedDatasetId) {
          return false;
        }
        if (scopedVersionId && job.dataset_version_id !== scopedVersionId) {
          return false;
        }
        return true;
      }),
    [scopedDatasetId, scopedVersionId, sortedJobs]
  );
  const preferredScopedJob = useMemo(
    () => (preferredJobId ? scopedJobs.find((job) => job.id === preferredJobId) ?? null : null),
    [preferredJobId, scopedJobs]
  );
  const preferredGlobalJob = useMemo(
    () => (preferredJobId ? sortedJobs.find((job) => job.id === preferredJobId) ?? null : null),
    [preferredJobId, sortedJobs]
  );
  const preferredJobOutOfScope = useMemo(
    () =>
      Boolean(
        preferredJobId &&
          !loading &&
          preferredGlobalJob &&
          !preferredScopedJob &&
          (scopedDatasetId || scopedVersionId)
      ),
    [
      loading,
      preferredGlobalJob,
      preferredJobId,
      preferredScopedJob,
      scopedDatasetId,
      scopedVersionId
    ]
  );
  const preferredJobMissing = useMemo(
    () => Boolean(preferredJobId && !loading && jobs.length > 0 && !preferredGlobalJob),
    [jobs.length, loading, preferredGlobalJob, preferredJobId]
  );

  const filteredJobs = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return scopedJobs.filter((job) => {
      if (taskFilter !== 'all' && job.task_type !== taskFilter) {
        return false;
      }
      if (frameworkFilter !== 'all' && job.framework !== frameworkFilter) {
        return false;
      }
      if (queueFilter === 'active' && !activeStatusSet.has(job.status)) {
        return false;
      }
      if (queueFilter === 'terminal' && !terminalStatusSet.has(job.status)) {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        job.name.toLowerCase().includes(query) ||
        job.base_model.toLowerCase().includes(query) ||
        job.id.toLowerCase().includes(query)
      );
    });
  }, [frameworkFilter, queueFilter, scopedJobs, searchText, taskFilter]);
  const activeVisibleJobs = useMemo(
    () => filteredJobs.filter((job) => activeStatusSet.has(job.status)),
    [filteredJobs]
  );
  const retryableVisibleJobs = useMemo(
    () => filteredJobs.filter((job) => ['failed', 'cancelled'].includes(job.status)),
    [filteredJobs]
  );

  useEffect(() => {
    preferredJobFilterRecoveryAppliedRef.current = false;
    preferredJobAppliedRef.current = false;
    setPreferredJobFilterHint('');
  }, [preferredJobId]);

  useEffect(() => {
    if (preferredJobFilterRecoveryAppliedRef.current || !preferredJobId || !preferredScopedJob) {
      return;
    }
    if (filteredJobs.some((job) => job.id === preferredJobId)) {
      return;
    }

    preferredJobFilterRecoveryAppliedRef.current = true;

    if (taskFilter !== preferredScopedJob.task_type) {
      setTaskFilter(preferredScopedJob.task_type);
    }
    if (frameworkFilter !== preferredScopedJob.framework) {
      setFrameworkFilter(preferredScopedJob.framework);
    }
    if (
      (queueFilter === 'active' && !activeStatusSet.has(preferredScopedJob.status)) ||
      (queueFilter === 'terminal' && !terminalStatusSet.has(preferredScopedJob.status))
    ) {
      setQueueFilter('all');
    }
    if (searchText.trim()) {
      setSearchText('');
    }

    setPreferredJobFilterHint(
      t('Adjusted filters to show the requested job {jobId}.', { jobId: preferredScopedJob.id })
    );
  }, [
    filteredJobs,
    frameworkFilter,
    preferredJobId,
    preferredScopedJob,
    queueFilter,
    searchText,
    t,
    taskFilter
  ]);

  useEffect(() => {
    if (!preferredJobFilterHint || !selectedJobId || selectedJobId !== preferredJobId) {
      return;
    }
    setPreferredJobFilterHint('');
  }, [preferredJobFilterHint, preferredJobId, selectedJobId]);

  useEffect(() => {
    if (!filteredJobs.length) {
      setSelectedJobId('');
      setDetailDrawerOpen(false);
      return;
    }
    if (selectedJobId && !filteredJobs.some((job) => job.id === selectedJobId)) {
      setSelectedJobId('');
      setDetailDrawerOpen(false);
    }
  }, [filteredJobs, selectedJobId]);

  useEffect(() => {
    if (preferredJobAppliedRef.current || !preferredJobId || filteredJobs.length === 0) {
      return;
    }

    const matchedJob = filteredJobs.find((job) => job.id === preferredJobId) ?? null;
    if (!matchedJob) {
      return;
    }

    preferredJobAppliedRef.current = true;
    setSelectedJobId(matchedJob.id);
    setDetailDrawerOpen(true);
  }, [filteredJobs, preferredJobId]);

  useEffect(() => {
    setActionFeedback(null);
    if (!actionBusy) {
      setActionProgressText('');
    }
    setCopiedOperationLogId('');
    setOperationLogCopyError('');
  }, [actionBusy, selectedJobId]);

  const selectedJob = useMemo(
    () => filteredJobs.find((job) => job.id === selectedJobId) ?? null,
    [filteredJobs, selectedJobId]
  );

  const selectedExecutionInsight = useMemo(() => {
    if (!selectedJob) {
      return null;
    }
    const cachedInsight = jobExecutionInsights[selectedJob.id];
    if (cachedInsight) {
      return cachedInsight;
    }
    return deriveTrainingExecutionInsight({
      status: selectedJob.status,
      executionMode: selectedJob.execution_mode,
      artifactSummary: selectedArtifactSummary
    });
  }, [jobExecutionInsights, selectedArtifactSummary, selectedJob]);

  const firstVisibleJob = filteredJobs[0] ?? null;
  const firstActiveJob = filteredJobs.find((job) => activeStatusSet.has(job.status)) ?? firstVisibleJob;
  const linkedVersionsByJobId = useMemo(() => {
    const next = new Map<string, ModelVersionRecord[]>();
    modelVersions.forEach((version) => {
      if (!version.training_job_id) {
        return;
      }
      const versions = next.get(version.training_job_id) ?? [];
      versions.push(version);
      next.set(version.training_job_id, versions);
    });
    next.forEach((versions, jobId) => {
      next.set(
        jobId,
        [...versions].sort((left, right) => {
          const rightTime = Date.parse(right.created_at);
          const leftTime = Date.parse(left.created_at);
          return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
        })
      );
    });
    return next;
  }, [modelVersions]);
  const getLatestLinkedVersion = useCallback(
    (jobId: string): ModelVersionRecord | null => linkedVersionsByJobId.get(jobId)?.[0] ?? null,
    [linkedVersionsByJobId]
  );
  const selectedJobLinkedVersion = useMemo(
    () => (selectedJob ? getLatestLinkedVersion(selectedJob.id) : null),
    [getLatestLinkedVersion, selectedJob]
  );
  const selectedJobInferencePath = useMemo(() => {
    if (!selectedJob?.dataset_id) {
      return '';
    }
    return buildScopedInferencePath(
      selectedJob.dataset_id,
      selectedJob.dataset_version_id,
      selectedJobLinkedVersion?.id ?? undefined,
      trainingLaunchContext
    );
  }, [selectedJob, selectedJobLinkedVersion?.id, trainingLaunchContext]);
  const selectedJobVersionDeliveryPath = useMemo(() => {
    if (!selectedJob || !selectedJobLinkedVersion) {
      return '';
    }
    return buildScopedVersionDeliveryPath(
      selectedJob,
      selectedJobLinkedVersion.version_name,
      selectedJobLinkedVersion.id,
      trainingLaunchContext
    );
  }, [selectedJob, selectedJobLinkedVersion, trainingLaunchContext]);

  const selectedExecutionRealityLabel = useMemo(() => {
    if (!selectedExecutionInsight) {
      return '';
    }
    if (selectedExecutionInsight.reality === 'standard') {
      return t('Standard output');
    }
    if (selectedExecutionInsight.reality === 'template') {
      return t('Fallback output');
    }
    if (selectedExecutionInsight.reality === 'simulated') {
      return t('Fallback output');
    }
    return t('Unknown execution');
  }, [selectedExecutionInsight, t]);
  const canCancelSelectedJob = Boolean(
    selectedJob && ['queued', 'preparing', 'running'].includes(selectedJob.status)
  );
  const canRetrySelectedJob = Boolean(selectedJob && ['failed', 'cancelled'].includes(selectedJob.status));
  const onlineWorkers = useMemo(
    () =>
      workers.filter(
        (worker) => worker.enabled && worker.effective_status === 'online' && Boolean(worker.endpoint)
      ),
    [workers]
  );
  const selectedRetryWorker = useMemo(
    () => workers.find((worker) => worker.id === retryWorkerId) ?? null,
    [retryWorkerId, workers]
  );
  const retryWorkerAvailable =
    !retryWorkerId || workersLoading || workersAccessDenied || Boolean(selectedRetryWorker);
  const selectedBulkRetryWorker = useMemo(
    () => workers.find((worker) => worker.id === bulkRetryWorkerId) ?? null,
    [bulkRetryWorkerId, workers]
  );
  const bulkRetryWorkerAvailable =
    !bulkRetryWorkerId || workersLoading || workersAccessDenied || Boolean(selectedBulkRetryWorker);
  const retryDispatchSummary = useMemo(() => {
    if (retryDispatchPreference === 'auto') {
      return t('Scheduler chooses between worker and control-plane automatically.');
    }
    if (retryDispatchPreference === 'control_plane') {
      return t('Run will stay on control-plane local execution path.');
    }
    if (retryWorkerId) {
      if (workersLoading || workersAccessDenied) {
        return t('Worker inventory is unavailable. Worker ID will be validated at submit time.');
      }
      return selectedRetryWorker
        ? t('Worker dispatch is pinned to {worker}.', { worker: selectedRetryWorker.name })
        : t('Pinned worker is not in current inventory.');
    }
    return t('Worker dispatch is required. Scheduler will pick one online eligible worker.');
  }, [
    retryDispatchPreference,
    retryWorkerId,
    selectedRetryWorker,
    t,
    workersAccessDenied,
    workersLoading
  ]);
  const bulkRetryDispatchSummary = useMemo(() => {
    if (bulkRetryDispatchPreference === 'auto') {
      return t('Scheduler chooses between worker and control-plane automatically.');
    }
    if (bulkRetryDispatchPreference === 'control_plane') {
      return t('Run will stay on control-plane local execution path.');
    }
    if (bulkRetryWorkerId) {
      if (workersLoading || workersAccessDenied) {
        return t('Worker inventory is unavailable. Worker ID will be validated at submit time.');
      }
      return selectedBulkRetryWorker
        ? t('Worker dispatch is pinned to {worker}.', { worker: selectedBulkRetryWorker.name })
        : t('Pinned worker is not in current inventory.');
    }
    return t('Worker dispatch is required. Scheduler will pick one online eligible worker.');
  }, [
    bulkRetryDispatchPreference,
    bulkRetryWorkerId,
    selectedBulkRetryWorker,
    t,
    workersAccessDenied,
    workersLoading
  ]);

  useEffect(() => {
    retryDispatchTouchedRef.current = false;
    if (!selectedJob || !['failed', 'cancelled'].includes(selectedJob.status)) {
      setRetryDispatchPreference('auto');
      setRetryWorkerId('');
      return;
    }
    if (selectedJob.execution_target === 'control_plane') {
      setRetryDispatchPreference('control_plane');
      setRetryWorkerId('');
      return;
    }
    setRetryDispatchPreference('worker');
    setRetryWorkerId(selectedJob.scheduled_worker_id ?? '');
  }, [selectedJob?.execution_target, selectedJob?.id, selectedJob?.scheduled_worker_id, selectedJob?.status]);

  const cancelSelectedJob = useCallback(async () => {
    if (!selectedJob) {
      return;
    }
    const confirmed = window.confirm(
      t('Cancel training job {job}? This cannot be undone.', {
        job: selectedJob.name || selectedJob.id
      })
    );
    if (!confirmed) {
      return;
    }
    setActionProgressText(
      t('Cancelling training job {job}...', {
        job: selectedJob.name || selectedJob.id
      })
    );
    setActionBusy(true);
    setActionFeedback(null);
    try {
      await api.cancelTrainingJob(selectedJob.id);
      await load('manual');
      setActionFeedback({ variant: 'success', text: t('Training job cancelled.') });
      appendOperationLog({
        tone: 'success',
        title: t('Single-job cancel'),
        detail: t('Cancelled job {job}.', {
          job: selectedJob.name || selectedJob.id
        }),
        isBatch: false,
        hasFailure: false,
        targetJobId: selectedJob.id
      });
    } catch (error) {
      setActionFeedback({ variant: 'error', text: (error as Error).message });
      appendOperationLog({
        tone: 'danger',
        title: t('Single-job cancel'),
        detail: t('Failed to cancel {job}: {message}', {
          job: selectedJob.name || selectedJob.id,
          message: (error as Error).message || t('Unknown')
        }),
        isBatch: false,
        hasFailure: true,
        errorSummary: (error as Error).message || t('Unknown'),
        targetJobId: selectedJob.id
      });
    } finally {
      setActionBusy(false);
      setActionProgressText('');
    }
  }, [appendOperationLog, load, selectedJob, t]);

  const retrySelectedJob = useCallback(async () => {
    if (!selectedJob) {
      return;
    }
    if (retryDispatchPreference === 'worker' && !retryWorkerAvailable) {
      setActionFeedback({ variant: 'error', text: t('Selected worker is not in current inventory.') });
      return;
    }
    const confirmed = window.confirm(
      t('Retry training job {job} with current dispatch strategy?', {
        job: selectedJob.name || selectedJob.id
      })
    );
    if (!confirmed) {
      return;
    }
    setActionProgressText(
      t('Retrying training job {job}...', {
        job: selectedJob.name || selectedJob.id
      })
    );
    setActionBusy(true);
    setActionFeedback(null);
    try {
      const executionTarget = retryDispatchPreference === 'auto' ? undefined : retryDispatchPreference;
      const workerId =
        retryDispatchPreference === 'worker' && retryWorkerId.trim() ? retryWorkerId.trim() : undefined;
      await api.retryTrainingJob(selectedJob.id, {
        ...(executionTarget ? { execution_target: executionTarget } : {}),
        ...(workerId ? { worker_id: workerId } : {})
      });
      await load('manual');
      setActionFeedback({
        variant: 'success',
        text: t('Training job retried with selected dispatch strategy.')
      });
      appendOperationLog({
        tone: 'success',
        title: t('Single-job retry'),
        detail: t('Retried job {job} with current dispatch strategy.', {
          job: selectedJob.name || selectedJob.id
        }),
        isBatch: false,
        hasFailure: false,
        targetJobId: selectedJob.id
      });
    } catch (error) {
      setActionFeedback({ variant: 'error', text: (error as Error).message });
      appendOperationLog({
        tone: 'danger',
        title: t('Single-job retry'),
        detail: t('Failed to retry {job}: {message}', {
          job: selectedJob.name || selectedJob.id,
          message: (error as Error).message || t('Unknown')
        }),
        isBatch: false,
        hasFailure: true,
        errorSummary: (error as Error).message || t('Unknown'),
        targetJobId: selectedJob.id
      });
    } finally {
      setActionBusy(false);
      setActionProgressText('');
    }
  }, [
    appendOperationLog,
    load,
    retryDispatchPreference,
    retryWorkerAvailable,
    retryWorkerId,
    selectedJob,
    t
  ]);

  const retryVisibleJobs = useCallback(async () => {
    if (!retryableVisibleJobs.length) {
      setActionFeedback({
        variant: 'error',
        text: t('No failed/cancelled jobs are visible in current filters.')
      });
      return;
    }
    if (bulkRetryDispatchPreference === 'worker' && !bulkRetryWorkerAvailable) {
      setActionFeedback({ variant: 'error', text: t('Selected worker is not in current inventory.') });
      return;
    }
    const confirmed = window.confirm(
      t(
        'Retry {count} failed/cancelled job(s) in current view with current dispatch strategy?',
        { count: retryableVisibleJobs.length }
      )
    );
    if (!confirmed) {
      return;
    }

    setActionProgressText(
      t('Retrying {count} job(s) in current view...', {
        count: retryableVisibleJobs.length
      })
    );
    setActionBusy(true);
    setActionFeedback(null);

    try {
      const executionTarget =
        bulkRetryDispatchPreference === 'auto' ? undefined : bulkRetryDispatchPreference;
      const workerId =
        bulkRetryDispatchPreference === 'worker' && bulkRetryWorkerId.trim()
          ? bulkRetryWorkerId.trim()
          : undefined;

      const results = await Promise.allSettled(
        retryableVisibleJobs.map((job) =>
          api.retryTrainingJob(job.id, {
            ...(executionTarget ? { execution_target: executionTarget } : {}),
            ...(workerId ? { worker_id: workerId } : {})
          })
        )
      );

      let successCount = 0;
      let failureCount = 0;
      let firstError = '';
      let firstSuccessJobId = '';
      let firstFailureJobId = '';
      results.forEach((result, index) => {
        const job = retryableVisibleJobs[index];
        if (result.status === 'fulfilled') {
          successCount += 1;
          if (!firstSuccessJobId && job) {
            firstSuccessJobId = job.id;
          }
          return;
        }
        failureCount += 1;
        if (!firstFailureJobId && job) {
          firstFailureJobId = job.id;
        }
        if (!firstError) {
          firstError = (result.reason as Error)?.message || String(result.reason || '');
        }
      });

      await load('manual');
      if (failureCount === 0) {
        setActionFeedback({
          variant: 'success',
          text: t('Retried {count} job(s) with selected dispatch strategy.', {
            count: successCount
          })
        });
        appendOperationLog({
          tone: 'success',
          title: t('Batch retry'),
          detail: t('Retried {count} job(s) successfully.', {
            count: successCount
          }),
          isBatch: true,
          hasFailure: false,
          targetJobId: firstSuccessJobId || undefined
        });
        return;
      }
      if (successCount === 0) {
        setActionFeedback({
          variant: 'error',
          text: t('Batch retry failed for all {count} jobs. First error: {message}', {
            count: failureCount,
            message: firstError || t('Unknown')
          })
        });
        appendOperationLog({
          tone: 'danger',
          title: t('Batch retry'),
          detail: t('All {count} retries failed. First error: {message}', {
            count: failureCount,
            message: firstError || t('Unknown')
          }),
          isBatch: true,
          hasFailure: true,
          errorSummary: firstError || t('Unknown'),
          targetJobId: firstFailureJobId || firstSuccessJobId || undefined
        });
        return;
      }
      setActionFeedback({
        variant: 'error',
        text: t('Batch retry completed: {success} succeeded, {failed} failed. First error: {message}', {
          success: successCount,
          failed: failureCount,
          message: firstError || t('Unknown')
        })
      });
      appendOperationLog({
        tone: 'warning',
        title: t('Batch retry'),
        detail: t('{success} succeeded, {failed} failed. First error: {message}', {
          success: successCount,
          failed: failureCount,
          message: firstError || t('Unknown')
        }),
        isBatch: true,
        hasFailure: true,
        errorSummary: firstError || t('Unknown'),
        targetJobId: firstFailureJobId || firstSuccessJobId || undefined
      });
    } finally {
      setActionBusy(false);
      setActionProgressText('');
    }
  }, [
    appendOperationLog,
    bulkRetryDispatchPreference,
    bulkRetryWorkerAvailable,
    bulkRetryWorkerId,
    load,
    retryableVisibleJobs,
    t
  ]);
  const cancelVisibleActiveJobs = useCallback(async () => {
    if (!activeVisibleJobs.length) {
      setActionFeedback({
        variant: 'error',
        text: t('No active jobs are visible in current filters.')
      });
      return;
    }
    const confirmed = window.confirm(
      t('Cancel {count} active job(s) in current view? This cannot be undone.', {
        count: activeVisibleJobs.length
      })
    );
    if (!confirmed) {
      return;
    }

    setActionProgressText(
      t('Cancelling {count} active job(s) in current view...', {
        count: activeVisibleJobs.length
      })
    );
    setActionBusy(true);
    setActionFeedback(null);

    try {
      const results = await Promise.allSettled(
        activeVisibleJobs.map(async (job) => {
          await api.cancelTrainingJob(job.id);
        })
      );

      let successCount = 0;
      let failureCount = 0;
      let firstError = '';
      let firstSuccessJobId = '';
      let firstFailureJobId = '';
      results.forEach((result, index) => {
        const job = activeVisibleJobs[index];
        if (result.status === 'fulfilled') {
          successCount += 1;
          if (!firstSuccessJobId && job) {
            firstSuccessJobId = job.id;
          }
          return;
        }
        const message = (result.reason as Error)?.message || String(result.reason || '');
        if (cancelTransitionRacePattern.test(message)) {
          successCount += 1;
          if (!firstSuccessJobId && job) {
            firstSuccessJobId = job.id;
          }
          return;
        }
        failureCount += 1;
        if (!firstFailureJobId && job) {
          firstFailureJobId = job.id;
        }
        if (!firstError) {
          firstError = message;
        }
      });

      await load('manual');
      if (failureCount === 0) {
        setActionFeedback({
          variant: 'success',
          text: t('Cancelled {count} job(s) in current view.', {
            count: successCount
          })
        });
        appendOperationLog({
          tone: 'success',
          title: t('Batch cancel'),
          detail: t('Cancelled {count} active job(s).', {
            count: successCount
          }),
          isBatch: true,
          hasFailure: false,
          targetJobId: firstSuccessJobId || undefined
        });
        return;
      }
      if (successCount === 0) {
        setActionFeedback({
          variant: 'error',
          text: t('Batch cancel failed for all {count} jobs. First error: {message}', {
            count: failureCount,
            message: firstError || t('Unknown')
          })
        });
        appendOperationLog({
          tone: 'danger',
          title: t('Batch cancel'),
          detail: t('All {count} cancels failed. First error: {message}', {
            count: failureCount,
            message: firstError || t('Unknown')
          }),
          isBatch: true,
          hasFailure: true,
          errorSummary: firstError || t('Unknown'),
          targetJobId: firstFailureJobId || firstSuccessJobId || undefined
        });
        return;
      }
      setActionFeedback({
        variant: 'error',
        text: t('Batch cancel completed: {success} succeeded, {failed} failed. First error: {message}', {
          success: successCount,
          failed: failureCount,
          message: firstError || t('Unknown')
        })
      });
      appendOperationLog({
        tone: 'warning',
        title: t('Batch cancel'),
        detail: t('{success} succeeded, {failed} failed. First error: {message}', {
          success: successCount,
          failed: failureCount,
          message: firstError || t('Unknown')
        }),
        isBatch: true,
        hasFailure: true,
        errorSummary: firstError || t('Unknown'),
        targetJobId: firstFailureJobId || firstSuccessJobId || undefined
      });
    } finally {
      setActionBusy(false);
      setActionProgressText('');
    }
  }, [activeVisibleJobs, appendOperationLog, load, t]);
  const bulkRetryPrecheck = useMemo(() => {
    if (bulkRetryDispatchPreference !== 'worker') {
      return {
        tone: 'success' as const,
        text: t('Precheck passed for current dispatch strategy.')
      };
    }
    if (workersLoading) {
      return {
        tone: 'warning' as const,
        text: t('Loading worker inventory...')
      };
    }
    if (workersAccessDenied) {
      return {
        tone: 'warning' as const,
        text: t('Worker inventory is restricted to admins.')
      };
    }
    if (bulkRetryWorkerId && !bulkRetryWorkerAvailable) {
      return {
        tone: 'danger' as const,
        text: t('Selected worker is not in current inventory.')
      };
    }
    if (!bulkRetryWorkerId && onlineWorkers.length === 0) {
      return {
        tone: 'warning' as const,
        text: t('Worker dispatch may fail if no eligible online worker is available.')
      };
    }
    return {
      tone: 'success' as const,
      text: t('Precheck passed for current dispatch strategy.')
    };
  }, [
    bulkRetryDispatchPreference,
    bulkRetryWorkerAvailable,
    bulkRetryWorkerId,
    onlineWorkers.length,
    t,
    workersAccessDenied,
    workersLoading
  ]);

  const getJobCompletionAction = useCallback(
    (job: TrainingJobRecord, artifactSummary?: TrainingArtifactSummary | null) => {
      if (job.status !== 'completed') {
        return null;
      }

      const insight =
        jobExecutionInsights[job.id] ??
        (artifactSummary
          ? deriveTrainingExecutionInsight({
              status: job.status,
              executionMode: job.execution_mode,
              artifactSummary
            })
          : null);

      if (!insight) {
        return null;
      }

      if (insight.reality !== 'standard') {
        return null;
      }

      const latestLinkedVersion = getLatestLinkedVersion(job.id);
      if (latestLinkedVersion) {
        return {
          label: t('Continue in version delivery lane'),
          to: buildScopedVersionDeliveryPath(
            job,
            latestLinkedVersion.version_name,
            latestLinkedVersion.id,
            trainingLaunchContext
          ),
          variant: 'secondary' as const
        };
      }

      const matchingModel = modelsLoaded ? models.find((model) => model.model_type === job.task_type) ?? null : null;
      if (modelsLoaded && !matchingModel) {
        return {
          label: t('Create model draft'),
          to: buildCreateModelDraftPath(job.task_type, {
            jobId: job.id,
            versionName: job.name
          }, trainingLaunchContext),
          variant: 'secondary' as const
        };
      }

      return {
        label: t('Register version'),
        to: buildScopedModelVersionsPath(job, job.name, trainingLaunchContext),
        variant: 'secondary' as const
      };
    },
    [getLatestLinkedVersion, jobExecutionInsights, models, modelsLoaded, t, trainingLaunchContext]
  );

  const selectedJobKey = selectedJob?.id ?? '';
  const selectedJobUpdatedAt = selectedJob?.updated_at ?? '';

  useEffect(() => {
    if (selectedJobId || !firstActiveJob) {
      return;
    }

    setSelectedJobId(firstActiveJob.id);
    setDetailDrawerOpen(false);
  }, [firstActiveJob, selectedJobId]);

  useEffect(() => {
    if (!selectedJobKey) {
      setSelectedArtifactSummary(null);
      return;
    }

    let cancelled = false;
    setSelectedArtifactSummary(null);

    api
      .getTrainingJobDetail(selectedJobKey)
      .then((detail) => {
        if (!cancelled) {
          setSelectedArtifactSummary(detail.artifact_summary);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedArtifactSummary(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedJobKey, selectedJobUpdatedAt]);

  const hasScopeFilter = Boolean(scopedDatasetId || scopedVersionId);
  const scopeLabel = scopedVersionId
    ? t('Scoped to dataset {datasetId} / version {versionId}', {
        datasetId: scopedDatasetId,
        versionId: scopedVersionId
      })
    : scopedDatasetId
      ? t('Scoped to dataset {datasetId}', { datasetId: scopedDatasetId })
      : '';
  const detailSearchParams = useMemo(() => {
    const next = new URLSearchParams(searchParams);
    // Always return from job detail to this scoped and filtered list state.
    next.delete('return_to');
    appendReturnTo(next, currentTaskPath);
    return next;
  }, [currentTaskPath, searchParams]);

  const scopedCreatePath = useMemo(() => {
    const next = new URLSearchParams();
    if (scopedDatasetId) {
      next.set('dataset', scopedDatasetId);
    }
    if (scopedVersionId) {
      next.set('version', scopedVersionId);
    }
    if (trainingLaunchContext.taskType?.trim()) {
      next.set('task_type', trainingLaunchContext.taskType.trim());
    }
    if (trainingLaunchContext.framework?.trim()) {
      next.set('framework', trainingLaunchContext.framework.trim());
    }
    if (
      trainingLaunchContext.executionTarget?.trim() &&
      trainingLaunchContext.executionTarget.trim() !== 'auto'
    ) {
      next.set('execution_target', trainingLaunchContext.executionTarget.trim());
    }
    if (trainingLaunchContext.workerId?.trim()) {
      next.set('worker', trainingLaunchContext.workerId.trim());
    }
    appendReturnTo(next, outboundReturnTo);
    const query = next.toString();
    return query ? `/training/jobs/new?${query}` : '/training/jobs/new';
  }, [
    outboundReturnTo,
    scopedDatasetId,
    scopedVersionId,
    trainingLaunchContext.executionTarget,
    trainingLaunchContext.framework,
    trainingLaunchContext.taskType,
    trainingLaunchContext.workerId
  ]);
  const buildCreatePathFromJob = useCallback(
    (job: TrainingJobRecord): string => {
      const next = new URLSearchParams();
      if (job.dataset_id.trim()) {
        next.set('dataset', job.dataset_id.trim());
      }
      if (job.dataset_version_id?.trim()) {
        next.set('version', job.dataset_version_id.trim());
      }
      if (job.task_type.trim()) {
        next.set('task_type', job.task_type.trim());
      }
      if (job.framework.trim()) {
        next.set('framework', job.framework.trim());
      }
      if (job.execution_target.trim()) {
        next.set('execution_target', job.execution_target.trim());
      }
      if (job.execution_target === 'worker' && job.scheduled_worker_id?.trim()) {
        next.set('worker', job.scheduled_worker_id.trim());
      }
      next.set('source_job', job.id);
      appendReturnTo(next, currentTaskPath);
      const query = next.toString();
      return query ? `/training/jobs/new?${query}` : '/training/jobs/new';
    },
    [currentTaskPath]
  );
  const clearScopePath = useMemo(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('dataset');
    next.delete('version');
    const query = next.toString();
    return query ? `/training/jobs?${query}` : '/training/jobs';
  }, [searchParams]);
  const clearPreferredJobContextPath = useMemo(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('job');
    next.delete('selectedJob');
    next.delete('drawer');
    const query = next.toString();
    return query ? `/training/jobs?${query}` : '/training/jobs';
  }, [searchParams]);
  const recoverPreferredJobPath = useMemo(() => {
    if (!preferredJobId) {
      return '/training/jobs';
    }
    const next = new URLSearchParams(searchParams);
    next.delete('dataset');
    next.delete('version');
    next.set('job', preferredJobId);
    next.set('drawer', 'open');
    const query = next.toString();
    return query ? `/training/jobs?${query}` : '/training/jobs';
  }, [preferredJobId, searchParams]);

  const hasActiveFilters =
    searchText.trim().length > 0 || taskFilter !== 'all' || frameworkFilter !== 'all' || queueFilter !== 'all';
  const scopeBlockerHint = useMemo(() => {
    if (!hasScopeFilter || scopedJobs.length > 0 || jobs.length === 0) {
      return '';
    }
    return scopedVersionId
      ? t(
          'Current scope dataset {datasetId} / version {versionId} has no training jobs yet.',
          {
            datasetId: scopedDatasetId,
            versionId: scopedVersionId
          }
        )
      : t('Current scope dataset {datasetId} has no training jobs yet.', {
          datasetId: scopedDatasetId
        });
  }, [
    hasScopeFilter,
    jobs.length,
    scopedDatasetId,
    scopedJobs.length,
    scopedVersionId,
    t
  ]);
  const activeJobsCount = filteredJobs.filter((job) => activeStatusSet.has(job.status)).length;
  const completedJobsCount = filteredJobs.filter((job) => job.status === 'completed').length;
  const queueEligibleCount = useMemo(
    () =>
      scopedJobs.filter((job) => {
        if (queueFilter === 'active') {
          return activeStatusSet.has(job.status);
        }
        if (queueFilter === 'terminal') {
          return terminalStatusSet.has(job.status);
        }
        return true;
      }).length,
    [queueFilter, scopedJobs]
  );
  const taskEligibleCount = useMemo(
    () => (taskFilter === 'all' ? scopedJobs.length : scopedJobs.filter((job) => job.task_type === taskFilter).length),
    [scopedJobs, taskFilter]
  );
  const frameworkEligibleCount = useMemo(
    () =>
      frameworkFilter === 'all'
        ? scopedJobs.length
        : scopedJobs.filter((job) => job.framework === frameworkFilter).length,
    [frameworkFilter, scopedJobs]
  );
  const searchEligibleCount = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    if (!query) {
      return scopedJobs.length;
    }
    return scopedJobs.filter((job) => {
      return (
        job.name.toLowerCase().includes(query) ||
        job.base_model.toLowerCase().includes(query) ||
        job.id.toLowerCase().includes(query)
      );
    }).length;
  }, [scopedJobs, searchText]);
  const filterBlockerHint = useMemo(() => {
    if (filteredJobs.length > 0 || !hasActiveFilters) {
      return '';
    }
    if (searchText.trim() && searchEligibleCount === 0) {
      return t('Search keyword currently matches 0 jobs in this scope.');
    }
    if (queueFilter !== 'all' && queueEligibleCount === 0) {
      return t('Queue filter currently has no matching jobs in this scope.');
    }
    if (taskFilter !== 'all' && taskEligibleCount === 0) {
      return t('Task filter currently has no matching jobs in this scope.');
    }
    if (frameworkFilter !== 'all' && frameworkEligibleCount === 0) {
      return t('Framework filter currently has no matching jobs in this scope.');
    }
    return t('Current filters are too strict. Clear one or more filters to recover jobs.');
  }, [
    filteredJobs.length,
    frameworkEligibleCount,
    frameworkFilter,
    hasActiveFilters,
    queueEligibleCount,
    queueFilter,
    searchEligibleCount,
    searchText,
    t,
    taskEligibleCount,
    taskFilter
  ]);
  const verificationNeededCount = filteredJobs.filter((job) => {
    const insight =
      jobExecutionInsights[job.id] ??
      deriveTrainingExecutionInsight({
        status: job.status,
        executionMode: job.execution_mode,
        artifactSummary:
          selectedJob?.id === job.id ? selectedArtifactSummary : null
      });
    return insight.reality !== 'standard';
  }).length;
  const selectedJobPosition = selectedJob
    ? filteredJobs.findIndex((job) => job.id === selectedJob.id) + 1
    : 0;
  const selectedJobIndex = selectedJob ? filteredJobs.findIndex((job) => job.id === selectedJob.id) : -1;
  const selectedJobPositionLabel =
    selectedJob && selectedJobPosition > 0
      ? t('Queue position {current} / {total}', {
          current: selectedJobPosition,
          total: filteredJobs.length
        })
      : '';
  type QuickstartStepState = {
    key: string;
    title: string;
    detail: string;
    tone: 'neutral' | 'info' | 'success' | 'warning';
    label: string;
    action?: {
      label: string;
      to?: string;
      onClick?: () => void;
      variant?: 'primary' | 'secondary' | 'ghost';
    };
  };
  const quickstartSteps = useMemo<QuickstartStepState[]>(() => {
    const firstCompletedJob = filteredJobs.find((job) => job.status === 'completed') ?? null;
    const completedJobForDetail = firstCompletedJob ?? firstActiveJob ?? firstVisibleJob;
    const completedJobDetailPath = completedJobForDetail
      ? buildScopedJobDetailPath(completedJobForDetail.id, detailSearchParams)
      : '';
    const completedJobForVersion = firstCompletedJob ?? selectedJob ?? null;
    const completedJobForVersionAction =
      completedJobForVersion && getJobCompletionAction(completedJobForVersion)
        ? getJobCompletionAction(completedJobForVersion)
        : null;
    const linkedVersionForDelivery =
      selectedJobLinkedVersion ??
      (firstCompletedJob ? getLatestLinkedVersion(firstCompletedJob.id) : null);

    return [
      {
        key: 'create',
        title: t('1) Create one training run'),
        detail: t('Start from a fixed dataset snapshot so downstream objects stay traceable.'),
        tone: jobs.length > 0 ? 'success' : 'warning',
        label: jobs.length > 0 ? t('Done') : t('Required'),
        action: jobs.length > 0 ? undefined : { label: t('Create Training Job'), to: scopedCreatePath }
      },
      {
        key: 'observe',
        title: t('2) Observe status and evidence'),
        detail: t('Use one job detail page to watch logs, metrics, artifacts, and execution evidence.'),
        tone: activeJobsCount > 0 ? 'info' : completedJobsCount > 0 ? 'success' : 'neutral',
        label: activeJobsCount > 0 ? t('Running') : completedJobsCount > 0 ? t('Ready') : t('Pending'),
        action: completedJobDetailPath ? { label: t('Open job detail'), to: completedJobDetailPath, variant: 'ghost' } : undefined
      },
      {
        key: 'version',
        title: t('3) Register or continue version'),
        detail: t('Completed verified runs should continue into model version lane.'),
        tone: modelVersions.some((version) => Boolean(version.training_job_id)) ? 'success' : completedJobsCount > 0 ? 'info' : 'neutral',
        label: modelVersions.some((version) => Boolean(version.training_job_id))
          ? t('Linked')
          : completedJobsCount > 0
            ? t('Next')
            : t('Pending'),
        action:
          completedJobForVersionAction && completedJobForVersionAction.to
            ? {
                label: completedJobForVersionAction.label,
                to: completedJobForVersionAction.to,
                variant: completedJobForVersionAction.variant
              }
            : undefined
      },
      {
        key: 'validate',
        title: t('4) Validate and deliver'),
        detail: t('After version linkage, continue to inference validation and controlled delivery.'),
        tone: linkedVersionForDelivery ? 'success' : 'neutral',
        label: linkedVersionForDelivery ? t('Available') : t('Pending'),
        action: linkedVersionForDelivery && selectedJobVersionDeliveryPath
          ? {
              label: t('Continue in version delivery lane'),
              to: selectedJobVersionDeliveryPath,
              variant: 'ghost'
            }
          : undefined
      }
    ];
  }, [
    activeJobsCount,
    completedJobsCount,
    detailSearchParams,
    filteredJobs,
    firstActiveJob,
    firstVisibleJob,
    getJobCompletionAction,
    getLatestLinkedVersion,
    jobs.length,
    modelVersions,
    scopedCreatePath,
    selectedJob,
    selectedJobLinkedVersion,
    selectedJobVersionDeliveryPath,
    t
  ]);
  const resetFilters = useCallback(() => {
    setSearchText('');
    setTaskFilter('all');
    setFrameworkFilter('all');
    setQueueFilter('all');
  }, []);
  const openJobDrawer = useCallback((jobId: string) => {
    setSelectedJobId(jobId);
    setDetailDrawerOpen(true);
  }, []);
  const buildSelectedJobDetailPath = useCallback(
    (jobId: string, options?: JobDetailPathOptions) => {
      const next = new URLSearchParams(detailSearchParams);
      if (options?.logEntryId?.trim()) {
        next.set('op_log', options.logEntryId.trim());
      }
      if (options?.evidenceView && options.evidenceView !== 'overview') {
        next.set('evidence', options.evidenceView);
      }
      if (options?.errorHint?.trim()) {
        next.set('error_hint', options.errorHint.trim().slice(0, 200));
      }
      return buildScopedJobDetailPath(jobId, next);
    },
    [detailSearchParams]
  );
  const buildOperationLogQueueFocusPath = useCallback(
    (jobId: string, logEntryId?: string) => {
      const next = new URLSearchParams(searchParams);
      const targetJob = jobs.find((item) => item.id === jobId) ?? null;
      next.delete('selectedJob');
      next.delete('q');
      next.set('job', jobId);
      next.set('drawer', 'open');
      if (logEntryId?.trim()) {
        next.set('op_log', logEntryId.trim());
      } else {
        next.delete('op_log');
      }
      if (targetJob) {
        next.set('task_filter', targetJob.task_type);
        next.set('framework_filter', targetJob.framework);
        if (activeStatusSet.has(targetJob.status)) {
          next.set('queue', 'active');
        } else if (terminalStatusSet.has(targetJob.status)) {
          next.set('queue', 'terminal');
        } else {
          next.delete('queue');
        }
      } else {
        next.delete('queue');
      }
      const query = next.toString();
      return query ? `${location.pathname}?${query}` : location.pathname;
    },
    [jobs, location.pathname, searchParams]
  );
  const clearOperationLogFocusPath = useMemo(() => {
    if (!focusedOperationLogId) {
      return '';
    }
    const next = new URLSearchParams(searchParams);
    next.delete('op_log');
    const query = next.toString();
    return query ? `${location.pathname}?${query}` : location.pathname;
  }, [focusedOperationLogId, location.pathname, searchParams]);
  const selectedJobDetailPath = useMemo(
    () => (selectedJob ? buildSelectedJobDetailPath(selectedJob.id) : ''),
    [buildSelectedJobDetailPath, selectedJob]
  );
  const selectedJobClosurePath = useMemo(() => {
    if (!selectedJob?.dataset_id) {
      return '';
    }
    return buildScopedClosurePath(
      selectedJob.dataset_id,
      selectedJob.dataset_version_id,
      trainingLaunchContext
    );
  }, [selectedJob, trainingLaunchContext]);
  const selectedJobRegisterVersionPath = useMemo(() => {
    if (!selectedJob) {
      return '';
    }
    return buildScopedModelVersionsPath(selectedJob, selectedJob.name, trainingLaunchContext);
  }, [selectedJob, trainingLaunchContext]);
  const selectedJobCreateModelDraftPath = useMemo(() => {
    if (!selectedJob) {
      return '';
    }
    return buildCreateModelDraftPath(
      selectedJob.task_type,
      {
        jobId: selectedJob.id,
        versionName: selectedJob.name
      },
      trainingLaunchContext
    );
  }, [selectedJob, trainingLaunchContext]);
  const selectedJobCreateNextRunPath = useMemo(
    () => (selectedJob ? buildCreatePathFromJob(selectedJob) : ''),
    [buildCreatePathFromJob, selectedJob]
  );
  const selectedJobCompletionAction = useMemo(
    () =>
      selectedJob
        ? getJobCompletionAction(
            selectedJob,
            selectedArtifactSummary
          )
        : null,
    [getJobCompletionAction, selectedArtifactSummary, selectedJob]
  );
  const openBestVisibleJob = useCallback(() => {
    if (!firstActiveJob) {
      return;
    }
    openJobDrawer(firstActiveJob.id);
  }, [firstActiveJob, openJobDrawer]);

  type JobRouteAction = {
    label: string;
    to?: string;
    onClick?: () => void;
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  };

  const getJobRowActions = useCallback(
    (job: TrainingJobRecord): JobRouteAction[] => {
      const actions: JobRouteAction[] = [];
      const insight =
        jobExecutionInsights[job.id] ??
        deriveTrainingExecutionInsight({
          status: job.status,
          executionMode: job.execution_mode
        });

      if (activeStatusSet.has(job.status)) {
        actions.push({
          label: t('Track run'),
          to: buildSelectedJobDetailPath(job.id),
          variant: 'secondary'
        });
        if (job.dataset_id) {
          actions.push({
            label: t('Open dataset'),
            to: buildScopedDatasetPath(job.dataset_id, job.dataset_version_id, trainingLaunchContext),
            variant: 'ghost'
          });
        }
        return actions;
      }

      if (job.status === 'failed' || job.status === 'cancelled') {
        actions.push({
          label: t('Review & retry'),
          onClick: () => openJobDrawer(job.id),
          variant: 'secondary'
        });
        actions.push({
          label: t('Create next run'),
          to: buildCreatePathFromJob(job),
          variant: 'ghost'
        });
        if (job.dataset_id) {
          actions.push({
            label: t('Open dataset'),
            to: buildScopedDatasetPath(job.dataset_id, job.dataset_version_id, trainingLaunchContext),
            variant: 'ghost'
          });
        }
        return actions;
      }

      const completionAction = getJobCompletionAction(job);
      if (completionAction) {
        actions.push(completionAction);
      } else if (job.status === 'completed' && insight.reality !== 'standard') {
        actions.push({
          label: t('Open Runtime Settings'),
          to: buildRuntimeSettingsPath('readiness', job.framework, trainingLaunchContext, outboundReturnTo),
          variant: 'secondary'
        });
      } else {
        actions.push({
          label: t('View full detail'),
          to: buildSelectedJobDetailPath(job.id),
          variant: 'secondary'
        });
      }
      actions.push({
        label: t('Create next run'),
        to: buildCreatePathFromJob(job),
        variant: 'ghost'
      });

      if (job.dataset_id) {
        actions.push({
          label: t('Open closure lane'),
          to: buildScopedClosurePath(job.dataset_id, job.dataset_version_id, trainingLaunchContext),
          variant: 'ghost'
        });
      }

      return actions;
    },
    [
      buildSelectedJobDetailPath,
      buildCreatePathFromJob,
      getJobCompletionAction,
      jobExecutionInsights,
      openJobDrawer,
      outboundReturnTo,
      t,
      trainingLaunchContext
    ]
  );
  type GuidanceAction = {
    label: string;
    to?: string;
    onClick?: () => void;
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    disabled?: boolean;
  };
  type TrainingListNextStepState = {
    current: number;
    total: number;
    title: string;
    detail: string;
    badgeTone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
    badgeLabel: string;
    actions: GuidanceAction[];
  };

  const focusJob = selectedJob ?? firstActiveJob ?? firstVisibleJob;
  const focusJobLinkedVersion = useMemo(
    () => (focusJob ? getLatestLinkedVersion(focusJob.id) : null),
    [focusJob, getLatestLinkedVersion]
  );
  const focusJobCompletionAction = focusJob
    ? getJobCompletionAction(
        focusJob,
        selectedJob?.id === focusJob.id ? selectedArtifactSummary : null
      )
    : null;
  const trainingListNextStep = useMemo<TrainingListNextStepState>(() => {
    if (filteredJobs.length === 0) {
      if (scopeBlockerHint) {
        return {
          current: 1,
          total: 4,
          title: t('Resolve scope first, then continue this lane'),
          detail: t(
            'The requested dataset scope is valid but currently has no runs. Clear scope to reopen queue history, or create the first run in this scope.'
          ),
          badgeTone: 'warning',
          badgeLabel: t('Scope empty'),
          actions: [
            { label: t('Clear scope'), to: clearScopePath },
            { label: t('Create Training Job'), to: scopedCreatePath, variant: 'secondary' }
          ]
        };
      }
      return {
        current: 1,
        total: 4,
        title: t('Launch the first training run'),
        detail: t('Start from one dataset snapshot so logs, artifacts, and later version registration stay tied to the same run.'),
        badgeTone: 'warning',
        badgeLabel: t('No runs'),
        actions: [{ label: t('Create Training Job'), to: scopedCreatePath }]
      };
    }

    if (!focusJob) {
      return {
        current: 2,
        total: 4,
        title: t('Open one job and keep the next step visible'),
        detail: t('Use the current list to pick the run you want to continue, then this rail will point to the next operational page.'),
        badgeTone: 'info',
        badgeLabel: t('Pick a run'),
        actions: firstActiveJob
          ? [{ label: t('Open active job'), onClick: openBestVisibleJob }]
          : []
      };
    }

    if (activeStatusSet.has(focusJob.status)) {
      return {
        current: 2,
        total: 4,
        title: t('Keep watching this run until artifacts are ready'),
        detail: t('The job is still executing. Stay on the job detail page for logs and metrics, then continue to version registration when it completes.'),
        badgeTone: 'info',
        badgeLabel: t('In progress'),
        actions: [
          { label: t('View full detail'), to: buildSelectedJobDetailPath(focusJob.id) },
          focusJob.dataset_id
            ? {
                label: t('Open closure lane'),
                to: buildScopedClosurePath(
                  focusJob.dataset_id,
                  focusJob.dataset_version_id,
                  trainingLaunchContext
                ),
                variant: 'ghost'
              }
            : {
                label: t('Refresh'),
                onClick: () => {
                  load('manual').catch(() => {
                    // no-op
                  });
                },
                variant: 'ghost'
              }
        ]
      };
    }

    if (focusJob.status === 'failed' || focusJob.status === 'cancelled') {
      return {
        current: 2,
        total: 4,
        title: t('Review logs and retry this run'),
        detail: t('The run ended early. Check logs first, then retry with a clearer dispatch choice if needed.'),
        badgeTone: 'danger',
        badgeLabel: t('Needs retry'),
        actions: [
          { label: t('Review & retry'), onClick: () => openJobDrawer(focusJob.id) },
          ...(focusJob.execution_target === 'worker'
            ? [
                {
                  label: t('Worker Settings'),
                  to: buildWorkerSettingsPath(focusJob, trainingLaunchContext, outboundReturnTo),
                  variant: 'ghost' as const
                }
              ]
            : []),
          {
            label: t('View full detail'),
            to: buildSelectedJobDetailPath(focusJob.id),
            variant: 'ghost'
          }
        ]
      };
    }

    const focusInsight =
      jobExecutionInsights[focusJob.id] ??
      deriveTrainingExecutionInsight({
        status: focusJob.status,
        executionMode: focusJob.execution_mode,
        artifactSummary: selectedJob?.id === focusJob.id ? selectedArtifactSummary : null
      });

    if (focusJob.status === 'completed' && focusInsight.reality !== 'standard') {
      return {
        current: 3,
        total: 4,
        title: t('Fix runtime evidence before registration'),
        detail: t('This run completed with incomplete or fallback evidence. Review runtime settings and closure checks before treating it as a publishable version.'),
        badgeTone: 'warning',
        badgeLabel: t('Evidence review'),
        actions: [
          {
            label: t('Open Runtime Settings'),
            to: buildRuntimeSettingsPath(
              'readiness',
              focusJob.framework,
              trainingLaunchContext,
              outboundReturnTo
            )
          },
          focusJob.dataset_id
            ? {
                label: t('Open closure lane'),
                to: buildScopedClosurePath(
                  focusJob.dataset_id,
                  focusJob.dataset_version_id,
                  trainingLaunchContext
                ),
                variant: 'ghost'
              }
            : {
                label: t('View full detail'),
                to: buildSelectedJobDetailPath(focusJob.id),
                variant: 'ghost'
              }
        ]
      };
    }

    if (focusJobCompletionAction) {
      const focusJobInferencePath =
        focusJob?.dataset_id
          ? buildScopedInferencePath(
              focusJob.dataset_id,
              focusJob.dataset_version_id,
              focusJobLinkedVersion?.id ?? undefined,
              trainingLaunchContext
            )
          : '';
      return {
        current: 4,
        total: 4,
        title:
          focusJobCompletionAction.label === t('Create model draft')
            ? t('Create a matching model shell first')
            : focusJobLinkedVersion
              ? t('Move the linked version into validation or delivery')
            : t('Register this completed run as a model version'),
        detail:
          focusJobCompletionAction.label === t('Create model draft')
            ? t('The training result is standard, but you still need an owned model draft before this run can register a version.')
            : focusJobLinkedVersion
              ? t('Version {version} is already linked to this run. Continue with inference validation, governance follow-up, or device delivery from the version page.', {
                  version: focusJobLinkedVersion.version_name
                })
            : t('The run is standard and artifacts are ready. Register one model version now so downstream validation and device delivery stay anchored to this run.'),
        badgeTone: 'success',
        badgeLabel:
          focusJobCompletionAction.label === t('Create model draft')
            ? t('Model needed')
            : focusJobLinkedVersion
              ? t('Linked version ready')
            : t('Ready to register'),
        actions: [
          focusJobCompletionAction,
          ...(focusJobLinkedVersion && focusJobInferencePath
            ? [
                {
                  label: t('Validate inference'),
                  to: focusJobInferencePath,
                  variant: 'secondary' as const
                }
              ]
            : []),
          focusJob.dataset_id
            ? {
                label: t('Open closure lane'),
                to: buildScopedClosurePath(
                  focusJob.dataset_id,
                  focusJob.dataset_version_id,
                  trainingLaunchContext
                ),
                variant: 'ghost'
              }
            : {
                label: t('View full detail'),
                to: buildSelectedJobDetailPath(focusJob.id),
                variant: 'ghost'
              }
        ]
      };
    }

    return {
      current: 4,
      total: 4,
      title: t('Open one completed run and continue from detail'),
      detail: t('Use the job detail page to inspect artifacts, linked versions, and closure objects before choosing the next governance step.'),
      badgeTone: 'neutral',
      badgeLabel: t('Completed'),
      actions: [{ label: t('View full detail'), to: buildSelectedJobDetailPath(focusJob.id) }]
    };
  }, [
    buildSelectedJobDetailPath,
    filteredJobs.length,
    firstActiveJob,
    focusJob,
    focusJobLinkedVersion,
    focusJobCompletionAction,
    jobExecutionInsights,
    load,
    openBestVisibleJob,
    openJobDrawer,
    clearScopePath,
    scopedCreatePath,
    selectedArtifactSummary,
    selectedJob?.id,
    scopeBlockerHint,
    t,
    trainingLaunchContext
  ]);
  const moveSelectedJob = useCallback(
    (delta: number) => {
      if (!selectedJob || filteredJobs.length === 0) {
        return;
      }
      const currentIndex = filteredJobs.findIndex((job) => job.id === selectedJob.id);
      if (currentIndex < 0) {
        return;
      }
      const nextIndex = currentIndex + delta;
      if (nextIndex < 0 || nextIndex >= filteredJobs.length) {
        return;
      }
      setSelectedJobId(filteredJobs[nextIndex].id);
      setDetailDrawerOpen(true);
    },
    [filteredJobs, selectedJob]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingField =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (isTypingField) {
        return;
      }

      if (event.key === '/') {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (!detailDrawerOpen || !selectedJob) {
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        moveSelectedJob(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        moveSelectedJob(1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setDetailDrawerOpen(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [detailDrawerOpen, moveSelectedJob, selectedJob]);

  const tableColumns = useMemo<StatusTableColumn<TrainingJobRecord>[]>(
    () => [
      {
        key: 'status',
        header: t('Status'),
        width: '10%',
        cell: (job) => <StatusTag status={job.status}>{t(job.status)}</StatusTag>
      },
      {
        key: 'job',
        header: t('Job'),
        width: '22%',
        cell: (job) => (
          <div className="stack tight">
            <strong>{job.name}</strong>
            <small className="muted">
              {job.id} · {t('Last updated')}: {formatTimestamp(job.updated_at)}
            </small>
          </div>
        )
      },
      {
        key: 'task',
        header: t('Task / Framework'),
        width: '16%',
        cell: (job) => (
          <div className="stack tight">
            <Badge tone="neutral">{t(job.task_type)}</Badge>
            <small className="muted">
              {t(job.framework)} · {job.base_model}
            </small>
          </div>
        )
      },
      {
        key: 'snapshot',
        header: t('Dataset'),
        width: '16%',
        cell: (job) => (
          <div className="stack tight">
            <small className="muted">{job.dataset_id || '—'}</small>
            <small className="muted">{job.dataset_version_id || t('Version pending')}</small>
          </div>
        )
      },
      {
        key: 'execution',
        header: t('Evidence'),
        width: '16%',
        cell: (job) => {
          const insight =
            jobExecutionInsights[job.id] ??
            deriveTrainingExecutionInsight({
              status: job.status,
              executionMode: job.execution_mode
            });
          return (
            <div className="stack tight">
              <Badge tone={insight.reality === 'standard' ? 'success' : 'warning'}>
                {describeRealityLabel(t, insight)}
              </Badge>
              <small className="muted">
                {describeExecutionTargetLabel(t, job.execution_target)} ·{' '}
                {describeExecutionModeLabel(t, job.execution_mode)}
              </small>
            </div>
          );
        }
      },
      {
        key: 'actions',
        header: t('Next'),
        width: '16%',
        cell: (job) => {
          const actions = getJobRowActions(job);
          return (
            <div className="workspace-record-actions row gap wrap">
              {actions.map((action) =>
                action.to ? (
                  <ButtonLink
                    key={`${job.id}:${action.label}`}
                    to={action.to}
                    variant={action.variant ?? 'secondary'}
                    size="sm"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {action.label}
                  </ButtonLink>
                ) : (
                  <Button
                    key={`${job.id}:${action.label}`}
                    type="button"
                    variant={action.variant ?? 'secondary'}
                    size="sm"
                    disabled={actionBusy}
                    onClick={(event) => {
                      event.stopPropagation();
                      action.onClick?.();
                    }}
                  >
                    {action.label}
                  </Button>
                )
              )}
            </div>
          );
        }
      }
    ],
    [actionBusy, getJobRowActions, jobExecutionInsights, t]
  );

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Training control')}
        title={t('Training Jobs')}
        description={t('Inspect one job, then move on.')}
        meta={
          <div className="stack tight">
            <div className="row gap wrap align-center">
              <Badge tone="info">
                {t('Visible jobs')}: {filteredJobs.length}
              </Badge>
              <Badge tone="success">
                {t('Active')}: {activeJobsCount}
              </Badge>
              <Badge tone="neutral">
                {t('Completed')}: {completedJobsCount}
              </Badge>
              {verificationNeededCount > 0 ? (
                <Badge tone="warning">
                  {t('Needs verification')}: {verificationNeededCount}
                </Badge>
              ) : null}
            </div>
            <TrainingLaunchContextPills
              taskType={trainingLaunchContext.taskType}
              framework={trainingLaunchContext.framework}
              executionTarget={trainingLaunchContext.executionTarget}
              workerId={trainingLaunchContext.workerId}
              t={t}
            />
          </div>
        }
        primaryAction={{
          label: t('Create Training Job'),
          onClick: () => {
            navigate(scopedCreatePath);
          }
        }}
        secondaryActions={
          <div className="row gap wrap align-center">
            {requestedReturnTo ? (
              <ButtonLink to={requestedReturnTo} variant="secondary" size="sm">
                {t('Return to current task')}
              </ButtonLink>
            ) : null}
            {firstActiveJob ? (
              <Button type="button" variant="ghost" size="sm" onClick={openBestVisibleJob}>
                {t('Open active job')}
              </Button>
            ) : null}
            {scopedDatasetId ? (
              <ButtonLink
                to={buildScopedClosurePath(scopedDatasetId, scopedVersionId, trainingLaunchContext)}
                variant="ghost"
                size="sm"
              >
                {t('Continue to next loop lane')}
              </ButtonLink>
            ) : null}
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
        }
      />

      {error ? <InlineAlert tone="danger" title={t('Load Failed')} description={error} /> : null}
      {preferredJobFilterHint ? (
        <InlineAlert tone="info" title={t('Focused on requested job')} description={preferredJobFilterHint} />
      ) : null}
      {preferredJobOutOfScope ? (
        <InlineAlert
          tone="warning"
          title={t('Requested job is outside current scope')}
          description={t(
            'Job {jobId} exists, but it is not inside the current dataset scope. Clear scope first to open it.',
            { jobId: preferredJobId }
          )}
          actions={
            <div className="row gap wrap">
              <ButtonLink to={recoverPreferredJobPath} variant="secondary" size="sm">
                {t('Clear scope and open job')}
              </ButtonLink>
              <ButtonLink to={clearScopePath} variant="ghost" size="sm">
                {t('Clear scope')}
              </ButtonLink>
            </div>
          }
        />
      ) : null}
      {preferredJobMissing ? (
        <InlineAlert
          tone="warning"
          title={t('Requested job not found')}
          description={t(
            'The job from the incoming link is unavailable. Showing current queue results instead.'
          )}
          actions={
            <ButtonLink to={clearPreferredJobContextPath} variant="ghost" size="sm">
              {t('Clear context')}
            </ButtonLink>
          }
        />
      ) : null}
      {scopeBlockerHint ? (
        <InlineAlert
          tone="info"
          title={t('Current scope has no jobs')}
          description={scopeBlockerHint}
          actions={
            <div className="row gap wrap">
              <ButtonLink to={clearScopePath} variant="secondary" size="sm">
                {t('Clear scope')}
              </ButtonLink>
              <ButtonLink to={scopedCreatePath} variant="ghost" size="sm">
                {t('Create Training Job')}
              </ButtonLink>
            </div>
          }
        />
      ) : null}
      {filterBlockerHint ? (
        <InlineAlert
          tone="warning"
          title={t('Filters are hiding all jobs')}
          description={filterBlockerHint}
          actions={
            <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
              {t('Clear Filters')}
            </Button>
          }
        />
      ) : null}

      {hasScopeFilter ? (
        <InlineAlert
          tone="info"
          title={t('Current scope')}
          description={scopeLabel}
          actions={
            <div className="row gap wrap">
              {scopedDatasetId ? (
                <ButtonLink
                  to={buildScopedDatasetPath(scopedDatasetId, scopedVersionId, trainingLaunchContext)}
                  variant="ghost"
                  size="sm"
                >
                  {t('Open dataset')}
                </ButtonLink>
              ) : null}
              <ButtonLink to={clearScopePath} variant="secondary" size="sm">
                {t('Clear scope')}
              </ButtonLink>
            </div>
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
                    ref={searchInputRef}
                    value={searchText}
                    onChange={(event) => setSearchText(event.target.value)}
                    placeholder={t('Search by job name, base model, or ID')}
                  />
                  <small className="muted">{t('Press / to focus search')}</small>
                </label>
                <label className="stack tight">
                  <small className="muted">{t('Queue')}</small>
                  <Select
                    value={queueFilter}
                    onChange={(event) => setQueueFilter(event.target.value as QueueFilter)}
                  >
                    <option value="all">{t('All')}</option>
                    <option value="active">{t('Active')}</option>
                    <option value="terminal">{t('Completed')}</option>
                  </Select>
                </label>
              </>
            }
            actions={
              <>
                {hasActiveFilters ? (
                  <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
                    {t('Clear Filters')}
                  </Button>
                ) : null}
              </>
            }
            summary={null}
          />
        }
        main={
          <div className="workspace-main-stack">
            <AdvancedSection
              title={t('More filters')}
              description={t('Collapsed by default for progressive disclosure.')}
            >
              <div className="row gap wrap">
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
              </div>
            </AdvancedSection>
            <SectionCard
              title={t('Job Queue')}
              description={t('Scan the list, then open one row for details.')}
            >
              {loading ? (
                <StateBlock
                  variant="loading"
                  title={t('Loading jobs')}
                  description={t('Loading training jobs.')}
                />
              ) : filteredJobs.length === 0 ? (
                <StateBlock
                  variant="empty"
                  title={hasActiveFilters ? t('No matches') : t('No training jobs yet')}
                  description={
                    hasActiveFilters
                      ? t('Clear filters or switch scope.')
                      : scopeBlockerHint || t('Create the first training job.')
                  }
                  extra={
                    <div className="row gap wrap">
                      <ButtonLink to={scopedCreatePath} variant="secondary" size="sm">
                        {t('Create Training Job')}
                      </ButtonLink>
                      {scopeBlockerHint ? (
                        <ButtonLink to={clearScopePath} variant="ghost" size="sm">
                          {t('Clear scope')}
                        </ButtonLink>
                      ) : null}
                      {hasActiveFilters ? (
                        <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
                          {t('Clear Filters')}
                        </Button>
                      ) : null}
                    </div>
                  }
                />
              ) : (
                <StatusTable
                  columns={tableColumns}
                  rows={filteredJobs}
                  getRowKey={(job) => job.id}
                  onRowClick={(job) => {
                    if (actionBusy) {
                      return;
                    }
                    openJobDrawer(job.id);
                  }}
                  rowClassName={(job) =>
                    selectedJobId === job.id && detailDrawerOpen ? 'selected' : undefined
                  }
                  emptyTitle={t('No jobs')}
                  emptyDescription={t('No jobs are visible in the current view.')}
                />
              )}
            </SectionCard>
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <SectionCard
              title={t('Quickstart lane')}
              description={t('Use this compact lane to avoid getting lost between pages.')}
            >
              <div className="stack">
                {quickstartSteps.map((step) => (
                  <Panel key={step.key} tone="soft" className="stack tight">
                    <div className="row gap wrap align-center">
                      <strong>{step.title}</strong>
                      <Badge tone={step.tone}>{step.label}</Badge>
                    </div>
                    <small className="muted">{step.detail}</small>
                    {step.action ? (
                      step.action.to ? (
                        <ButtonLink to={step.action.to} variant={step.action.variant ?? 'secondary'} size="sm">
                          {step.action.label}
                        </ButtonLink>
                      ) : (
                        <Button
                          type="button"
                          variant={step.action.variant ?? 'secondary'}
                          size="sm"
                          onClick={step.action.onClick}
                        >
                          {step.action.label}
                        </Button>
                      )
                    ) : null}
                  </Panel>
                ))}
              </div>
            </SectionCard>

            <WorkspaceNextStepCard
              title={t('Next step')}
              description={t('Keep training progress, evidence checks, and version handoff aligned from one lane.')}
              stepLabel={trainingListNextStep.title}
              stepDetail={trainingListNextStep.detail}
              current={trainingListNextStep.current}
              total={trainingListNextStep.total}
              badgeLabel={trainingListNextStep.badgeLabel}
              badgeTone={trainingListNextStep.badgeTone}
              actions={trainingListNextStep.actions.map((action) =>
                action.to ? (
                  <ButtonLink key={action.label} to={action.to} variant={action.variant ?? 'primary'} size="sm">
                    {action.label}
                  </ButtonLink>
                ) : (
                  <Button
                    key={action.label}
                    type="button"
                    variant={action.variant ?? 'primary'}
                    size="sm"
                    onClick={action.onClick}
                    disabled={action.disabled}
                  >
                    {action.label}
                  </Button>
                )
              )}
            />

            <SectionCard
              title={t('Current job')}
              description={
                filteredJobs.length === 0
                  ? hasActiveFilters
                    ? t('Clear filters or broaden the scope.')
                    : t('Create a job to start tracking evidence.')
                  : selectedJob
                    ? selectedJobPositionLabel || t('Review status and evidence.')
                    : firstActiveJob
                      ? t('Open the active job first.')
                      : t('Select a row to inspect it.')
              }
              actions={
                <div className="row gap wrap">
                  {selectedJob ? (
                    <>
                      {canCancelSelectedJob ? (
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          onClick={cancelSelectedJob}
                          disabled={actionBusy}
                        >
                          {t('Cancel')}
                        </Button>
                      ) : null}
                      {canRetrySelectedJob ? (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={retrySelectedJob}
                          disabled={actionBusy}
                        >
                          {t('Retry')}
                        </Button>
                      ) : null}
                      <ButtonLink to={selectedJobCreateNextRunPath} variant="secondary" size="sm">
                        {t('Create next run')}
                      </ButtonLink>
                      {selectedJob.dataset_id ? (
                        <ButtonLink
                          to={buildScopedDatasetPath(
                            selectedJob.dataset_id,
                            selectedJob.dataset_version_id,
                            trainingLaunchContext
                          )}
                          variant="ghost"
                          size="sm"
                        >
                          {t('Open dataset')}
                        </ButtonLink>
                      ) : null}
                      {selectedJobLinkedVersion ? (
                        <ButtonLink
                          to={selectedJobVersionDeliveryPath}
                          variant="secondary"
                          size="sm"
                        >
                          {t('Continue in version delivery lane')}
                        </ButtonLink>
                      ) : null}
                      {selectedJob.dataset_id ? (
                        <ButtonLink
                          to={buildScopedClosurePath(
                            selectedJob.dataset_id,
                            selectedJob.dataset_version_id,
                            trainingLaunchContext
                          )}
                          variant="ghost"
                          size="sm"
                        >
                          {t('Continue to next loop lane')}
                        </ButtonLink>
                      ) : null}
                      <ButtonLink
                        to={buildSelectedJobDetailPath(selectedJob.id)}
                        variant="secondary"
                        size="sm"
                      >
                        {t('View full detail')}
                      </ButtonLink>
                    </>
                  ) : filteredJobs.length === 0 ? (
                    hasActiveFilters ? (
                      <Button type="button" variant="secondary" size="sm" onClick={resetFilters}>
                        {t('Clear Filters')}
                      </Button>
                    ) : (
                      <ButtonLink to={scopedCreatePath} variant="secondary" size="sm">
                        {t('Create Training Job')}
                      </ButtonLink>
                    )
                  ) : null}
                </div>
              }
            >
              {selectedJob ? (
                <div className="stack">
                  <TrainingJobSummaryBlock
                    t={t}
                    job={selectedJob}
                    insight={selectedExecutionInsight}
                    realityLabel={selectedExecutionRealityLabel}
                    variant="glance"
                  />
                  {selectedJobLinkedVersion ? (
                    <Panel tone="soft" className="stack tight">
                      <strong>{t('Version handoff')}</strong>
                      <small className="muted">
                        {t('This run already has linked version {version}. Use the version delivery lane for validation, device authorization, and remote API handoff.', {
                          version: selectedJobLinkedVersion.version_name
                        })}
                      </small>
                      <div className="row gap wrap">
                        <Badge tone="success">{t('Linked versions')}: {linkedVersionsByJobId.get(selectedJob.id)?.length ?? 1}</Badge>
                        <Badge tone="info">{t('Latest linked version')}: {selectedJobLinkedVersion.version_name}</Badge>
                      </div>
                      <div className="row gap wrap">
                        <ButtonLink to={selectedJobVersionDeliveryPath} variant="secondary" size="sm">
                          {t('Continue in version delivery lane')}
                        </ButtonLink>
                        {selectedJobInferencePath ? (
                          <ButtonLink to={selectedJobInferencePath} variant="ghost" size="sm">
                            {t('Validate inference')}
                          </ButtonLink>
                        ) : null}
                      </div>
                    </Panel>
                  ) : null}
                  {actionFeedback ? (
                    <InlineAlert
                      tone={actionFeedback.variant === 'success' ? 'success' : 'danger'}
                      title={actionFeedback.variant === 'success' ? t('Success') : t('Operation failed')}
                      description={actionFeedback.text}
                    />
                  ) : null}
                  {actionBusy && actionProgressText ? (
                    <InlineAlert
                      tone="info"
                      title={t('In progress')}
                      description={actionProgressText}
                    />
                  ) : null}
                  <Panel tone="soft" className="stack tight">
                    <strong>{t('Recent operation summaries')}</strong>
                    <label className="stack tight">
                      <small className="muted">{t('Filter')}</small>
                      <Select
                        value={operationLogFilter}
                        onChange={(event) =>
                          setOperationLogFilter(
                            event.target.value as 'all' | 'failures' | 'batch'
                          )
                        }
                      >
                        <option value="all">{t('All')}</option>
                        <option value="failures">{t('Failed only')}</option>
                        <option value="batch">{t('Batch only')}</option>
                      </Select>
                    </label>
                    <div className="row gap wrap align-center">
                      <Badge tone="neutral">{t('{count} logs', { count: operationLogEntryCount })}</Badge>
                      <Badge tone={failedOperationLogCount > 0 ? 'warning' : 'success'}>
                        {t('{count} failed', { count: failedOperationLogCount })}
                      </Badge>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={jumpToFirstFailedOperationLog}
                        disabled={!firstFailedOperationLogEntry}
                      >
                        {t('Jump to first failure')}
                      </Button>
                    </div>
                    {focusedOperationLogId && clearOperationLogFocusPath ? (
                      <div className="row gap wrap">
                        <ButtonLink to={clearOperationLogFocusPath} variant="ghost" size="sm">
                          {t('Clear located marker')}
                        </ButtonLink>
                        {focusedOperationLogEntry ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setOperationLogFocusMode((current) => !current)}
                          >
                            {operationLogFocusMode ? t('Show all logs') : t('Return to focused log')}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                    {focusedOperationLogId && operationLogFocusMode && focusedOperationLogEntry ? (
                      <small className="muted">
                        {t('Focus mode is on. Showing only the located operation log.')}
                      </small>
                    ) : null}
                    {operationLogCopyError ? (
                      <InlineAlert
                        tone="warning"
                        title={t('Copy failed')}
                        description={operationLogCopyError}
                      />
                    ) : null}
                    {groupedOperationLogEntries.length > 0 ? (
                      <div className="row gap wrap">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setCollapsedOperationLogGroups((current) => {
                              if (!hasExpandedOperationLogGroup) {
                                return current;
                              }
                              return OPERATION_LOG_GROUP_KEYS.reduce<Record<OperationLogGroupKey, boolean>>(
                                (acc, key) => {
                                  acc[key] = true;
                                  return acc;
                                },
                                {
                                  today: current.today,
                                  yesterday: current.yesterday,
                                  earlier: current.earlier
                                }
                              );
                            });
                          }}
                          disabled={!hasExpandedOperationLogGroup}
                        >
                          {t('Collapse all')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setCollapsedOperationLogGroups((current) => {
                              if (!hasCollapsedOperationLogGroup) {
                                return current;
                              }
                              return OPERATION_LOG_GROUP_KEYS.reduce<Record<OperationLogGroupKey, boolean>>(
                                (acc, key) => {
                                  acc[key] = false;
                                  return acc;
                                },
                                {
                                  today: current.today,
                                  yesterday: current.yesterday,
                                  earlier: current.earlier
                                }
                              );
                            });
                          }}
                          disabled={!hasCollapsedOperationLogGroup}
                        >
                          {t('Expand all')}
                        </Button>
                      </div>
                    ) : null}
                    {groupedOperationLogEntries.length === 0 ? (
                      <small className="muted">{t('No recent operations yet.')}</small>
                    ) : (
                      groupedOperationLogEntries.map((group) => (
                        <div key={group.key} className="stack tight">
                          <div className="row between align-center">
                            <div className="row gap align-center">
                              <strong>{group.label}</strong>
                              <Badge tone="neutral">{t('{count} entries', { count: group.entries.length })}</Badge>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setCollapsedOperationLogGroups((current) => ({
                                  ...current,
                                  [group.key]: !current[group.key]
                                }))
                              }
                            >
                              {collapsedOperationLogGroups[group.key] ? t('Expand') : t('Collapse')}
                            </Button>
                          </div>
                          {collapsedOperationLogGroups[group.key]
                            ? null
                            : group.entries.map((entry) => (
                                <div
                                  key={entry.id}
                                  ref={(node) => {
                                    operationLogEntryRefs.current[entry.id] = node;
                                  }}
                                  className="stack tight"
                                  style={{
                                    padding: '0.5rem',
                                    borderRadius: '0.5rem',
                                    border:
                                      entry.id === focusedOperationLogId
                                        ? '1px solid #60a5fa'
                                        : '1px solid transparent',
                                    background:
                                      entry.id === focusedOperationLogId
                                        ? 'rgba(59, 130, 246, 0.08)'
                                        : 'transparent'
                                  }}
                                >
                                  <div className="row gap wrap align-center">
                                    <Badge tone={entry.tone}>{entry.title}</Badge>
                                    <Badge tone={entry.isBatch ? 'info' : 'neutral'}>
                                      {entry.isBatch ? t('Batch') : t('Single')}
                                    </Badge>
                                    <Badge tone={entry.hasFailure ? 'warning' : 'success'}>
                                      {entry.hasFailure ? t('Failed') : t('Success')}
                                    </Badge>
                                    {entry.id === focusedOperationLogId ? (
                                      <Badge tone="info">{t('Located')}</Badge>
                                    ) : null}
                                    <small className="muted">{formatTimestamp(entry.createdAt)}</small>
                                  </div>
                                  <small className="muted">{entry.detail}</small>
                                  {entry.targetJobId ? (
                                    <div className="row gap wrap">
                                      <ButtonLink
                                        to={buildSelectedJobDetailPath(entry.targetJobId)}
                                        variant="ghost"
                                        size="sm"
                                      >
                                        {t('Open job')}
                                      </ButtonLink>
                                      <ButtonLink
                                        to={buildOperationLogQueueFocusPath(entry.targetJobId, entry.id)}
                                        variant="ghost"
                                        size="sm"
                                      >
                                        {t('Locate in queue')}
                                      </ButtonLink>
                                      {entry.hasFailure ? (
                                        <ButtonLink
                                          to={buildSelectedJobDetailPath(entry.targetJobId, {
                                            logEntryId: entry.id,
                                            evidenceView: 'logs',
                                            errorHint: entry.errorSummary || entry.detail
                                          })}
                                          variant="ghost"
                                          size="sm"
                                        >
                                          {t('Open logs with failure context')}
                                        </ButtonLink>
                                      ) : null}
                                    </div>
                                  ) : null}
                                  {entry.hasFailure && entry.errorSummary ? (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => {
                                        copyOperationLogErrorSummary(entry).catch(() => {
                                          // no-op
                                        });
                                      }}
                                    >
                                      {copiedOperationLogId === entry.id
                                        ? t('Copied')
                                        : t('Copy error summary')}
                                    </Button>
                                  ) : null}
                                </div>
                              ))}
                        </div>
                      ))
                    )}
                  </Panel>
                  {canRetrySelectedJob ? (
                    <Panel tone="soft" className="stack tight">
                      <strong>{t('Retry dispatch strategy')}</strong>
                      <small className="muted">{t('Choose where the retried run should execute.')}</small>
                      <label className="stack tight">
                        <small className="muted">{t('Dispatch target')}</small>
                        <Select
                          value={retryDispatchPreference}
                          onChange={(event) => {
                            retryDispatchTouchedRef.current = true;
                            const nextPreference = event.target.value as 'auto' | 'control_plane' | 'worker';
                            setRetryDispatchPreference(nextPreference);
                            if (nextPreference !== 'worker') {
                              setRetryWorkerId('');
                            }
                          }}
                        >
                          <option value="auto">{t('Auto (scheduler decides)')}</option>
                          <option value="control_plane">{t('Force control-plane')}</option>
                          <option value="worker">{t('Prefer worker dispatch')}</option>
                        </Select>
                      </label>
                      {retryDispatchPreference === 'worker' ? (
                        <label className="stack tight">
                          <small className="muted">{t('Worker preference (optional)')}</small>
                          <Select
                            value={retryWorkerId}
                            onChange={(event) => {
                              retryDispatchTouchedRef.current = true;
                              setRetryWorkerId(event.target.value);
                            }}
                            disabled={workersLoading || workersAccessDenied || workers.length === 0}
                          >
                            <option value="">{t('Auto-select from online workers')}</option>
                            {onlineWorkers.map((worker) => (
                              <option key={worker.id} value={worker.id}>
                                {worker.name} · {worker.id}
                              </option>
                            ))}
                          </Select>
                        </label>
                      ) : null}
                      <small className="muted">{retryDispatchSummary}</small>
                      {retryDispatchPreference === 'worker' ? (
                        <div className="row gap wrap">
                          <Badge tone={onlineWorkers.length > 0 ? 'success' : 'warning'}>
                            {t('Online workers')}: {onlineWorkers.length}
                          </Badge>
                          {retryWorkerId ? (
                            <Badge tone={retryWorkerAvailable ? 'success' : 'danger'}>
                              {retryWorkerAvailable ? t('Selected worker ready') : t('Selected worker missing')}
                            </Badge>
                          ) : null}
                        </div>
                      ) : null}
                      {workersLoading ? (
                        <small className="muted">{t('Loading worker inventory...')}</small>
                      ) : null}
                      {workersAccessDenied ? (
                        <small className="muted">{t('Worker inventory is restricted to admins.')}</small>
                      ) : null}
                      {!workersAccessDenied && workersError ? (
                        <small className="muted">{workersError}</small>
                      ) : null}
                      {retryDispatchPreference === 'worker' &&
                      !workersLoading &&
                      !workersAccessDenied &&
                      onlineWorkers.length === 0 ? (
                        <InlineAlert
                          tone="warning"
                          title={t('No online worker')}
                          description={t(
                            'Worker dispatch may fail if no eligible online worker is available.'
                          )}
                        />
                      ) : null}
                    </Panel>
                  ) : null}
                  {activeVisibleJobs.length > 0 || retryableVisibleJobs.length > 0 ? (
                    <Panel tone="soft" className="stack tight">
                      <strong>{t('Batch operations in current view')}</strong>
                      <small className="muted">
                        {t('Applies to jobs in the current filter scope only.')}
                      </small>
                      <div className="row gap wrap">
                        <Badge tone="info">
                          {t('Active jobs')}: {activeVisibleJobs.length}
                        </Badge>
                        <Badge tone="warning">
                          {t('Retryable jobs')}: {retryableVisibleJobs.length}
                        </Badge>
                      </div>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        onClick={cancelVisibleActiveJobs}
                        disabled={actionBusy || activeVisibleJobs.length === 0}
                      >
                        {t('Cancel all visible active jobs')}
                      </Button>
                      {retryableVisibleJobs.length === 0 ? null : (
                        <>
                          <label className="stack tight">
                            <small className="muted">{t('Dispatch target')}</small>
                            <Select
                              value={bulkRetryDispatchPreference}
                              onChange={(event) => {
                                const nextPreference = event.target.value as
                                  | 'auto'
                                  | 'control_plane'
                                  | 'worker';
                                setBulkRetryDispatchPreference(nextPreference);
                                if (nextPreference !== 'worker') {
                                  setBulkRetryWorkerId('');
                                }
                              }}
                            >
                              <option value="auto">{t('Auto (scheduler decides)')}</option>
                              <option value="control_plane">{t('Force control-plane')}</option>
                              <option value="worker">{t('Prefer worker dispatch')}</option>
                            </Select>
                          </label>
                          {bulkRetryDispatchPreference === 'worker' ? (
                            <label className="stack tight">
                              <small className="muted">{t('Worker preference (optional)')}</small>
                              <Select
                                value={bulkRetryWorkerId}
                                onChange={(event) => {
                                  setBulkRetryWorkerId(event.target.value);
                                }}
                                disabled={workersLoading || workersAccessDenied || workers.length === 0}
                              >
                                <option value="">{t('Auto-select from online workers')}</option>
                                {onlineWorkers.map((worker) => (
                                  <option key={worker.id} value={worker.id}>
                                    {worker.name} · {worker.id}
                                  </option>
                                ))}
                              </Select>
                            </label>
                          ) : null}
                          <small className="muted">{bulkRetryDispatchSummary}</small>
                          <InlineAlert
                            tone={bulkRetryPrecheck.tone}
                            title={t('Batch retry precheck')}
                            description={bulkRetryPrecheck.text}
                          />
                          {bulkRetryDispatchPreference === 'worker' ? (
                            <div className="row gap wrap">
                              <Badge tone={onlineWorkers.length > 0 ? 'success' : 'warning'}>
                                {t('Online workers')}: {onlineWorkers.length}
                              </Badge>
                              {bulkRetryWorkerId ? (
                                <Badge tone={bulkRetryWorkerAvailable ? 'success' : 'danger'}>
                                  {bulkRetryWorkerAvailable
                                    ? t('Selected worker ready')
                                    : t('Selected worker missing')}
                                </Badge>
                              ) : null}
                            </div>
                          ) : null}
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={retryVisibleJobs}
                            disabled={
                              actionBusy ||
                              retryableVisibleJobs.length === 0 ||
                              (bulkRetryDispatchPreference === 'worker' && !bulkRetryWorkerAvailable)
                            }
                          >
                            {t('Retry all visible failed jobs')}
                          </Button>
                          {bulkRetryDispatchPreference === 'worker' &&
                          !workersLoading &&
                          !workersAccessDenied &&
                          onlineWorkers.length === 0 ? (
                            <InlineAlert
                              tone="warning"
                              title={t('No online worker')}
                              description={t(
                                'Worker dispatch may fail if no eligible online worker is available.'
                              )}
                            />
                          ) : null}
                        </>
                      )}
                    </Panel>
                  ) : null}
                </div>
              ) : firstActiveJob ? (
                <div className="stack tight">
                  <small className="muted">{t('Open the active job first.')}</small>
                  <Button type="button" variant="secondary" size="sm" onClick={openBestVisibleJob}>
                    {t('Open active job')}
                  </Button>
                </div>
              ) : (
                <small className="muted">
                  {hasActiveFilters ? t('Filters are hiding every row right now.') : t('Select a row to inspect it.')}
                </small>
              )}
            </SectionCard>

            <SectionCard
              title={t('Handoff map')}
              description={t('Keep key objects and next-page entries in one place.')}
            >
              {selectedJob ? (
                <div className="stack">
                  <DetailList
                    items={[
                      { label: t('Dataset'), value: selectedJob.dataset_id || '-' },
                      { label: t('Dataset Version'), value: selectedJob.dataset_version_id || '-' },
                      { label: t('Training Job'), value: selectedJob.id },
                      { label: t('Latest Model Version'), value: selectedJobLinkedVersion?.id || t('Not linked yet') },
                      { label: t('Evidence status'), value: selectedExecutionRealityLabel || t('Unknown execution') },
                      { label: t('Inference lane'), value: selectedJobInferencePath ? t('Ready') : t('Pending') },
                      { label: t('Closure lane'), value: selectedJobClosurePath ? t('Ready') : t('Pending') }
                    ]}
                  />
                  <div className="row gap wrap">
                    <ButtonLink to={selectedJobDetailPath} variant="secondary" size="sm">
                      {t('View full detail')}
                    </ButtonLink>
                    <ButtonLink to={selectedJobCreateNextRunPath} variant="secondary" size="sm">
                      {t('Create next run')}
                    </ButtonLink>
                    {selectedJobCompletionAction?.to ? (
                      <ButtonLink
                        to={selectedJobCompletionAction.to}
                        variant={selectedJobCompletionAction.variant ?? 'secondary'}
                        size="sm"
                      >
                        {selectedJobCompletionAction.label}
                      </ButtonLink>
                    ) : null}
                    {!selectedJobLinkedVersion ? (
                      <ButtonLink to={selectedJobRegisterVersionPath} variant="ghost" size="sm">
                        {t('Register version')}
                      </ButtonLink>
                    ) : null}
                    {!selectedJobLinkedVersion ? (
                      <ButtonLink to={selectedJobCreateModelDraftPath} variant="ghost" size="sm">
                        {t('Create model draft')}
                      </ButtonLink>
                    ) : null}
                    {selectedJobInferencePath ? (
                      <ButtonLink to={selectedJobInferencePath} variant="ghost" size="sm">
                        {t('Validate inference')}
                      </ButtonLink>
                    ) : null}
                    {selectedJobClosurePath ? (
                      <ButtonLink to={selectedJobClosurePath} variant="ghost" size="sm">
                        {t('Open closure lane')}
                      </ButtonLink>
                    ) : null}
                  </div>
                </div>
              ) : (
                <small className="muted">
                  {firstActiveJob
                    ? t('Open one active job, then this map will show direct handoff links.')
                    : t('Create or select one job first.')}
                </small>
              )}
            </SectionCard>
          </div>
        }
      />

      <DetailDrawer
        open={detailDrawerOpen && Boolean(selectedJob)}
        onClose={() => setDetailDrawerOpen(false)}
        title={selectedJob ? selectedJob.name : t('Job detail')}
        description={t('Execution summary')}
        actions={
          selectedJob ? (
            <div className="row gap wrap align-center">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => moveSelectedJob(-1)}
                disabled={actionBusy || selectedJobIndex <= 0}
              >
                {t('Previous')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => moveSelectedJob(1)}
                disabled={actionBusy || selectedJobIndex >= filteredJobs.length - 1}
              >
                {t('Next')}
              </Button>
              <ButtonLink to={buildSelectedJobDetailPath(selectedJob.id)} variant="secondary" size="sm">
                {t('View full detail')}
              </ButtonLink>
            </div>
          ) : null
        }
      >
        {selectedJob ? (
          <>
            <small className="muted">{t('Queue shortcuts: Previous / next · Esc close')}</small>
            <TrainingJobSummaryBlock
              t={t}
              job={selectedJob}
              insight={selectedExecutionInsight}
              realityLabel={selectedExecutionRealityLabel}
              variant="full"
            />
            {selectedArtifactSummary ? (
              <Panel className="stack tight" tone="soft">
                <div className="row gap wrap">
                  <Badge tone="neutral">
                    {t('Runner')}: {selectedArtifactSummary.runner || t('Pending')}
                  </Badge>
                  {selectedArtifactSummary.mode ? (
                    <Badge tone="info">
                      {t('Mode:')} {selectedArtifactSummary.mode}
                    </Badge>
                  ) : null}
                  {selectedArtifactSummary.training_performed !== null ? (
                    <Badge tone={selectedArtifactSummary.training_performed ? 'success' : 'warning'}>
                      {t('Training')}: {selectedArtifactSummary.training_performed ? t('Yes') : t('No')}
                    </Badge>
                  ) : null}
                  {selectedArtifactSummary.sampled_items !== null ? (
                    <Badge tone="info">
                      {t('Sampled items')}: {selectedArtifactSummary.sampled_items}
                    </Badge>
                  ) : null}
                </div>
                {selectedArtifactSummary.generated_at ? (
                  <small className="muted">
                    {t('Artifact generated at')}:{' '}
                    {formatCompactTimestamp(selectedArtifactSummary.generated_at, t('n/a'))}
                  </small>
                ) : null}
                {selectedArtifactSummary.primary_model_path ? (
                  <small className="muted">
                    {t('Primary model path')}: {selectedArtifactSummary.primary_model_path}
                  </small>
                ) : null}
                {selectedArtifactSummary.metrics_keys.length > 0 ? (
                  <div className="row gap wrap">
                    {selectedArtifactSummary.metrics_keys.map((metricKey) => (
                      <Badge key={metricKey} tone="neutral">
                        {metricKey}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {selectedArtifactSummary.fallback_reason ? (
                  <small className="muted">
                    {t('Fallback reason')}: {describeFallbackReasonLabel(t, selectedArtifactSummary.fallback_reason)}
                  </small>
                ) : null}
              </Panel>
            ) : selectedExecutionInsight?.showWarning ? (
              <InlineAlert
                tone={selectedExecutionInsight.reality === 'simulated' ? 'danger' : 'warning'}
                title={t('Needs verification')}
                description={
                  selectedExecutionInsight.fallbackReason
                    ? t(
                        'The job does not have complete standard execution evidence. Review the detail first. Reason: {reason}',
                        { reason: describeFallbackReasonLabel(t, selectedExecutionInsight.fallbackReason) }
                      )
                    : t('The job does not have complete standard execution evidence. Review the detail first.')
                }
              />
            ) : null}
          </>
        ) : null}
      </DetailDrawer>
    </WorkspacePage>
  );
}
