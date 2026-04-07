import { useEffect, useMemo, useState } from 'react';
import type {
  ModelFramework,
  RuntimeConnectivityRecord,
  RuntimeMetricsRetentionSummary,
  TrainingArtifactSummary,
  TrainingJobRecord,
  TrainingWorkerBootstrapSessionRecord,
  TrainingWorkerDeploymentMode,
  TrainingWorkerProfile,
  TrainingWorkerNodeView
} from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import StateBlock from '../components/StateBlock';
import SettingsTabs from '../components/settings/SettingsTabs';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Input, Select } from '../components/ui/Field';
import { Drawer } from '../components/ui/Overlay';
import ProgressStepper from '../components/ui/ProgressStepper';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceSplit
} from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const FRAMEWORKS: ModelFramework[] = ['paddleocr', 'doctr', 'yolo'];
const recentMetricJobsPerFramework = 2;

type FrameworkMetricKeySummary = {
  framework: ModelFramework;
  jobsChecked: number;
  jobsWithMetrics: number;
  metricKeys: string[];
  latestJobLabel: string | null;
  latestGeneratedAt: string | null;
};

type WorkerOnboardingDraft = {
  deployment_mode: TrainingWorkerDeploymentMode;
  worker_profile: TrainingWorkerProfile;
  control_plane_base_url: string;
  worker_name: string;
  worker_public_host: string;
  worker_bind_port: string;
  max_concurrency: string;
};

const endpointEnvByFramework: Record<ModelFramework, { endpoint: string; apiKey: string }> = {
  paddleocr: {
    endpoint: 'PADDLEOCR_RUNTIME_ENDPOINT',
    apiKey: 'PADDLEOCR_RUNTIME_API_KEY'
  },
  doctr: {
    endpoint: 'DOCTR_RUNTIME_ENDPOINT',
    apiKey: 'DOCTR_RUNTIME_API_KEY'
  },
  yolo: {
    endpoint: 'YOLO_RUNTIME_ENDPOINT',
    apiKey: 'YOLO_RUNTIME_API_KEY'
  }
};

const sampleInputByFramework: Record<ModelFramework, Record<string, unknown>> = {
  paddleocr: {
    framework: 'paddleocr',
    model_id: 'm-ocr',
    model_version_id: 'mv-ocr-v1',
    input_attachment_id: 'f-ocr-001',
    filename: 'invoice-sample.jpg',
    task_type: 'ocr'
  },
  doctr: {
    framework: 'doctr',
    model_id: 'm-ocr',
    model_version_id: 'mv-ocr-v2',
    input_attachment_id: 'f-ocr-001',
    filename: 'invoice-sample.jpg',
    task_type: 'ocr'
  },
  yolo: {
    framework: 'yolo',
    model_id: 'm-det',
    model_version_id: 'mv-det-v1',
    input_attachment_id: 'f-det-001',
    filename: 'defect-sample.jpg',
    task_type: 'detection'
  }
};

const sampleOutputByFramework: Record<ModelFramework, Record<string, unknown>> = {
  paddleocr: {
    image: { filename: 'invoice-sample.jpg', width: 1280, height: 720 },
    lines: [
      { text: 'Invoice No. 2026-0402', confidence: 0.95 },
      { text: 'Total: 458.30', confidence: 0.92 }
    ],
    words: [
      { text: 'Invoice', confidence: 0.96 },
      { text: 'Total', confidence: 0.93 }
    ]
  },
  doctr: {
    image: { filename: 'invoice-sample.jpg', width: 1280, height: 720 },
    ocr: {
      lines: [{ text: 'docTR line output', confidence: 0.94 }],
      words: [{ text: 'docTR', confidence: 0.91 }]
    }
  },
  yolo: {
    image: { filename: 'defect-sample.jpg', width: 1280, height: 720 },
    boxes: [
      { x: 180, y: 210, width: 170, height: 110, label: 'defect', score: 0.91 },
      { x: 540, y: 360, width: 200, height: 120, label: 'scratch', score: 0.87 }
    ]
  }
};

const buildEmptyFrameworkMetricKeySummary = (): FrameworkMetricKeySummary[] =>
  FRAMEWORKS.map((framework) => ({
    framework,
    jobsChecked: 0,
    jobsWithMetrics: 0,
    metricKeys: [],
    latestJobLabel: null,
    latestGeneratedAt: null
  }));

const sortTrainingJobsByRecent = (left: TrainingJobRecord, right: TrainingJobRecord) => {
  const leftTime = Date.parse(left.updated_at || left.created_at) || 0;
  const rightTime = Date.parse(right.updated_at || right.created_at) || 0;
  if (rightTime !== leftTime) {
    return rightTime - leftTime;
  }

  return right.id.localeCompare(left.id);
};

const collectRecentMetricSummaryJobs = (jobs: TrainingJobRecord[]) => {
  const jobsByFramework = new Map<ModelFramework, TrainingJobRecord[]>();
  FRAMEWORKS.forEach((framework) => jobsByFramework.set(framework, []));

  [...jobs]
    .filter((job) => job.status === 'completed')
    .sort(sortTrainingJobsByRecent)
    .forEach((job) => {
      const bucket = jobsByFramework.get(job.framework);
      if (!bucket || bucket.length >= recentMetricJobsPerFramework) {
        return;
      }

      bucket.push(job);
    });

  return jobsByFramework;
};

const summarizeFrameworkMetricKeys = (
  jobsByFramework: Map<ModelFramework, TrainingJobRecord[]>,
  artifactSummaryByJobId: Map<string, TrainingArtifactSummary | null>
): FrameworkMetricKeySummary[] =>
  FRAMEWORKS.map((framework) => {
    const frameworkJobs = jobsByFramework.get(framework) ?? [];
    const metricKeys = new Set<string>();
    let jobsWithMetrics = 0;
    let latestJobLabel: string | null = null;
    let latestGeneratedAt: string | null = null;

    frameworkJobs.forEach((job) => {
      const artifactSummary = artifactSummaryByJobId.get(job.id);
      const keys = artifactSummary?.metrics_keys ?? [];
      if (keys.length === 0) {
        return;
      }

      jobsWithMetrics += 1;
      keys.forEach((metricKey) => metricKeys.add(metricKey));
      if (!latestJobLabel) {
        latestJobLabel = job.name.trim() || job.id;
      }
      if (!latestGeneratedAt) {
        latestGeneratedAt = artifactSummary?.generated_at ?? job.updated_at;
      }
    });

    if (!latestJobLabel && frameworkJobs[0]) {
      latestJobLabel = frameworkJobs[0].name.trim() || frameworkJobs[0].id;
    }
    if (!latestGeneratedAt && frameworkJobs[0]) {
      latestGeneratedAt = frameworkJobs[0].updated_at;
    }

    return {
      framework,
      jobsChecked: frameworkJobs.length,
      jobsWithMetrics,
      metricKeys: Array.from(metricKeys).sort((left, right) => left.localeCompare(right)),
      latestJobLabel,
      latestGeneratedAt
    };
  });

