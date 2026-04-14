import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  LlmConfigView,
  ModelFramework,
  RuntimeConnectivityRecord,
  RuntimeFrameworkConfigView,
  RuntimeMetricsRetentionSummary,
  RuntimeReadinessReport,
  RuntimeProfileView,
  RuntimeSettingsView,
  RuntimeApiKeyMetaView,
  TrainingArtifactSummary,
  TrainingJobRecord,
  ModelRecord,
  ModelVersionRecord
} from '../../shared/domain';
import AdvancedSection from '../components/AdvancedSection';
import WorkspaceOnboardingCard from '../components/onboarding/WorkspaceOnboardingCard';
import WorkspaceNextStepCard from '../components/onboarding/WorkspaceNextStepCard';
import StateBlock from '../components/StateBlock';
import SettingsTabs from '../components/settings/SettingsTabs';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import {
  ActionBar,
  DetailList,
  FilterToolbar,
  HealthSummaryPanel,
  InlineAlert,
  KPIStatRow,
  PageHeader,
  SectionCard,
  StatusTable,
  type StatusTableColumn
} from '../components/ui/ConsolePage';
import WorkspaceActionStack from '../components/ui/WorkspaceActionStack';
import { Input, Select, Textarea } from '../components/ui/Field';
import ProgressStepper from '../components/ui/ProgressStepper';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';
import { detectInferenceRunReality } from '../utils/inferenceSource';

const FRAMEWORKS: ModelFramework[] = ['paddleocr', 'doctr', 'yolo'];
const recentMetricJobsPerFramework = 2;
const runtimeOnboardingDismissedStorageKey = 'vistral-runtime-onboarding-dismissed';

type FrameworkMetricKeySummary = {
  framework: ModelFramework;
  jobsChecked: number;
  jobsWithMetrics: number;
  metricKeys: string[];
  latestJobLabel: string | null;
  latestGeneratedAt: string | null;
};

type RuntimeFrameworkDraft = {
  endpoint: string;
  api_key: string;
  default_model_id: string;
  default_model_version_id: string;
  model_api_keys: Record<string, string>;
  model_api_key_expires_at: Record<string, string>;
  model_api_key_max_calls: Record<string, string>;
  model_api_keys_meta: Record<string, RuntimeApiKeyMetaView>;
  local_model_path: string;
  local_train_command: string;
  local_predict_command: string;
  has_api_key: boolean;
  api_key_masked: string;
};

type RuntimeFrameworkDraftMap = Record<ModelFramework, RuntimeFrameworkDraft>;
type RuntimeConnectionMode = 'local' | 'endpoint';
type RuntimeConnectionModeMap = Record<ModelFramework, RuntimeConnectionMode>;

type RuntimeControlDraft = {
  python_bin: string;
  disable_simulated_train_fallback: boolean;
  disable_inference_fallback: boolean;
};

type RuntimeReadinessCommandGroup = {
  key: string;
  label: string;
  commands: string[];
};

type InferenceRealitySummaryKey = 'real' | 'fallback';
type TrainingExecutionSummaryKey = 'local_command' | 'simulated' | 'unknown';

type RuntimeManualTaskItem = {
  key: string;
  title: string;
  status: 'ready' | 'warning' | 'pending' | 'action_required';
  detail: string;
  actionLabel?: string;
  actionHref?: string;
};

type RuntimeModelOption = {
  id: string;
  label: string;
  isFoundation: boolean;
  isPublished: boolean;
  modelType: string;
};

type RuntimeModelVersionOption = {
  id: string;
  modelId: string;
  label: string;
};

type RuntimeSettingsDraftSnapshot = {
  frameworks: RuntimeFrameworkDraftMap;
  controls: RuntimeControlDraft;
};

const runtimeFrameworkTaskTypes: Record<ModelFramework, string[]> = {
  paddleocr: ['ocr'],
  doctr: ['ocr'],
  yolo: ['detection', 'classification', 'segmentation', 'obb']
};

const describeTrainingExecutionSummaryLabel = (
  t: (source: string, vars?: Record<string, string | number>) => string,
  key: string
): string => {
  const normalized = key.trim() as TrainingExecutionSummaryKey;
  if (normalized === 'local_command') {
    return t('Local command');
  }
  if (normalized === 'simulated') {
    return t('Degraded execution');
  }
  return t('Unknown');
};

const defaultDoctrPreseedExpectedFiles = ['db_resnet50-79bd7d70.pt', 'vgg16_bn_r-d108c19c.pt'];
const defaultDoctrPreseedRuntimeDir = '/app/runtime-preseed/doctr';
const defaultDoctrPreseedHostDirHint = './runtime-assets/doctr-preseed';
const doctrPreseedRecoveryCommands = [
  'npm run setup:doctr-preseed',
  'docker compose up -d --build vistral-api',
  'npm run smoke:runtime-success'
];

const resolveDoctrPreseedHostDirHint = (runtimeDir: string | null): string => {
  if (!runtimeDir) {
    return defaultDoctrPreseedHostDirHint;
  }
  const normalized = runtimeDir.trim();
  if (!normalized) {
    return defaultDoctrPreseedHostDirHint;
  }
  if (normalized === defaultDoctrPreseedRuntimeDir) {
    return defaultDoctrPreseedHostDirHint;
  }
  const composeMountPrefix = '/app/runtime-preseed/';
  if (normalized.startsWith(composeMountPrefix)) {
    return `./runtime-assets/${normalized.slice(composeMountPrefix.length)}`;
  }
  return normalized;
};

