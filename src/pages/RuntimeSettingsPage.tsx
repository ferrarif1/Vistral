import { useEffect, useMemo, useState } from 'react';
import type {
  CreateTrainingWorkerInput,
  ModelFramework,
  RuntimeConnectivityRecord,
  RuntimeFrameworkConfigView,
  RuntimeMetricsRetentionSummary,
  RuntimeSettingsView,
  TrainingArtifactSummary,
  TrainingJobRecord,
  TrainingWorkerBootstrapSessionRecord,
  TrainingWorkerDeploymentMode,
  TrainingWorkerProfile,
  TrainingWorkerStatus,
  TrainingWorkerNodeView
} from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import StateBlock from '../components/StateBlock';
import SettingsTabs from '../components/settings/SettingsTabs';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Input, Select, Textarea } from '../components/ui/Field';
import { Drawer } from '../components/ui/Overlay';
import ProgressStepper from '../components/ui/ProgressStepper';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';

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

type WorkerRegistryDraft = {
  name: string;
  endpoint: string;
  status: TrainingWorkerStatus;
  enabled: boolean;
  max_concurrency: string;
  capabilities_text: string;
  metadata_text: string;
};

type RuntimeFrameworkDraft = {
  endpoint: string;
  api_key: string;
  local_train_command: string;
  local_predict_command: string;
  has_api_key: boolean;
  api_key_masked: string;
};

type RuntimeFrameworkDraftMap = Record<ModelFramework, RuntimeFrameworkDraft>;