const buildDefaultWorkerOnboardingDraft = (): WorkerOnboardingDraft => ({
  deployment_mode: 'docker',
  worker_profile: 'yolo',
  control_plane_base_url:
    typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '',
  worker_name: '',
  worker_public_host: '',
  worker_bind_port: '9090',
  max_concurrency: '1'
});

const workerBootstrapStatusTone = (
  status: TrainingWorkerBootstrapSessionRecord['status']
): 'ready' | 'running' | 'failed' | 'draft' => {
  if (status === 'online') {
    return 'ready';
  }
  if (status === 'pairing' || status === 'awaiting_confirmation') {
    return 'running';
  }
  if (status === 'validation_failed' || status === 'expired') {
    return 'failed';
  }
  return 'draft';
};

export default function RuntimeSettingsPage() {
  const { t } = useI18n();
  const [checks, setChecks] = useState<RuntimeConnectivityRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [workersLoading, setWorkersLoading] = useState(true);
  const [workers, setWorkers] = useState<TrainingWorkerNodeView[]>([]);
  const [workersAccessDenied, setWorkersAccessDenied] = useState(false);
  const [workersError, setWorkersError] = useState('');
  const [bootstrapSessionsLoading, setBootstrapSessionsLoading] = useState(true);
  const [bootstrapSessions, setBootstrapSessions] = useState<TrainingWorkerBootstrapSessionRecord[]>([]);
  const [bootstrapSessionsAccessDenied, setBootstrapSessionsAccessDenied] = useState(false);
  const [bootstrapSessionsError, setBootstrapSessionsError] = useState('');
  const [workerOnboardingOpen, setWorkerOnboardingOpen] = useState(false);
  const [creatingBootstrapSession, setCreatingBootstrapSession] = useState(false);
  const [downloadingBootstrapSessionId, setDownloadingBootstrapSessionId] = useState<string | null>(null);
  const [validatingBootstrapSessionId, setValidatingBootstrapSessionId] = useState<string | null>(null);
  const [workerOnboardingDraft, setWorkerOnboardingDraft] = useState<WorkerOnboardingDraft>(
    () => buildDefaultWorkerOnboardingDraft()
  );
  const [activeBootstrapSessionId, setActiveBootstrapSessionId] = useState<string | null>(null);
  const [inferenceSourceSummary, setInferenceSourceSummary] = useState<Array<{ key: string; count: number }>>([]);
  const [trainingModeSummary, setTrainingModeSummary] = useState<Array<{ key: string; count: number }>>([]);
  const [frameworkMetricKeySummary, setFrameworkMetricKeySummary] = useState<FrameworkMetricKeySummary[]>(
    () => buildEmptyFrameworkMetricKeySummary()
  );
  const [metricsRetentionSummary, setMetricsRetentionSummary] = useState<RuntimeMetricsRetentionSummary | null>(null);
  const [frameworkFilter, setFrameworkFilter] = useState<'all' | ModelFramework>('all');
  const [templateFramework, setTemplateFramework] = useState<ModelFramework>('yolo');
  const [copyMessage, setCopyMessage] = useState('');

  const describeErrorKind = (kind: RuntimeConnectivityRecord['error_kind']) => {
    if (kind === 'timeout') {
      return t('Runtime responded too slowly. Check endpoint latency and timeout.');
    }
    if (kind === 'network') {
      return t('Network connection failed. Check host/port/DNS and service reachability.');
    }
    if (kind === 'http_status') {
      return t('Runtime returned non-200 status. Check endpoint path and auth.');
    }
    if (kind === 'invalid_payload') {
      return t('Runtime payload shape is incompatible. Check response JSON contract.');
    }
    if (kind === 'none') {
      return t('No connectivity error.');
    }
    return t('Unknown runtime error. Check runtime logs for details.');
  };

  const copyText = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage(t('{label} copied.', { label }));
    } catch (copyError) {
      setCopyMessage(t('Copy failed: {message}', { message: (copyError as Error).message }));
    }
  };

  const refresh = async (framework?: ModelFramework) => {
    setChecking(true);
    setError('');

    try {
      const result = await api.getRuntimeConnectivity(framework);
      if (framework) {
        setChecks((prev) => {
          const map = new Map(prev.map((item) => [item.framework, item]));
          result.forEach((item) => map.set(item.framework, item));
          return FRAMEWORKS.map((entry) => map.get(entry)).filter(
            (item): item is RuntimeConnectivityRecord => Boolean(item)
          );
        });
      } else {
        setChecks(result);
      }
    } catch (runtimeError) {
      setError((runtimeError as Error).message);
    } finally {
      setChecking(false);
      setLoading(false);
    }
  };

  const refreshExecutionSummary = async () => {
    setSummaryLoading(true);
    try {
      const [runs, jobs, retention] = await Promise.all([
        api.listInferenceRuns(),
        api.listTrainingJobs(),
        api.getRuntimeMetricsRetentionSummary()
      ]);
      const sourceCounter = new Map<string, number>();
      runs.forEach((run) => {
        const source =
          typeof run.execution_source === 'string' && run.execution_source.trim()
            ? run.execution_source
            : typeof run.normalized_output?.normalized_output?.source === 'string'
              ? run.normalized_output.normalized_output.source
              : 'unknown';
        sourceCounter.set(source, (sourceCounter.get(source) ?? 0) + 1);
      });

      const modeCounter = new Map<string, number>();
      jobs.forEach((job) => {
        const mode = job.execution_mode || 'unknown';
        modeCounter.set(mode, (modeCounter.get(mode) ?? 0) + 1);
      });

      setInferenceSourceSummary(
        Array.from(sourceCounter.entries())
          .sort((left, right) => right[1] - left[1])
          .map(([key, count]) => ({ key, count }))
      );
      setTrainingModeSummary(
        Array.from(modeCounter.entries())
          .sort((left, right) => right[1] - left[1])
          .map(([key, count]) => ({ key, count }))
      );
      const recentJobsByFramework = collectRecentMetricSummaryJobs(jobs);
      const metricDetailJobs = Array.from(recentJobsByFramework.values()).flat();
      const metricDetailResults = await Promise.allSettled(
        metricDetailJobs.map((job) => api.getTrainingJobDetail(job.id))
      );
      const artifactSummaryByJobId = new Map<string, TrainingArtifactSummary | null>();

      metricDetailResults.forEach((result, index) => {
        artifactSummaryByJobId.set(
          metricDetailJobs[index].id,
          result.status === 'fulfilled' ? result.value.artifact_summary : null
        );
      });

      setFrameworkMetricKeySummary(
        summarizeFrameworkMetricKeys(recentJobsByFramework, artifactSummaryByJobId)
      );
      setMetricsRetentionSummary(retention);
    } catch {
      setInferenceSourceSummary([]);
      setTrainingModeSummary([]);
      setFrameworkMetricKeySummary(buildEmptyFrameworkMetricKeySummary());
      setMetricsRetentionSummary(null);
    } finally {
      setSummaryLoading(false);
    }
  };

  const refreshTrainingWorkers = async () => {
    setWorkersLoading(true);
    setWorkersError('');
    setWorkersAccessDenied(false);
    try {
      const list = await api.listTrainingWorkers();
      setWorkers(list);
    } catch (workerError) {
      const message = (workerError as Error).message;
      if (/admin/i.test(message) || /permission/i.test(message)) {
        setWorkersAccessDenied(true);
        setWorkers([]);
      } else {
        setWorkersError(message);
      }
    } finally {
      setWorkersLoading(false);
    }
  };

  const refreshBootstrapSessions = async () => {
    setBootstrapSessionsLoading(true);
    setBootstrapSessionsError('');
    setBootstrapSessionsAccessDenied(false);
    try {
      const list = await api.listTrainingWorkerBootstrapSessions();
      setBootstrapSessions(list);
    } catch (bootstrapError) {
      const message = (bootstrapError as Error).message;
      if (/admin/i.test(message) || /permission/i.test(message)) {
        setBootstrapSessionsAccessDenied(true);
        setBootstrapSessions([]);
      } else {
        setBootstrapSessionsError(message);
      }
    } finally {
      setBootstrapSessionsLoading(false);
    }
  };

  const createBootstrapSession = async () => {
    setCreatingBootstrapSession(true);
    setBootstrapSessionsError('');
    try {
      const created = await api.createTrainingWorkerBootstrapSession({
        deployment_mode: workerOnboardingDraft.deployment_mode,
        worker_profile: workerOnboardingDraft.worker_profile,
        control_plane_base_url: workerOnboardingDraft.control_plane_base_url,
        worker_name: workerOnboardingDraft.worker_name || undefined,
        worker_public_host: workerOnboardingDraft.worker_public_host || undefined,
        worker_bind_port: Number.parseInt(workerOnboardingDraft.worker_bind_port, 10) || 9090,
        max_concurrency: Number.parseInt(workerOnboardingDraft.max_concurrency, 10) || 1
      });
      setBootstrapSessions((prev) => [created, ...prev.filter((item) => item.id !== created.id)]);
      setActiveBootstrapSessionId(created.id);
      setCopyMessage('');
    } catch (bootstrapError) {
      setBootstrapSessionsError((bootstrapError as Error).message);
    } finally {
      setCreatingBootstrapSession(false);
    }
  };

  const validateBootstrapSession = async (sessionId: string) => {
    setValidatingBootstrapSessionId(sessionId);
    setBootstrapSessionsError('');
    try {
      const updated = await api.validateTrainingWorkerBootstrapCallback(sessionId);
      setBootstrapSessions((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      await refreshTrainingWorkers();
    } catch (bootstrapError) {
      setBootstrapSessionsError((bootstrapError as Error).message);
    } finally {
      setValidatingBootstrapSessionId(null);
    }
  };

  const downloadBootstrapBundle = async (sessionId: string) => {
    setDownloadingBootstrapSessionId(sessionId);
    setBootstrapSessionsError('');
    try {
      const { blob, filename } = await api.downloadTrainingWorkerBootstrapBundle(sessionId);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (bootstrapError) {
      setBootstrapSessionsError((bootstrapError as Error).message);
    } finally {
      setDownloadingBootstrapSessionId(null);
    }
  };

  useEffect(() => {
    void refresh();
    void refreshExecutionSummary();
    void refreshTrainingWorkers();
    void refreshBootstrapSessions();
  }, []);

  const checkByFramework = useMemo(
    () => new Map(checks.map((item) => [item.framework, item])),
    [checks]
  );

  const selectedTemplateRuntime = checkByFramework.get(templateFramework);

  const predictEndpointForTemplate = selectedTemplateRuntime?.endpoint ?? 'http://127.0.0.1:9393/predict';

  const healthEndpointForTemplate = (() => {
    const normalized = predictEndpointForTemplate.replace(/\/+$/, '');
    if (normalized.endsWith('/predict')) {
      return `${normalized.slice(0, -'/predict'.length)}/health`;
    }

    return `${normalized}/health`;
  })();

  const visibleFrameworks = frameworkFilter === 'all' ? FRAMEWORKS : [frameworkFilter];
  const reachableCount = checks.filter((item) => item.source === 'reachable').length;
  const unreachableCount = checks.filter((item) => item.source === 'unreachable').length;
  const configuredCount = checks.filter((item) => item.source !== 'not_configured').length;
  const notConfiguredCount = Math.max(FRAMEWORKS.length - configuredCount, 0);
  const diagnosticsLayoutClassName = visibleFrameworks.length > 1 ? 'three-col' : 'stack';
  const hasCompletedTrainingJobs = frameworkMetricKeySummary.some((entry) => entry.jobsChecked > 0);
  const onlineWorkerCount = workers.filter((worker) => worker.enabled && worker.effective_status === 'online').length;
  const pendingBootstrapCount = bootstrapSessions.filter(
    (session) => session.status !== 'online' && session.status !== 'expired'
  ).length;
  const activeBootstrapSession =
    bootstrapSessions.find((session) => session.id === activeBootstrapSessionId) ?? null;
  const onboardingStep =
    activeBootstrapSession?.status === 'online' ? 2 : activeBootstrapSession ? 1 : 0;
  const formatPercent = (value: number | null | undefined) => {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return t('n/a');
    }
    return `${Math.round(value * 100)}%`;
  };

  const formatTimestamp = (value: string | null) => {
    if (!value) {
      return t('n/a');
    }

    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      return value;
    }

    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(parsed));
  };

  const heroSection = (
    <WorkspaceHero
      eyebrow={t('Runtime Control Plane')}
      title={t('Runtime Settings')}
      description={t('Keep framework diagnostics, execution summaries, and integration templates in one operational lane.')}
      actions={
        <div className="row gap wrap align-center">
          <StatusTag status={checking ? 'running' : 'ready'}>
            {checking ? t('Checking...') : t('Ready')}
          </StatusTag>
          <Button type="button" variant="secondary" onClick={() => setWorkerOnboardingOpen(true)}>
            {t('Add Worker')}
          </Button>
        </div>
      }
      stats={[
        {
          label: t('Reachable frameworks'),
          value: reachableCount
        },
        {
          label: t('Unreachable frameworks'),
          value: unreachableCount
        },
        {
          label: t('Not Configured'),
          value: notConfiguredCount
        },
        {
          label: t('Template focus'),
          value: t(templateFramework)
        },
        {
          label: t('Online workers'),
          value: workersLoading ? t('...') : onlineWorkerCount
        },
        {
          label: t('Pending pairing'),
          value: bootstrapSessionsLoading ? t('...') : pendingBootstrapCount
        }
      ]}
    />
  );

  if (loading) {
    return (
      <WorkspacePage>
        <SettingsTabs />
        {heroSection}
        <StateBlock variant="loading" title={t('Loading Runtime Status')} description={t('Checking framework endpoints.')} />
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage>
      <SettingsTabs />
      {heroSection}

      {error ? <StateBlock variant="error" title={t('Runtime Check Failed')} description={error} /> : null}

      <WorkspaceMetricGrid
        items={[
          {
            title: t('Reachable frameworks'),
            description: t('Frameworks that currently answer health and predict probes.'),
            value: reachableCount
          },
          {
            title: t('Unreachable frameworks'),
            description: t('Frameworks that failed connectivity validation and need follow-up.'),
            value: unreachableCount,
            tone: unreachableCount > 0 ? 'attention' : 'default'
          },
          {
            title: t('Not Configured'),
            description: t('Frameworks still missing endpoint configuration.'),
            value: notConfiguredCount
          },
          {
            title: t('Training metric retention'),
            description: t('Metric retention visibility for recent training telemetry.'),
            value: summaryLoading ? t('Loading') : metricsRetentionSummary ? metricsRetentionSummary.current_total_rows : t('N/A')
          }
        ]}
      />

      <WorkspaceSplit
        main={
          <div>
          <Card as="article">
            <div className="workspace-section-header">
              <div className="stack tight">
                <h3>{t('Framework diagnostics')}</h3>
                <small className="muted">
                  {t('Review live runtime bridge state for each framework and keep configuration gaps obvious.')}
                </small>
              </div>
            </div>

            <div className={diagnosticsLayoutClassName}>
              {visibleFrameworks.map((framework) => {
                const item = checkByFramework.get(framework);
                const source = item?.source ?? 'not_configured';
                const statusText =
                  source === 'reachable'
                    ? t('reachable')
                    : source === 'unreachable'
                      ? t('unreachable')
                      : t('not configured');
                const tone = source === 'reachable' ? 'ready' : source === 'unreachable' ? 'error' : 'draft';

                return (
                  <Panel key={framework} as="article" className="workspace-record-item" tone="soft">
                    <div className="row between gap wrap">
                      <strong>{t(framework)}</strong>
                      <StatusTag status={tone === 'ready' ? 'ready' : tone === 'error' ? 'failed' : 'draft'}>
                        {statusText}
                      </StatusTag>
                    </div>
                    <small className="muted">
                      {t('env')}: {endpointEnvByFramework[framework].endpoint} (+ {endpointEnvByFramework[framework].apiKey}{' '}
                      {t('optional')})
                    </small>
                    <small className="muted">{t('endpoint')}: {item?.endpoint ?? t('not set')}</small>
                    <small className="muted">{t('error kind')}: {item?.error_kind ? t(item.error_kind) : t('none')}</small>
                    <small className="muted">{t('checked at')}: {item?.checked_at ?? t('n/a')}</small>
                    {source === 'reachable' ? (
                      <StateBlock
                        variant="success"
                        title={t('Runtime Ready')}
                        description={item?.message ?? t('Runtime endpoint responded with compatible payload.')}
                      />
                    ) : source === 'unreachable' ? (
                      <StateBlock
                        variant="error"
                        title={t('Runtime Unreachable')}
                        description={`${item?.message ?? t('Runtime endpoint call failed.')} ${describeErrorKind(
                          item?.error_kind ?? 'unknown'
                        )}`}
                      />
                    ) : (
                      <StateBlock
                        variant="empty"
                        title={t('Not Configured')}
                        description={t('Set endpoint env vars to enable runtime bridge for this framework.')}
                      />
                    )}
                  </Panel>
                );
              })}
            </div>
          </Card>

          <AdvancedSection
            title={t('Runtime Integration Templates')}
            description={t('Executable snippets for framework runtime adapters. Use this to align payload contracts quickly.')}
          >
            {copyMessage ? <StateBlock variant="success" title={t('Clipboard')} description={copyMessage} /> : null}

            <label>
              {t('Template Framework')}
              <Select
                value={templateFramework}
                onChange={(event) => setTemplateFramework(event.target.value as ModelFramework)}
              >
                <option value="paddleocr">{t('paddleocr')}</option>
                <option value="doctr">{t('doctr')}</option>
                <option value="yolo">{t('yolo')}</option>
              </Select>
            </label>

            <Card as="section">
              <div className="row between gap wrap align-center">
                <h3>{t('Environment Variables')}</h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    copyText(
                      t('Environment snippet'),
                      `${endpointEnvByFramework[templateFramework].endpoint}=${predictEndpointForTemplate}\n${endpointEnvByFramework[templateFramework].apiKey}=<optional-bearer-key>`
                    )
                  }
                >
                  {t('Copy')}
                </Button>
              </div>
              <pre className="code-block">{`${endpointEnvByFramework[templateFramework].endpoint}=${predictEndpointForTemplate}\n${endpointEnvByFramework[templateFramework].apiKey}=<optional-bearer-key>`}</pre>
            </Card>

            <Card as="section">
              <div className="row between gap wrap align-center">
                <h3>{t('Health Check Curl')}</h3>
                <Button type="button" variant="ghost" size="sm" onClick={() => copyText(t('Health curl'), `curl -sS ${healthEndpointForTemplate}`)}>
                  {t('Copy')}
                </Button>
              </div>
              <pre className="code-block">{`curl -sS ${healthEndpointForTemplate}`}</pre>
            </Card>

            <Card as="section">
              <div className="row between gap wrap align-center">
                <h3>{t('Predict Request Payload (from Vistral)')}</h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    copyText(
                      t('Predict request payload'),
                      JSON.stringify(sampleInputByFramework[templateFramework], null, 2)
                    )
                  }
                >
                  {t('Copy')}
                </Button>
              </div>
              <pre className="code-block">{JSON.stringify(sampleInputByFramework[templateFramework], null, 2)}</pre>
            </Card>

            <Card as="section">
              <div className="row between gap wrap align-center">
                <h3>{t('Predict Response Payload (expected minimal shape)')}</h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    copyText(
                      t('Predict response payload'),
                      JSON.stringify(sampleOutputByFramework[templateFramework], null, 2)
                    )
                  }
                >
                  {t('Copy')}
                </Button>
              </div>
              <pre className="code-block">{JSON.stringify(sampleOutputByFramework[templateFramework], null, 2)}</pre>
            </Card>
          </AdvancedSection>
          </div>
        }
        side={
          <div>
          <Card as="article">
            <div className="workspace-section-header">
              <div className="stack tight">
                <h3>{t('Runtime controls')}</h3>
                <small className="muted">
                  {t('Filter the diagnostics surface and rerun selected checks without leaving the page.')}
                </small>
              </div>
              <Badge tone="neutral">{frameworkFilter === 'all' ? t('all') : t(frameworkFilter)}</Badge>
            </div>

            <label>
              {t('Framework')}
              <Select
                value={frameworkFilter}
                onChange={(event) => setFrameworkFilter(event.target.value as 'all' | ModelFramework)}
              >
                <option value="all">{t('all')}</option>
                <option value="paddleocr">{t('paddleocr')}</option>
                <option value="doctr">{t('doctr')}</option>
                <option value="yolo">{t('yolo')}</option>
              </Select>
            </label>

            <div className="workspace-button-stack">
              <Button type="button" onClick={() => void refresh()} disabled={checking}>
                {checking && frameworkFilter === 'all' ? t('Checking...') : t('Refresh All')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void refresh(frameworkFilter === 'all' ? undefined : frameworkFilter)}
                disabled={checking || frameworkFilter === 'all'}
              >
                {checking && frameworkFilter !== 'all' ? t('Checking...') : t('Check Selected')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => void refreshExecutionSummary()}
                disabled={summaryLoading}
              >
                {summaryLoading ? t('Refreshing...') : t('Refresh Summary')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => void refreshTrainingWorkers()}
                disabled={workersLoading}
              >
                {workersLoading ? t('Refreshing workers...') : t('Refresh Workers')}
              </Button>
            </div>
          </Card>

          <Card as="article">
            <div className="workspace-section-header">
              <div className="stack tight">
                <h3>{t('Worker onboarding')}</h3>
                <small className="muted">
                  {t('Generate one-time pairing commands, then finish worker setup from the local /setup page.')}
                </small>
              </div>
              <Badge tone="info">{t('Pending')}: {pendingBootstrapCount}</Badge>
            </div>
            <div className="workspace-button-stack">
              <Button
                type="button"
                onClick={() => {
                  setWorkerOnboardingOpen(true);
                  if (!activeBootstrapSessionId) {
                    setActiveBootstrapSessionId(null);
                  }
                }}
              >
                {t('Add Worker')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => void refreshBootstrapSessions()}
                disabled={bootstrapSessionsLoading}
              >
                {bootstrapSessionsLoading ? t('Refreshing pairing...') : t('Refresh Pairing')}
              </Button>
            </div>
            {bootstrapSessionsLoading ? (
              <StateBlock
                variant="loading"
                title={t('Loading pairing sessions')}
                description={t('Collecting recent worker bootstrap commands and states.')}
              />
            ) : bootstrapSessionsAccessDenied ? (
              <StateBlock
                variant="empty"
                title={t('Admin only')}
                description={t('Worker onboarding sessions are visible to administrators only.')}
              />
            ) : bootstrapSessionsError ? (
              <StateBlock
                variant="error"
                title={t('Pairing unavailable')}
                description={bootstrapSessionsError}
              />
            ) : bootstrapSessions.length === 0 ? (
              <StateBlock
                variant="empty"
                title={t('No pairing sessions')}
                description={t('Create an Add Worker session to generate a startup command and pairing token.')}
              />
            ) : (
              <ul className="workspace-record-list compact">
                {bootstrapSessions.slice(0, 5).map((session) => (
                  <Panel key={session.id} as="li" className="workspace-record-item compact" tone="soft">
                    <div className="row between gap wrap align-center">
                      <strong>{session.worker_name}</strong>
                      <StatusTag status={workerBootstrapStatusTone(session.status)}>
                        {t(session.status)}
                      </StatusTag>
                    </div>
                    <div className="row gap wrap">
                      <Badge tone="neutral">{t(session.worker_profile)}</Badge>
                      <Badge tone="neutral">{t(session.deployment_mode)}</Badge>
                      <Badge tone="info">{t('token')}: {session.token_preview}</Badge>
                    </div>
                    <small className="muted">
                      {t('worker id')}: {session.worker_id}
                    </small>
                    <small className="muted">
                      {t('setup url')}: {session.setup_url_hint}
                    </small>
                    <small className="muted">
                      {t('endpoint hint')}: {session.worker_endpoint_hint ?? t('to be confirmed in /setup')}
                    </small>
                    <small className="muted">
                      {t('expires')}: {formatTimestamp(session.expires_at)}
                    </small>
                    {session.callback_validation_message ? (
                      <small className="muted">{session.callback_validation_message}</small>
                    ) : null}
                    <div className="row gap wrap">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setActiveBootstrapSessionId(session.id);
                          setWorkerOnboardingOpen(true);
                        }}
                      >
                        {t('Open')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void copyText(t('Docker command'), session.docker_command)}
                      >
                        {t('Copy Docker')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void downloadBootstrapBundle(session.id)}
                        disabled={downloadingBootstrapSessionId === session.id}
                      >
                        {downloadingBootstrapSessionId === session.id ? t('Downloading...') : t('Download Bundle')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void validateBootstrapSession(session.id)}
                        disabled={validatingBootstrapSessionId === session.id}
                      >
                        {validatingBootstrapSessionId === session.id ? t('Validating...') : t('Retry callback')}
                      </Button>
                    </div>
                  </Panel>
                ))}
              </ul>
            )}
          </Card>

          <Card as="article">
            <div className="workspace-section-header">
              <div className="stack tight">
                <h3>{t('Worker scheduler observability')}</h3>
                <small className="muted">
                  {t('Inspect worker score composition and recent dispatch health before launching new jobs.')}
                </small>
              </div>
              <Badge tone="neutral">{t('Workers')}: {workers.length}</Badge>
            </div>
            {workersLoading ? (
              <StateBlock
                variant="loading"
                title={t('Loading Workers')}
                description={t('Collecting training worker score and health signals.')}
              />
            ) : workersAccessDenied ? (
              <StateBlock
                variant="empty"
                title={t('Admin only')}
                description={t('Worker scheduler observability is visible to administrators only.')}
              />
            ) : workersError ? (
              <StateBlock variant="error" title={t('Worker list unavailable')} description={workersError} />
            ) : workers.length === 0 ? (
              <StateBlock
                variant="empty"
                title={t('No workers')}
                description={t('No training workers are currently registered in the control plane.')}
              />
            ) : (
              <ul className="workspace-record-list compact">
                {workers.map((worker) => (
                  <Panel key={worker.id} as="li" className="workspace-record-item compact" tone="soft">
                    <div className="row between gap wrap align-center">
                      <strong>{worker.name}</strong>
                      <StatusTag
                        status={
                          worker.effective_status === 'online'
                            ? 'ready'
                            : worker.effective_status === 'draining'
                              ? 'running'
                              : 'failed'
                        }
                      >
                        {t(worker.effective_status)}
                      </StatusTag>
                    </div>
                    <div className="row gap wrap">
                      <Badge tone="neutral">{t('score')}: {worker.scheduler_score.toFixed(3)}</Badge>
                      <Badge tone="neutral">{t('load')}: {formatPercent(worker.last_reported_load)}</Badge>
                      <Badge tone="warning">{t('penalty')}: {worker.scheduler_health_penalty.toFixed(3)}</Badge>
                      <Badge tone="info">{t('bonus')}: {worker.scheduler_capability_bonus.toFixed(3)}</Badge>
                    </div>
                    <div className="row gap wrap">
                      <Badge tone="neutral">
                        {t('in-flight')}: {worker.in_flight_jobs}/{worker.max_concurrency}
                      </Badge>
                      <Badge tone={worker.dispatch_recent_failures > 0 ? 'warning' : 'success'}>
                        {t('recent failures')}: {worker.dispatch_recent_failures}
                      </Badge>
                      <Badge tone={worker.dispatch_cooldown_active ? 'warning' : 'neutral'}>
                        {worker.dispatch_cooldown_active ? t('cooldown active') : t('cooldown idle')}
                      </Badge>
                    </div>
                    <small className="muted">
                      {t('last failure')}: {formatTimestamp(worker.dispatch_last_failure_at)} · {t('last success')}:{' '}
                      {formatTimestamp(worker.dispatch_last_success_at)}
                    </small>
                    <small className="muted">
                      {t('endpoint')}: {worker.endpoint ?? t('not set')}
                    </small>
                    <small className="muted">
                      {t('scheduler note')}: load={worker.scheduler_load_component.toFixed(3)}, penalty=
                      {worker.scheduler_health_penalty.toFixed(3)}, bonus=
                      {worker.scheduler_capability_bonus.toFixed(3)}
                    </small>
                  </Panel>
                ))}
              </ul>
            )}
          </Card>

          <Card as="article">
            <div className="workspace-section-header">
              <div className="stack tight">
                <h3>{t('Execution watch')}</h3>
                <small className="muted">{t('Recent inference and training execution signals stay visible here.')}</small>
              </div>
            </div>
            {summaryLoading ? (
              <StateBlock
                variant="loading"
                title={t('Loading Summary')}
                description={t('Collecting recent training and inference execution sources.')}
              />
            ) : (
              <ul className="workspace-record-list compact">
                <Panel as="li" className="workspace-record-item compact" tone="soft">
                  <div className="stack tight">
                    <strong>{t('Inference source distribution')}</strong>
                    {inferenceSourceSummary.length === 0 ? (
                      <small className="muted">{t('No inference runs yet.')}</small>
                    ) : (
                      <div className="row gap wrap">
                        {inferenceSourceSummary.map((entry) => (
                          <Badge key={entry.key} tone="neutral">
                            {entry.key}: {entry.count}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </Panel>

                <Panel as="li" className="workspace-record-item compact" tone="soft">
                  <div className="stack tight">
                    <strong>{t('Training execution mode distribution')}</strong>
                    {trainingModeSummary.length === 0 ? (
                      <small className="muted">{t('No training jobs yet.')}</small>
                    ) : (
                      <div className="row gap wrap">
                        {trainingModeSummary.map((entry) => (
                          <Badge key={entry.key} tone="info">
                            {entry.key}: {entry.count}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </Panel>

                <Panel as="li" className="workspace-record-item compact" tone="soft">
                  <div className="stack tight">
                    <strong>{t('Latest framework metric keys')}</strong>
                    {!hasCompletedTrainingJobs ? (
                      <small className="muted">{t('No completed training jobs yet.')}</small>
                    ) : (
                      <div className="stack">
                        {frameworkMetricKeySummary.map((entry) => (
                          <div key={entry.framework} className="stack tight">
                            <div className="row gap wrap align-center">
                              <Badge tone="info">{t(entry.framework)}</Badge>
                              <small className="muted">
                                {entry.jobsChecked > 0
                                  ? t('Checked {count} recent completed jobs.', { count: entry.jobsChecked })
                                  : t('No completed jobs yet for this framework.')}
                              </small>
                              {entry.jobsWithMetrics > 0 ? (
                                <Badge tone="success">
                                  {t('Metrics found')}: {entry.jobsWithMetrics}
                                </Badge>
                              ) : null}
                            </div>
                            {entry.metricKeys.length > 0 ? (
                              <>
                                <div className="row gap wrap">
                                  {entry.metricKeys.map((metricKey) => (
                                    <Badge key={`${entry.framework}-${metricKey}`} tone="neutral">
                                      {metricKey}
                                    </Badge>
                                  ))}
                                </div>
                                <small className="muted">
                                  {t('Latest artifact: {job} · {time}', {
                                    job: entry.latestJobLabel ?? t('n/a'),
                                    time: formatTimestamp(entry.latestGeneratedAt)
                                  })}
                                </small>
                              </>
                            ) : entry.jobsChecked > 0 ? (
                              <small className="muted">
                                {t('No artifact metrics captured in the latest completed jobs yet.')}
                              </small>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </Panel>

                <Panel as="li" className="workspace-record-item compact" tone="soft">
                  <div className="stack tight">
                    <strong>{t('Training metric retention')}</strong>
                    {!metricsRetentionSummary ? (
                      <small className="muted">{t('Retention summary unavailable.')}</small>
                    ) : (
                      <>
                        <div className="row gap wrap">
                          <Badge tone="neutral">
                            {t('Current rows')}: {metricsRetentionSummary.current_total_rows}
                          </Badge>
                          <Badge tone="neutral">
                            {t('Total cap')}: {metricsRetentionSummary.max_total_rows}
                          </Badge>
                          <Badge tone="neutral">
                            {t('Per-job cap')}: {metricsRetentionSummary.max_points_per_job}
                          </Badge>
                          <Badge tone="neutral">
                            {t('Jobs with metrics')}: {metricsRetentionSummary.jobs_with_metrics}
                          </Badge>
                          <Badge tone="info">
                            {t('Visible jobs')}: {metricsRetentionSummary.visible_job_count}
                          </Badge>
                          <Badge tone="warning">
                            {t('Max rows (single job)')}: {metricsRetentionSummary.max_rows_single_job}
                          </Badge>
                        </div>
                        <small className="muted">
                          {metricsRetentionSummary.near_total_cap
                            ? t('Retention usage is close to cap. Consider lowering metric density or increasing cap.')
                            : t('Retention usage is within normal range.')}
                        </small>
                        {metricsRetentionSummary.top_jobs.length > 0 ? (
                          <div className="row gap wrap">
                            {metricsRetentionSummary.top_jobs.map((item) => (
                              <Badge key={item.training_job_id} tone="info">
                                {item.training_job_id}: {item.rows}
                              </Badge>
                            ))}
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                </Panel>
              </ul>
            )}
          </Card>
          </div>
        }
      />

      <Drawer
        open={workerOnboardingOpen}
        onClose={() => setWorkerOnboardingOpen(false)}
        side="right"
        className="runtime-worker-drawer"
        title={t('Add Worker')}
      >
        <div className="stack">
          <div className="workspace-section-header">
            <div className="stack tight">
              <h3>{t('Add Worker')}</h3>
              <small className="muted">
                {t('Generate a startup command, launch the worker, then finish pairing in the worker-local setup UI.')}
              </small>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setWorkerOnboardingOpen(false)}>
              {t('Close')}
            </Button>
          </div>

          <ProgressStepper
            steps={[t('Configure'), t('Start Worker'), t('Finish Pairing')]}
            current={onboardingStep}
            title={t('Worker onboarding')}
            caption={t('Admin runtime flow')}
          />

          {copyMessage ? <StateBlock variant="success" title={t('Clipboard')} description={copyMessage} /> : null}
          {bootstrapSessionsError && !activeBootstrapSession ? (
            <StateBlock variant="error" title={t('Pairing unavailable')} description={bootstrapSessionsError} />
          ) : null}

          <Card as="section">
            <div className="workspace-section-header">
              <div className="stack tight">
                <h3>{t('Bootstrap draft')}</h3>
                <small className="muted">
                  {t('Docker-first by default. These fields define the pairing token and startup template.')}
                </small>
              </div>
              <Badge tone="neutral">{t(workerOnboardingDraft.deployment_mode)}</Badge>
            </div>

            <label>
              {t('Deployment mode')}
              <Select
                value={workerOnboardingDraft.deployment_mode}
                onChange={(event) =>
                  setWorkerOnboardingDraft((prev) => ({
                    ...prev,
                    deployment_mode: event.target.value as TrainingWorkerDeploymentMode
                  }))
                }
              >
                <option value="docker">{t('Docker')}</option>
                <option value="script">{t('Linux Script')}</option>
              </Select>
            </label>

            <label>
              {t('Worker profile')}
              <Select
                value={workerOnboardingDraft.worker_profile}
                onChange={(event) =>
                  setWorkerOnboardingDraft((prev) => ({
                    ...prev,
                    worker_profile: event.target.value as TrainingWorkerProfile
                  }))
                }
              >
                <option value="yolo">{t('YOLO / detection')}</option>
                <option value="paddleocr">{t('PaddleOCR / OCR')}</option>
                <option value="doctr">{t('docTR / OCR')}</option>
                <option value="mixed">{t('Mixed')}</option>
              </Select>
            </label>

            <label>
              {t('Control plane URL')}
              <Input
                value={workerOnboardingDraft.control_plane_base_url}
                onChange={(event) =>
                  setWorkerOnboardingDraft((prev) => ({
                    ...prev,
                    control_plane_base_url: event.target.value
                  }))
                }
                placeholder="http://10.0.0.10:8080"
              />
            </label>

            <label>
              {t('Worker name')}
              <Input
                value={workerOnboardingDraft.worker_name}
                onChange={(event) =>
                  setWorkerOnboardingDraft((prev) => ({
                    ...prev,
                    worker_name: event.target.value
                  }))
                }
                placeholder="yolo-worker-b"
              />
            </label>

            <label>
              {t('Worker public host / IP')}
              <Input
                value={workerOnboardingDraft.worker_public_host}
                onChange={(event) =>
                  setWorkerOnboardingDraft((prev) => ({
                    ...prev,
                    worker_public_host: event.target.value
                  }))
                }
                placeholder="10.0.0.22 or gpu-b.internal"
              />
            </label>

            <label>
              {t('Worker bind port')}
              <Input
                type="number"
                min={1}
                max={65535}
                step={1}
                value={workerOnboardingDraft.worker_bind_port}
                onChange={(event) =>
                  setWorkerOnboardingDraft((prev) => ({
                    ...prev,
                    worker_bind_port: event.target.value
                  }))
                }
              />
            </label>

            <label>
              {t('Max concurrency')}
              <Input
                type="number"
                min={1}
                step={1}
                value={workerOnboardingDraft.max_concurrency}
                onChange={(event) =>
                  setWorkerOnboardingDraft((prev) => ({
                    ...prev,
                    max_concurrency: event.target.value
                  }))
                }
              />
            </label>

            <div className="workspace-button-stack">
              <Button type="button" onClick={() => void createBootstrapSession()} disabled={creatingBootstrapSession}>
                {creatingBootstrapSession ? t('Generating...') : t('Generate Pairing Command')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setWorkerOnboardingDraft(buildDefaultWorkerOnboardingDraft());
                  setActiveBootstrapSessionId(null);
                }}
              >
                {t('Reset Draft')}
              </Button>
            </div>
          </Card>

          {activeBootstrapSession ? (
            <>
              <Card as="section">
                <div className="workspace-section-header">
                  <div className="stack tight">
                    <h3>{t('Current pairing session')}</h3>
                    <small className="muted">
                      {t('Keep this token/command nearby while the worker operator starts the node.')}
                    </small>
                  </div>
                  <StatusTag status={workerBootstrapStatusTone(activeBootstrapSession.status)}>
                    {t(activeBootstrapSession.status)}
                  </StatusTag>
                </div>
                <div className="row gap wrap">
                  <Badge tone="neutral">{t(activeBootstrapSession.worker_profile)}</Badge>
                  <Badge tone="neutral">{t(activeBootstrapSession.deployment_mode)}</Badge>
                  <Badge tone="info">{t('worker id')}: {activeBootstrapSession.worker_id}</Badge>
                  <Badge tone="neutral">{t('bind port')}: {activeBootstrapSession.worker_bind_port}</Badge>
                  {activeBootstrapSession.worker_public_host ? (
                    <Badge tone="info">{t('host')}: {activeBootstrapSession.worker_public_host}</Badge>
                  ) : null}
                </div>
                <small className="muted">
                  {t('pairing token')}: {activeBootstrapSession.pairing_token}
                </small>
                <small className="muted">
                  {t('setup url')}: {activeBootstrapSession.setup_url_hint}
                </small>
                <small className="muted">
                  {t('endpoint hint')}: {activeBootstrapSession.worker_endpoint_hint ?? t('to be confirmed in /setup')}
                </small>
                <div className="row gap wrap">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void copyText(t('Pairing token'), activeBootstrapSession.pairing_token)}
                  >
                    {t('Copy Token')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void refreshBootstrapSessions()}
                    disabled={bootstrapSessionsLoading}
                  >
                    {bootstrapSessionsLoading ? t('Refreshing...') : t('Refresh Status')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void downloadBootstrapBundle(activeBootstrapSession.id)}
                    disabled={downloadingBootstrapSessionId === activeBootstrapSession.id}
                  >
                    {downloadingBootstrapSessionId === activeBootstrapSession.id
                      ? t('Downloading...')
                      : t('Download Bundle')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void validateBootstrapSession(activeBootstrapSession.id)}
                    disabled={validatingBootstrapSessionId === activeBootstrapSession.id}
                  >
                    {validatingBootstrapSessionId === activeBootstrapSession.id
                      ? t('Validating...')
                      : t('Retry callback')}
                  </Button>
                </div>
                {activeBootstrapSession.callback_validation_message ? (
                  <small className="muted">{activeBootstrapSession.callback_validation_message}</small>
                ) : null}
              </Card>

              <Card as="section">
                <div className="workspace-section-header">
                  <div className="stack tight">
                    <h3>{t('Docker startup command')}</h3>
                    <small className="muted">
                      {t('Recommended path for remote worker nodes. Starts the worker directly in setup mode.')}
                    </small>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void copyText(t('Docker command'), activeBootstrapSession.docker_command)}
                  >
                    {t('Copy')}
                  </Button>
                </div>
                <pre className="code-block">{activeBootstrapSession.docker_command}</pre>
              </Card>

              <Card as="section">
                <div className="workspace-section-header">
                  <div className="stack tight">
                    <h3>{t('Script fallback')}</h3>
                    <small className="muted">
                      {t('Use this when the operator already has the repository and wants a shell-only path.')}
                    </small>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void copyText(t('Script command'), activeBootstrapSession.script_command)}
                  >
                    {t('Copy')}
                  </Button>
                </div>
                <pre className="code-block">{activeBootstrapSession.script_command}</pre>
              </Card>

              <Card as="section">
                <div className="workspace-section-header">
                  <div className="stack tight">
                    <h3>{t('Worker-local finish')}</h3>
                    <small className="muted">
                      {t('After startup, the operator opens the local setup page, claims the pairing token, validates, and saves.')}
                    </small>
                  </div>
                </div>
                <div className="stack tight">
                  <small className="muted">
                    {t('1. Open {url}', { url: activeBootstrapSession.setup_url_hint })}
                  </small>
                  <small className="muted">
                    {t('2. Click the pairing action or paste the pairing token if the worker was started manually')}
                  </small>
                  <small className="muted">
                    {t('3. Confirm endpoint / concurrency / capabilities, then run Validate and Save')}
                  </small>
                </div>
                {activeBootstrapSession.status === 'online' ? (
                  <StateBlock
                    variant="success"
                    title={t('Worker online')}
                    description={t('Heartbeat has been accepted by the control plane and the worker can now join scheduling.')}
                  />
                ) : activeBootstrapSession.status === 'validation_failed' ? (
                  <StateBlock
                    variant="error"
                    title={t('Callback validation failed')}
                    description={
                      activeBootstrapSession.callback_validation_message ??
                      t('The control plane could not reach the worker endpoint yet. Retry after checking worker URL / port.')
                    }
                  />
                ) : (
                  <StateBlock
                    variant="loading"
                    title={t('Waiting for worker pairing')}
                    description={
                      activeBootstrapSession.callback_validation_message ??
                      t('The control plane is waiting for the worker-local setup flow to claim and validate this session.')
                    }
                  />
                )}
              </Card>
            </>
          ) : (
            <StateBlock
              variant="empty"
              title={t('Create a pairing session')}
              description={t('Generate one session first, then this drawer will show the exact startup command and pairing token.')}
            />
          )}
        </div>
      </Drawer>
    </WorkspacePage>
  );
}