const buildDefaultRuntimeFrameworkDraft = (): RuntimeFrameworkDraft => ({
  endpoint: '',
  api_key: '',
  default_model_id: '',
  default_model_version_id: '',
  model_api_keys: {},
  model_api_key_expires_at: {},
  model_api_key_max_calls: {},
  model_api_keys_meta: {},
  local_model_path: '',
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

const resolveRuntimeConnectionMode = (draft: RuntimeFrameworkDraft): RuntimeConnectionMode =>
  draft.endpoint.trim() ? 'endpoint' : 'local';

const normalizeRuntimeSnapshot = (snapshot: RuntimeSettingsDraftSnapshot): string =>
  {
    const normalizeModelApiKeys = (value: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(value)
          .map(([key, apiKey]) => [key.trim(), apiKey.trim()])
          .filter(([key]) => Boolean(key))
          .sort(([left], [right]) => left.localeCompare(right))
      );
    const normalizeStringMap = (value: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(value)
          .map(([key, fieldValue]) => [key.trim(), fieldValue.trim()])
          .filter(([key]) => Boolean(key))
          .sort(([left], [right]) => left.localeCompare(right))
      );

    return JSON.stringify({
      frameworks: {
        paddleocr: {
          endpoint: snapshot.frameworks.paddleocr.endpoint.trim(),
          api_key: snapshot.frameworks.paddleocr.api_key.trim(),
          default_model_id: snapshot.frameworks.paddleocr.default_model_id.trim(),
          default_model_version_id: snapshot.frameworks.paddleocr.default_model_version_id.trim(),
          model_api_keys: normalizeModelApiKeys(snapshot.frameworks.paddleocr.model_api_keys),
          model_api_key_expires_at: normalizeStringMap(
            snapshot.frameworks.paddleocr.model_api_key_expires_at
          ),
          model_api_key_max_calls: normalizeStringMap(
            snapshot.frameworks.paddleocr.model_api_key_max_calls
          ),
          local_model_path: snapshot.frameworks.paddleocr.local_model_path.trim(),
          local_train_command: snapshot.frameworks.paddleocr.local_train_command.trim(),
          local_predict_command: snapshot.frameworks.paddleocr.local_predict_command.trim()
        },
        doctr: {
          endpoint: snapshot.frameworks.doctr.endpoint.trim(),
          api_key: snapshot.frameworks.doctr.api_key.trim(),
          default_model_id: snapshot.frameworks.doctr.default_model_id.trim(),
          default_model_version_id: snapshot.frameworks.doctr.default_model_version_id.trim(),
          model_api_keys: normalizeModelApiKeys(snapshot.frameworks.doctr.model_api_keys),
          model_api_key_expires_at: normalizeStringMap(
            snapshot.frameworks.doctr.model_api_key_expires_at
          ),
          model_api_key_max_calls: normalizeStringMap(
            snapshot.frameworks.doctr.model_api_key_max_calls
          ),
          local_model_path: snapshot.frameworks.doctr.local_model_path.trim(),
          local_train_command: snapshot.frameworks.doctr.local_train_command.trim(),
          local_predict_command: snapshot.frameworks.doctr.local_predict_command.trim()
        },
        yolo: {
          endpoint: snapshot.frameworks.yolo.endpoint.trim(),
          api_key: snapshot.frameworks.yolo.api_key.trim(),
          default_model_id: snapshot.frameworks.yolo.default_model_id.trim(),
          default_model_version_id: snapshot.frameworks.yolo.default_model_version_id.trim(),
          model_api_keys: normalizeModelApiKeys(snapshot.frameworks.yolo.model_api_keys),
          model_api_key_expires_at: normalizeStringMap(
            snapshot.frameworks.yolo.model_api_key_expires_at
          ),
          model_api_key_max_calls: normalizeStringMap(
            snapshot.frameworks.yolo.model_api_key_max_calls
          ),
          local_model_path: snapshot.frameworks.yolo.local_model_path.trim(),
          local_train_command: snapshot.frameworks.yolo.local_train_command.trim(),
          local_predict_command: snapshot.frameworks.yolo.local_predict_command.trim()
        }
      },
      controls: {
        python_bin: snapshot.controls.python_bin.trim(),
        disable_simulated_train_fallback: snapshot.controls.disable_simulated_train_fallback,
        disable_inference_fallback: snapshot.controls.disable_inference_fallback
      }
    });
  };

const mergeRuntimeFrameworkDraft = (
  view: RuntimeFrameworkConfigView
): RuntimeFrameworkDraft => ({
  endpoint: view.endpoint,
  api_key: '',
  default_model_id: view.default_model_id ?? '',
  default_model_version_id: view.default_model_version_id ?? '',
  model_api_keys: {},
  model_api_key_expires_at: Object.fromEntries(
    Object.entries(view.model_api_keys_meta ?? {}).map(([key, meta]) => [key, meta.expires_at ?? ''])
  ),
  model_api_key_max_calls: Object.fromEntries(
    Object.entries(view.model_api_keys_meta ?? {}).map(([key, meta]) => [
      key,
      typeof meta.max_calls === 'number' ? String(meta.max_calls) : ''
    ])
  ),
  model_api_keys_meta: view.model_api_keys_meta ?? {},
  local_model_path: view.local_model_path,
  local_train_command: view.local_train_command,
  local_predict_command: view.local_predict_command,
  has_api_key: view.has_api_key,
  api_key_masked: view.api_key_masked
});

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


type RuntimeApiKeyExpiryTier = 'none' | 'healthy' | 'within_7_days' | 'within_3_days' | 'expired';

type RuntimeApiKeyExpiryStatus = {
  tier: RuntimeApiKeyExpiryTier;
  daysLeft: number | null;
};

const runtimeApiKeyExpiryTiers = new Set<RuntimeApiKeyExpiryTier>([
  'none',
  'healthy',
  'within_7_days',
  'within_3_days',
  'expired'
]);

const resolveRuntimeApiKeyExpiryStatus = (
  meta?: RuntimeApiKeyMetaView | null
): RuntimeApiKeyExpiryStatus => {
  if (!meta) {
    return {
      tier: 'none',
      daysLeft: null
    };
  }
  if (runtimeApiKeyExpiryTiers.has(meta.expires_status)) {
    const normalizedDays =
      typeof meta.expires_in_days === 'number' && Number.isFinite(meta.expires_in_days)
        ? Math.max(0, Math.floor(meta.expires_in_days))
        : null;
    return {
      tier: meta.expires_status,
      daysLeft: normalizedDays
    };
  }
  const expiresAt = meta.expires_at;
  if (!expiresAt || !expiresAt.trim()) {
    return {
      tier: 'none',
      daysLeft: null
    };
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return {
      tier: 'none',
      daysLeft: null
    };
  }
  const deltaMs = expiresAtMs - Date.now();
  if (deltaMs <= 0) {
    return {
      tier: 'expired',
      daysLeft: 0
    };
  }
  const daysLeft = Math.max(1, Math.ceil(deltaMs / (24 * 60 * 60 * 1000)));
  if (daysLeft <= 3) {
    return {
      tier: 'within_3_days',
      daysLeft
    };
  }
  if (daysLeft <= 7) {
    return {
      tier: 'within_7_days',
      daysLeft
    };
  }
  return {
    tier: 'healthy',
    daysLeft
  };
};

export default function RuntimeSettingsPage() {
  const { t } = useI18n();
  const runtimeUiBuildId = (import.meta.env.VITE_APP_BUILD_ID as string | undefined)?.trim() ?? '';
  const runtimeRecommendedLocalPythonBin = '/opt/vistral-venv/bin/python';
  const runtimeUiBuildLabel = runtimeUiBuildId
    ? runtimeUiBuildId.length > 24
      ? `${runtimeUiBuildId.slice(0, 24)}...`
      : runtimeUiBuildId
    : t('unknown');
  const [checks, setChecks] = useState<RuntimeConnectivityRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [runtimeSettingsLoading, setRuntimeSettingsLoading] = useState(true);
  const [runtimeSettingsSaving, setRuntimeSettingsSaving] = useState(false);
  const [runtimeSettingsClearing, setRuntimeSettingsClearing] = useState(false);
  const [runtimeSettingsAutoConfiguring, setRuntimeSettingsAutoConfiguring] = useState(false);
  const [runtimeSettingsAutoBootstrapAttempted, setRuntimeSettingsAutoBootstrapAttempted] =
    useState(false);
  const [runtimeSettingsError, setRuntimeSettingsError] = useState('');
  const [runtimeSettingsMessage, setRuntimeSettingsMessage] = useState('');
  const [runtimeReadinessLoading, setRuntimeReadinessLoading] = useState(true);
  const [runtimeReadiness, setRuntimeReadiness] = useState<RuntimeReadinessReport | null>(null);
  const [runtimeReadinessError, setRuntimeReadinessError] = useState('');
  const [runtimeSettingsUpdatedAt, setRuntimeSettingsUpdatedAt] = useState<string | null>(null);
  const [runtimeSettingsActiveProfileId, setRuntimeSettingsActiveProfileId] = useState<string | null>(null);
  const [runtimeProfiles, setRuntimeProfiles] = useState<RuntimeProfileView[]>([]);
  const [selectedRuntimeProfileId, setSelectedRuntimeProfileId] = useState('');
  const [runtimeProfileActivating, setRuntimeProfileActivating] = useState(false);
  const [runtimeBaselineSnapshotKey, setRuntimeBaselineSnapshotKey] = useState('');
  const [keepExistingApiKeys, setKeepExistingApiKeys] = useState(true);
  const [runtimeDrafts, setRuntimeDrafts] = useState<RuntimeFrameworkDraftMap>(() =>
    buildDefaultRuntimeFrameworkDraftMap()
  );
  const [runtimeModelOptionsLoading, setRuntimeModelOptionsLoading] = useState(true);
  const [runtimeModelOptionsError, setRuntimeModelOptionsError] = useState('');
  const [runtimeModels, setRuntimeModels] = useState<ModelRecord[]>([]);
  const [runtimeModelVersions, setRuntimeModelVersions] = useState<ModelVersionRecord[]>([]);
  const [runtimeControlDraft, setRuntimeControlDraft] = useState<RuntimeControlDraft>(() =>
    buildDefaultRuntimeControlDraft()
  );
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [llmConfigLoading, setLlmConfigLoading] = useState(true);
  const [llmConfigView, setLlmConfigView] = useState<LlmConfigView | null>(null);
  const [llmConfigError, setLlmConfigError] = useState('');
  const runtimeConfigurationRef = useRef<HTMLDivElement | null>(null);
  const readinessSectionRef = useRef<HTMLDivElement | null>(null);
  const [inferenceSourceSummary, setInferenceSourceSummary] = useState<
    Array<{ key: InferenceRealitySummaryKey; count: number }>
  >([]);
  const [trainingModeSummary, setTrainingModeSummary] = useState<Array<{ key: string; count: number }>>([]);
  const [trainingJobLabels, setTrainingJobLabels] = useState<Record<string, string>>({});
  const [frameworkMetricKeySummary, setFrameworkMetricKeySummary] = useState<FrameworkMetricKeySummary[]>(
    () => buildEmptyFrameworkMetricKeySummary()
  );
  const [metricsRetentionSummary, setMetricsRetentionSummary] = useState<RuntimeMetricsRetentionSummary | null>(null);
  const [frameworkFilter, setFrameworkFilter] = useState<'all' | ModelFramework>('all');

  const describeErrorKind = useCallback((kind: RuntimeConnectivityRecord['error_kind']) => {
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
      return t('Runtime response format is incompatible. Verify endpoint response fields.');
    }
    if (kind === 'none') {
      return t('No connectivity error.');
    }
    return t('Unknown runtime error. Check runtime logs for details.');
  }, [t]);

  const copyText = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setRuntimeSettingsMessage(t('{label} copied.', { label }));
    } catch (copyError) {
      setRuntimeSettingsError(t('Copy failed: {message}', { message: (copyError as Error).message }));
    }
  };

  const generateRuntimeApiKeyLocal = () => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const length = 36;
    if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
      const random = new Uint8Array(length);
      window.crypto.getRandomValues(random);
      const token = Array.from(random)
        .map((value) => alphabet[value % alphabet.length])
        .join('');
      return `vsk_${token}`;
    }
    return `vsk_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  };

  const generateRuntimeApiKey = async (): Promise<string> => {
    try {
      const generated = await api.generateRuntimeApiKey();
      const key = typeof generated.api_key === 'string' ? generated.api_key.trim() : '';
      if (key) {
        return key;
      }
    } catch {
      // fallback to local generation when backend helper is unavailable
    }
    return generateRuntimeApiKeyLocal();
  };

  const applyRuntimeSettingsView = (view: RuntimeSettingsView) => {
    setRuntimeSettingsUpdatedAt(view.updated_at);
    const availableProfiles = Array.isArray(view.available_profiles) ? view.available_profiles : [];
    setRuntimeProfiles(availableProfiles);
    const activeProfileId =
      typeof view.active_profile_id === 'string' && view.active_profile_id.trim()
        ? view.active_profile_id.trim()
        : null;
    setRuntimeSettingsActiveProfileId(activeProfileId);
    setSelectedRuntimeProfileId(
      activeProfileId ?? (availableProfiles[0]?.id ? availableProfiles[0].id : '')
    );
    const nextDrafts = {
      paddleocr: mergeRuntimeFrameworkDraft(view.frameworks.paddleocr),
      doctr: mergeRuntimeFrameworkDraft(view.frameworks.doctr),
      yolo: mergeRuntimeFrameworkDraft(view.frameworks.yolo)
    };
    const nextControls = {
      python_bin: view.controls.python_bin,
      disable_simulated_train_fallback: view.controls.disable_simulated_train_fallback,
      disable_inference_fallback: view.controls.disable_inference_fallback
    };
    setRuntimeDrafts(nextDrafts);
    setRuntimeControlDraft(nextControls);
    setRuntimeBaselineSnapshotKey(
      normalizeRuntimeSnapshot({
        frameworks: nextDrafts,
        controls: nextControls
      })
    );
  };

  const runtimeDraftSnapshotKey = useMemo(
    () =>
      normalizeRuntimeSnapshot({
        frameworks: runtimeDrafts,
        controls: runtimeControlDraft
      }),
    [runtimeDrafts, runtimeControlDraft]
  );
  const runtimeHasUnsavedChanges = Boolean(runtimeBaselineSnapshotKey) && runtimeDraftSnapshotKey !== runtimeBaselineSnapshotKey;
  const selectedRuntimeProfile = useMemo(
    () => runtimeProfiles.find((profile) => profile.id === selectedRuntimeProfileId) ?? null,
    [runtimeProfiles, selectedRuntimeProfileId]
  );
  const runtimeConnectionModes = useMemo<RuntimeConnectionModeMap>(
    () => ({
      paddleocr: resolveRuntimeConnectionMode(runtimeDrafts.paddleocr),
      doctr: resolveRuntimeConnectionMode(runtimeDrafts.doctr),
      yolo: resolveRuntimeConnectionMode(runtimeDrafts.yolo)
    }),
    [runtimeDrafts]
  );
  const runtimeAllFrameworksLocalMode = FRAMEWORKS.every(
    (framework) => runtimeConnectionModes[framework] === 'local'
  );
  const runtimeModelById = useMemo(
    () => new Map(runtimeModels.map((model) => [model.id, model])),
    [runtimeModels]
  );
  const frameworkModelOptions = useMemo<Record<ModelFramework, RuntimeModelOption[]>>(() => {
    const result: Record<ModelFramework, RuntimeModelOption[]> = {
      paddleocr: [],
      doctr: [],
      yolo: []
    };
    FRAMEWORKS.forEach((framework) => {
      const supportedTaskTypes = runtimeFrameworkTaskTypes[framework];
      const frameworkModels = runtimeModels
        .filter((model) => supportedTaskTypes.includes(model.model_type))
        .filter((model) => {
          const frameworkHint = (model.metadata.framework ?? '').trim().toLowerCase();
          if (!frameworkHint) {
            return true;
          }
          return frameworkHint === framework;
        })
        .filter((model) => {
          const isFoundation = (model.metadata.foundation ?? '').trim().toLowerCase() === 'true';
          const hasRegisteredVersion = runtimeModelVersions.some(
            (version) => version.model_id === model.id && version.status === 'registered'
          );
          const isPublished = model.status === 'published';
          return isFoundation || isPublished || hasRegisteredVersion;
        })
        .map((model) => {
          const isFoundation = (model.metadata.foundation ?? '').trim().toLowerCase() === 'true';
          const isPublished = model.status === 'published';
          const labelPrefix = isFoundation
            ? t('[Foundation]')
            : isPublished
              ? t('[Published]')
              : t('[Registered]');
          return {
            id: model.id,
            label: `${labelPrefix} ${model.name}`,
            isFoundation,
            isPublished,
            modelType: model.model_type
          };
        })
        .sort((left, right) => left.label.localeCompare(right.label));
      result[framework] = frameworkModels;
    });
    return result;
  }, [runtimeModels, runtimeModelVersions, t]);
  const frameworkVersionOptions = useMemo<Record<ModelFramework, RuntimeModelVersionOption[]>>(() => {
    const result: Record<ModelFramework, RuntimeModelVersionOption[]> = {
      paddleocr: [],
      doctr: [],
      yolo: []
    };
    FRAMEWORKS.forEach((framework) => {
      const selectedModelId = runtimeDrafts[framework].default_model_id.trim();
      const supportedTaskTypes = runtimeFrameworkTaskTypes[framework];
      const versions = runtimeModelVersions
        .filter((version) => version.status === 'registered')
        .filter((version) => {
          const model = runtimeModelById.get(version.model_id);
          if (!model) {
            return false;
          }
          if (!supportedTaskTypes.includes(model.model_type)) {
            return false;
          }
          const frameworkHint = (model.metadata.framework ?? '').trim().toLowerCase();
          if (frameworkHint && frameworkHint !== framework) {
            return false;
          }
          if (selectedModelId && version.model_id !== selectedModelId) {
            return false;
          }
          return true;
        })
        .map((version) => {
          const model = runtimeModelById.get(version.model_id);
          const modelName = model?.name?.trim() || version.model_id;
          return {
            id: version.id,
            modelId: version.model_id,
            label: `${modelName} / ${version.version_name}`
          };
        })
        .sort((left, right) => left.label.localeCompare(right.label));
      result[framework] = versions;
    });
    return result;
  }, [runtimeDrafts, runtimeModelById, runtimeModelVersions]);

  const activateRuntimeProfile = async () => {
    const profileId = selectedRuntimeProfileId.trim();
    if (!profileId) {
      return;
    }

    if (runtimeHasUnsavedChanges) {
      const proceed = window.confirm(
        t('You have unsaved runtime edits. Activating a profile will overwrite current draft values. Continue?')
      );
      if (!proceed) {
        return;
      }
    }

    setRuntimeProfileActivating(true);
    setRuntimeSettingsError('');
    setRuntimeSettingsMessage('');
    try {
      const updated = await api.activateRuntimeProfile(profileId);
      applyRuntimeSettingsView(updated);
      setRuntimeSettingsMessage(t('Runtime profile activated.'));
      void refresh();
      void refreshRuntimeReadiness();
    } catch (runtimeProfileError) {
      setRuntimeSettingsError((runtimeProfileError as Error).message);
    } finally {
      setRuntimeProfileActivating(false);
    }
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

  const refreshRuntimeReadiness = useCallback(async () => {
    setRuntimeReadinessLoading(true);
    setRuntimeReadinessError('');
    try {
      const report = await api.getRuntimeReadiness();
      setRuntimeReadiness(report);
    } catch (runtimeReadinessLoadError) {
      setRuntimeReadinessError((runtimeReadinessLoadError as Error).message);
    } finally {
      setRuntimeReadinessLoading(false);
    }
  }, []);

  const refresh = useCallback(async (framework?: ModelFramework) => {
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
  }, []);

  const refreshRuntimeModelOptions = async () => {
    setRuntimeModelOptionsLoading(true);
    setRuntimeModelOptionsError('');
    try {
      const [models, modelVersions] = await Promise.all([
        api.listModels(),
        api.listModelVersions()
      ]);
      setRuntimeModels(models);
      setRuntimeModelVersions(modelVersions);
    } catch (runtimeModelLoadError) {
      setRuntimeModels([]);
      setRuntimeModelVersions([]);
      setRuntimeModelOptionsError((runtimeModelLoadError as Error).message);
    } finally {
      setRuntimeModelOptionsLoading(false);
    }
  };

  const updateRuntimeDraft = (
    framework: ModelFramework,
    field:
      | 'endpoint'
      | 'api_key'
      | 'default_model_id'
      | 'default_model_version_id'
      | 'local_model_path'
      | 'local_train_command'
      | 'local_predict_command',
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

  const updateRuntimeDraftModelApiKey = (
    framework: ModelFramework,
    bindingKey: string,
    apiKeyValue: string
  ) => {
    const normalizedBindingKey = bindingKey.trim();
    if (!normalizedBindingKey) {
      return;
    }
    setRuntimeDrafts((prev) => ({
      ...prev,
      [framework]: {
        ...prev[framework],
        model_api_keys: {
          ...prev[framework].model_api_keys,
          [normalizedBindingKey]: apiKeyValue
        }
      }
    }));
  };

  const updateRuntimeDraftModelApiKeyExpiresAt = (
    framework: ModelFramework,
    bindingKey: string,
    expiresAtValue: string
  ) => {
    const normalizedBindingKey = bindingKey.trim();
    if (!normalizedBindingKey) {
      return;
    }
    setRuntimeDrafts((prev) => ({
      ...prev,
      [framework]: {
        ...prev[framework],
        model_api_key_expires_at: {
          ...prev[framework].model_api_key_expires_at,
          [normalizedBindingKey]: expiresAtValue
        }
      }
    }));
  };

  const updateRuntimeDraftModelApiKeyMaxCalls = (
    framework: ModelFramework,
    bindingKey: string,
    maxCallsValue: string
  ) => {
    const normalizedBindingKey = bindingKey.trim();
    if (!normalizedBindingKey) {
      return;
    }
    setRuntimeDrafts((prev) => ({
      ...prev,
      [framework]: {
        ...prev[framework],
        model_api_key_max_calls: {
          ...prev[framework].model_api_key_max_calls,
          [normalizedBindingKey]: maxCallsValue
        }
      }
    }));
  };

  const generateAndApplyFrameworkApiKey = (framework: ModelFramework) => {
    void (async () => {
      const generatedKey = await generateRuntimeApiKey();
      updateRuntimeDraft(framework, 'api_key', generatedKey);
      setRuntimeSettingsMessage(t('Generated a new runtime API key. Save runtime settings to persist it.'));
      setRuntimeSettingsError('');
    })();
  };

  const generateAndApplyModelBindingApiKey = (
    framework: ModelFramework,
    bindingKey: string
  ) => {
    void (async () => {
      const generatedKey = await generateRuntimeApiKey();
      updateRuntimeDraftModelApiKey(framework, bindingKey, generatedKey);
      setRuntimeSettingsMessage(t('Generated a new runtime API key. Save runtime settings to persist it.'));
      setRuntimeSettingsError('');
    })();
  };

  const revokeRuntimeApiKey = (framework: ModelFramework, bindingKey?: string) => {
    void (async () => {
      setRuntimeSettingsSaving(true);
      setRuntimeSettingsError('');
      setRuntimeSettingsMessage('');
      try {
        const updated = await api.revokeRuntimeApiKey(framework, bindingKey);
        applyRuntimeSettingsView(updated);
        setRuntimeSettingsMessage(
          bindingKey
            ? t('Runtime API key binding revoked.')
            : t('Framework runtime API key revoked.')
        );
      } catch (error) {
        setRuntimeSettingsError((error as Error).message);
      } finally {
        setRuntimeSettingsSaving(false);
      }
    })();
  };

  const rotateRuntimeApiKey = (framework: ModelFramework, bindingKey?: string) => {
    void (async () => {
      setRuntimeSettingsSaving(true);
      setRuntimeSettingsError('');
      setRuntimeSettingsMessage('');
      try {
        const rotated = await api.rotateRuntimeApiKey(framework, bindingKey);
        applyRuntimeSettingsView(rotated.settings);
        try {
          await navigator.clipboard.writeText(rotated.api_key);
          setRuntimeSettingsMessage(
            t('Runtime API key rotated and copied. Save this key in your remote runtime service.')
          );
        } catch {
          setRuntimeSettingsMessage(
            t('Runtime API key rotated. Copy and configure it in your remote runtime service now.')
          );
        }
      } catch (error) {
        setRuntimeSettingsError((error as Error).message);
      } finally {
        setRuntimeSettingsSaving(false);
      }
    })();
  };

  const setRuntimeFrameworkMode = (
    framework: ModelFramework,
    mode: RuntimeConnectionMode
  ) => {
    setRuntimeDrafts((prev) => {
      if (mode === 'endpoint') {
        return prev;
      }
      return {
        ...prev,
        [framework]: {
          ...prev[framework],
          endpoint: '',
          api_key: '',
          model_api_keys: {},
          model_api_key_expires_at: {},
          model_api_key_max_calls: {}
        }
      };
    });
    if (mode === 'local') {
      setKeepExistingApiKeys(true);
    }
  };

  const prepareLocalOnlyRuntimeDraft = useCallback(() => {
    setRuntimeDrafts((prev) => {
      const next: RuntimeFrameworkDraftMap = {
        paddleocr: {
          ...prev.paddleocr,
          endpoint: '',
          api_key: '',
          model_api_keys: {},
          model_api_key_expires_at: {},
          model_api_key_max_calls: {}
        },
        doctr: {
          ...prev.doctr,
          endpoint: '',
          api_key: '',
          model_api_keys: {},
          model_api_key_expires_at: {},
          model_api_key_max_calls: {}
        },
        yolo: {
          ...prev.yolo,
          endpoint: '',
          api_key: '',
          model_api_keys: {},
          model_api_key_expires_at: {},
          model_api_key_max_calls: {}
        }
      };
      return next;
    });
    setKeepExistingApiKeys(true);
    setRuntimeSettingsError('');
    setRuntimeSettingsMessage(
      t('Switched all frameworks to local-only draft mode. Save runtime settings to apply.')
    );
  }, [t]);

  const applyLocalQuickSetup = useCallback(async () => {
    setRuntimeSettingsSaving(true);
    setRuntimeSettingsError('');
    setRuntimeSettingsMessage('');
    try {
      const requestedPythonBin = runtimeControlDraft.python_bin.trim();
      const resolvedPythonBin = requestedPythonBin || runtimeRecommendedLocalPythonBin;
      const localOnlyConfig = {
        paddleocr: {
          endpoint: '',
          api_key: '',
          default_model_id: runtimeDrafts.paddleocr.default_model_id.trim(),
          default_model_version_id: runtimeDrafts.paddleocr.default_model_version_id.trim(),
          model_api_keys: {},
          model_api_key_policies: {},
          local_model_path: runtimeDrafts.paddleocr.local_model_path.trim(),
          local_train_command: runtimeDrafts.paddleocr.local_train_command.trim(),
          local_predict_command: runtimeDrafts.paddleocr.local_predict_command.trim()
        },
        doctr: {
          endpoint: '',
          api_key: '',
          default_model_id: runtimeDrafts.doctr.default_model_id.trim(),
          default_model_version_id: runtimeDrafts.doctr.default_model_version_id.trim(),
          model_api_keys: {},
          model_api_key_policies: {},
          local_model_path: runtimeDrafts.doctr.local_model_path.trim(),
          local_train_command: runtimeDrafts.doctr.local_train_command.trim(),
          local_predict_command: runtimeDrafts.doctr.local_predict_command.trim()
        },
        yolo: {
          endpoint: '',
          api_key: '',
          default_model_id: runtimeDrafts.yolo.default_model_id.trim(),
          default_model_version_id: runtimeDrafts.yolo.default_model_version_id.trim(),
          model_api_keys: {},
          model_api_key_policies: {},
          local_model_path: runtimeDrafts.yolo.local_model_path.trim(),
          local_train_command: runtimeDrafts.yolo.local_train_command.trim(),
          local_predict_command: runtimeDrafts.yolo.local_predict_command.trim()
        }
      };
      const saved = await api.saveRuntimeSettings(
        localOnlyConfig,
        {
          python_bin: resolvedPythonBin,
          disable_simulated_train_fallback: runtimeControlDraft.disable_simulated_train_fallback,
          disable_inference_fallback: runtimeControlDraft.disable_inference_fallback
        },
        true
      );
      applyRuntimeSettingsView(saved);
      if (!requestedPythonBin) {
        setRuntimeControlDraft((prev) => ({
          ...prev,
          python_bin: runtimeRecommendedLocalPythonBin
        }));
      }
      setKeepExistingApiKeys(true);
      setRuntimeSettingsMessage(
        requestedPythonBin
          ? t('Local-only runtime settings applied.')
          : t('Local-only runtime settings applied with recommended Python path.')
      );
      void refresh();
      void refreshRuntimeReadiness();
    } catch (runtimeConfigError) {
      setRuntimeSettingsError((runtimeConfigError as Error).message);
    } finally {
      setRuntimeSettingsSaving(false);
    }
  }, [
    refresh,
    refreshRuntimeReadiness,
    runtimeControlDraft,
    runtimeDrafts,
    runtimeRecommendedLocalPythonBin,
    t
  ]);

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
      const buildModelApiKeyPolicyPayload = (draft: RuntimeFrameworkDraft) => {
        const normalizedKeys = Object.fromEntries(
          Object.entries(draft.model_api_keys)
            .map(([key, value]) => [key.trim(), value.trim()])
            .filter(([key]) => Boolean(key))
        );
        const keySpace = new Set<string>([
          ...Object.keys(normalizedKeys),
          ...Object.keys(draft.model_api_key_expires_at),
          ...Object.keys(draft.model_api_key_max_calls)
        ]);
        const policies: Record<
          string,
          {
            api_key: string;
            expires_at: string | null;
            max_calls: number | null;
            used_calls: number;
            last_used_at: string | null;
          }
        > = {};

        for (const rawKey of keySpace) {
          const bindingKey = rawKey.trim();
          if (!bindingKey) {
            continue;
          }
          const apiKey = (normalizedKeys[bindingKey] ?? '').trim();
          const expiresAtRaw = (draft.model_api_key_expires_at[bindingKey] ?? '').trim();
          const maxCallsRaw = (draft.model_api_key_max_calls[bindingKey] ?? '').trim();
          const parsedMaxCalls = maxCallsRaw ? Number.parseInt(maxCallsRaw, 10) : Number.NaN;
          const maxCalls =
            Number.isFinite(parsedMaxCalls) && parsedMaxCalls >= 0 ? parsedMaxCalls : null;

          policies[bindingKey] = {
            api_key: apiKey,
            expires_at: expiresAtRaw || null,
            max_calls: maxCalls,
            used_calls: 0,
            last_used_at: null
          };
        }

        return {
          model_api_keys: normalizedKeys,
          model_api_key_policies: policies
        };
      };
      const paddleocrPolicies = buildModelApiKeyPolicyPayload(runtimeDrafts.paddleocr);
      const doctrPolicies = buildModelApiKeyPolicyPayload(runtimeDrafts.doctr);
      const yoloPolicies = buildModelApiKeyPolicyPayload(runtimeDrafts.yolo);

      const nextConfig = {
        paddleocr: {
          endpoint: runtimeDrafts.paddleocr.endpoint.trim(),
          api_key: runtimeDrafts.paddleocr.api_key.trim(),
          default_model_id: runtimeDrafts.paddleocr.default_model_id.trim(),
          default_model_version_id: runtimeDrafts.paddleocr.default_model_version_id.trim(),
          model_api_keys: paddleocrPolicies.model_api_keys,
          model_api_key_policies: paddleocrPolicies.model_api_key_policies,
          local_model_path: runtimeDrafts.paddleocr.local_model_path.trim(),
          local_train_command: runtimeDrafts.paddleocr.local_train_command.trim(),
          local_predict_command: runtimeDrafts.paddleocr.local_predict_command.trim()
        },
        doctr: {
          endpoint: runtimeDrafts.doctr.endpoint.trim(),
          api_key: runtimeDrafts.doctr.api_key.trim(),
          default_model_id: runtimeDrafts.doctr.default_model_id.trim(),
          default_model_version_id: runtimeDrafts.doctr.default_model_version_id.trim(),
          model_api_keys: doctrPolicies.model_api_keys,
          model_api_key_policies: doctrPolicies.model_api_key_policies,
          local_model_path: runtimeDrafts.doctr.local_model_path.trim(),
          local_train_command: runtimeDrafts.doctr.local_train_command.trim(),
          local_predict_command: runtimeDrafts.doctr.local_predict_command.trim()
        },
        yolo: {
          endpoint: runtimeDrafts.yolo.endpoint.trim(),
          api_key: runtimeDrafts.yolo.api_key.trim(),
          default_model_id: runtimeDrafts.yolo.default_model_id.trim(),
          default_model_version_id: runtimeDrafts.yolo.default_model_version_id.trim(),
          model_api_keys: yoloPolicies.model_api_keys,
          model_api_key_policies: yoloPolicies.model_api_key_policies,
          local_model_path: runtimeDrafts.yolo.local_model_path.trim(),
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
      void refreshRuntimeReadiness();
    } catch (runtimeConfigError) {
      setRuntimeSettingsError((runtimeConfigError as Error).message);
    } finally {
      setRuntimeSettingsSaving(false);
    }
  };

  const clearRuntimeSettingsConfig = async () => {
    const confirmed = window.confirm(
      t('Clear UI-saved runtime settings and switch back to environment defaults?')
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
      void refreshRuntimeReadiness();
    } catch (runtimeConfigError) {
      setRuntimeSettingsError((runtimeConfigError as Error).message);
    } finally {
      setRuntimeSettingsClearing(false);
    }
  };

  const autoConfigureRuntimeSettingsConfig = async (overwriteEndpoint = false) => {
    if (overwriteEndpoint) {
      const confirmed = window.confirm(
        t(
          'Auto-configure will probe candidate runtime endpoints and overwrite existing endpoint fields. Continue?'
        )
      );
      if (!confirmed) {
        return;
      }
    }

    setRuntimeSettingsAutoConfiguring(true);
    setRuntimeSettingsError('');
    setRuntimeSettingsMessage('');
    try {
      const autoConfigured = await api.autoConfigureRuntimeSettings(overwriteEndpoint);
      applyRuntimeSettingsView(autoConfigured);
      setRuntimeSettingsMessage(
        overwriteEndpoint
          ? t('Runtime auto-config completed (including endpoint overwrite).')
          : t('Runtime auto-config completed.')
      );
      void refresh();
      void refreshRuntimeReadiness();
    } catch (runtimeConfigError) {
      setRuntimeSettingsError((runtimeConfigError as Error).message);
    } finally {
      setRuntimeSettingsAutoConfiguring(false);
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
      const sourceCounter = new Map<InferenceRealitySummaryKey, number>();
      runs.forEach((run) => {
        const reality = detectInferenceRunReality(run);
        const key: InferenceRealitySummaryKey = reality.fallback ? 'fallback' : 'real';
        sourceCounter.set(key, (sourceCounter.get(key) ?? 0) + 1);
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

  const refreshLlmConfigSummary = async () => {
    setLlmConfigLoading(true);
    setLlmConfigError('');
    try {
      const view = await api.getLlmConfig();
      setLlmConfigView(view);
    } catch (llmLoadError) {
      setLlmConfigView(null);
      setLlmConfigError((llmLoadError as Error).message);
    } finally {
      setLlmConfigLoading(false);
    }
  };

  // Run one-time bootstrap pulls for diagnostics and worker/runtime summaries.
  useEffect(() => {
    void refresh();
    void refreshRuntimeSettings();
    void refreshRuntimeReadiness();
    void refreshRuntimeModelOptions();
    void refreshExecutionSummary();
    void refreshLlmConfigSummary();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (runtimeSettingsLoading || runtimeSettingsAutoConfiguring || runtimeSettingsAutoBootstrapAttempted) {
      return;
    }
    if (runtimeSettingsError) {
      return;
    }
    if (runtimeSettingsUpdatedAt) {
      return;
    }

    setRuntimeSettingsAutoBootstrapAttempted(true);
    setRuntimeSettingsAutoConfiguring(true);
    setRuntimeSettingsMessage(t('Running initial runtime auto-config...'));

    void (async () => {
      try {
        const autoConfigured = await api.autoConfigureRuntimeSettings(false);
        applyRuntimeSettingsView(autoConfigured);
        setRuntimeSettingsMessage(t('Initial runtime auto-config completed.'));
        void refresh();
        void refreshRuntimeReadiness();
      } catch (runtimeConfigError) {
        setRuntimeSettingsError((runtimeConfigError as Error).message);
      } finally {
        setRuntimeSettingsAutoConfiguring(false);
      }
    })();
  }, [
    runtimeSettingsLoading,
    runtimeSettingsAutoConfiguring,
    runtimeSettingsAutoBootstrapAttempted,
    runtimeSettingsError,
    runtimeSettingsUpdatedAt,
    refresh,
    refreshRuntimeReadiness,
    t
  ]);

  const checkByFramework = useMemo(
    () => new Map(checks.map((item) => [item.framework, item])),
    [checks]
  );

  const visibleFrameworks = frameworkFilter === 'all' ? FRAMEWORKS : [frameworkFilter];
  const reachableCount = checks.filter((item) => item.source === 'reachable').length;
  const unreachableCount = checks.filter((item) => item.source === 'unreachable').length;
  const configuredCount = checks.filter((item) => item.source !== 'not_configured').length;
  const notConfiguredCount = Math.max(FRAMEWORKS.length - configuredCount, 0);
  const hasCompletedTrainingJobs = frameworkMetricKeySummary.some((entry) => entry.jobsChecked > 0);
  const runtimeReadinessIssueCount = runtimeReadiness?.issues.length ?? 0;
  const runtimeReadinessErrorCount =
    runtimeReadiness?.issues.filter((item) => item.level === 'error').length ?? 0;
  const runtimeReadinessWarningCount =
    runtimeReadiness?.issues.filter((item) => item.level === 'warning').length ?? 0;
  const runtimeReadinessBadgeTone =
    runtimeReadiness?.status === 'ready'
      ? 'success'
      : runtimeReadiness?.status === 'degraded'
        ? 'warning'
        : 'danger';
  const runtimeReadinessFixCommands = useMemo(() => {
    if (!runtimeReadiness) {
      return [] as string[];
    }

    const uniqueCommands = new Set<string>();
    for (const issue of runtimeReadiness.issues) {
      const command = issue.remediation_command?.trim();
      if (command) {
        uniqueCommands.add(command);
      }
    }
    return Array.from(uniqueCommands);
  }, [runtimeReadiness]);
  const runtimeReadinessCommandGroups = useMemo(() => {
    if (!runtimeReadiness) {
      return [] as RuntimeReadinessCommandGroup[];
    }

    const groups = new Map<string, { label: string; commands: Set<string> }>();
    const ensureGroup = (key: string, label: string) => {
      if (!groups.has(key)) {
        groups.set(key, { label, commands: new Set<string>() });
      }
      return groups.get(key)!;
    };
    const classifyIssueGroup = (issueCode: string) => {
      if (issueCode.includes('endpoint')) {
        return { key: 'endpoint', label: t('Endpoint checks') };
      }
      if (issueCode.includes('python') || issueCode.includes('module')) {
        return { key: 'python', label: t('Python dependency fixes') };
      }
      if (issueCode.includes('local_command')) {
        return { key: 'local_command', label: t('Local execution command fixes') };
      }
      if (issueCode.includes('strict')) {
        return { key: 'strict', label: t('Safety guard follow-ups') };
      }
      return { key: 'general', label: t('General fixes') };
    };

    for (const issue of runtimeReadiness.issues) {
      const command = issue.remediation_command?.trim();
      if (!command) {
        continue;
      }
      const group = classifyIssueGroup(issue.code);
      ensureGroup(group.key, group.label).commands.add(command);
    }

    return Array.from(groups.entries()).map(([key, value]) => ({
      key,
      label: value.label,
      commands: Array.from(value.commands)
    }));
  }, [runtimeReadiness, t]);
  const runtimeReadinessOpsChecklist = useMemo(() => {
    if (!runtimeReadiness) {
      return '';
    }

    const lines: string[] = [
      `${t('Runtime readiness')} (${runtimeReadiness.status})`,
      `${t('checked at')}: ${runtimeReadiness.checked_at}`,
      `${t('Configured Python executable')}: ${runtimeReadiness.python_bin_requested || t('platform default')}`,
      `${t('Detected Python executable')}: ${runtimeReadiness.python_bin_resolved || t('unavailable')}`,
      `${t('Issues')}: ${runtimeReadinessIssueCount} (${t('error')} ${runtimeReadinessErrorCount} / ${t('warning')} ${runtimeReadinessWarningCount})`,
      '',
      `${t('Issue details')}:`
    ];
    for (const issue of runtimeReadiness.issues) {
      lines.push(`- [${issue.level}] ${issue.code}: ${issue.message}`);
      if (issue.remediation) {
        lines.push(`  ${t('Remediation')}: ${issue.remediation}`);
      }
      if (issue.remediation_command) {
        lines.push(`  ${t('Fix command')}: ${issue.remediation_command}`);
      }
    }

    if (runtimeReadinessCommandGroups.length > 0) {
      lines.push('');
      lines.push(`${t('Grouped fix commands')}:`);
      for (const group of runtimeReadinessCommandGroups) {
        lines.push(`- ${group.label}`);
        for (const command of group.commands) {
          lines.push(`  - ${command}`);
        }
      }
    }

    return lines.join('\n');
  }, [
    runtimeReadiness,
    runtimeReadinessIssueCount,
    runtimeReadinessErrorCount,
    runtimeReadinessWarningCount,
    runtimeReadinessCommandGroups,
    t
  ]);
  const doctrBootstrapFailureIssue = useMemo(
    () =>
      runtimeReadiness?.issues.find((issue) => issue.code === 'runtime_bootstrap_failed_doctr') ??
      null,
    [runtimeReadiness]
  );
  const doctrBootstrapAsset = useMemo(
    () =>
      runtimeReadiness?.bootstrap_assets.find((asset) => asset.framework === 'doctr') ?? null,
    [runtimeReadiness]
  );
  const doctrPreseedExpectedFiles = doctrBootstrapAsset?.expected_files ?? [];
  const doctrPreseedMissingFiles = doctrBootstrapAsset?.missing_files ?? [];
  const doctrPreseedRuntimeDir =
    doctrBootstrapAsset?.preseed_dir?.trim() || defaultDoctrPreseedRuntimeDir;
  const doctrPreseedHostDirHint = resolveDoctrPreseedHostDirHint(doctrPreseedRuntimeDir);
  const doctrPreseedExpectedFileNames =
    doctrPreseedExpectedFiles.length > 0
      ? doctrPreseedExpectedFiles.map((item) => item.name)
      : defaultDoctrPreseedExpectedFiles;
  const showDoctrPreseedRecoveryGuide =
    resolveRuntimeConnectionMode(runtimeDrafts.doctr) === 'local' && Boolean(doctrBootstrapFailureIssue);
  const runtimeManualTaskItems = useMemo<RuntimeManualTaskItem[]>(() => {
    const items: RuntimeManualTaskItem[] = [];

    if (llmConfigLoading) {
      items.push({
        key: 'llm',
        title: t('LLM key configuration'),
        status: 'pending',
        detail: t('Checking whether a usable LLM API key is already configured.')
      });
    } else if (llmConfigError) {
      items.push({
        key: 'llm',
        title: t('LLM key configuration'),
        status: 'warning',
        detail: t('Unable to load LLM settings. Verify account/session, then open LLM settings to confirm API key state.'),
        actionLabel: t('Open LLM Settings'),
        actionHref: '/settings/llm'
      });
    } else {
      const hasLlmKey = Boolean(llmConfigView?.enabled && llmConfigView?.has_api_key);
      items.push({
        key: 'llm',
        title: t('LLM key configuration'),
        status: hasLlmKey ? 'ready' : 'action_required',
        detail: hasLlmKey
          ? t('LLM key is configured. Conversation and assistant routing can use real provider credentials.')
          : t('No active LLM API key is configured. Chat and ops bridge may stay in mock/default mode until key is set.'),
        actionLabel: t('Open LLM Settings'),
        actionHref: '/settings/llm'
      });
    }

    if (checking && checks.length === 0) {
      items.push({
        key: 'runtime-endpoint',
        title: t('Runtime endpoint availability'),
        status: 'pending',
        detail: t('Checking runtime endpoint reachability across frameworks.')
      });
    } else if (reachableCount > 0) {
      items.push({
        key: 'runtime-endpoint',
        title: t('Runtime endpoint availability'),
        status: 'ready',
        detail: t('At least one framework endpoint is reachable. Real runtime execution path is available.')
      });
    } else if (configuredCount > 0 && unreachableCount > 0) {
      items.push({
        key: 'runtime-endpoint',
        title: t('Runtime endpoint availability'),
        status: 'warning',
        detail: t(
          'Endpoint is configured but currently unreachable. Fix connectivity, or keep safety guards enabled before production runs.'
        ),
        actionLabel: t('Open Runtime Settings'),
        actionHref: '/settings/runtime'
      });
    } else {
      items.push({
        key: 'runtime-endpoint',
        title: t('Runtime endpoint availability'),
        status: 'action_required',
        detail: t(
          'No reachable runtime endpoint. You can continue with local execution, but production runs require either a reachable endpoint or a verified local environment.'
        ),
        actionLabel: t('Open Runtime Settings'),
        actionHref: '/settings/runtime'
      });
    }

    if (runtimeReadinessLoading) {
      items.push({
        key: 'local-runtime',
        title: t('Local runtime dependencies'),
        status: 'pending',
        detail: t('Checking local runtime environment (Python and command configuration).')
      });
    } else if (runtimeReadinessError) {
      items.push({
        key: 'local-runtime',
        title: t('Local runtime dependencies'),
        status: 'warning',
        detail: t('Runtime readiness check failed. Resolve connectivity/auth issue first, then rerun readiness.')
      });
    } else if (runtimeReadiness) {
      const localIssues = runtimeReadiness.issues.filter(
        (issue) =>
          issue.code.includes('python') ||
          issue.code.includes('module') ||
          issue.code.includes('local_command') ||
          issue.code.includes('model_path') ||
          issue.code.includes('bootstrap_failed')
      );
      const localErrors = localIssues.filter((issue) => issue.level === 'error').length;
      const localWarnings = localIssues.filter((issue) => issue.level === 'warning').length;
      if (localErrors > 0) {
        items.push({
          key: 'local-runtime',
          title: t('Local runtime dependencies'),
          status: 'action_required',
          detail: t('Local runtime has blocking issues ({errors} errors / {warnings} warnings). Run fix commands in readiness panel.', {
            errors: localErrors,
            warnings: localWarnings
          })
        });
      } else if (localWarnings > 0) {
        items.push({
          key: 'local-runtime',
          title: t('Local runtime dependencies'),
          status: 'warning',
          detail: t('Local runtime has follow-up warnings ({warnings}). Recommended to fix before production runs.', {
            warnings: localWarnings
          })
        });
      } else {
        items.push({
          key: 'local-runtime',
          title: t('Local runtime dependencies'),
          status: 'ready',
          detail: t('No blocking local runtime dependency issues detected.')
        });
      }
    }

    return items;
  }, [
    checking,
    checks.length,
    configuredCount,
    llmConfigError,
    llmConfigLoading,
    llmConfigView,
    reachableCount,
    runtimeReadiness,
    runtimeReadinessError,
    runtimeReadinessLoading,
    t,
    unreachableCount
  ]);
  const runtimeManualTaskPendingCount = runtimeManualTaskItems.filter((item) => item.status === 'pending').length;
  const runtimeManualTaskBlockingCount = runtimeManualTaskItems.filter((item) => item.status === 'action_required').length;
  const runtimeManualTaskWarningCount = runtimeManualTaskItems.filter((item) => item.status === 'warning').length;
  const runtimeManualTaskStatusTone = (
    status: RuntimeManualTaskItem['status']
  ): 'success' | 'warning' | 'danger' | 'neutral' => {
    if (status === 'ready') {
      return 'success';
    }
    if (status === 'action_required') {
      return 'danger';
    }
    if (status === 'warning') {
      return 'warning';
    }
    return 'neutral';
  };
  const runtimeReadinessReady = runtimeReadiness?.status === 'ready' && runtimeManualTaskBlockingCount === 0;
  const runtimeLocalConfigPersisted = runtimeAllFrameworksLocalMode && !runtimeHasUnsavedChanges;
  const runtimeConfigurationPrepared =
    configuredCount > 0 || (runtimeLocalConfigPersisted && Boolean(runtimeSettingsUpdatedAt));
  const runtimeExecutionPathReady = reachableCount > 0 || runtimeLocalConfigPersisted;
  const runtimeLocalQuickSetupRecommended =
    notConfiguredCount === FRAMEWORKS.length && !runtimeConfigurationPrepared;
  const localQuickStartSteps = useMemo(
    () => [
      {
        key: 'prepare',
        label: t('Prepare local-only draft'),
        done: runtimeAllFrameworksLocalMode
      },
      {
        key: 'apply',
        label: t('Apply local quick setup'),
        done: runtimeLocalConfigPersisted && Boolean(runtimeSettingsUpdatedAt)
      },
      {
        key: 'readiness',
        label: t('Run readiness checks'),
        done: runtimeReadinessReady
      }
    ],
    [runtimeAllFrameworksLocalMode, runtimeLocalConfigPersisted, runtimeReadinessReady, runtimeSettingsUpdatedAt, t]
  );
  const localQuickStartNextStep =
    localQuickStartSteps.find((stepItem) => !stepItem.done) ?? null;
  const localQuickStartCompletedCount = localQuickStartSteps.filter((stepItem) => stepItem.done).length;
  const localQuickStartCompleted = localQuickStartCompletedCount === localQuickStartSteps.length;
  const localQuickStartCurrentIndex = localQuickStartNextStep
    ? localQuickStartSteps.findIndex((stepItem) => stepItem.key === localQuickStartNextStep.key)
    : localQuickStartSteps.length;
  const runtimeOnboardingSteps = useMemo(
    () => [
      {
        key: 'configure',
        label: t('Configure at least one framework'),
        detail: runtimeLocalQuickSetupRecommended
          ? t('Use local quick setup to save a local-first runtime baseline, then run readiness checks.')
          : t('Complete endpoint or local command settings (or run auto-config) so framework checks can run.'),
        done: runtimeConfigurationPrepared,
        to: '/settings/runtime',
        cta: t('Open runtime configuration')
      },
      {
        key: 'profile',
        label: t('Activate runtime profile'),
        detail: t('Switch active runtime profile so checks and execution follow the intended target.'),
        done: Boolean(runtimeSettingsActiveProfileId),
        to: '/settings/runtime',
        cta: t('Activate profile')
      },
      {
        key: 'readiness',
        label: t('Pass readiness checks'),
        detail: t('Resolve local environment issues and safety checks before production runs.'),
        done: runtimeReadinessReady,
        to: '/settings/runtime',
        cta: t('Run readiness checks')
      },
      {
        key: 'next',
        label: t('Continue to validation lane'),
        detail: t('After readiness is green, run inference validation with real runtime output.'),
        done: runtimeReadinessReady && runtimeConfigurationPrepared && runtimeExecutionPathReady,
        to: '/inference/validate',
        cta: t('Validate Inference')
      }
    ],
    [
      runtimeConfigurationPrepared,
      runtimeExecutionPathReady,
      runtimeLocalQuickSetupRecommended,
      runtimeReadinessReady,
      runtimeSettingsActiveProfileId,
      t
    ]
  );
  const nextOnboardingStep = useMemo(
    () => runtimeOnboardingSteps.find((stepItem) => !stepItem.done) ?? null,
    [runtimeOnboardingSteps]
  );
  const nextOnboardingStepIndex = useMemo(
    () =>
      nextOnboardingStep
        ? runtimeOnboardingSteps.findIndex((stepItem) => stepItem.key === nextOnboardingStep.key) + 1
        : 0,
    [nextOnboardingStep, runtimeOnboardingSteps]
  );

  const focusRuntimeConfiguration = useCallback(() => {
    runtimeConfigurationRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const focusReadinessSection = useCallback(() => {
    readinessSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const renderRuntimeNextAction = useCallback(
    (
      stepItem: (typeof runtimeOnboardingSteps)[number],
      options?: {
        variant?: 'secondary' | 'ghost';
      }
    ) => {
      const variant = options?.variant ?? 'secondary';

      if (stepItem.key === 'next') {
        return (
          <ButtonLink to={stepItem.to} variant={variant} size="sm">
            {stepItem.cta}
          </ButtonLink>
        );
      }

      if (stepItem.key === 'readiness') {
        return (
          <Button type="button" variant={variant} size="sm" onClick={focusReadinessSection}>
            {stepItem.cta}
          </Button>
        );
      }

      if (stepItem.key === 'configure' && runtimeLocalQuickSetupRecommended) {
        return (
          <Button
            type="button"
            variant={variant}
            size="sm"
            onClick={() => void applyLocalQuickSetup()}
            disabled={
              runtimeSettingsLoading ||
              runtimeSettingsSaving ||
              runtimeSettingsClearing ||
              runtimeSettingsAutoConfiguring
            }
          >
            {runtimeSettingsSaving ? t('Applying...') : t('Apply local quick setup')}
          </Button>
        );
      }

      return (
        <Button type="button" variant={variant} size="sm" onClick={focusRuntimeConfiguration}>
          {stepItem.key === 'profile' ? t('Activate profile') : t('Open runtime configuration')}
        </Button>
      );
    },
    [
      applyLocalQuickSetup,
      focusReadinessSection,
      focusRuntimeConfiguration,
      runtimeLocalQuickSetupRecommended,
      runtimeSettingsAutoConfiguring,
      runtimeSettingsClearing,
      runtimeSettingsLoading,
      runtimeSettingsSaving,
      t
    ]
  );
  const renderLocalQuickStartAction = useCallback(
    (variant: 'secondary' | 'ghost' = 'secondary') => {
      if (localQuickStartNextStep?.key === 'prepare') {
        return (
          <Button
            type="button"
            size="sm"
            variant={variant}
            onClick={prepareLocalOnlyRuntimeDraft}
            disabled={
              runtimeSettingsLoading ||
              runtimeSettingsSaving ||
              runtimeSettingsClearing ||
              runtimeSettingsAutoConfiguring
            }
          >
            {t('Prepare local-only draft')}
          </Button>
        );
      }

      if (localQuickStartNextStep?.key === 'apply') {
        return (
          <Button
            type="button"
            size="sm"
            variant={variant}
            onClick={() => void applyLocalQuickSetup()}
            disabled={
              runtimeSettingsLoading ||
              runtimeSettingsSaving ||
              runtimeSettingsClearing ||
              runtimeSettingsAutoConfiguring
            }
          >
            {runtimeSettingsSaving ? t('Applying...') : t('Apply local quick setup')}
          </Button>
        );
      }

      if (localQuickStartNextStep?.key === 'readiness') {
        return (
          <Button
            type="button"
            size="sm"
            variant={variant}
            onClick={() => {
              focusReadinessSection();
              void refreshRuntimeReadiness();
            }}
            disabled={runtimeReadinessLoading}
          >
            {runtimeReadinessLoading ? t('Checking...') : t('Run readiness checks')}
          </Button>
        );
      }

      return (
        <ButtonLink to="/inference/validate" size="sm" variant={variant}>
          {t('Validate Inference')}
        </ButtonLink>
      );
    },
    [
      applyLocalQuickSetup,
      focusReadinessSection,
      localQuickStartNextStep?.key,
      prepareLocalOnlyRuntimeDraft,
      refreshRuntimeReadiness,
      runtimeReadinessLoading,
      runtimeSettingsAutoConfiguring,
      runtimeSettingsClearing,
      runtimeSettingsLoading,
      runtimeSettingsSaving,
      t
    ]
  );
  const formatTimestamp = useCallback((value: string | null) => {
    return formatCompactTimestamp(value, t('n/a'));
  }, [t]);

  const frameworkTableColumns = useMemo<StatusTableColumn<ModelFramework>[]>(
    () => [
      {
        key: 'framework',
        header: t('Framework'),
        width: '14%',
        cell: (framework) => (
          <div className="stack tight">
            <strong>{t(framework)}</strong>
            <small className="muted">
              {runtimeDrafts[framework].default_model_id
                ? t('Default model bound')
                : t('No default model')}
            </small>
          </div>
        )
      },
      {
        key: 'status',
        header: t('Status'),
        width: '12%',
        cell: (framework) => {
          const source = checkByFramework.get(framework)?.source ?? 'not_configured';
          const status =
            source === 'reachable'
              ? t('reachable')
              : source === 'unreachable'
                ? t('unreachable')
                : t('not configured');
          return (
            <div className="stack tight">
              <StatusTag
                status={
                  source === 'reachable'
                    ? 'ready'
                    : source === 'unreachable'
                      ? 'failed'
                      : 'draft'
                }
              >
                {status}
              </StatusTag>
              {source === 'unreachable' ? (
                <small className="muted">
                  {describeErrorKind(checkByFramework.get(framework)?.error_kind ?? 'unknown')}
                </small>
              ) : null}
            </div>
          );
        }
      },
      {
        key: 'mode',
        header: t('Mode'),
        width: '12%',
        cell: (framework) => (
          <div className="stack tight">
            <Badge tone={runtimeConnectionModes[framework] === 'local' ? 'info' : 'warning'}>
              {runtimeConnectionModes[framework] === 'local' ? t('Local mode') : t('Endpoint mode')}
            </Badge>
            <small className="muted">
              {runtimeConnectionModes[framework] === 'local'
                ? t('Run on this machine')
                : t('Call remote runtime')}
            </small>
          </div>
        )
      },
      {
        key: 'endpoint',
        header: t('Endpoint'),
        width: '24%',
        cell: (framework) => (
          <div className="stack tight">
            <span>
              {runtimeConnectionModes[framework] === 'local'
                ? t('Local runner / local command')
                : runtimeDrafts[framework].endpoint || t('not set')}
            </span>
            <small className="muted">
              {t('Model path')}: {runtimeDrafts[framework].local_model_path || t('not set')}
            </small>
          </div>
        )
      },
      {
        key: 'api_key',
        header: t('API Key'),
        width: '14%',
        cell: (framework) => (
          <div className="stack tight">
            {runtimeConnectionModes[framework] === 'local' ? (
              <Badge tone="neutral">{t('Not needed')}</Badge>
            ) : runtimeDrafts[framework].has_api_key ? (
              <Badge tone="success">{t('Saved')}</Badge>
            ) : (
              <Badge tone="warning">{t('Missing')}</Badge>
            )}
            <small className="muted">
              {runtimeConnectionModes[framework] === 'local'
                ? t('Local mode does not require API key')
                : runtimeDrafts[framework].api_key_masked || t('Use framework or model-level key')}
            </small>
          </div>
        )
      },
      {
        key: 'checked_at',
        header: t('Last checked'),
        width: '12%',
        cell: (framework) => (
          <small className="muted">{formatTimestamp(checkByFramework.get(framework)?.checked_at ?? null)}</small>
        )
      },
      {
        key: 'actions',
        header: t('Actions'),
        width: '12%',
        cell: (framework) => (
          <div className="workspace-record-actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                setFrameworkFilter(framework);
                focusRuntimeConfiguration();
              }}
            >
              {t('Edit')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                void refresh(framework);
              }}
              disabled={checking}
            >
              {checking && frameworkFilter === framework ? t('Checking...') : t('Check')}
            </Button>
          </div>
        )
      }
    ],
    [
      checkByFramework,
      checking,
      describeErrorKind,
      formatTimestamp,
      focusRuntimeConfiguration,
      frameworkFilter,
      refresh,
      runtimeConnectionModes,
      runtimeDrafts,
      t
    ]
  );

  const runtimeChecklistCollapsed =
    runtimeConfigurationPrepared &&
    Boolean(runtimeSettingsActiveProfileId) &&
    runtimeReadinessReady &&
    runtimeManualTaskBlockingCount === 0;
  const heroSection = (
    <>
      <PageHeader
        eyebrow={t('Runtime operations')}
        title={t('Runtime Settings')}
        description={t('Configure framework execution paths and readiness here. Worker lifecycle operations are handled in Worker Settings.')}
        meta={
          <div className="row gap wrap align-center">
            <StatusTag status={checking ? 'running' : 'ready'}>
              {checking ? t('Checking...') : t('Ready')}
            </StatusTag>
            <Badge tone={runtimeHasUnsavedChanges ? 'warning' : 'neutral'}>
              {runtimeHasUnsavedChanges ? t('Unsaved edits') : t('Saved draft')}
            </Badge>
            <Badge tone="neutral">
              {t('Active profile')}: {runtimeSettingsActiveProfileId ?? t('saved')}
            </Badge>
            <Badge tone="neutral">
              {t('Build ID')}: {runtimeUiBuildLabel}
            </Badge>
          </div>
        }
        primaryAction={{
          label: runtimeReadinessLoading ? t('Checking...') : t('Run readiness check'),
          onClick: () => {
            focusReadinessSection();
            void refreshRuntimeReadiness();
          },
          disabled: runtimeReadinessLoading
        }}
        secondaryActions={
          <div className="row gap wrap">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void saveRuntimeSettingsConfig()}
              disabled={
                runtimeSettingsLoading ||
                runtimeSettingsSaving ||
                runtimeSettingsClearing ||
                runtimeSettingsAutoConfiguring
              }
            >
              {runtimeSettingsSaving ? t('Saving...') : t('Save runtime settings')}
            </Button>
          </div>
        }
      />
      <KPIStatRow
        items={[
          {
            label: t('Reachable frameworks'),
            value: reachableCount,
            tone: reachableCount > 0 ? 'success' : 'warning',
            hint: t('{count} of {total} frameworks are reachable.', {
              count: reachableCount,
              total: FRAMEWORKS.length
            })
          },
          {
            label: t('Unconfigured frameworks'),
            value: notConfiguredCount,
            tone: notConfiguredCount > 0 ? 'warning' : 'neutral',
            hint: t('Frameworks still missing endpoint or local setup.')
          },
          {
            label: t('Active profile'),
            value: runtimeSettingsActiveProfileId ? t('configured') : t('none'),
            tone: runtimeSettingsActiveProfileId ? 'success' : 'warning',
            hint: runtimeSettingsActiveProfileId
              ? runtimeSettingsActiveProfileId
              : t('Activate one runtime profile before production validation.')
          },
          {
            label: t('Open issues'),
            value: runtimeReadinessIssueCount,
            tone: runtimeReadinessIssueCount > 0 ? 'danger' : 'success',
            hint: t('error {errors} / warning {warnings}', {
              errors: runtimeReadinessErrorCount,
              warnings: runtimeReadinessWarningCount
            })
          }
        ]}
      />
    </>
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

      {error ? (
        <InlineAlert
          tone="danger"
          title={t('Runtime Check Failed')}
          description={error}
        />
      ) : null}

      <SectionCard
        title={t('Quick local setup')}
        description={t('Complete this three-step path first. It keeps runtime usable without endpoint/API key setup.')}
        actions={
          <div className="row gap wrap align-center">
            <Badge tone={localQuickStartCompleted ? 'success' : 'info'}>
              {localQuickStartCompleted
                ? t('Ready')
                : t('Current step')}: {localQuickStartNextStep?.label ?? t('Completed')}
            </Badge>
            <Badge tone="neutral">
              {t('Done {done}/{total}', {
                done: localQuickStartCompletedCount,
                total: localQuickStartSteps.length
              })}
            </Badge>
          </div>
        }
      >
        <ProgressStepper
          steps={localQuickStartSteps.map((stepItem) => stepItem.label)}
          current={localQuickStartCurrentIndex}
          title={t('Local quick-start progress')}
          caption={t('Completed') + `: ${localQuickStartCompletedCount}/${localQuickStartSteps.length}`}
        />
        <ActionBar
          primary={renderLocalQuickStartAction('secondary')}
          secondary={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={focusRuntimeConfiguration}
            >
              {t('Open runtime configuration')}
            </Button>
          }
          tertiary={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                focusReadinessSection();
                void refreshRuntimeReadiness();
              }}
              disabled={runtimeReadinessLoading}
            >
              {runtimeReadinessLoading ? t('Checking...') : t('Run readiness checks')}
            </Button>
          }
        />
      </SectionCard>

      <SectionCard
        title={t('Local runtime configuration (single machine)')}
        description={t('If you only run local runtime, keep endpoint and API key empty. Use one Python executable for all local runners.')}
        actions={
          <div className="row gap wrap">
            <Badge tone="info">{t('Mode')}: {t('Local mode')}</Badge>
            <Badge tone="neutral">
              {t('Recommended Python')}: {runtimeRecommendedLocalPythonBin}
            </Badge>
          </div>
        }
      >
        <ul className="stack tight" style={{ margin: 0, paddingLeft: '1rem' }}>
          <li className="muted">{t('1. Click "Prepare local-only draft" to clear endpoint/API key for all frameworks.')}</li>
          <li className="muted">{t('2. Keep every framework in local mode. Endpoint/API key fields are not required for local execution.')}</li>
          <li className="muted">{t('3. Set Built-in runner Python executable, then click "Apply local quick setup".')}</li>
          <li className="muted">{t('4. Run readiness checks. When status is ready, continue to inference validation.')}</li>
        </ul>
        <ActionBar
          primary={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => updateRuntimeControlDraft('python_bin', runtimeRecommendedLocalPythonBin)}
            >
              {t('Use recommended Python path')}
            </Button>
          }
          secondary={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void applyLocalQuickSetup()}
              disabled={
                runtimeSettingsLoading ||
                runtimeSettingsSaving ||
                runtimeSettingsClearing ||
                runtimeSettingsAutoConfiguring
              }
            >
              {runtimeSettingsSaving ? t('Applying...') : t('Apply local quick setup')}
            </Button>
          }
        />
      </SectionCard>

      <WorkspaceWorkbench
        toolbar={
          <FilterToolbar
            filters={
              <>
                <label className="stack tight">
                  <small className="muted">{t('Framework')}</small>
                  <Select
                    value={frameworkFilter}
                    onChange={(event) =>
                      setFrameworkFilter(event.target.value as 'all' | ModelFramework)
                    }
                  >
                    <option value="all">{t('all')}</option>
                    <option value="paddleocr">{t('paddleocr')}</option>
                    <option value="doctr">{t('doctr')}</option>
                    <option value="yolo">{t('yolo')}</option>
                  </Select>
                </label>
                <div className="stack tight">
                  <small className="muted">{t('Configured')}</small>
                  <Badge tone="neutral">
                    {configuredCount} / {FRAMEWORKS.length}
                  </Badge>
                </div>
              </>
            }
            actions={
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void refresh()}
                  disabled={checking}
                >
                  {checking && frameworkFilter === 'all' ? t('Checking...') : t('Refresh All')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void refresh(frameworkFilter === 'all' ? undefined : frameworkFilter)
                  }
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
              </>
            }
            summary={
              <div className="row gap wrap">
                <Badge tone="neutral">{t('Reachable frameworks')}: {reachableCount}</Badge>
                <Badge tone={unreachableCount > 0 ? 'warning' : 'neutral'}>
                  {t('Unreachable frameworks')}: {unreachableCount}
                </Badge>
                <Badge tone="neutral">{t('Not Configured')}: {notConfiguredCount}</Badge>
                <Badge tone={runtimeSettingsActiveProfileId ? 'success' : 'warning'}>
                  {t('Active profile')}: {runtimeSettingsActiveProfileId ? t('configured') : t('none')}
                </Badge>
              </div>
            }
          />
        }
        main={
          <div className="workspace-main-stack">
            {runtimeChecklistCollapsed ? (
              <InlineAlert
                tone="success"
                title={t('Runtime checklist complete')}
                description={t('Framework configuration, active profile, and readiness are all in a healthy state.')}
                actions={
                  <div className="row gap wrap">
                    <ButtonLink to="/inference/validate" variant="secondary" size="sm">
                      {t('Validate Inference')}
                    </ButtonLink>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={focusRuntimeConfiguration}
                    >
                      {t('Review configuration')}
                    </Button>
                  </div>
                }
              />
            ) : (
              <>
                <WorkspaceOnboardingCard
                  title={t('Runtime first-run guide')}
                  description={t('Use this page to prepare runtime connectivity before real inference/training.')}
                  summary={t('Runtime guide status is computed from runtime settings, profile activation, readiness report, and connectivity checks.')}
                  storageKey={runtimeOnboardingDismissedStorageKey}
                  steps={runtimeOnboardingSteps.map((stepItem) => ({
                    key: stepItem.key,
                    label: stepItem.label,
                    detail: stepItem.detail,
                    done: stepItem.done,
                    primaryAction: {
                      to: stepItem.key === 'next' ? stepItem.to : undefined,
                      label:
                        stepItem.key === 'next'
                          ? stepItem.cta
                          : stepItem.key === 'readiness'
                            ? t('Run readiness checks')
                            : stepItem.key === 'profile'
                              ? t('Activate profile')
                              : t('Open runtime configuration'),
                      onClick:
                        stepItem.key === 'next'
                          ? undefined
                          : stepItem.key === 'readiness'
                            ? focusReadinessSection
                            : focusRuntimeConfiguration
                    }
                  }))}
                />

                {nextOnboardingStep ? (
                  <WorkspaceNextStepCard
                    title={t('Next runtime step')}
                    description={t('Finish one clear runtime setup action here before switching to validation.')}
                    stepLabel={nextOnboardingStep.label}
                    stepDetail={nextOnboardingStep.detail}
                    current={nextOnboardingStepIndex}
                    total={runtimeOnboardingSteps.length}
                    actions={
                      <div className="row gap wrap">
                        {renderRuntimeNextAction(nextOnboardingStep)}
                        <ButtonLink to="/settings/account" variant="ghost" size="sm">
                          {t('Account Settings')}
                        </ButtonLink>
                      </div>
                    }
                  />
                ) : null}
              </>
            )}

            <div ref={runtimeConfigurationRef}>
            <Card as="article">
              <WorkspaceSectionHeader
                title={t('Runtime configuration')}
                description={t('Configure each framework in local mode or endpoint mode directly from UI.')}
                actions={
                  <ActionBar
                    primary={
                      <div className="row gap wrap">
                        <Badge tone="neutral">
                          {t('Last updated')}: {formatTimestamp(runtimeSettingsUpdatedAt)}
                        </Badge>
                        <Badge tone="info">
                          {t('Active profile')}: {runtimeSettingsActiveProfileId ?? t('saved')}
                        </Badge>
                      </div>
                    }
                    secondary={
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => void saveRuntimeSettingsConfig()}
                        disabled={
                          runtimeSettingsLoading ||
                          runtimeSettingsSaving ||
                          runtimeSettingsClearing ||
                          runtimeSettingsAutoConfiguring
                        }
                      >
                        {runtimeSettingsSaving ? t('Saving...') : t('Save runtime settings')}
                      </Button>
                    }
                    tertiary={
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void refreshRuntimeSettings()}
                        disabled={
                          runtimeSettingsLoading ||
                          runtimeSettingsSaving ||
                          runtimeSettingsClearing ||
                          runtimeSettingsAutoConfiguring
                        }
                      >
                        {runtimeSettingsLoading ? t('Loading...') : t('Reload settings')}
                      </Button>
                    }
                  />
                }
              />

            <div className="row gap wrap align-center">
              <label className="stack tight" style={{ minWidth: 280 }}>
                <small className="muted">{t('Deployment runtime profile')}</small>
                <Select
                  value={selectedRuntimeProfileId}
                  onChange={(event) => setSelectedRuntimeProfileId(event.target.value)}
                  disabled={
                    runtimeSettingsLoading ||
                    runtimeSettingsSaving ||
                    runtimeSettingsClearing ||
                    runtimeSettingsAutoConfiguring
                  }
                >
                  {runtimeProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label} ({profile.source})
                    </option>
                  ))}
                  {runtimeProfiles.length === 0 ? <option value="">{t('No profiles')}</option> : null}
                </Select>
              </label>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void activateRuntimeProfile()}
                disabled={
                  runtimeSettingsLoading ||
                  runtimeSettingsSaving ||
                  runtimeSettingsClearing ||
                  runtimeSettingsAutoConfiguring ||
                  runtimeProfileActivating ||
                  !selectedRuntimeProfileId.trim()
                }
              >
                {runtimeProfileActivating ? t('Switching...') : t('Activate profile')}
              </Button>
              {runtimeHasUnsavedChanges ? (
                <Badge tone="warning">{t('Unsaved edits will be overwritten')}</Badge>
              ) : null}
            </div>
            {selectedRuntimeProfile ? (
              <Panel as="section" className="workspace-record-item stack tight" tone="soft">
                <div className="row between gap wrap align-center">
                  <strong>{t('Selected profile snapshot')}</strong>
                  <Badge tone="neutral">
                    {t('Source')}: {selectedRuntimeProfile.source}
                  </Badge>
                </div>
                <div className="workspace-keyline-list">
                  <div className="workspace-keyline-item">
                    <span>{t('Built-in runner Python executable')}</span>
                    <small>{selectedRuntimeProfile.controls.python_bin || t('platform default')}</small>
                  </div>
                  <div className="workspace-keyline-item">
                    <span>{t('YOLO local model path')}</span>
                    <small>{selectedRuntimeProfile.frameworks.yolo.local_model_path || t('not set')}</small>
                  </div>
                  <div className="workspace-keyline-item">
                    <span>{t('Runtime safety guards')}</span>
                    <small>
                      {t('Training safety guard')}:{' '}
                      {selectedRuntimeProfile.controls.disable_simulated_train_fallback ? t('yes') : t('no')} ·{' '}
                      {t('Inference safety guard')}:{' '}
                      {selectedRuntimeProfile.controls.disable_inference_fallback ? t('yes') : t('no')}
                    </small>
                  </div>
                  <div className="workspace-keyline-item">
                    <span>{t('Endpoints')}</span>
                    <small>
                      OCR={selectedRuntimeProfile.frameworks.paddleocr.endpoint || '-'} · docTR=
                      {selectedRuntimeProfile.frameworks.doctr.endpoint || '-'} · YOLO=
                      {selectedRuntimeProfile.frameworks.yolo.endpoint || '-'}
                    </small>
                  </div>
                </div>
              </Panel>
            ) : null}
            <div ref={readinessSectionRef}>

            {runtimeSettingsError ? (
              <InlineAlert
                tone="danger"
                title={t('Runtime settings unavailable')}
                description={runtimeSettingsError}
              />
            ) : null}
            {runtimeSettingsMessage ? (
              <InlineAlert
                tone="success"
                title={t('Runtime settings')}
                description={runtimeSettingsMessage}
              />
            ) : null}
            <AdvancedSection
              title={t('Choose runtime setup path')}
              description={t(
                'Start with one clear setup path. Keep expert maintenance collapsed until you really need it.'
              )}
            >
              <Panel as="section" className="workspace-record-item stack tight" tone="soft">
                <div className="three-col">
                  <Panel as="section" className="workspace-record-item stack tight" tone="soft">
                  <div className="row between gap wrap align-center">
                    <strong>{t('Local quick setup path')}</strong>
                    <Badge tone={runtimeLocalConfigPersisted ? 'success' : 'info'}>
                      {runtimeLocalConfigPersisted ? t('ready') : t('Recommended')}
                    </Badge>
                  </div>
                  <small className="muted">
                    {t('Best for first-time single-machine usage. No endpoint or API key is required.')}
                  </small>
                  <ProgressStepper
                    steps={localQuickStartSteps.map((stepItem) => stepItem.label)}
                    current={localQuickStartCurrentIndex}
                    title={t('Local quick-start progress')}
                    caption={t('Completed') + `: ${localQuickStartCompletedCount}/${localQuickStartSteps.length}`}
                  />
                  <WorkspaceActionStack>{renderLocalQuickStartAction()}</WorkspaceActionStack>
                </Panel>
                <Panel as="section" className="workspace-record-item stack tight" tone="soft">
                  <div className="row between gap wrap align-center">
                    <strong>{t('Profile activation path')}</strong>
                    <Badge
                      tone={
                        runtimeSettingsActiveProfileId &&
                        runtimeSettingsActiveProfileId !== 'saved'
                          ? 'success'
                          : selectedRuntimeProfileId.trim()
                            ? 'info'
                            : 'neutral'
                      }
                    >
                      {runtimeSettingsActiveProfileId && runtimeSettingsActiveProfileId !== 'saved'
                        ? t('active')
                        : selectedRuntimeProfileId.trim()
                          ? t('selected')
                          : t('pending')}
                    </Badge>
                  </div>
                  <small className="muted">
                    {t('Use this when deployment/runtime profiles are already prepared by your environment or ops team.')}
                  </small>
                  <div className="workspace-keyline-list">
                    <div className="workspace-keyline-item">
                      <span>{t('Selected profile')}</span>
                      <small>{selectedRuntimeProfile?.label || t('No profiles')}</small>
                    </div>
                    <div className="workspace-keyline-item">
                      <span>{t('Source')}</span>
                      <small>{selectedRuntimeProfile?.source || t('n/a')}</small>
                    </div>
                  </div>
                  <WorkspaceActionStack>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void activateRuntimeProfile()}
                      disabled={
                        runtimeSettingsLoading ||
                        runtimeSettingsSaving ||
                        runtimeSettingsClearing ||
                        runtimeSettingsAutoConfiguring ||
                        runtimeProfileActivating ||
                        !selectedRuntimeProfileId.trim()
                      }
                    >
                      {runtimeProfileActivating ? t('Switching...') : t('Activate profile')}
                    </Button>
                    {!selectedRuntimeProfileId.trim() ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={focusRuntimeConfiguration}
                      >
                        {t('Open runtime configuration')}
                      </Button>
                    ) : null}
                  </WorkspaceActionStack>
                </Panel>
                <Panel as="section" className="workspace-record-item stack tight" tone="soft">
                  <div className="row between gap wrap align-center">
                    <strong>{t('Custom framework setup')}</strong>
                    <Badge tone={runtimeHasUnsavedChanges ? 'warning' : configuredCount > 0 ? 'info' : 'neutral'}>
                      {runtimeHasUnsavedChanges
                        ? t('Unsaved edits')
                        : configuredCount > 0
                          ? t('in_progress')
                          : t('pending')}
                    </Badge>
                  </div>
                  <small className="muted">
                    {t('Manually adjust framework mode, endpoint, auth, and local overrides when the guided paths are not enough.')}
                  </small>
                  <div className="workspace-keyline-list">
                    <div className="workspace-keyline-item">
                      <span>{t('Configured')}</span>
                      <small>
                        {configuredCount} / {FRAMEWORKS.length}
                      </small>
                    </div>
                    <div className="workspace-keyline-item">
                      <span>{t('Unsaved edits')}</span>
                      <small>{runtimeHasUnsavedChanges ? t('yes') : t('no')}</small>
                    </div>
                  </div>
                    <WorkspaceActionStack>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={focusRuntimeConfiguration}
                      >
                        {t('Open runtime configuration')}
                      </Button>
                    </WorkspaceActionStack>
                  </Panel>
                </div>
              </Panel>
            </AdvancedSection>
            {runtimeReadinessError ? (
              <StateBlock
                variant="error"
                title={t('Runtime readiness check failed')}
                description={runtimeReadinessError}
              />
            ) : null}
            {runtimeReadinessLoading ? (
              <StateBlock
                variant="loading"
                title={t('Checking runtime readiness')}
                description={t('Checking local runtime environment and framework availability.')}
              />
            ) : runtimeReadiness ? (
              <HealthSummaryPanel
                title={t('Runtime readiness')}
                description={t('Keep the summary visible by default, and only open detailed diagnostics when you need to fix something.')}
                status={
                  <Badge tone={runtimeReadinessBadgeTone}>
                    {t('Status')}: {runtimeReadiness.status}
                  </Badge>
                }
                items={[
                  {
                    label: t('Errors'),
                    value: runtimeReadinessErrorCount,
                    tone: runtimeReadinessErrorCount > 0 ? 'danger' : 'success'
                  },
                  {
                    label: t('Warnings'),
                    value: runtimeReadinessWarningCount,
                    tone: runtimeReadinessWarningCount > 0 ? 'warning' : 'neutral'
                  },
                  {
                    label: t('Suggestions'),
                    value: Math.max(
                      runtimeReadinessIssueCount -
                        runtimeReadinessErrorCount -
                        runtimeReadinessWarningCount,
                      0
                    ),
                    tone: 'info'
                  },
                  {
                    label: t('Runtime mode'),
                    value: runtimeAllFrameworksLocalMode ? t('Local-first') : t('Mixed / endpoint'),
                    tone: runtimeAllFrameworksLocalMode ? 'info' : 'warning'
                  }
                ]}
                actions={
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void refreshRuntimeReadiness()}
                    disabled={runtimeReadinessLoading}
                  >
                    {t('Refresh readiness')}
                  </Button>
                }
              >
                <DetailList
                  items={[
                    {
                      label: t('Python'),
                      value: `${runtimeReadiness.python_bin_requested || t('platform default')} -> ${
                        runtimeReadiness.python_bin_resolved || t('unavailable')
                      }`
                    },
                    {
                      label: t('Safety guards'),
                      value: `${t('train')}: ${
                        runtimeReadiness.strict_controls.disable_simulated_train_fallback
                          ? t('yes')
                          : t('no')
                      } · ${t('inference')}: ${
                        runtimeReadiness.strict_controls.disable_inference_fallback
                          ? t('yes')
                          : t('no')
                      }`
                    },
                    {
                      label: t('Open issues'),
                      value: `${runtimeReadinessIssueCount} (${t('error')} ${runtimeReadinessErrorCount} / ${t(
                        'warning'
                      )} ${runtimeReadinessWarningCount})`
                    }
                  ]}
                />
                {runtimeReadinessFixCommands.length > 0 || runtimeReadiness.issues.length > 0 ? (
                  <details className="workspace-details">
                    <summary>{t('Advanced diagnostics and fix commands')}</summary>
                    <div className="stack tight">
                      {runtimeReadinessFixCommands.length > 0 ? (
                        <div className="stack tight">
                          <div className="row gap wrap align-center">
                            <strong>{t('Fix commands')}</strong>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                void copyText(t('Operations checklist'), runtimeReadinessOpsChecklist)
                              }
                            >
                              {t('Copy checklist')}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                void copyText(t('Fix commands'), runtimeReadinessFixCommands.join('\n'))
                              }
                            >
                              {t('Copy all commands')}
                            </Button>
                          </div>
                          <small className="muted">{t('Run these on the runtime host, then refresh readiness.')}</small>
                          <ul className="stack tight" style={{ margin: 0, paddingLeft: '1rem' }}>
                            {runtimeReadinessFixCommands.map((command) => (
                              <li key={command} className="muted">
                                <div className="row gap wrap align-center">
                                  <code>{command}</code>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => void copyText(t('Fix command'), command)}
                                  >
                                    {t('Copy command')}
                                  </Button>
                                </div>
                              </li>
                            ))}
                          </ul>
                          {runtimeReadinessCommandGroups.length > 0 ? (
                            <div className="stack tight">
                              {runtimeReadinessCommandGroups.map((group) => (
                                <div key={group.key} className="stack tight">
                                  <strong>{group.label}</strong>
                                  <ul className="stack tight" style={{ margin: 0, paddingLeft: '1rem' }}>
                                    {group.commands.map((command) => (
                                      <li key={`${group.key}-${command}`} className="muted">
                                        <code>{command}</code>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      {runtimeReadiness.issues.length > 0 ? (
                        <ul className="stack tight" style={{ margin: 0, paddingLeft: '1rem' }}>
                          {runtimeReadiness.issues.map((issue) => (
                            <li key={`${issue.code}-${issue.message}`} className="muted">
                              <div className="row gap wrap align-center">
                                <Badge tone={issue.level === 'error' ? 'danger' : issue.level === 'warning' ? 'warning' : 'neutral'}>
                                  {t(issue.level)}
                                </Badge>
                                <small className="muted">{issue.message}</small>
                              </div>
                              <small className="muted">
                                {t('Issue code')}: {issue.code}
                              </small>
                              {issue.remediation ? (
                                <div className="row gap wrap align-center" style={{ marginTop: 4 }}>
                                  <small className="muted">
                                    {t('Remediation')}: {issue.remediation}
                                  </small>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => void copyText(t('Remediation'), issue.remediation ?? '')}
                                  >
                                    {t('Copy fix')}
                                  </Button>
                                </div>
                              ) : null}
                              {issue.remediation_command ? (
                                <div className="row gap wrap align-center" style={{ marginTop: 4 }}>
                                  <small className="muted">
                                    {t('Fix command')}: <code>{issue.remediation_command}</code>
                                  </small>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      void copyText(t('Fix command'), issue.remediation_command ?? '')
                                    }
                                  >
                                    {t('Copy command')}
                                  </Button>
                                </div>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </details>
                ) : (
                  <small className="muted">{t('No blocking runtime issues detected.')}</small>
                )}
              </HealthSummaryPanel>
            ) : null}
            {showDoctrPreseedRecoveryGuide && doctrBootstrapFailureIssue ? (
              <Panel as="section" className="workspace-record-item stack tight" tone="soft">
                <div className="row between gap wrap align-center">
                  <strong>{t('docTR local bootstrap recovery')}</strong>
                  <Badge tone="warning">{t('Action required')}</Badge>
                </div>
                <InlineAlert
                  tone="warning"
                  title={t('docTR model warmup failed in local mode')}
                  description={
                    doctrBootstrapFailureIssue.remediation ||
                    t('Pre-seed docTR model files, then restart API and refresh readiness.')
                  }
                />
                <div className="stack tight">
                  <small className="muted">
                    {t('Runtime preseed directory')}: <code>{doctrPreseedRuntimeDir}</code>
                  </small>
                  <small className="muted">
                    {t('Host preseed directory hint')}: <code>{doctrPreseedHostDirHint}</code>
                  </small>
                  <small className="muted">{t('Required files')}:</small>
                  <div className="row gap wrap align-center">
                    {doctrPreseedExpectedFileNames.map((file) => {
                      const current = doctrPreseedExpectedFiles.find((item) => item.name === file);
                      const present = current ? current.present : false;
                      return (
                        <span key={file} className="row gap wrap align-center">
                          <code>{file}</code>
                          <Badge tone={present ? 'success' : 'danger'}>
                            {present ? t('ready') : t('missing')}
                          </Badge>
                        </span>
                      );
                    })}
                  </div>
                  {doctrPreseedMissingFiles.length > 0 ? (
                    <small className="muted">
                      {t('Missing files')}: {doctrPreseedMissingFiles.join(', ')}
                    </small>
                  ) : (
                    <small className="muted">{t('All expected preseed files are present.')}</small>
                  )}
                </div>
                <div className="stack tight">
                  <div className="row gap wrap align-center">
                    <strong>{t('Quick recovery commands')}</strong>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void copyText(
                          t('docTR recovery commands'),
                          doctrPreseedRecoveryCommands.join('\n')
                        )
                      }
                    >
                      {t('Copy all commands')}
                    </Button>
                  </div>
                  <ul className="stack tight" style={{ margin: 0, paddingLeft: '1rem' }}>
                    {doctrPreseedRecoveryCommands.map((command) => (
                      <li key={command} className="muted">
                        <div className="row gap wrap align-center">
                          <code>{command}</code>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => void copyText(t('Fix command'), command)}
                          >
                            {t('Copy command')}
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="row gap wrap align-center">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => void refreshRuntimeReadiness()}
                    disabled={runtimeReadinessLoading}
                  >
                    {runtimeReadinessLoading ? t('Refreshing...') : t('Refresh readiness')}
                  </Button>
                </div>
              </Panel>
            ) : null}
            </div>
            <Panel as="section" className="workspace-record-item stack tight" tone="soft">
              <div className="row between gap wrap align-center">
                <strong>{t('Manual-only required checks')}</strong>
                <div className="row gap wrap align-center">
                  <Badge tone="danger">
                    {t('Action required')}: {runtimeManualTaskBlockingCount}
                  </Badge>
                  <Badge tone="warning">
                    {t('warning')}: {runtimeManualTaskWarningCount}
                  </Badge>
                  <Badge tone="neutral">
                    {t('pending')}: {runtimeManualTaskPendingCount}
                  </Badge>
                </div>
              </div>
              <small className="muted">
                {t('Auto-config handles defaults, but these items still require manual confirmation for production readiness.')}
              </small>
              <ul className="stack tight" style={{ margin: 0, paddingLeft: '1rem' }}>
                {runtimeManualTaskItems.map((item) => (
                  <li key={item.key} className="muted">
                    <div className="row between gap wrap align-center">
                      <strong>{item.title}</strong>
                      <Badge tone={runtimeManualTaskStatusTone(item.status)}>
                        {item.status === 'action_required' ? t('Action required') : t(item.status)}
                      </Badge>
                    </div>
                    <small className="muted">{item.detail}</small>
                    {item.actionHref && item.actionLabel ? (
                      <div className="row gap wrap align-center" style={{ marginTop: 6 }}>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            window.location.assign(item.actionHref as string);
                          }}
                        >
                          {item.actionLabel}
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Panel>
            <AdvancedSection
              title={t('Expert runtime controls')}
              description={t(
                'Keep low-frequency maintenance, safety controls, and advanced command overrides here so first-run setup stays calm.'
              )}
            >
              <div className="row gap wrap align-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void autoConfigureRuntimeSettingsConfig(false)}
                  disabled={
                    runtimeSettingsLoading ||
                    runtimeSettingsSaving ||
                    runtimeSettingsClearing ||
                    runtimeSettingsAutoConfiguring
                  }
                >
                  {runtimeSettingsAutoConfiguring
                    ? t('Auto-configuring...')
                    : t('Auto configure (safe)')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void autoConfigureRuntimeSettingsConfig(true)}
                  disabled={
                    runtimeSettingsLoading ||
                    runtimeSettingsSaving ||
                    runtimeSettingsClearing ||
                    runtimeSettingsAutoConfiguring
                  }
                >
                  {t('Auto configure (overwrite endpoints)')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void clearRuntimeSettingsConfig()}
                  disabled={
                    runtimeSettingsLoading ||
                    runtimeSettingsSaving ||
                    runtimeSettingsClearing ||
                    runtimeSettingsAutoConfiguring
                  }
                >
                  {runtimeSettingsClearing ? t('Clearing...') : t('Clear UI settings')}
                </Button>
              </div>
              {!runtimeAllFrameworksLocalMode ? (
                <label className="row gap wrap align-center">
                  <input
                    type="checkbox"
                    className="ui-checkbox"
                    checked={keepExistingApiKeys}
                    onChange={(event) => setKeepExistingApiKeys(event.target.checked)}
                  />
                  <span>{t('Keep existing API keys when key field is left blank')}</span>
                </label>
              ) : (
                <small className="muted">
                  {t('All frameworks are in local mode, so API key fields stay hidden by default.')}
                </small>
              )}
              <Panel as="section" className="workspace-record-item" tone="soft">
                <div className="stack tight">
                  <strong>{t('Runtime safety guards')}</strong>
                  <small className="muted">
                    {t(
                      'Set safety behavior for runtime output, and choose the default Python executable for built-in runners.'
                    )}
                  </small>
                </div>
                <label className="stack tight">
                  <small className="muted">{t('Built-in runner Python executable')}</small>
                  <Input
                    value={runtimeControlDraft.python_bin}
                    onChange={(event) =>
                      updateRuntimeControlDraft('python_bin', event.target.value)
                    }
                    placeholder={`${t('Recommended')}: ${runtimeRecommendedLocalPythonBin}`}
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
                      'Stop training immediately when local execution command is unavailable'
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
                      'Block degraded inference output and return an explicit error'
                    )}
                  </span>
                </label>
              </Panel>
            </AdvancedSection>

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
                  const connectionMode = runtimeConnectionModes[framework];
                  const isLocalMode = connectionMode === 'local';
                  const modelOptions = frameworkModelOptions[framework] ?? [];
                  const versionOptions = frameworkVersionOptions[framework] ?? [];
                  const selectedModelBindingKey = draft.default_model_id.trim()
                    ? `model:${draft.default_model_id.trim()}`
                    : '';
                  const selectedModelVersionBindingKey = draft.default_model_version_id.trim()
                    ? `model_version:${draft.default_model_version_id.trim()}`
                    : '';
                  const selectedModelApiKeyMeta = selectedModelBindingKey
                    ? draft.model_api_keys_meta[selectedModelBindingKey]
                    : null;
                  const selectedModelVersionApiKeyMeta = selectedModelVersionBindingKey
                    ? draft.model_api_keys_meta[selectedModelVersionBindingKey]
                    : null;
                  const selectedModelKeyExpiryStatus = resolveRuntimeApiKeyExpiryStatus(
                    selectedModelApiKeyMeta
                  );
                  const selectedModelVersionKeyExpiryStatus = resolveRuntimeApiKeyExpiryStatus(
                    selectedModelVersionApiKeyMeta
                  );
                  const selectedModelApiKeyValue = selectedModelBindingKey
                    ? (draft.model_api_keys[selectedModelBindingKey] ?? '')
                    : '';
                  const selectedModelApiKeyExpiresAtValue = selectedModelBindingKey
                    ? (draft.model_api_key_expires_at[selectedModelBindingKey] ?? '')
                    : '';
                  const selectedModelApiKeyMaxCallsValue = selectedModelBindingKey
                    ? (draft.model_api_key_max_calls[selectedModelBindingKey] ?? '')
                    : '';
                  const selectedModelVersionApiKeyValue = selectedModelVersionBindingKey
                    ? (draft.model_api_keys[selectedModelVersionBindingKey] ?? '')
                    : '';
                  const selectedModelVersionApiKeyExpiresAtValue = selectedModelVersionBindingKey
                    ? (draft.model_api_key_expires_at[selectedModelVersionBindingKey] ?? '')
                    : '';
                  const selectedModelVersionApiKeyMaxCallsValue = selectedModelVersionBindingKey
                    ? (draft.model_api_key_max_calls[selectedModelVersionBindingKey] ?? '')
                    : '';
                  return (
                    <Panel key={framework} as="section" className="workspace-record-item" tone="soft">
                      <div className="row between gap wrap align-center">
                        <strong>{t(framework)}</strong>
                        <div className="row gap wrap align-center">
                          <Badge tone={isLocalMode ? 'info' : 'warning'}>
                            {isLocalMode ? t('Local mode') : t('Endpoint mode')}
                          </Badge>
                          {draft.has_api_key ? (
                            <Badge tone="success">{t('API key saved')}</Badge>
                          ) : (
                            <Badge tone="neutral">{t('No API key')}</Badge>
                          )}
                        </div>
                      </div>
                      <div className="row gap wrap align-center">
                        <small className="muted">{t('Runtime setup path')}</small>
                        <Button
                          type="button"
                          size="sm"
                          variant={isLocalMode ? 'secondary' : 'ghost'}
                          onClick={() => setRuntimeFrameworkMode(framework, 'local')}
                        >
                          {t('Use local mode')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={isLocalMode ? 'ghost' : 'secondary'}
                          onClick={() => setRuntimeFrameworkMode(framework, 'endpoint')}
                        >
                          {t('Use endpoint mode')}
                        </Button>
                      </div>
                      {isLocalMode ? (
                        <small className="muted">
                          {t('This framework will run through local command or bundled runner path on this machine. No API key is needed.')}
                        </small>
                      ) : (
                        <small className="muted">
                          {t('This framework will call a remote runtime endpoint. API key is optional and only needed when that endpoint requires auth.')}
                        </small>
                      )}

                      <label className="stack tight">
                        <small className="muted">{t('Default model')}</small>
                        <Select
                          value={draft.default_model_id}
                          onChange={(event) => {
                            const nextModelId = event.target.value;
                            setRuntimeDrafts((prev) => {
                              const previousDraft = prev[framework];
                              const keepVersion = runtimeModelVersions.some(
                                (item) =>
                                  item.id === previousDraft.default_model_version_id &&
                                  item.model_id === nextModelId
                              );
                              return {
                                ...prev,
                                [framework]: {
                                  ...previousDraft,
                                  default_model_id: nextModelId,
                                  default_model_version_id: keepVersion
                                    ? previousDraft.default_model_version_id
                                    : ''
                                }
                              };
                            });
                          }}
                        >
                          <option value="">{t('Select model (optional)')}</option>
                          {modelOptions.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </Select>
                        {runtimeModelOptionsLoading ? (
                          <small className="muted">{t('Loading model options...')}</small>
                        ) : runtimeModelOptionsError ? (
                          <small className="muted">
                            {t('Model options unavailable: {message}', {
                              message: runtimeModelOptionsError
                            })}
                          </small>
                        ) : modelOptions.length === 0 ? (
                          <small className="muted">
                            {t('No foundation/published model options found for this framework yet.')}
                          </small>
                        ) : (
                          <small className="muted">
                            {t('{count} model options available.', { count: modelOptions.length })}
                          </small>
                        )}
                      </label>

                      <label className="stack tight">
                        <small className="muted">{t('Default model version')}</small>
                        <Select
                          value={draft.default_model_version_id}
                          onChange={(event) =>
                            updateRuntimeDraft(
                              framework,
                              'default_model_version_id',
                              event.target.value
                            )
                          }
                          disabled={versionOptions.length === 0}
                        >
                          <option value="">
                            {draft.default_model_id
                              ? t('Select model version (optional)')
                              : t('Select model first')}
                          </option>
                          {versionOptions.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </Select>
                        {draft.default_model_id && versionOptions.length === 0 ? (
                          <small className="muted">
                            {t('No registered model versions found under current model.')}
                          </small>
                        ) : null}
                      </label>

                      {!isLocalMode ? (
                        <>
                          <label className="stack tight">
                            <small className="muted">{t('Runtime endpoint')}</small>
                            <Input
                              value={draft.endpoint}
                              onChange={(event) => updateRuntimeDraft(framework, 'endpoint', event.target.value)}
                              placeholder={`http://127.0.0.1:9393/predict`}
                            />
                          </label>

                          <label className="stack tight">
                            <small className="muted">{t('Runtime API key (optional, endpoint auth only)')}</small>
                            <div className="row gap wrap align-center">
                              <Input
                                type="password"
                                value={draft.api_key}
                                onChange={(event) =>
                                  updateRuntimeDraft(framework, 'api_key', event.target.value)
                                }
                                placeholder={
                                  draft.api_key_masked
                                    ? t('Stored key: {masked}', {
                                        masked: draft.api_key_masked
                                      })
                                    : t('Leave blank if runtime endpoint has no key')
                                }
                              />
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => generateAndApplyFrameworkApiKey(framework)}
                              >
                                {t('Generate key')}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => rotateRuntimeApiKey(framework)}
                              >
                                {t('Rotate key')}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={!draft.has_api_key}
                                onClick={() => revokeRuntimeApiKey(framework)}
                              >
                                {t('Revoke key')}
                              </Button>
                            </div>
                            <small className="muted">
                              {t('Generated key must also be configured and validated by the remote runtime service.')}
                            </small>
                          </label>

                          <AdvancedSection
                            title={t('Per-model auth routing')}
                            description={t('Only needed when remote runtime differentiates auth by model or model version.')}
                          >
                            {selectedModelBindingKey ? (
                              <label className="stack tight">
                                <small className="muted">
                                  {t('Model API key (for selected model)')}
                                </small>
                                <div className="row gap wrap align-center">
                                  <Input
                                    type="password"
                                    value={selectedModelApiKeyValue}
                                    onChange={(event) =>
                                      updateRuntimeDraftModelApiKey(
                                        framework,
                                        selectedModelBindingKey,
                                        event.target.value
                                      )
                                    }
                                    placeholder={
                                      selectedModelApiKeyMeta?.api_key_masked
                                        ? t('Stored key: {masked}', {
                                            masked: selectedModelApiKeyMeta.api_key_masked
                                          })
                                        : t('Leave blank if selected model does not need dedicated auth')
                                    }
                                  />
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      generateAndApplyModelBindingApiKey(
                                        framework,
                                        selectedModelBindingKey
                                      )
                                    }
                                  >
                                    {t('Generate key')}
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      rotateRuntimeApiKey(
                                        framework,
                                        selectedModelBindingKey
                                      )
                                    }
                                  >
                                    {t('Rotate key')}
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    disabled={!selectedModelApiKeyMeta?.has_api_key}
                                    onClick={() =>
                                      revokeRuntimeApiKey(
                                        framework,
                                        selectedModelBindingKey
                                      )
                                    }
                                  >
                                    {t('Revoke key')}
                                  </Button>
                                </div>
                                <small className="muted">
                                  {t('This model-level key only works after remote runtime is configured with the same key.')}
                                </small>
                                {selectedModelApiKeyMeta?.expires_at ? (
                                  <small className="muted">
                                    {t('Model key expires at {expiresAt}.', {
                                      expiresAt: selectedModelApiKeyMeta.expires_at
                                    })}
                                  </small>
                                ) : null}
                                <div className="row gap wrap">
                                  <Badge tone={selectedModelApiKeyMeta?.is_expired ? 'danger' : 'neutral'}>
                                    {selectedModelApiKeyMeta?.is_expired ? t('expired') : t('active')}
                                  </Badge>
                                  {selectedModelKeyExpiryStatus.tier === 'within_3_days' ? (
                                    <Badge tone="danger">{t('Expiring <=3d')}</Badge>
                                  ) : null}
                                  {selectedModelKeyExpiryStatus.tier === 'within_7_days' ? (
                                    <Badge tone="warning">{t('Expiring <=7d')}</Badge>
                                  ) : null}
                                  <Badge tone="neutral">
                                    {t('Used')}: {selectedModelApiKeyMeta?.used_calls ?? 0}
                                  </Badge>
                                  <Badge tone="neutral">
                                    {t('Remaining')}:{' '}
                                    {selectedModelApiKeyMeta?.remaining_calls ?? t('unlimited')}
                                  </Badge>
                                </div>
                                {selectedModelKeyExpiryStatus.tier === 'expired' ? (
                                  <small className="muted">
                                    {t('Model key expired. Rotate key and sync remote runtime now.')}
                                  </small>
                                ) : null}
                                {selectedModelKeyExpiryStatus.tier === 'within_3_days' &&
                                selectedModelKeyExpiryStatus.daysLeft !== null ? (
                                  <small className="muted">
                                    {t('Model key expires in {days} day(s). Rotate soon.', {
                                      days: selectedModelKeyExpiryStatus.daysLeft
                                    })}
                                  </small>
                                ) : null}
                                {selectedModelKeyExpiryStatus.tier === 'within_7_days' &&
                                selectedModelKeyExpiryStatus.daysLeft !== null ? (
                                  <small className="muted">
                                    {t('Model key expires in {days} day(s). Plan key rotation.', {
                                      days: selectedModelKeyExpiryStatus.daysLeft
                                    })}
                                  </small>
                                ) : null}
                                <div className="stack tight">
                                  <small className="muted">{t('Expires at (optional)')}</small>
                                  <Input
                                    value={selectedModelApiKeyExpiresAtValue}
                                    onChange={(event) =>
                                      updateRuntimeDraftModelApiKeyExpiresAt(
                                        framework,
                                        selectedModelBindingKey,
                                        event.target.value
                                      )
                                    }
                                    placeholder={t('ISO time, e.g. 2026-12-31T23:59:59Z')}
                                  />
                                </div>
                                <div className="stack tight">
                                  <small className="muted">{t('Max calls (optional)')}</small>
                                  <Input
                                    type="number"
                                    min={0}
                                    value={selectedModelApiKeyMaxCallsValue}
                                    onChange={(event) =>
                                      updateRuntimeDraftModelApiKeyMaxCalls(
                                        framework,
                                        selectedModelBindingKey,
                                        event.target.value
                                      )
                                    }
                                    placeholder={t('Leave empty for unlimited')}
                                  />
                                </div>
                              </label>
                            ) : (
                              <small className="muted">
                                {t('Select default model first to configure model-level API key.')}
                              </small>
                            )}

                            {selectedModelVersionBindingKey ? (
                              <label className="stack tight">
                                <small className="muted">
                                  {t('Model version API key (for selected version)')}
                                </small>
                                <div className="row gap wrap align-center">
                                  <Input
                                    type="password"
                                    value={selectedModelVersionApiKeyValue}
                                    onChange={(event) =>
                                      updateRuntimeDraftModelApiKey(
                                        framework,
                                        selectedModelVersionBindingKey,
                                        event.target.value
                                      )
                                    }
                                    placeholder={
                                      selectedModelVersionApiKeyMeta?.api_key_masked
                                        ? t('Stored key: {masked}', {
                                            masked: selectedModelVersionApiKeyMeta.api_key_masked
                                          })
                                        : t('Leave blank if selected model version does not need dedicated auth')
                                    }
                                  />
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      generateAndApplyModelBindingApiKey(
                                        framework,
                                        selectedModelVersionBindingKey
                                      )
                                    }
                                  >
                                    {t('Generate key')}
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      rotateRuntimeApiKey(
                                        framework,
                                        selectedModelVersionBindingKey
                                      )
                                    }
                                  >
                                    {t('Rotate key')}
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    disabled={!selectedModelVersionApiKeyMeta?.has_api_key}
                                    onClick={() =>
                                      revokeRuntimeApiKey(
                                        framework,
                                        selectedModelVersionBindingKey
                                      )
                                    }
                                  >
                                    {t('Revoke key')}
                                  </Button>
                                </div>
                                <small className="muted">
                                  {t('This model-version key only works after remote runtime is configured with the same key.')}
                                </small>
                                {selectedModelVersionApiKeyMeta?.expires_at ? (
                                  <small className="muted">
                                    {t('Model version key expires at {expiresAt}.', {
                                      expiresAt: selectedModelVersionApiKeyMeta.expires_at
                                    })}
                                  </small>
                                ) : null}
                                <div className="row gap wrap">
                                  <Badge tone={selectedModelVersionApiKeyMeta?.is_expired ? 'danger' : 'neutral'}>
                                    {selectedModelVersionApiKeyMeta?.is_expired ? t('expired') : t('active')}
                                  </Badge>
                                  {selectedModelVersionKeyExpiryStatus.tier === 'within_3_days' ? (
                                    <Badge tone="danger">{t('Expiring <=3d')}</Badge>
                                  ) : null}
                                  {selectedModelVersionKeyExpiryStatus.tier === 'within_7_days' ? (
                                    <Badge tone="warning">{t('Expiring <=7d')}</Badge>
                                  ) : null}
                                  <Badge tone="neutral">
                                    {t('Used')}: {selectedModelVersionApiKeyMeta?.used_calls ?? 0}
                                  </Badge>
                                  <Badge tone="neutral">
                                    {t('Remaining')}:{' '}
                                    {selectedModelVersionApiKeyMeta?.remaining_calls ?? t('unlimited')}
                                  </Badge>
                                </div>
                                {selectedModelVersionKeyExpiryStatus.tier === 'expired' ? (
                                  <small className="muted">
                                    {t(
                                      'Model version key expired. Rotate key and sync remote runtime now.'
                                    )}
                                  </small>
                                ) : null}
                                {selectedModelVersionKeyExpiryStatus.tier === 'within_3_days' &&
                                selectedModelVersionKeyExpiryStatus.daysLeft !== null ? (
                                  <small className="muted">
                                    {t('Model version key expires in {days} day(s). Rotate soon.', {
                                      days: selectedModelVersionKeyExpiryStatus.daysLeft
                                    })}
                                  </small>
                                ) : null}
                                {selectedModelVersionKeyExpiryStatus.tier === 'within_7_days' &&
                                selectedModelVersionKeyExpiryStatus.daysLeft !== null ? (
                                  <small className="muted">
                                    {t('Model version key expires in {days} day(s). Plan key rotation.', {
                                      days: selectedModelVersionKeyExpiryStatus.daysLeft
                                    })}
                                  </small>
                                ) : null}
                                <div className="stack tight">
                                  <small className="muted">{t('Expires at (optional)')}</small>
                                  <Input
                                    value={selectedModelVersionApiKeyExpiresAtValue}
                                    onChange={(event) =>
                                      updateRuntimeDraftModelApiKeyExpiresAt(
                                        framework,
                                        selectedModelVersionBindingKey,
                                        event.target.value
                                      )
                                    }
                                    placeholder={t('ISO time, e.g. 2026-12-31T23:59:59Z')}
                                  />
                                </div>
                                <div className="stack tight">
                                  <small className="muted">{t('Max calls (optional)')}</small>
                                  <Input
                                    type="number"
                                    min={0}
                                    value={selectedModelVersionApiKeyMaxCallsValue}
                                    onChange={(event) =>
                                      updateRuntimeDraftModelApiKeyMaxCalls(
                                        framework,
                                        selectedModelVersionBindingKey,
                                        event.target.value
                                      )
                                    }
                                    placeholder={t('Leave empty for unlimited')}
                                  />
                                </div>
                              </label>
                            ) : null}
                          </AdvancedSection>
                        </>
                      ) : null}

                      <AdvancedSection
                        title={t('Local runtime overrides')}
                        description={t('Optional local path and command overrides for operators who need non-default runners or weights.')}
                      >
                        <label className="stack tight">
                          <small className="muted">{t('Local model path')}</small>
                          <Input
                            value={draft.local_model_path}
                            onChange={(event) =>
                              updateRuntimeDraft(framework, 'local_model_path', event.target.value)
                            }
                            placeholder={
                              framework === 'yolo'
                                ? t('Optional. Recommended for YOLO real local execution.')
                                : t('Optional. Leave blank unless this framework needs a local model asset path.')
                            }
                          />
                          <small className="muted">
                            {framework === 'yolo'
                              ? t('Used for local real training/inference when endpoint is unavailable or you prefer local weights.')
                              : t('Only needed when this framework relies on local model assets instead of remote runtime defaults.')}
                          </small>
                        </label>

                        <label className="stack tight">
                          <small className="muted">{t('Local train command')}</small>
                          <Textarea
                            value={draft.local_train_command}
                            onChange={(event) =>
                              updateRuntimeDraft(framework, 'local_train_command', event.target.value)
                            }
                            rows={4}
                            placeholder={t('Optional. Leave empty to use built-in local runner preset.')}
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
                            placeholder={t('Optional. Leave empty to use built-in local runner preset.')}
                          />
                        </label>
                      </AdvancedSection>
                    </Panel>
                  );
	                })}
	              </div>
	            )}
	          </Card>
	          </div>

	          <SectionCard
              title={t('Framework inventory')}
              description={t('Use the table to see which frameworks are configured, reachable, and ready for endpoint or local execution.')}
              actions={
                <div className="row gap wrap">
                  <Badge tone="neutral">{t('Visible')}: {visibleFrameworks.length}</Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={focusRuntimeConfiguration}
                  >
                    {t('Open runtime configuration')}
                  </Button>
                </div>
              }
            >
              <StatusTable
                columns={frameworkTableColumns}
                rows={visibleFrameworks}
                getRowKey={(framework) => framework}
                emptyTitle={t('No frameworks')}
                emptyDescription={t('No framework matches the current filter.')}
              />
            </SectionCard>

	          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <Card as="article" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Next runtime step')}
                description={t('Finish one clear runtime setup action here before switching to validation.')}
                actions={
                  <Badge tone={localQuickStartCompleted ? 'success' : 'info'}>
                    {t('Done {done}/{total}', {
                      done: localQuickStartCompletedCount,
                      total: localQuickStartSteps.length
                    })}
                  </Badge>
                }
              />
              <div className="stack tight">
                <small className="muted">
                  {localQuickStartNextStep?.label ?? t('Completed')}
                </small>
                <div className="row gap wrap">
                  <Badge tone={runtimeReadinessIssueCount > 0 ? 'warning' : 'success'}>
                    {t('Open issues')}: {runtimeReadinessIssueCount}
                  </Badge>
                  <Badge tone="neutral">
                    {t('Active profile')}: {runtimeSettingsActiveProfileId ? t('configured') : t('none')}
                  </Badge>
                </div>
              </div>
              <div className="row gap wrap" style={{ marginTop: 8 }}>
                {renderLocalQuickStartAction('secondary')}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={focusRuntimeConfiguration}
                >
                  {t('Open runtime configuration')}
                </Button>
              </div>
            </Card>

          <Card as="article" className="workspace-inspector-card">
            <WorkspaceSectionHeader
              title={t('Other pages')}
              description={t('Keep Runtime page focused. Open other domains in their dedicated pages.')}
              actions={<Badge tone="info">{t('Single primary task')}</Badge>}
            />
            <div className="stack tight">
              <div className="row gap wrap">
                <ButtonLink to="/settings/runtime/templates" size="sm" variant="secondary">
                  {t('Open Runtime Templates')}
                </ButtonLink>
                <ButtonLink to="/settings/workers" size="sm" variant="ghost">
                  {t('Open Worker Settings')}
                </ButtonLink>
              </div>
              <small className="muted">
                {t('Use Runtime Templates for endpoint snippets and Worker Settings for lifecycle actions.')}
              </small>
            </div>
          </Card>

          <AdvancedSection
            title={t('Recent activity')}
            description={t('Recent inference and training summaries stay visible here.')}
          >
            <Card as="article" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Recent activity')}
                description={t('Recent inference and training summaries stay visible here.')}
              />
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
                          <Badge key={entry.key} tone={entry.key === 'fallback' ? 'warning' : 'success'}>
                            {entry.key === 'fallback' ? t('Degraded mode') : t('Real execution')}: {entry.count}
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
                            {describeTrainingExecutionSummaryLabel(t, entry.key)}: {entry.count}
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
          </AdvancedSection>
          </div>
        }
      />

    </WorkspacePage>
  );
}