type RuntimeControlDraft = {
  python_bin: string;
  disable_simulated_train_fallback: boolean;
  disable_inference_fallback: boolean;
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

const buildDefaultRuntimeFrameworkDraft = (): RuntimeFrameworkDraft => ({
  endpoint: '',
  api_key: '',
  local_train_command: '',
  local_predict_command: '',
  has_api_key: false,
  api_key_masked: ''
});

const buildDefaultRuntimeFrameworkDraftMap = (): RuntimeFrameworkDraftMap => ({
  paddleocr: buildDefaultRuntimeFrameworkDraft(),
  doctr: buildDefaultRuntimeFrameworkDraft(),
  yolo: buildDefaultRuntimeFrameworkDraft()
});

const buildDefaultRuntimeControlDraft = (): RuntimeControlDraft => ({
  python_bin: '',
  disable_simulated_train_fallback: false,
  disable_inference_fallback: false
});

const mergeRuntimeFrameworkDraft = (
  view: RuntimeFrameworkConfigView
): RuntimeFrameworkDraft => ({
  endpoint: view.endpoint,
  api_key: '',
  local_train_command: view.local_train_command,
  local_predict_command: view.local_predict_command,
  has_api_key: view.has_api_key,
  api_key_masked: view.api_key_masked
});

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
      { text: 'TEMPLATE_OCR_LINE_1', confidence: 0.95 },
      { text: 'TEMPLATE_OCR_LINE_2', confidence: 0.92 }
    ],
    words: [
      { text: 'TEMPLATE', confidence: 0.96 },
      { text: 'OCR', confidence: 0.93 }
    ]
  },
  doctr: {
    image: { filename: 'invoice-sample.jpg', width: 1280, height: 720 },
    ocr: {
      lines: [{ text: 'TEMPLATE_OCR_LINE_1', confidence: 0.94 }],
      words: [{ text: 'TEMPLATE', confidence: 0.91 }]
    }
  },
  yolo: {
    image: { filename: 'defect-sample.jpg', width: 1280, height: 720 },
    boxes: [
      { x: 180, y: 210, width: 170, height: 110, label: 'TEMPLATE_DETECTION_OBJECT', score: 0.91 },
      { x: 540, y: 360, width: 200, height: 120, label: 'TEMPLATE_DETECTION_OBJECT', score: 0.87 }
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
        latestJobLabel = job.name.trim() || null;
      }
      if (!latestGeneratedAt) {
        latestGeneratedAt = artifactSummary?.generated_at ?? job.updated_at;
      }
    });

    if (!latestJobLabel && frameworkJobs[0]?.name.trim()) {
      latestJobLabel = frameworkJobs[0].name.trim();
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

const normalizeCapabilityTokens = (raw: string): string[] =>
  raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

const normalizeMetadataInput = (raw: string): Record<string, string> =>
  raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((result, line) => {
      const separatorIndex = line.indexOf('=');
      if (separatorIndex < 0) {
        result[line] = '';
        return result;
      }

      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      if (key) {
        result[key] = value;
      }
      return result;
    }, {});

const serializeCapabilities = (capabilities: string[]) => capabilities.join(', ');

const serializeMetadata = (metadata: Record<string, string>) =>
  Object.entries(metadata)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

const buildDefaultWorkerRegistryDraft = (): WorkerRegistryDraft => ({
  name: '',
  endpoint: '',
  status: 'online',
  enabled: true,
  max_concurrency: '1',
  capabilities_text: 'framework:yolo, task:detection',
  metadata_text: ''
});

const buildWorkerRegistryDraftFromWorker = (worker: TrainingWorkerNodeView): WorkerRegistryDraft => ({
  name: worker.name,
  endpoint: worker.endpoint ?? '',
  status: worker.status,
  enabled: worker.enabled,
  max_concurrency: String(worker.max_concurrency),
  capabilities_text: serializeCapabilities(worker.capabilities),
  metadata_text: serializeMetadata(worker.metadata)
});

const formatWorkerUrlHost = (value: string): string =>
  value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;

const buildWorkerEndpointHint = (
  workerPublicHost: string | null,
  workerBindPort: number
): string | null =>
  workerPublicHost ? `http://${formatWorkerUrlHost(workerPublicHost)}:${workerBindPort}` : null;

const buildWorkerSetupUrlHint = (workerPublicHost: string | null, workerBindPort: number): string => {
  const endpoint = buildWorkerEndpointHint(workerPublicHost, workerBindPort);
  return endpoint ? `${endpoint}/setup` : `http://<worker-host>:${workerBindPort}/setup`;
};

const isConcreteWorkerUrl = (value: string | null | undefined): value is string =>
  Boolean(value && value.trim() && !value.includes('<worker-host>'));

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

const resolveSessionCompatibility = (
  session: TrainingWorkerBootstrapSessionRecord
): NonNullable<TrainingWorkerBootstrapSessionRecord['compatibility']> =>
  session.compatibility ?? {
    status: 'unknown',
    message: 'Compatibility check has not run yet.',
    expected_runtime_profile: session.worker_runtime_profile,
    reported_runtime_profile: null,
    reported_worker_version: null,
    reported_contract_version: null,
    missing_capabilities: []
  };

const workerCompatibilityBadgeTone = (
  status: NonNullable<TrainingWorkerBootstrapSessionRecord['compatibility']>['status']
): 'success' | 'warning' | 'danger' | 'neutral' => {
  if (status === 'compatible') {
    return 'success';
  }
  if (status === 'warning') {
    return 'warning';
  }
  if (status === 'incompatible') {
    return 'danger';
  }
  return 'neutral';
};

export default function RuntimeSettingsPage() {
  const { t } = useI18n();
  const [checks, setChecks] = useState<RuntimeConnectivityRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [runtimeSettingsLoading, setRuntimeSettingsLoading] = useState(true);
  const [runtimeSettingsSaving, setRuntimeSettingsSaving] = useState(false);
  const [runtimeSettingsClearing, setRuntimeSettingsClearing] = useState(false);
  const [runtimeSettingsError, setRuntimeSettingsError] = useState('');
  const [runtimeSettingsMessage, setRuntimeSettingsMessage] = useState('');
  const [runtimeSettingsUpdatedAt, setRuntimeSettingsUpdatedAt] = useState<string | null>(null);
  const [keepExistingApiKeys, setKeepExistingApiKeys] = useState(true);
  const [runtimeDrafts, setRuntimeDrafts] = useState<RuntimeFrameworkDraftMap>(() =>
    buildDefaultRuntimeFrameworkDraftMap()
  );
  const [runtimeControlDraft, setRuntimeControlDraft] = useState<RuntimeControlDraft>(() =>
    buildDefaultRuntimeControlDraft()
  );
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
  const [workerRegistryOpen, setWorkerRegistryOpen] = useState(false);
  const [workerRegistrySaving, setWorkerRegistrySaving] = useState(false);
  const [workerRegistryError, setWorkerRegistryError] = useState('');
  const [editingWorkerId, setEditingWorkerId] = useState<string | null>(null);
  const [workerRegistryDraft, setWorkerRegistryDraft] = useState<WorkerRegistryDraft>(
    () => buildDefaultWorkerRegistryDraft()
  );
  const [workerMutationTargetId, setWorkerMutationTargetId] = useState<string | null>(null);
  const [workerMutationAction, setWorkerMutationAction] = useState<string>('');
  const [creatingBootstrapSession, setCreatingBootstrapSession] = useState(false);
  const [downloadingBootstrapSessionId, setDownloadingBootstrapSessionId] = useState<string | null>(null);
  const [validatingBootstrapSessionId, setValidatingBootstrapSessionId] = useState<string | null>(null);
  const [activatingBootstrapWorkerId, setActivatingBootstrapWorkerId] = useState<string | null>(null);
  const [reconfiguringWorkerId, setReconfiguringWorkerId] = useState<string | null>(null);
  const [workerOnboardingDraft, setWorkerOnboardingDraft] = useState<WorkerOnboardingDraft>(
    () => buildDefaultWorkerOnboardingDraft()
  );
  const [activeBootstrapSessionId, setActiveBootstrapSessionId] = useState<string | null>(null);
  const [inferenceSourceSummary, setInferenceSourceSummary] = useState<Array<{ key: string; count: number }>>([]);
  const [trainingModeSummary, setTrainingModeSummary] = useState<Array<{ key: string; count: number }>>([]);
  const [trainingJobLabels, setTrainingJobLabels] = useState<Record<string, string>>({});
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

  const openExternalUrl = (url: string) => {
    if (!isConcreteWorkerUrl(url)) {
      return;
    }

    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const applyRuntimeSettingsView = (view: RuntimeSettingsView) => {
    setRuntimeSettingsUpdatedAt(view.updated_at);
    setRuntimeDrafts({
      paddleocr: mergeRuntimeFrameworkDraft(view.frameworks.paddleocr),
      doctr: mergeRuntimeFrameworkDraft(view.frameworks.doctr),
      yolo: mergeRuntimeFrameworkDraft(view.frameworks.yolo)
    });
    setRuntimeControlDraft({
      python_bin: view.controls.python_bin,
      disable_simulated_train_fallback: view.controls.disable_simulated_train_fallback,
      disable_inference_fallback: view.controls.disable_inference_fallback
    });
  };

  const refreshRuntimeSettings = async () => {
    setRuntimeSettingsError('');
    try {
      const view = await api.getRuntimeSettings();
      applyRuntimeSettingsView(view);
    } catch (runtimeConfigError) {
      setRuntimeSettingsError((runtimeConfigError as Error).message);
    } finally {
      setRuntimeSettingsLoading(false);
    }
  };

  const updateRuntimeDraft = (
    framework: ModelFramework,
    field: 'endpoint' | 'api_key' | 'local_train_command' | 'local_predict_command',
    value: string
  ) => {
    setRuntimeDrafts((prev) => ({
      ...prev,
      [framework]: {
        ...prev[framework],
        [field]: value
      }
    }));
  };

  const updateRuntimeControlDraft = (
    field: keyof RuntimeControlDraft,
    value: string | boolean
  ) => {
    setRuntimeControlDraft((prev) => ({
      ...prev,
      [field]: value
    }));
  };

  const saveRuntimeSettingsConfig = async () => {
    setRuntimeSettingsSaving(true);
    setRuntimeSettingsError('');
    setRuntimeSettingsMessage('');
    try {
      const nextConfig = {
        paddleocr: {
          endpoint: runtimeDrafts.paddleocr.endpoint.trim(),
          api_key: runtimeDrafts.paddleocr.api_key.trim(),
          local_train_command: runtimeDrafts.paddleocr.local_train_command.trim(),
          local_predict_command: runtimeDrafts.paddleocr.local_predict_command.trim()
        },
        doctr: {
          endpoint: runtimeDrafts.doctr.endpoint.trim(),
          api_key: runtimeDrafts.doctr.api_key.trim(),
          local_train_command: runtimeDrafts.doctr.local_train_command.trim(),
          local_predict_command: runtimeDrafts.doctr.local_predict_command.trim()
        },
        yolo: {
          endpoint: runtimeDrafts.yolo.endpoint.trim(),
          api_key: runtimeDrafts.yolo.api_key.trim(),
          local_train_command: runtimeDrafts.yolo.local_train_command.trim(),
          local_predict_command: runtimeDrafts.yolo.local_predict_command.trim()
        }
      };
      const saved = await api.saveRuntimeSettings(
        nextConfig,
        {
          python_bin: runtimeControlDraft.python_bin.trim(),
          disable_simulated_train_fallback: runtimeControlDraft.disable_simulated_train_fallback,
          disable_inference_fallback: runtimeControlDraft.disable_inference_fallback
        },
        keepExistingApiKeys
      );
      applyRuntimeSettingsView(saved);
      setRuntimeSettingsMessage(t('Runtime settings saved.'));
      void refresh();
    } catch (runtimeConfigError) {
      setRuntimeSettingsError((runtimeConfigError as Error).message);
    } finally {
      setRuntimeSettingsSaving(false);
    }
  };

  const clearRuntimeSettingsConfig = async () => {
    const confirmed = window.confirm(
      t('Clear UI-saved runtime settings and switch back to environment-variable fallback mode?')
    );
    if (!confirmed) {
      return;
    }

    setRuntimeSettingsClearing(true);
    setRuntimeSettingsError('');
    setRuntimeSettingsMessage('');
    try {
      const cleared = await api.clearRuntimeSettings();
      applyRuntimeSettingsView(cleared);
      setRuntimeSettingsMessage(t('Runtime settings cleared. Environment defaults now apply.'));
      void refresh();
    } catch (runtimeConfigError) {
      setRuntimeSettingsError((runtimeConfigError as Error).message);
    } finally {
      setRuntimeSettingsClearing(false);
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
      setTrainingJobLabels(
        Object.fromEntries(
          jobs.map((job) => [job.id, job.name.trim()])
        )
      );

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

  const openCreateWorkerRegistry = () => {
    setEditingWorkerId(null);
    setWorkerRegistryDraft(buildDefaultWorkerRegistryDraft());
    setWorkerRegistryError('');
    setWorkerRegistryOpen(true);
  };

  const openEditWorkerRegistry = (worker: TrainingWorkerNodeView) => {
    setEditingWorkerId(worker.id);
    setWorkerRegistryDraft(buildWorkerRegistryDraftFromWorker(worker));
    setWorkerRegistryError('');
    setWorkerRegistryOpen(true);
  };

  const buildWorkerRegistryPayload = (): CreateTrainingWorkerInput => ({
    name: workerRegistryDraft.name.trim(),
    endpoint: workerRegistryDraft.endpoint.trim() || null,
    status: workerRegistryDraft.status,
    enabled: workerRegistryDraft.enabled,
    max_concurrency: Number.parseInt(workerRegistryDraft.max_concurrency, 10) || 1,
    capabilities: normalizeCapabilityTokens(workerRegistryDraft.capabilities_text),
    metadata: normalizeMetadataInput(workerRegistryDraft.metadata_text)
  });

  const saveWorkerRegistry = async () => {
    setWorkerRegistrySaving(true);
    setWorkerRegistryError('');
    try {
      const payload = buildWorkerRegistryPayload();
      const updatedWorker = editingWorkerId
        ? await api.updateTrainingWorker(editingWorkerId, payload)
        : await api.createTrainingWorker(payload);
      setWorkers((prev) => {
        const next = editingWorkerId
          ? prev.map((item) => (item.id === updatedWorker.id ? updatedWorker : item))
          : [updatedWorker, ...prev];
        return [...next].sort((left, right) => left.name.localeCompare(right.name));
      });
      setWorkerRegistryOpen(false);
      setEditingWorkerId(null);
      setWorkerRegistryDraft(buildDefaultWorkerRegistryDraft());
    } catch (workerError) {
      setWorkerRegistryError((workerError as Error).message);
    } finally {
      setWorkerRegistrySaving(false);
    }
  };

  const patchWorker = async (
    workerId: string,
    patch: Partial<CreateTrainingWorkerInput>,
    actionLabel: string
  ) => {
    setWorkerMutationTargetId(workerId);
    setWorkerMutationAction(actionLabel);
    setWorkersError('');
    try {
      const updated = await api.updateTrainingWorker(workerId, patch);
      setWorkers((prev) =>
        [...prev.map((item) => (item.id === workerId ? updated : item))].sort((left, right) =>
          left.name.localeCompare(right.name)
        )
      );
    } catch (workerError) {
      setWorkersError((workerError as Error).message);
    } finally {
      setWorkerMutationTargetId(null);
      setWorkerMutationAction('');
    }
  };

  const removeWorker = async (worker: TrainingWorkerNodeView) => {
    const confirmed = window.confirm(
      t('Remove worker {name} from the scheduling pool?', { name: worker.name })
    );
    if (!confirmed) {
      return;
    }

    setWorkerMutationTargetId(worker.id);
    setWorkerMutationAction('remove');
    setWorkersError('');
    try {
      await api.removeTrainingWorker(worker.id);
      setWorkers((prev) => prev.filter((item) => item.id !== worker.id));
    } catch (workerError) {
      setWorkersError((workerError as Error).message);
    } finally {
      setWorkerMutationTargetId(null);
      setWorkerMutationAction('');
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

  const activateBootstrapWorker = async (workerId: string) => {
    setActivatingBootstrapWorkerId(workerId);
    setBootstrapSessionsError('');
    try {
      const result = await api.activateTrainingWorker(workerId);
      setWorkers((prev) =>
        [...prev.map((item) => (item.id === result.worker.id ? result.worker : item))].sort(
          (left, right) => left.name.localeCompare(right.name)
        )
      );
      if (result.bootstrap_session) {
        const updatedSession = result.bootstrap_session;
        setBootstrapSessions((prev) =>
          prev.map((item) =>
            item.id === updatedSession.id ? updatedSession : item
          )
        );
      }
      setCopyMessage(t('Worker activation succeeded.'));
      await refreshTrainingWorkers();
      await refreshBootstrapSessions();
    } catch (bootstrapError) {
      setBootstrapSessionsError((bootstrapError as Error).message);
    } finally {
      setActivatingBootstrapWorkerId(null);
    }
  };

  const createWorkerReconfigureSession = async (worker: TrainingWorkerNodeView) => {
    setReconfiguringWorkerId(worker.id);
    setBootstrapSessionsError('');
    try {
      const session = await api.createTrainingWorkerReconfigureSession(worker.id);
      setBootstrapSessions((prev) => [session, ...prev.filter((item) => item.id !== session.id)]);
      setActiveBootstrapSessionId(session.id);
      setWorkerOnboardingOpen(true);
      setCopyMessage(
        t('Worker reconfiguration session created for {name}.', { name: worker.name })
      );
      await refreshBootstrapSessions();
    } catch (workerError) {
      setBootstrapSessionsError((workerError as Error).message);
    } finally {
      setReconfiguringWorkerId(null);
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

  // Run one-time bootstrap pulls for diagnostics and worker/runtime summaries.
  useEffect(() => {
    void refresh();
    void refreshRuntimeSettings();
    void refreshExecutionSummary();
    void refreshTrainingWorkers();
    void refreshBootstrapSessions();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
  const defaultPythonBinByPlatform =
    typeof navigator !== 'undefined' && /win/i.test(navigator.platform) ? 'python' : 'python3';
  const resolvedPythonBin =
    runtimeControlDraft.python_bin.trim() || `${defaultPythonBinByPlatform} (${t('platform default')})`;
  const runtimeStrictModeEnabled =
    runtimeControlDraft.disable_simulated_train_fallback && runtimeControlDraft.disable_inference_fallback;
  const activeBootstrapSession =
    bootstrapSessions.find((session) => session.id === activeBootstrapSessionId) ?? null;
  const editingWorker =
    editingWorkerId ? workers.find((worker) => worker.id === editingWorkerId) ?? null : null;
  const onboardingStep =
    activeBootstrapSession?.status === 'online' ? 2 : activeBootstrapSession ? 1 : 0;
  const workerRegistryTitle = editingWorker ? t('Edit Worker') : t('Register Worker');
  const onboardingPreviewBindPort =
    Number.parseInt(workerOnboardingDraft.worker_bind_port, 10) || 9090;
  const onboardingPreviewPublicHost = workerOnboardingDraft.worker_public_host.trim() || null;
  const onboardingPreviewEndpoint = buildWorkerEndpointHint(
    onboardingPreviewPublicHost,
    onboardingPreviewBindPort
  );
  const onboardingPreviewSetupUrl = buildWorkerSetupUrlHint(
    onboardingPreviewPublicHost,
    onboardingPreviewBindPort
  );
  const activeBootstrapSetupUrl = activeBootstrapSession?.setup_url_hint ?? null;
  const activeBootstrapEndpointHint = activeBootstrapSession?.worker_endpoint_hint ?? null;
  const activeBootstrapCompatibility = activeBootstrapSession
    ? resolveSessionCompatibility(activeBootstrapSession)
    : null;
  const activeBootstrapSetupUrlReady = isConcreteWorkerUrl(activeBootstrapSession?.setup_url_hint);
  const activeBootstrapEndpointReady = isConcreteWorkerUrl(activeBootstrapSession?.worker_endpoint_hint);
  const formatPercent = (value: number | null | undefined) => {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return t('n/a');
    }
    return `${Math.round(value * 100)}%`;
  };

  const formatTimestamp = (value: string | null) => {
    return formatCompactTimestamp(value, t('n/a'));
  };

  const heroSection = (
    <WorkspaceHero
      eyebrow={t('Runtime overview')}
      title={t('Runtime Settings')}
      description={t('Check framework connections, worker availability, and recent execution signals from one place.')}
      actions={
        <div className="row gap wrap align-center">
          <StatusTag status={checking ? 'running' : 'ready'}>
            {checking ? t('Checking...') : t('Ready')}
          </StatusTag>
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
            description: t('How much recent training telemetry is currently retained.'),
            value: summaryLoading ? t('Loading') : metricsRetentionSummary ? metricsRetentionSummary.current_total_rows : t('N/A')
          }
        ]}
      />

      <WorkspaceWorkbench
        toolbar={
          <Card as="section" className="workspace-toolbar-card">
            <div className="workspace-toolbar-head">
              <div className="workspace-toolbar-copy">
                <h3>{t('Runtime Controls')}</h3>
                <small className="muted">
                  {t('Keep framework filtering, connectivity refresh, and worker follow-up in one stable strip.')}
                </small>
              </div>
              <div className="workspace-toolbar-actions">
                <Button type="button" size="sm" onClick={() => setWorkerOnboardingOpen(true)}>
                  {t('Add Worker')}
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={() => void refresh()} disabled={checking}>
                  {checking && frameworkFilter === 'all' ? t('Checking...') : t('Refresh All')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void refresh(frameworkFilter === 'all' ? undefined : frameworkFilter)}
                  disabled={checking || frameworkFilter === 'all'}
                >
                  {checking && frameworkFilter !== 'all' ? t('Checking...') : t('Check Selected')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void refreshExecutionSummary()}
                  disabled={summaryLoading}
                >
                  {summaryLoading ? t('Refreshing...') : t('Refresh Summary')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void refreshTrainingWorkers()}
                  disabled={workersLoading}
                >
                  {workersLoading ? t('Refreshing workers...') : t('Refresh Workers')}
                </Button>
              </div>
            </div>
            <div className="workspace-filter-grid">
              <label className="stack tight">
                <small className="muted">{t('Framework')}</small>
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
              <label className="stack tight">
                <small className="muted">{t('Template framework')}</small>
                <Select
                  value={templateFramework}
                  onChange={(event) => setTemplateFramework(event.target.value as ModelFramework)}
                >
                  <option value="paddleocr">{t('paddleocr')}</option>
                  <option value="doctr">{t('doctr')}</option>
                  <option value="yolo">{t('yolo')}</option>
                </Select>
              </label>
              <div className="stack tight">
                <small className="muted">{t('Configured')}</small>
                <div className="row gap wrap">
                  <Badge tone="neutral">
                    {configuredCount} / {FRAMEWORKS.length}
                  </Badge>
                </div>
              </div>
              <div className="stack tight">
                <small className="muted">{t('Pairing')}</small>
                <div className="row gap wrap">
                  <Badge tone="info">{t('Pending')}: {pendingBootstrapCount}</Badge>
                </div>
              </div>
            </div>
            <div className="workspace-toolbar-meta">
              <div className="workspace-segmented-actions">
                <Badge tone="neutral">{t('Reachable frameworks')}: {reachableCount}</Badge>
                <Badge tone={unreachableCount > 0 ? 'warning' : 'neutral'}>
                  {t('Unreachable frameworks')}: {unreachableCount}
                </Badge>
                <Badge tone="neutral">{t('Not Configured')}: {notConfiguredCount}</Badge>
                <Badge tone="info">{t('Online workers')}: {workersLoading ? t('...') : onlineWorkerCount}</Badge>
              </div>
            </div>
          </Card>
        }
        main={
          <div className="workspace-main-stack">
          <Card as="article">
            <div className="workspace-section-header">
              <div className="stack tight">
                <h3>{t('Runtime configuration')}</h3>
                <small className="muted">
                  {t('Configure runtime endpoint, API key, and local command templates directly from UI.')}
                </small>
              </div>
              <div className="row gap wrap align-center">
                <Badge tone="neutral">
                  {t('Last updated')}: {formatTimestamp(runtimeSettingsUpdatedAt)}
                </Badge>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void saveRuntimeSettingsConfig()}
                  disabled={runtimeSettingsLoading || runtimeSettingsSaving || runtimeSettingsClearing}
                >
                  {runtimeSettingsSaving ? t('Saving...') : t('Save runtime settings')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void refreshRuntimeSettings()}
                  disabled={runtimeSettingsLoading || runtimeSettingsSaving || runtimeSettingsClearing}
                >
                  {runtimeSettingsLoading ? t('Loading...') : t('Reload settings')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void clearRuntimeSettingsConfig()}
                  disabled={runtimeSettingsLoading || runtimeSettingsSaving || runtimeSettingsClearing}
                >
                  {runtimeSettingsClearing ? t('Clearing...') : t('Clear UI settings')}
                </Button>
              </div>
            </div>

            {runtimeSettingsError ? (
              <StateBlock variant="error" title={t('Runtime settings unavailable')} description={runtimeSettingsError} />
            ) : null}
            {runtimeSettingsMessage ? (
              <StateBlock variant="success" title={t('Runtime settings')} description={runtimeSettingsMessage} />
            ) : null}

            <label className="row gap wrap align-center">
              <input
                type="checkbox"
                className="ui-checkbox"
                checked={keepExistingApiKeys}
                onChange={(event) => setKeepExistingApiKeys(event.target.checked)}
              />
              <span>{t('Keep existing API keys when key field is left blank')}</span>
            </label>

            <Panel as="section" className="workspace-record-item" tone="soft">
              <div className="stack tight">
                <strong>{t('Runtime strict controls')}</strong>
                <small className="muted">
                  {t('Control whether runtime can fallback to simulated/template outputs, and choose default Python executable for bundled runners.')}
                </small>
              </div>
              <label className="stack tight">
                <small className="muted">{t('Bundled runner Python executable')}</small>
                <Input
                  value={runtimeControlDraft.python_bin}
                  onChange={(event) =>
                    updateRuntimeControlDraft('python_bin', event.target.value)
                  }
                  placeholder={t('Leave blank to use platform default (python3 / python)')}
                />
              </label>
              <label className="row gap wrap align-center">
                <input
                  type="checkbox"
                  className="ui-checkbox"
                  checked={runtimeControlDraft.disable_simulated_train_fallback}
                  onChange={(event) =>
                    updateRuntimeControlDraft(
                      'disable_simulated_train_fallback',
                      event.target.checked
                    )
                  }
                />
                <span>
                  {t(
                    'Disable simulated training fallback (fail fast when local runner command is missing or unavailable)'
                  )}
                </span>
              </label>
              <label className="row gap wrap align-center">
                <input
                  type="checkbox"
                  className="ui-checkbox"
                  checked={runtimeControlDraft.disable_inference_fallback}
                  onChange={(event) =>
                    updateRuntimeControlDraft(
                      'disable_inference_fallback',
                      event.target.checked
                    )
                  }
                />
                <span>
                  {t(
                    'Disable inference fallback (reject template/fallback runtime outputs and return explicit error)'
                  )}
                </span>
              </label>
            </Panel>

            {runtimeSettingsLoading ? (
              <StateBlock
                variant="loading"
                title={t('Loading runtime settings')}
                description={t('Fetching saved runtime configuration from backend.')}
              />
            ) : (
              <div className="three-col">
                {FRAMEWORKS.map((framework) => {
                  const draft = runtimeDrafts[framework];
                  return (
                    <Panel key={framework} as="section" className="workspace-record-item" tone="soft">
                      <div className="row between gap wrap align-center">
                        <strong>{t(framework)}</strong>
                        {draft.has_api_key ? (
                          <Badge tone="success">{t('API key saved')}</Badge>
                        ) : (
                          <Badge tone="neutral">{t('No API key')}</Badge>
                        )}
                      </div>

                      <label className="stack tight">
                        <small className="muted">{t('Runtime endpoint')}</small>
                        <Input
                          value={draft.endpoint}
                          onChange={(event) => updateRuntimeDraft(framework, 'endpoint', event.target.value)}
                          placeholder={`http://127.0.0.1:9393/predict`}
                        />
                      </label>

                      <label className="stack tight">
                        <small className="muted">{t('Runtime API key (optional)')}</small>
                        <Input
                          type="password"
                          value={draft.api_key}
                          onChange={(event) => updateRuntimeDraft(framework, 'api_key', event.target.value)}
                          placeholder={
                            draft.api_key_masked
                              ? t('Stored key: {masked}', {
                                  masked: draft.api_key_masked
                                })
                              : t('Leave blank if runtime endpoint has no key')
                          }
                        />
                      </label>

                      <label className="stack tight">
                        <small className="muted">{t('Local train command')}</small>
                        <Textarea
                          value={draft.local_train_command}
                          onChange={(event) =>
                            updateRuntimeDraft(framework, 'local_train_command', event.target.value)
                          }
                          rows={4}
                          placeholder={t('Optional. Leave empty to use bundled local runner template.')}
                        />
                      </label>

                      <label className="stack tight">
                        <small className="muted">{t('Local predict command')}</small>
                        <Textarea
                          value={draft.local_predict_command}
                          onChange={(event) =>
                            updateRuntimeDraft(framework, 'local_predict_command', event.target.value)
                          }
                          rows={4}
                          placeholder={t('Optional. Leave empty to use bundled local runner template.')}
                        />
                      </label>
                    </Panel>
                  );
                })}
              </div>
            )}
          </Card>

          <Card as="article">
            <div className="workspace-section-header">
              <div className="stack tight">
                <h3>{t('Framework connections')}</h3>
                <small className="muted">
                  {t('Review whether each framework is reachable and whether setup is complete.')}
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
                    <small className="muted">{t('checked at')}: {formatTimestamp(item?.checked_at ?? null)}</small>
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
          <div className="workspace-inspector-rail">
          <Card as="article" className="workspace-inspector-card">
            <div className="workspace-section-header">
              <div className="stack tight">
                <h3>{t('Runtime Summary')}</h3>
                <small className="muted">
                  {t('Keep current framework scope, connectivity mix, and worker readiness visible at a glance.')}
                </small>
              </div>
              <Badge tone="neutral">{frameworkFilter === 'all' ? t('all') : t(frameworkFilter)}</Badge>
            </div>
            <div className="row gap wrap">
              <Badge tone="neutral">{t('Reachable frameworks')}: {reachableCount}</Badge>
              <Badge tone={unreachableCount > 0 ? 'warning' : 'neutral'}>
                {t('Unreachable frameworks')}: {unreachableCount}
              </Badge>
              <Badge tone="info">{t('Online workers')}: {workersLoading ? t('...') : onlineWorkerCount}</Badge>
              <Badge tone="neutral">{t('Pending pairing')}: {bootstrapSessionsLoading ? t('...') : pendingBootstrapCount}</Badge>
            </div>
            <small className="muted">
              {t('Framework filter')}: {frameworkFilter === 'all' ? t('all') : t(frameworkFilter)} · {t('Configured')}:{' '}
              {configuredCount} / {FRAMEWORKS.length}
            </small>
            <Panel as="section" className="workspace-record-item compact" tone="soft">
              <div className="stack tight">
                <strong>{t('Runtime strict controls')}</strong>
                <div className="row gap wrap">
                  <Badge tone={runtimeStrictModeEnabled ? 'success' : 'warning'}>
                    {runtimeStrictModeEnabled ? t('yes') : t('no')}
                  </Badge>
                </div>
                <small className="muted">
                  {t('Bundled runner Python executable')}: {resolvedPythonBin}
                </small>
                <small className="muted">
                  {t(
                    'Disable simulated training fallback (fail fast when local runner command is missing or unavailable)'
                  )}
                  : {runtimeControlDraft.disable_simulated_train_fallback ? t('yes') : t('no')}
                </small>
                <small className="muted">
                  {t(
                    'Disable inference fallback (reject template/fallback runtime outputs and return explicit error)'
                  )}
                  : {runtimeControlDraft.disable_inference_fallback ? t('yes') : t('no')}
                </small>
              </div>
            </Panel>
          </Card>

          <Card as="article" className="workspace-inspector-card">
            <div className="workspace-section-header">
              <div className="stack tight">
                <h3>{t('Worker setup')}</h3>
                <small className="muted">
                  {t('Create one-time setup sessions and help operators finish worker connection locally.')}
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
                {bootstrapSessions.slice(0, 5).map((session) => {
                  const compatibility = resolveSessionCompatibility(session);
                  return (
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
                      <Badge tone={workerCompatibilityBadgeTone(compatibility.status)}>
                        {t('Compatibility')}: {t(compatibility.status)}
                      </Badge>
                      {session.linked_worker_id ? <Badge tone="success">{t('linked worker')}</Badge> : null}
                    </div>
                    <small className="muted">
                      {t('setup url')}: {session.setup_url_hint}
                    </small>
                    <small className="muted">
                      {t('endpoint hint')}: {session.worker_endpoint_hint ?? t('to be confirmed in /setup')}
                    </small>
                    <small className="muted">
                      {t('claimed at')}: {formatTimestamp(session.claimed_at)}
                    </small>
                    <small className="muted">
                      {t('last seen')}: {formatTimestamp(session.last_seen_at)}
                    </small>
                    <small className="muted">
                      {t('expires')}: {formatTimestamp(session.expires_at)}
                    </small>
                    <small className="muted">
                      {t('expected profile')}: {compatibility.expected_runtime_profile ?? t('n/a')} · {t('reported profile')}:{' '}
                      {compatibility.reported_runtime_profile ?? t('n/a')}
                    </small>
                    <small className="muted">
                      {t('worker version')}: {compatibility.reported_worker_version ?? t('n/a')} · {t('contract version')}:{' '}
                      {compatibility.reported_contract_version ?? t('n/a')}
                    </small>
                    {compatibility.missing_capabilities.length > 0 ? (
                      <small className="muted">
                        {t('missing capabilities')}: {compatibility.missing_capabilities.join(', ')}
                      </small>
                    ) : null}
                    <small className="muted">{compatibility.message}</small>
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
                        onClick={() => void copyText(t('Setup URL'), session.setup_url_hint)}
                      >
                        {t('Copy Setup URL')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => openExternalUrl(session.setup_url_hint)}
                        disabled={!isConcreteWorkerUrl(session.setup_url_hint)}
                      >
                        {t('Open Setup')}
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
                  );
                })}
              </ul>
            )}
          </Card>

          <Card as="article" className="workspace-inspector-card">
            <div className="workspace-section-header">
              <div className="stack tight">
                <h3>{t('Worker availability')}</h3>
                <small className="muted">
                  {t('Review worker capacity, health, and readiness before sending new jobs.')}
                </small>
              </div>
              <div className="row gap wrap align-center">
                <Badge tone="neutral">{t('Workers')}: {workers.length}</Badge>
                <Button type="button" variant="secondary" size="sm" onClick={openCreateWorkerRegistry}>
                  {t('Register Worker')}
                </Button>
              </div>
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
                      {t('Registration')}: {t(worker.registration_source)} · {t('Auth mode')}: {t(worker.auth_mode)} ·{' '}
                      {t('Enabled')}: {worker.enabled ? t('yes') : t('no')}
                    </small>
                    <div className="workspace-record-actions">
                      <Button type="button" variant="ghost" size="sm" onClick={() => openEditWorkerRegistry(worker)}>
                        {t('Edit')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={reconfiguringWorkerId === worker.id}
                        onClick={() => void createWorkerReconfigureSession(worker)}
                      >
                        {reconfiguringWorkerId === worker.id ? t('Creating...') : t('Reconfigure')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={workerMutationTargetId === worker.id}
                        onClick={() =>
                          void patchWorker(
                            worker.id,
                            { status: worker.status === 'draining' ? 'online' : 'draining' },
                            'status'
                          )
                        }
                      >
                        {workerMutationTargetId === worker.id && workerMutationAction === 'status'
                          ? t('Saving...')
                          : worker.status === 'draining'
                            ? t('Resume Scheduling')
                            : t('Mark Draining')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={workerMutationTargetId === worker.id}
                        onClick={() =>
                          void patchWorker(
                            worker.id,
                            { enabled: !worker.enabled },
                            'enabled'
                          )
                        }
                      >
                        {workerMutationTargetId === worker.id && workerMutationAction === 'enabled'
                          ? t('Saving...')
                          : worker.enabled
                            ? t('Disable')
                            : t('Enable')}
                      </Button>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        disabled={worker.in_flight_jobs > 0 || workerMutationTargetId === worker.id}
                        onClick={() => void removeWorker(worker)}
                      >
                        {workerMutationTargetId === worker.id && workerMutationAction === 'remove'
                          ? t('Removing...')
                          : t('Remove')}
                      </Button>
                    </div>
                  </Panel>
                ))}
              </ul>
            )}
          </Card>

          <Card as="article" className="workspace-inspector-card">
            <div className="workspace-section-header">
              <div className="stack tight">
                <h3>{t('Recent activity')}</h3>
                <small className="muted">{t('Recent inference and training summaries stay visible here.')}</small>
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
                            {t(entry.key)}: {entry.count}
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
                            {t(entry.key)}: {entry.count}
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
                                {trainingJobLabels[item.training_job_id] || t('Recent training job')}: {item.rows}
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

            <Panel tone="soft">
              <div className="stack tight">
                <strong>{t('Worker access preview')}</strong>
                <small className="muted">
                  {t('Precompute the worker callback endpoint and local /setup page before generating the pairing session.')}
                </small>
                <small className="muted">
                  {t('endpoint hint')}: {onboardingPreviewEndpoint ?? t('to be confirmed in /setup')}
                </small>
                <small className="muted">
                  {t('Setup URL')}: {onboardingPreviewSetupUrl}
                </small>
              </div>
            </Panel>

            {!onboardingPreviewPublicHost ? (
              <StateBlock
                variant="empty"
                title={t('Worker host still missing')}
                description={t(
                  'Fill Worker public host / IP so the generated setup URL and callback endpoint are directly usable from the control plane.'
                )}
              />
            ) : null}

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
                  <Badge tone="neutral">{t('bind port')}: {activeBootstrapSession.worker_bind_port}</Badge>
                  <Badge tone="warning">
                    {t('issued auth mode')}: {t(activeBootstrapSession.issued_auth_mode)}
                  </Badge>
                  {activeBootstrapCompatibility ? (
                    <Badge tone={workerCompatibilityBadgeTone(activeBootstrapCompatibility.status)}>
                      {t('Compatibility')}: {t(activeBootstrapCompatibility.status)}
                    </Badge>
                  ) : null}
                  {activeBootstrapSession.worker_public_host ? (
                    <Badge tone="info">{t('host')}: {activeBootstrapSession.worker_public_host}</Badge>
                  ) : null}
                  {activeBootstrapSession.issued_auth_token_preview ? (
                    <Badge tone="info">
                      {t('issued token')}: {activeBootstrapSession.issued_auth_token_preview}
                    </Badge>
                  ) : null}
                  {activeBootstrapSession.linked_worker_id ? (
                    <Badge tone="success">{t('linked worker')}</Badge>
                  ) : null}
                </div>
                <small className="muted">
                  {t('pairing token')}: {activeBootstrapSession.pairing_token}
                </small>
                <small className="muted">
                  {t('setup url')}: {activeBootstrapSetupUrl}
                </small>
                <small className="muted">
                  {t('endpoint hint')}: {activeBootstrapEndpointHint ?? t('to be confirmed in /setup')}
                </small>
                {activeBootstrapCompatibility ? (
                  <>
                    <small className="muted">
                      {t('expected profile')}: {activeBootstrapCompatibility.expected_runtime_profile ?? t('n/a')} ·{' '}
                      {t('reported profile')}: {activeBootstrapCompatibility.reported_runtime_profile ?? t('n/a')}
                    </small>
                    <small className="muted">
                      {t('worker version')}: {activeBootstrapCompatibility.reported_worker_version ?? t('n/a')} ·{' '}
                      {t('contract version')}: {activeBootstrapCompatibility.reported_contract_version ?? t('n/a')}
                    </small>
                    {activeBootstrapCompatibility.missing_capabilities.length > 0 ? (
                      <small className="muted">
                        {t('missing capabilities')}: {activeBootstrapCompatibility.missing_capabilities.join(', ')}
                      </small>
                    ) : null}
                    <small className="muted">{activeBootstrapCompatibility.message}</small>
                  </>
                ) : null}
                <small className="muted">
                  {t('claimed at')}: {formatTimestamp(activeBootstrapSession.claimed_at)}
                </small>
                <small className="muted">
                  {t('last seen')}: {formatTimestamp(activeBootstrapSession.last_seen_at)}
                </small>
                <small className="muted">
                  {t('callback checked')}: {formatTimestamp(activeBootstrapSession.callback_checked_at)}
                </small>
                <small className="muted">
                  {t('expires')}: {formatTimestamp(activeBootstrapSession.expires_at)}
                </small>
                <div className="row gap wrap">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void copyText(t('pairing token'), activeBootstrapSession.pairing_token)}
                  >
                    {t('Copy Token')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void copyText(t('Setup URL'), activeBootstrapSession.setup_url_hint)}
                  >
                    {t('Copy Setup URL')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => openExternalUrl(activeBootstrapSession.setup_url_hint)}
                    disabled={!activeBootstrapSetupUrlReady}
                  >
                    {t('Open Setup')}
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
                  {activeBootstrapSession.status !== 'online' ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void activateBootstrapWorker(
                          activeBootstrapSession.linked_worker_id ?? activeBootstrapSession.worker_id
                        )
                      }
                      disabled={
                        activatingBootstrapWorkerId ===
                        (activeBootstrapSession.linked_worker_id ?? activeBootstrapSession.worker_id)
                      }
                    >
                      {activatingBootstrapWorkerId ===
                      (activeBootstrapSession.linked_worker_id ?? activeBootstrapSession.worker_id)
                        ? t('Activating...')
                        : t('Activate Worker')}
                    </Button>
                  ) : null}
                </div>
                {activeBootstrapSession.callback_validation_message ? (
                  <small className="muted">{activeBootstrapSession.callback_validation_message}</small>
                ) : null}
                {!activeBootstrapSetupUrlReady ? (
                  <StateBlock
                    variant="empty"
                    title={t('Setup URL still needs a real host')}
                    description={t(
                      'This pairing session was created without Worker public host / IP. Regenerate it with a reachable host so the operator can open /setup directly and the control plane can validate callbacks cleanly.'
                    )}
                  />
                ) : null}
                {!activeBootstrapEndpointReady ? (
                  <StateBlock
                    variant="empty"
                    title={t('Worker host still missing')}
                    description={t(
                      'Fill Worker public host / IP so the generated setup URL and callback endpoint are directly usable from the control plane.'
                    )}
                  />
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
                {!activeBootstrapSetupUrlReady ? (
                  <StateBlock
                    variant="empty"
                    title={t('Setup URL still needs a real host')}
                    description={t(
                      'This pairing session was created without Worker public host / IP. Regenerate it with a reachable host so the operator can open /setup directly and the control plane can validate callbacks cleanly.'
                    )}
                  />
                ) : null}
                {activeBootstrapSession.status === 'online' ? (
                  activeBootstrapCompatibility?.status === 'warning' ? (
                    <StateBlock
                      variant="error"
                      title={t('Compatibility warning')}
                      description={activeBootstrapCompatibility.message}
                    />
                  ) : (
                    <StateBlock
                      variant="success"
                      title={t('Worker online')}
                      description={t('Heartbeat has been accepted by the control plane and the worker can now join scheduling.')}
                    />
                  )
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

      <Drawer
        open={workerRegistryOpen}
        onClose={() => setWorkerRegistryOpen(false)}
        side="right"
        className="runtime-worker-drawer"
        title={workerRegistryTitle}
      >
        <div className="stack">
          <div className="workspace-section-header">
            <div className="stack tight">
              <h3>{workerRegistryTitle}</h3>
              <small className="muted">
                {editingWorker
                  ? t('Adjust endpoint, scheduler status, or capacity without leaving the runtime page.')
                  : t('Manually register an existing worker endpoint when you do not need the guided pairing flow.')}
              </small>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setWorkerRegistryOpen(false)}>
              {t('Close')}
            </Button>
          </div>

          {workerRegistryError ? (
            <StateBlock variant="error" title={t('Worker update failed')} description={workerRegistryError} />
          ) : null}

          {editingWorker ? (
            <Card as="section">
              <div className="row gap wrap align-center">
                <Badge tone="neutral">{t(editingWorker.registration_source)}</Badge>
                <Badge tone="neutral">{t(editingWorker.auth_mode)}</Badge>
              </div>
              <small className="muted">
                {t('Last heartbeat')}: {formatTimestamp(editingWorker.last_heartbeat_at)} · {t('Last success')}:{' '}
                {formatTimestamp(editingWorker.dispatch_last_success_at)}
              </small>
            </Card>
          ) : null}

          <Card as="section">
            <label>
              {t('Worker name')}
              <Input
                value={workerRegistryDraft.name}
                onChange={(event) =>
                  setWorkerRegistryDraft((prev) => ({
                    ...prev,
                    name: event.target.value
                  }))
                }
                placeholder="gpu-worker-b"
              />
            </label>

            <label>
              {t('Worker endpoint')}
              <Input
                value={workerRegistryDraft.endpoint}
                onChange={(event) =>
                  setWorkerRegistryDraft((prev) => ({
                    ...prev,
                    endpoint: event.target.value
                  }))
                }
                placeholder="http://10.10.0.22:9090"
              />
            </label>

            <div className="workspace-form-grid">
              <label>
                {t('Status')}
                <Select
                  value={workerRegistryDraft.status}
                  onChange={(event) =>
                    setWorkerRegistryDraft((prev) => ({
                      ...prev,
                      status: event.target.value as TrainingWorkerStatus
                    }))
                  }
                >
                  <option value="online">{t('online')}</option>
                  <option value="offline">{t('offline')}</option>
                  <option value="draining">{t('draining')}</option>
                </Select>
              </label>

              <label>
                {t('Max concurrency')}
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={workerRegistryDraft.max_concurrency}
                  onChange={(event) =>
                    setWorkerRegistryDraft((prev) => ({
                      ...prev,
                      max_concurrency: event.target.value
                    }))
                  }
                />
              </label>
            </div>

            <label className="workspace-checkbox-row">
              <input
                type="checkbox"
                checked={workerRegistryDraft.enabled}
                onChange={(event) =>
                  setWorkerRegistryDraft((prev) => ({
                    ...prev,
                    enabled: event.target.checked
                  }))
                }
              />
              <span>{t('Enabled for scheduling')}</span>
            </label>

            <label>
              {t('Capabilities')}
              <Textarea
                value={workerRegistryDraft.capabilities_text}
                onChange={(event) =>
                  setWorkerRegistryDraft((prev) => ({
                    ...prev,
                    capabilities_text: event.target.value
                  }))
                }
                rows={3}
                placeholder="framework:yolo, task:detection"
              />
              <small className="muted">
                {t('Use comma or line breaks, for example framework:yolo and task:detection.')}
              </small>
            </label>

            <label>
              {t('Metadata')}
              <Textarea
                value={workerRegistryDraft.metadata_text}
                onChange={(event) =>
                  setWorkerRegistryDraft((prev) => ({
                    ...prev,
                    metadata_text: event.target.value
                  }))
                }
                rows={4}
                placeholder={'ip=10.10.0.22\nzone=rack-b'}
              />
              <small className="muted">{t('One key=value pair per line.')}</small>
            </label>

            <div className="workspace-button-stack">
              <Button type="button" onClick={() => void saveWorkerRegistry()} disabled={workerRegistrySaving}>
                {workerRegistrySaving ? t('Saving...') : editingWorker ? t('Save Worker') : t('Create Worker')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setWorkerRegistryDraft(editingWorker ? buildWorkerRegistryDraftFromWorker(editingWorker) : buildDefaultWorkerRegistryDraft());
                  setWorkerRegistryError('');
                }}
              >
                {t('Reset Draft')}
              </Button>
            </div>
          </Card>
        </div>
      </Drawer>
    </WorkspacePage>
  );
}
