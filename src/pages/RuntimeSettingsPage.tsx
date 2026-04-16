import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ModelFramework,
  RuntimeConnectivityRecord,
  RuntimeFrameworkConfigView,
  RuntimeReadinessReport,
  RuntimeProfileView,
  RuntimeSettingsView,
  RuntimeApiKeyMetaView,
  ModelRecord,
  ModelVersionRecord
} from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import SettingsTabs from '../components/settings/SettingsTabs';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import {
  FilterToolbar,
  InlineAlert,
  PageHeader,
  SectionCard,
  StatusTable,
  type StatusTableColumn
} from '../components/ui/ConsolePage';
import { Checkbox, Input, Select, Textarea } from '../components/ui/Field';
import { Panel } from '../components/ui/Surface';
import { WorkspacePage, WorkspaceWorkbench } from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';

const FRAMEWORKS: ModelFramework[] = ['paddleocr', 'doctr', 'yolo'];

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

const buildDefaultRuntimeConnectionModeMap = (): RuntimeConnectionModeMap => ({
  paddleocr: 'local',
  doctr: 'local',
  yolo: 'local'
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
  const runtimeRecommendedLocalPythonBin = '/opt/vistral-venv/bin/python';
  const [runtimePageMode, setRuntimePageMode] = useState<'setup' | 'readiness' | 'advanced'>('setup');
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
  const [runtimeConnectionModes, setRuntimeConnectionModes] = useState<RuntimeConnectionModeMap>(
    () => buildDefaultRuntimeConnectionModeMap()
  );
  const runtimeConfigurationRef = useRef<HTMLDivElement | null>(null);
  const runtimeAdvancedEditorRef = useRef<HTMLDivElement | null>(null);
  const readinessSectionRef = useRef<HTMLDivElement | null>(null);
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
    setRuntimeConnectionModes({
      paddleocr: resolveRuntimeConnectionMode(nextDrafts.paddleocr),
      doctr: resolveRuntimeConnectionMode(nextDrafts.doctr),
      yolo: resolveRuntimeConnectionMode(nextDrafts.yolo)
    });
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
  const runtimeAllFrameworksLocalMode = FRAMEWORKS.every(
    (framework) => runtimeConnectionModes[framework] === 'local'
  );
  const runtimeModelById = useMemo(
    () => new Map(runtimeModels.map((model) => [model.id, model])),
    [runtimeModels]
  );
  const runtimeModelVersionById = useMemo(
    () => new Map(runtimeModelVersions.map((version) => [version.id, version])),
    [runtimeModelVersions]
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
    if (field === 'endpoint' && value.trim()) {
      setRuntimeConnectionModes((prev) => ({
        ...prev,
        [framework]: 'endpoint'
      }));
    }
  };

  const updateRuntimeDefaultModel = (framework: ModelFramework, modelId: string) => {
    setRuntimeDrafts((prev) => {
      const currentVersionId = prev[framework].default_model_version_id.trim();
      const allowedVersionIds = new Set(
        runtimeModelVersions
          .filter((version) => !modelId || version.model_id === modelId)
          .map((version) => version.id)
      );
      return {
        ...prev,
        [framework]: {
          ...prev[framework],
          default_model_id: modelId,
          default_model_version_id:
            currentVersionId && allowedVersionIds.has(currentVersionId) ? currentVersionId : ''
        }
      };
    });
  };

  const updateRuntimeDefaultModelVersion = (framework: ModelFramework, versionId: string) => {
    setRuntimeDrafts((prev) => {
      const selectedVersion = runtimeModelVersionById.get(versionId);
      return {
        ...prev,
        [framework]: {
          ...prev[framework],
          default_model_id: versionId
            ? selectedVersion?.model_id ?? prev[framework].default_model_id
            : prev[framework].default_model_id,
          default_model_version_id: versionId
        }
      };
    });
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
    if (mode === 'local') {
      const currentDraft = runtimeDrafts[framework];
      const hasRemoteConfig = Boolean(
        currentDraft.endpoint.trim() ||
          currentDraft.api_key.trim() ||
          currentDraft.has_api_key ||
          Object.keys(currentDraft.model_api_keys).some((key) => currentDraft.model_api_keys[key]?.trim()) ||
          Object.keys(currentDraft.model_api_keys_meta).length
      );
      if (
        hasRemoteConfig &&
        !window.confirm(
          t('Switching to local mode will clear endpoint and runtime keys. Continue?')
        )
      ) {
        return;
      }
      setRuntimeDrafts((prev) => ({
        ...prev,
        [framework]: {
          ...prev[framework],
          endpoint: '',
          api_key: '',
          model_api_keys: {},
          model_api_key_expires_at: {},
          model_api_key_max_calls: {}
        }
      }));
    }
    setRuntimeConnectionModes((prev) => ({
      ...prev,
      [framework]: mode
    }));
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
    setRuntimeConnectionModes({
      paddleocr: 'local',
      doctr: 'local',
      yolo: 'local'
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

  // Run one-time bootstrap pulls for runtime configuration and readiness.
  useEffect(() => {
    void refresh();
    void refreshRuntimeSettings();
    void refreshRuntimeReadiness();
    void refreshRuntimeModelOptions();
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
  const unreachableCount = checks.filter((item) => item.source === 'unreachable').length;
  const configuredCount = checks.filter((item) => item.source !== 'not_configured').length;
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
  const runtimeReadinessReady = runtimeReadiness?.status === 'ready';
  const runtimeLocalConfigPersisted = runtimeAllFrameworksLocalMode && !runtimeHasUnsavedChanges;
  const configuredLocalPythonBin = runtimeControlDraft.python_bin.trim() || runtimeRecommendedLocalPythonBin;
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

  const focusRuntimeConfiguration = useCallback(() => {
    const target = runtimeAdvancedEditorRef.current ?? runtimeConfigurationRef.current;
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const focusReadinessSection = useCallback(() => {
    readinessSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const openFrameworkEditor = useCallback(
    (framework: ModelFramework) => {
      setRuntimePageMode('advanced');
      setFrameworkFilter(framework);
      window.requestAnimationFrame(() => {
        focusRuntimeConfiguration();
      });
    },
    [focusRuntimeConfiguration]
  );

  const getRuntimeBindingEntries = useCallback(
    (framework: ModelFramework) => {
      const draft = runtimeDrafts[framework];
      const entries: Array<{
        key: string;
        label: string;
        description: string;
        meta?: RuntimeApiKeyMetaView;
      }> = [];
      const seen = new Set<string>();
      const bindingKeys = new Set<string>([
        ...Object.keys(draft.model_api_keys_meta),
        ...Object.keys(draft.model_api_keys),
        ...Object.keys(draft.model_api_key_expires_at),
        ...Object.keys(draft.model_api_key_max_calls)
      ]);
      const pushBinding = (bindingKey: string) => {
        const normalized = bindingKey.trim();
        if (!normalized || seen.has(normalized)) {
          return;
        }
        seen.add(normalized);
        if (normalized.startsWith('model_version:')) {
          const versionId = normalized.slice('model_version:'.length);
          const version = runtimeModelVersionById.get(versionId);
          const model = version ? runtimeModelById.get(version.model_id) : null;
          entries.push({
            key: normalized,
            label: t('Version-specific API key'),
            description:
              version && model
                ? `${model.name} / ${version.version_name}`
                : version?.version_name ?? versionId,
            meta: draft.model_api_keys_meta[normalized]
          });
          return;
        }
        if (normalized.startsWith('model:')) {
          const modelId = normalized.slice('model:'.length);
          const model = runtimeModelById.get(modelId);
          entries.push({
            key: normalized,
            label: t('Model-specific API key'),
            description: model?.name ?? modelId,
            meta: draft.model_api_keys_meta[normalized]
          });
        }
      };

      if (draft.default_model_id.trim()) {
        bindingKeys.add(`model:${draft.default_model_id.trim()}`);
      }
      if (draft.default_model_version_id.trim()) {
        bindingKeys.add(`model_version:${draft.default_model_version_id.trim()}`);
      }

      Array.from(bindingKeys)
        .sort((left, right) => left.localeCompare(right))
        .forEach(pushBinding);

      return entries;
    },
    [runtimeDrafts, runtimeModelById, runtimeModelVersionById, t]
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
                openFrameworkEditor(framework);
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
      frameworkFilter,
      openFrameworkEditor,
      refresh,
      runtimeConnectionModes,
      runtimeDrafts,
      t
    ]
  );

  void [
    resolveRuntimeApiKeyExpiryStatus,
    unreachableCount,
    runtimeReadinessBadgeTone
  ];

  const heroPrimaryAction =
    runtimePageMode === 'setup'
      ? {
          label: t('Go to readiness'),
          onClick: () => {
            setRuntimePageMode('readiness');
            focusReadinessSection();
            void refreshRuntimeReadiness();
          },
          disabled: runtimeReadinessLoading
        }
      : runtimePageMode === 'readiness'
        ? {
            label: runtimeReadinessLoading ? t('Checking...') : t('Refresh readiness'),
            onClick: () => {
              setRuntimePageMode('readiness');
              focusReadinessSection();
              void refreshRuntimeReadiness();
            },
            disabled: runtimeReadinessLoading
          }
        : {
            label: checking ? t('Checking...') : t('Refresh frameworks'),
            onClick: () => {
              setRuntimePageMode('advanced');
              void refresh();
            },
            disabled: checking
          };

  const heroSection = (
    <PageHeader
      eyebrow={t('Runtime operations')}
      title={t('Runtime Settings')}
      description={t('Choose a setup path first, then inspect readiness only when you need to fix something. Worker lifecycle operations live in Worker Settings.')}
      meta={
        <div className="row gap wrap align-center">
          <Badge tone={runtimeHasUnsavedChanges ? 'warning' : 'neutral'}>
            {runtimeHasUnsavedChanges ? t('Unsaved edits') : t('Saved draft')}
          </Badge>
          <Badge tone="neutral">
            {t('Python')}: <code>{configuredLocalPythonBin}</code>
          </Badge>
        </div>
      }
      primaryAction={heroPrimaryAction}
      secondaryActions={
        <div className="row gap wrap">
          <Button
            type="button"
            variant={runtimePageMode === 'setup' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setRuntimePageMode('setup')}
          >
            {t('Setup')}
          </Button>
          <Button
            type="button"
            variant={runtimePageMode === 'readiness' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setRuntimePageMode('readiness')}
          >
            {t('Readiness')}
          </Button>
          <Button
            type="button"
            variant={runtimePageMode === 'advanced' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setRuntimePageMode('advanced')}
          >
            {t('Advanced')}
          </Button>
        </div>
      }
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
      {error ? (
        <InlineAlert
          tone="danger"
          title={t('Runtime Check Failed')}
          description={error}
        />
      ) : null}
      <WorkspaceWorkbench
        toolbar={
          runtimePageMode === 'advanced' ? (
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
                </>
              }
            />
          ) : null
        }
        main={
          <div className="workspace-main-stack">
            {runtimePageMode === 'setup' ? (
              <div ref={runtimeConfigurationRef} className="stack">
                <SectionCard
                  title={t('Recommended local runtime')}
                  description={t('Set the local Python path, then apply the draft.')}
                  actions={
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
                >
                  <div className="stack">
                    <Panel as="section" className="workspace-record-item stack tight" tone="soft">
                      <div className="row between gap wrap align-center">
                        <strong>{t('Local runtime')}</strong>
                        <Badge tone={runtimeLocalConfigPersisted ? 'success' : 'info'}>
                          {runtimeLocalConfigPersisted ? t('ready') : t('Recommended')}
                        </Badge>
                      </div>
                      <small className="muted">
                        {t('Use the single-machine path and the runtime Python shown above.')}
                      </small>
                      <small className="muted">
                        {t('Runtime Python')}: <code>{configuredLocalPythonBin}</code>
                      </small>
                      <div className="row gap wrap">
                        {renderLocalQuickStartAction()}
                        <ButtonLink to="/inference/validate" size="sm" variant="ghost">
                          {t('Open Validation')}
                        </ButtonLink>
                      </div>
                    </Panel>

                    <details className="workspace-details">
                      <summary>{t('Advanced setup')} · {t('profiles')} / {t('manual overrides')}</summary>
                      <div className="stack">
                        <Panel as="section" className="workspace-record-item stack tight" tone="soft">
                          <div className="row between gap wrap align-center">
                            <strong>{t('Profile activation')}</strong>
                            <Badge
                              tone={
                                runtimeSettingsActiveProfileId && runtimeSettingsActiveProfileId !== 'saved'
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
                            {t('Use this when deployment profiles are already prepared.')}
                          </small>
                          <label className="stack tight">
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
                          <div className="stack tight">
                            <small className="muted">
                              {t('Selected profile')}: {selectedRuntimeProfile?.label || t('No profiles')}
                            </small>
                            <small className="muted">
                              {t('Source')}: {selectedRuntimeProfile?.source || t('n/a')}
                            </small>
                          </div>
                          <div className="row gap wrap">
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
                          </div>
                        </Panel>

                        <Panel as="section" className="workspace-record-item stack tight" tone="soft">
                          <div className="row between gap wrap align-center">
                            <strong>{t('Custom framework setup')}</strong>
                            <Badge tone={runtimeHasUnsavedChanges ? 'warning' : configuredCount > 0 ? 'info' : 'neutral'}>
                              {runtimeHasUnsavedChanges
                                ? t('Unsaved edits')
                                : configuredCount > 0
                                  ? t('in progress')
                                  : t('pending')}
                            </Badge>
                          </div>
                          <small className="muted">
                            {t('Manual mode for endpoint, auth, and local overrides.')}
                          </small>
                          <div className="stack tight">
                            <small className="muted">
                              {t('Configured')}: {configuredCount} / {FRAMEWORKS.length}
                            </small>
                            <small className="muted">
                              {t('Unsaved edits')}: {runtimeHasUnsavedChanges ? t('yes') : t('no')}
                            </small>
                          </div>
                        </Panel>
                      </div>

                    </details>
                    <div className="row gap wrap align-center">
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
                      {runtimeHasUnsavedChanges ? (
                        <Badge tone="warning">{t('Unsaved edits')}</Badge>
                      ) : (
                        <Badge tone="success">{t('Saved draft')}</Badge>
                      )}
                    </div>
                  </div>
                </SectionCard>
              </div>
            ) : runtimePageMode === 'readiness' ? (
              <div ref={readinessSectionRef} className="stack">
                {runtimeReadinessError ? (
                  <StateBlock
                    variant="error"
                    title={t('Runtime readiness check failed')}
                    description={runtimeReadinessError}
                  />
                ) : runtimeReadinessLoading ? (
                  <StateBlock
                    variant="loading"
                    title={t('Checking runtime readiness')}
                    description={t('Checking local runtime.')}
                  />
                ) : runtimeReadiness ? (
                  <>
                    <SectionCard
                      title={t('Runtime readiness')}
                      description={t('Keep the summary visible. Open diagnostics only when needed.')}
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
                      <div className="stack tight">
                        <div className="row gap wrap align-center">
                          <Badge tone={runtimeReadinessBadgeTone}>
                            {runtimeReadiness.status === 'ready'
                              ? t('Ready')
                              : runtimeReadiness.status === 'degraded'
                                ? t('Degraded')
                                : t('Not ready')}
                          </Badge>
                          <Badge tone={runtimeReadinessErrorCount > 0 ? 'danger' : 'success'}>
                            {t('Errors')}: {runtimeReadinessErrorCount}
                          </Badge>
                          <Badge tone={runtimeReadinessWarningCount > 0 ? 'warning' : 'neutral'}>
                            {t('Warnings')}: {runtimeReadinessWarningCount}
                          </Badge>
                          <Badge tone={runtimeAllFrameworksLocalMode ? 'info' : 'warning'}>
                            {t('Mode')}: {runtimeAllFrameworksLocalMode ? t('Local-first') : t('Mixed / endpoint')}
                          </Badge>
                        </div>
                        <small className="muted">
                            {runtimeReadinessIssueCount > 0
                            ? t('{count} open issues remain. Open diagnostics for details.', {
                                count: runtimeReadinessIssueCount
                              })
                            : t('No blocking runtime issues detected.')}
                        </small>
                      </div>
                    </SectionCard>
                    {runtimeReadinessFixCommands.length > 0 || runtimeReadiness.issues.length > 0 ? (
                      <details className="workspace-details">
                        <summary>{t('Technical diagnostics and fix commands')}</summary>
                        <SectionCard
                          title={t('Detailed diagnostics')}
                          description={t('Keep raw issues, remediation text, and copyable commands folded until you need to act.')}
                          actions={
                            <div className="row gap wrap align-center">
                              {runtimeReadinessFixCommands.length > 0 ? (
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
                              ) : null}
                              {runtimeReadiness.issues.length > 0 ? (
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
                              ) : null}
                            </div>
                          }
                        >
                          <div className="stack tight">
                            {runtimeReadinessFixCommands.length > 0 ? (
                              <div className="stack tight">
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
                        </SectionCard>
                      </details>
                    ) : (
                      <small className="muted">{t('No blocking runtime issues detected.')}</small>
                    )}
                  </>
                ) : null}
              </div>
            ) : (
              <div className="stack">
                <SectionCard
                  title={t('Framework inventory')}
                  description={t('Use the table to see which frameworks are configured and reachable.')}
                  actions={
                    <div className="row gap wrap">
                      <Badge tone="neutral">{t('Visible')}: {visibleFrameworks.length}</Badge>
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
                <SectionCard
                  title={t('Editing form')}
                  description={t('Edit the form below. Leave API Key blank to keep the saved key.')}
                  actions={
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
                        {runtimeSettingsClearing ? t('Clearing...') : t('Clear saved settings')}
                      </Button>
                    </div>
                  }
                >
                  <div ref={runtimeAdvancedEditorRef} className="stack">
                    {runtimeModelOptionsError ? (
                      <InlineAlert
                        tone="danger"
                        title={t('Runtime model options unavailable')}
                        description={runtimeModelOptionsError}
                      />
                    ) : null}
                    {runtimeModelOptionsLoading ? (
                      <small className="muted">{t('Loading runtime model options...')}</small>
                    ) : null}
                    <Panel as="section" className="workspace-record-item stack tight" tone="soft">
                      <div className="row between gap wrap align-center">
                        <strong>{t('Local execution controls')}</strong>
                        <Badge tone={runtimeHasUnsavedChanges ? 'warning' : 'neutral'}>
                          {runtimeHasUnsavedChanges ? t('Unsaved edits') : t('Saved draft')}
                        </Badge>
                      </div>
                      <small className="muted">
                        {t('Update Python path, fallback guards, and key reuse before saving.')}
                      </small>
                      <div className="workspace-form-grid">
                        <label className="stack tight">
                          <small className="muted">{t('Local Python executable')}</small>
                          <Input
                            value={runtimeControlDraft.python_bin}
                            onChange={(event) =>
                              updateRuntimeControlDraft('python_bin', event.target.value)
                            }
                            placeholder={runtimeRecommendedLocalPythonBin}
                          />
                        </label>
                        <label className="stack tight">
                          <small className="muted">{t('Saved snapshot')}</small>
                          <small className="muted">
                            {runtimeSettingsUpdatedAt
                              ? `${t('Updated')}: ${formatTimestamp(runtimeSettingsUpdatedAt)}`
                              : t('No saved settings yet.')}
                          </small>
                        </label>
                        <label className="workspace-checkbox-row workspace-form-span-2">
                          <Checkbox
                            checked={keepExistingApiKeys}
                            onChange={(event) => setKeepExistingApiKeys(event.target.checked)}
                          />
                          <span>{t('Blank API Key means save/test will keep using the saved key.')}</span>
                        </label>
                        <label className="workspace-checkbox-row">
                          <Checkbox
                            checked={runtimeControlDraft.disable_simulated_train_fallback}
                            onChange={(event) =>
                              updateRuntimeControlDraft(
                                'disable_simulated_train_fallback',
                                event.target.checked
                              )
                            }
                          />
                          <span>{t('Disable simulated train fallback')}</span>
                        </label>
                        <label className="workspace-checkbox-row">
                          <Checkbox
                            checked={runtimeControlDraft.disable_inference_fallback}
                            onChange={(event) =>
                              updateRuntimeControlDraft(
                                'disable_inference_fallback',
                                event.target.checked
                              )
                            }
                          />
                          <span>{t('Disable inference fallback')}</span>
                        </label>
                      </div>
                      <div className="row gap wrap">
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
                          {runtimeSettingsAutoConfiguring ? t('Applying...') : t('Auto-match endpoints')}
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
                          {t('Overwrite endpoints')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => void refresh()}
                          disabled={checking}
                        >
                          {checking ? t('Checking...') : t('Refresh frameworks')}
                        </Button>
                      </div>
                    </Panel>

                    {visibleFrameworks.map((framework) => {
                      const draft = runtimeDrafts[framework];
                      const mode = runtimeConnectionModes[framework];
                      const connectivity = checkByFramework.get(framework)?.source ?? 'not_configured';
                      const modelOptions = frameworkModelOptions[framework];
                      const versionOptions = frameworkVersionOptions[framework];
                      const bindingEntries = getRuntimeBindingEntries(framework);

                      return (
                        <Panel
                          key={framework}
                          as="section"
                          className="workspace-record-item stack"
                          tone="soft"
                        >
                          <div className="row between gap wrap align-center">
                            <div className="stack tight">
                              <strong>{t(framework)}</strong>
                              <small className="muted">
                                {mode === 'local'
                                  ? t('Run on this machine')
                                  : t('Call remote runtime')}
                              </small>
                            </div>
                            <div className="row gap wrap align-center">
                              <Badge
                                tone={
                                  connectivity === 'reachable'
                                    ? 'success'
                                    : connectivity === 'unreachable'
                                      ? 'danger'
                                      : 'neutral'
                                }
                              >
                                {connectivity === 'reachable'
                                  ? t('reachable')
                                  : connectivity === 'unreachable'
                                    ? t('unreachable')
                                    : t('not configured')}
                              </Badge>
                              <Badge tone={mode === 'local' ? 'info' : 'warning'}>
                                {mode === 'local' ? t('Local mode') : t('Endpoint mode')}
                              </Badge>
                              {bindingEntries.some((entry) => entry.meta?.has_api_key) ? (
                                <Badge tone="info">
                                  {t('Saved bindings')}:{' '}
                                  {bindingEntries.filter((entry) => entry.meta?.has_api_key).length}
                                </Badge>
                              ) : null}
                            </div>
                          </div>

                          <div className="row gap wrap">
                            <Button
                              type="button"
                              variant={mode === 'local' ? 'secondary' : 'ghost'}
                              size="sm"
                              onClick={() => setRuntimeFrameworkMode(framework, 'local')}
                              disabled={
                                runtimeSettingsLoading ||
                                runtimeSettingsSaving ||
                                runtimeSettingsClearing ||
                                runtimeSettingsAutoConfiguring
                              }
                            >
                              {t('Local mode')}
                            </Button>
                            <Button
                              type="button"
                              variant={mode === 'endpoint' ? 'secondary' : 'ghost'}
                              size="sm"
                              onClick={() => setRuntimeFrameworkMode(framework, 'endpoint')}
                              disabled={
                                runtimeSettingsLoading ||
                                runtimeSettingsSaving ||
                                runtimeSettingsClearing ||
                                runtimeSettingsAutoConfiguring
                              }
                            >
                              {t('Endpoint mode')}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => void refresh(framework)}
                              disabled={checking}
                            >
                              {checking && frameworkFilter === framework ? t('Checking...') : t('Check')}
                            </Button>
                          </div>

                          <div className="workspace-form-grid">
                            <label className="stack tight">
                              <small className="muted">{t('Default model')}</small>
                              <Select
                                value={draft.default_model_id}
                                onChange={(event) =>
                                  updateRuntimeDefaultModel(framework, event.target.value)
                                }
                              >
                                <option value="">{t('No default model')}</option>
                                {modelOptions.map((option) => (
                                  <option key={option.id} value={option.id}>
                                    {option.label}
                                  </option>
                                ))}
                              </Select>
                            </label>
                            <label className="stack tight">
                              <small className="muted">{t('Default model version')}</small>
                              <Select
                                value={draft.default_model_version_id}
                                onChange={(event) =>
                                  updateRuntimeDefaultModelVersion(framework, event.target.value)
                                }
                              >
                                <option value="">{t('No default version')}</option>
                                {versionOptions.map((option) => (
                                  <option key={option.id} value={option.id}>
                                    {option.label}
                                  </option>
                                ))}
                              </Select>
                            </label>
                            {mode === 'endpoint' ? (
                              <>
                                <label className="stack tight workspace-form-span-2">
                                  <small className="muted">{t('Endpoint URL')}</small>
                                  <Input
                                    value={draft.endpoint}
                                    onChange={(event) =>
                                      updateRuntimeDraft(framework, 'endpoint', event.target.value)
                                    }
                                    placeholder="http://127.0.0.1:9001"
                                  />
                                  <small className="muted">
                                    {t('Call remote runtime when endpoint is configured.')}
                                  </small>
                                </label>
                                <label className="stack tight workspace-form-span-2">
                                  <small className="muted">{t('Framework API key')}</small>
                                  <Input
                                    type="password"
                                    value={draft.api_key}
                                    onChange={(event) =>
                                      updateRuntimeDraft(framework, 'api_key', event.target.value)
                                    }
                                    placeholder={
                                      draft.has_api_key
                                        ? t('Leave API Key blank to keep using the saved key.')
                                        : ''
                                    }
                                  />
                                  <small className="muted">
                                    {draft.has_api_key
                                      ? t('Stored key: {key}', { key: draft.api_key_masked })
                                      : t('No saved key yet. Input API key once to start managed editing.')}
                                  </small>
                                </label>
                              </>
                            ) : null}
                            <label className="stack tight">
                              <small className="muted">{t('Local model path')}</small>
                              <Input
                                value={draft.local_model_path}
                                onChange={(event) =>
                                  updateRuntimeDraft(framework, 'local_model_path', event.target.value)
                                }
                                placeholder={t('Optional local model artifact path')}
                              />
                            </label>
                            <label className="stack tight workspace-form-span-2">
                              <small className="muted">{t('Local train command')}</small>
                              <Textarea
                                rows={3}
                                value={draft.local_train_command}
                                onChange={(event) =>
                                  updateRuntimeDraft(
                                    framework,
                                    'local_train_command',
                                    event.target.value
                                  )
                                }
                                placeholder={t('Optional local training command')}
                              />
                            </label>
                            <label className="stack tight workspace-form-span-2">
                              <small className="muted">{t('Local predict command')}</small>
                              <Textarea
                                rows={3}
                                value={draft.local_predict_command}
                                onChange={(event) =>
                                  updateRuntimeDraft(
                                    framework,
                                    'local_predict_command',
                                    event.target.value
                                  )
                                }
                                placeholder={t('Optional local prediction command')}
                              />
                            </label>
                          </div>

                          {mode === 'endpoint' ? (
                            <div className="stack tight">
                              <div className="row gap wrap">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => generateAndApplyFrameworkApiKey(framework)}
                                  disabled={
                                    runtimeSettingsLoading ||
                                    runtimeSettingsSaving ||
                                    runtimeSettingsClearing ||
                                    runtimeSettingsAutoConfiguring
                                  }
                                >
                                  {t('Generate key')}
                                </Button>
                                {draft.has_api_key ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => rotateRuntimeApiKey(framework)}
                                    disabled={runtimeSettingsSaving}
                                  >
                                    {t('Rotate saved key')}
                                  </Button>
                                ) : null}
                                {draft.has_api_key ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => revokeRuntimeApiKey(framework)}
                                    disabled={runtimeSettingsSaving}
                                  >
                                    {t('Revoke saved key')}
                                  </Button>
                                ) : null}
                              </div>

                              {bindingEntries.length > 0 ? (
                                <details className="workspace-details">
                                  <summary>{t('Model and version keys')}</summary>
                                  <div className="stack" style={{ marginTop: '0.75rem' }}>
                                    {bindingEntries.map((entry) => {
                                      const draftValue = draft.model_api_keys[entry.key] ?? '';
                                      const expiresAtValue =
                                        draft.model_api_key_expires_at[entry.key] ?? '';
                                      const maxCallsValue =
                                        draft.model_api_key_max_calls[entry.key] ?? '';
                                      return (
                                        <Panel
                                          key={entry.key}
                                          as="section"
                                          className="workspace-record-item compact stack tight"
                                          tone="soft"
                                        >
                                          <div className="row between gap wrap align-center">
                                            <div className="stack tight">
                                              <strong>{entry.label}</strong>
                                              <small className="muted">{entry.description}</small>
                                            </div>
                                            <Badge
                                              tone={
                                                entry.meta?.has_api_key
                                                  ? 'success'
                                                  : draftValue.trim()
                                                    ? 'info'
                                                    : 'neutral'
                                              }
                                            >
                                              {entry.meta?.has_api_key
                                                ? t('Saved')
                                                : draftValue.trim()
                                                  ? t('Unsaved edits')
                                                  : t('Missing')}
                                            </Badge>
                                          </div>
                                          <div className="workspace-form-grid">
                                            <label className="stack tight workspace-form-span-2">
                                              <small className="muted">{t('API Key')}</small>
                                              <Input
                                                type="password"
                                                value={draftValue}
                                                onChange={(event) =>
                                                  updateRuntimeDraftModelApiKey(
                                                    framework,
                                                    entry.key,
                                                    event.target.value
                                                  )
                                                }
                                                placeholder={
                                                  entry.meta?.has_api_key
                                                    ? t('Leave API Key blank to keep using the saved key.')
                                                    : ''
                                                }
                                              />
                                            </label>
                                            <label className="stack tight">
                                              <small className="muted">{t('Expires at (optional)')}</small>
                                              <Input
                                                value={expiresAtValue}
                                                onChange={(event) =>
                                                  updateRuntimeDraftModelApiKeyExpiresAt(
                                                    framework,
                                                    entry.key,
                                                    event.target.value
                                                  )
                                                }
                                                placeholder="2026-12-31T00:00:00Z"
                                              />
                                            </label>
                                            <label className="stack tight">
                                              <small className="muted">{t('Max calls (optional)')}</small>
                                              <Input
                                                value={maxCallsValue}
                                                inputMode="numeric"
                                                onChange={(event) =>
                                                  updateRuntimeDraftModelApiKeyMaxCalls(
                                                    framework,
                                                    entry.key,
                                                    event.target.value
                                                  )
                                                }
                                              />
                                            </label>
                                          </div>
                                          <small className="muted">
                                            {entry.meta?.has_api_key
                                              ? t('Stored key: {key}', {
                                                  key: entry.meta.api_key_masked
                                                })
                                              : t('No saved key yet. Input API key once to start managed editing.')}
                                          </small>
                                          <div className="row gap wrap">
                                            <Button
                                              type="button"
                                              variant="ghost"
                                              size="sm"
                                              onClick={() =>
                                                generateAndApplyModelBindingApiKey(
                                                  framework,
                                                  entry.key
                                                )
                                              }
                                              disabled={runtimeSettingsSaving}
                                            >
                                              {t('Generate key')}
                                            </Button>
                                            {entry.meta?.has_api_key ? (
                                              <Button
                                                type="button"
                                                variant="ghost"
                                                size="sm"
                                                onClick={() =>
                                                  rotateRuntimeApiKey(framework, entry.key)
                                                }
                                                disabled={runtimeSettingsSaving}
                                              >
                                                {t('Rotate saved key')}
                                              </Button>
                                            ) : null}
                                            {entry.meta?.has_api_key ? (
                                              <Button
                                                type="button"
                                                variant="ghost"
                                                size="sm"
                                                onClick={() =>
                                                  revokeRuntimeApiKey(framework, entry.key)
                                                }
                                                disabled={runtimeSettingsSaving}
                                              >
                                                {t('Revoke saved key')}
                                              </Button>
                                            ) : null}
                                          </div>
                                        </Panel>
                                      );
                                    })}
                                  </div>
                                </details>
                              ) : null}
                            </div>
                          ) : (
                            <small className="muted">
                              {t('Local mode ignores remote endpoint and API key fields.')}
                            </small>
                          )}
                        </Panel>
                      );
                    })}
                  </div>
                </SectionCard>
              </div>
            )}

          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <SectionCard
              title={t('Next step')}
              description={t('Keep the rail short. The main setup flow stays on the left.')}
            >
              <small className="muted">
                {t('Current focus')}:{' '}
                {runtimePageMode === 'setup'
                  ? localQuickStartNextStep?.label ?? t('Completed')
                  : runtimePageMode === 'readiness'
                    ? t('Refresh readiness and resolve open issues')
                    : t('Review framework inventory and advanced controls')}
              </small>
              <div className="row gap wrap">
                {runtimePageMode === 'setup' ? (
                  renderLocalQuickStartAction('ghost')
                ) : runtimePageMode === 'readiness' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void refreshRuntimeReadiness()}
                    disabled={runtimeReadinessLoading}
                  >
                    {runtimeReadinessLoading ? t('Checking...') : t('Refresh readiness')}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void refresh()}
                    disabled={checking}
                  >
                    {checking ? t('Checking...') : t('Refresh frameworks')}
                  </Button>
                )}
              </div>
            </SectionCard>

          </div>
        }
      />

    </WorkspacePage>
  );
}
