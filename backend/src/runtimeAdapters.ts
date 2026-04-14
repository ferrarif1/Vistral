import { spawn } from 'node:child_process';
import { existsSync, promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import type {
  ModelFramework,
  RuntimeApiKeyPolicy,
  RuntimeConnectivityErrorKind,
  RuntimeConnectivityRecord,
  TaskType,
  UnifiedInferenceOutput
} from '../../shared/domain';
import type {
  EvaluateInput,
  EvaluateResult,
  ExportInput,
  ExportResult,
  LoadedModelRef,
  LoadModelInput,
  PredictInput,
  TrainInput,
  TrainResult,
  UnifiedTrainer,
  ValidateDatasetInput,
  ValidateDatasetResult
} from '../../shared/runtime';
import { persistRuntimeSettings, runtimeSettings } from './store';
import { bundledLocalRunnerCommands, resolveBundledLocalModelPath } from './runtimeDefaults';

const delay = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

interface FrameworkRuntimeConfig {
  endpoint: string;
  apiKey: string;
  defaultModelId: string;
  defaultModelVersionId: string;
  modelApiKeys: Record<string, string>;
  modelApiKeyPolicies: Record<string, RuntimeApiKeyPolicy>;
  localModelPath: string;
  localTrainCommand: string;
  localPredictCommand: string;
}

const emptyFrameworkRuntimeConfig: FrameworkRuntimeConfig = {
  endpoint: '',
  apiKey: '',
  defaultModelId: '',
  defaultModelVersionId: '',
  modelApiKeys: {},
  modelApiKeyPolicies: {},
  localModelPath: '',
  localTrainCommand: '',
  localPredictCommand: ''
};

const resolveFrameworkRuntimeConfigFromEnv = (
  framework: ModelFramework
): FrameworkRuntimeConfig => {
  if (framework === 'paddleocr') {
    return {
      endpoint: (process.env.PADDLEOCR_RUNTIME_ENDPOINT ?? '').trim(),
      apiKey: (process.env.PADDLEOCR_RUNTIME_API_KEY ?? '').trim(),
      defaultModelId: '',
      defaultModelVersionId: '',
      modelApiKeys: {},
      modelApiKeyPolicies: {},
      localModelPath:
        (process.env.PADDLEOCR_LOCAL_MODEL_PATH ?? '').trim() || resolveBundledLocalModelPath(framework),
      localTrainCommand: (process.env.PADDLEOCR_LOCAL_TRAIN_COMMAND ?? '').trim(),
      localPredictCommand: (process.env.PADDLEOCR_LOCAL_PREDICT_COMMAND ?? '').trim()
    };
  }

  if (framework === 'doctr') {
    return {
      endpoint: (process.env.DOCTR_RUNTIME_ENDPOINT ?? '').trim(),
      apiKey: (process.env.DOCTR_RUNTIME_API_KEY ?? '').trim(),
      defaultModelId: '',
      defaultModelVersionId: '',
      modelApiKeys: {},
      modelApiKeyPolicies: {},
      localModelPath:
        (process.env.DOCTR_LOCAL_MODEL_PATH ?? '').trim() || resolveBundledLocalModelPath(framework),
      localTrainCommand: (process.env.DOCTR_LOCAL_TRAIN_COMMAND ?? '').trim(),
      localPredictCommand: (process.env.DOCTR_LOCAL_PREDICT_COMMAND ?? '').trim()
    };
  }

  return {
    endpoint: (process.env.YOLO_RUNTIME_ENDPOINT ?? '').trim(),
    apiKey: (process.env.YOLO_RUNTIME_API_KEY ?? '').trim(),
    defaultModelId: '',
    defaultModelVersionId: '',
    modelApiKeys: {},
    modelApiKeyPolicies: {},
    localModelPath:
      (process.env.YOLO_LOCAL_MODEL_PATH ?? '').trim() || resolveBundledLocalModelPath(framework),
    localTrainCommand: (process.env.YOLO_LOCAL_TRAIN_COMMAND ?? '').trim(),
    localPredictCommand: (process.env.YOLO_LOCAL_PREDICT_COMMAND ?? '').trim()
  };
};

const normalizePythonBinCandidate = (value: string): string => {
  if (!value.trim()) {
    return '';
  }
  const tokens = tokenizeCommand(value.trim());
  if (tokens.length > 0) {
    return tokens[0].trim();
  }
  return value.trim();
};

const isPathLikeCommand = (value: string): boolean =>
  path.isAbsolute(value) || value.startsWith('.') || value.includes('/') || value.includes('\\');

const resolveUsablePythonCandidate = (value: string): string | null => {
  const normalized = normalizePythonBinCandidate(value);
  if (!normalized) {
    return null;
  }

  if (!isPathLikeCommand(normalized)) {
    return normalized;
  }

  const resolved = path.isAbsolute(normalized) ? normalized : path.resolve(process.cwd(), normalized);
  if (!existsSync(resolved)) {
    return null;
  }
  try {
    const stats = statSync(resolved);
    if (!stats.isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  return resolved;
};

const resolveLocalPythonBin = (): string => {
  const runtimeControls = resolveRuntimeControlSettings();
  const localRuntimeVenvCandidates =
    process.platform === 'win32'
      ? [
          path.resolve('C:\\opt\\vistral-venv\\Scripts\\python.exe'),
          path.resolve(process.cwd(), '.data', 'runtime-python', '.venv', 'Scripts', 'python.exe'),
          path.resolve(process.cwd(), '.data', 'runtime-python', '.venv', 'Scripts', 'python')
        ]
      : [
          '/opt/vistral-venv/bin/python',
          '/opt/vistral-venv/bin/python3',
          path.resolve(process.cwd(), '.data', 'runtime-python', '.venv', 'bin', 'python3'),
          path.resolve(process.cwd(), '.data', 'runtime-python', '.venv', 'bin', 'python')
        ];

  const defaultCommandCandidates =
    process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];

  const candidates = [
    runtimeControls.pythonBin,
    (process.env.VISTRAL_PYTHON_BIN ?? '').trim(),
    (process.env.PYTHON_BIN ?? '').trim(),
    ...localRuntimeVenvCandidates,
    ...defaultCommandCandidates
  ];

  const visited = new Set<string>();
  for (const candidate of candidates) {
    const usable = resolveUsablePythonCandidate(candidate);
    if (!usable) {
      continue;
    }
    const dedupeKey = process.platform === 'win32' ? usable.toLowerCase() : usable;
    if (visited.has(dedupeKey)) {
      continue;
    }
    visited.add(dedupeKey);
    return usable;
  }

  return process.platform === 'win32' ? 'python' : 'python3';
};

const resolveEffectiveRuntimeConfig = (
  framework: ModelFramework
): FrameworkRuntimeConfig => {
  const normalizeIsoDate = (value: unknown): string | null => {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return new Date(parsed).toISOString();
  };
  const fallback = runtimeSettings.updated_at
    ? emptyFrameworkRuntimeConfig
    : resolveFrameworkRuntimeConfigFromEnv(framework);
  const stored = runtimeSettings.frameworks[framework];
  const resolvedModelApiKeys =
    stored?.model_api_keys && typeof stored.model_api_keys === 'object'
      ? Object.fromEntries(
          Object.entries(stored.model_api_keys)
            .map(([key, value]) => [key.trim(), typeof value === 'string' ? value.trim() : ''])
            .filter(([key]) => Boolean(key))
        )
      : { ...fallback.modelApiKeys };
  const rawPolicies =
    stored?.model_api_key_policies &&
    typeof stored.model_api_key_policies === 'object' &&
    !Array.isArray(stored.model_api_key_policies)
      ? (stored.model_api_key_policies as Record<string, RuntimeApiKeyPolicy>)
      : {};
  const mergedPolicyKeys = new Set<string>([
    ...Object.keys(resolvedModelApiKeys),
    ...Object.keys(rawPolicies)
  ]);
  const resolvedPolicies: Record<string, RuntimeApiKeyPolicy> = {};

  for (const rawKey of mergedPolicyKeys) {
    const key = rawKey.trim();
    if (!key) {
      continue;
    }
    const rawPolicy = rawPolicies[key];
    const apiKey =
      typeof rawPolicy?.api_key === 'string' && rawPolicy.api_key.trim()
        ? rawPolicy.api_key.trim()
        : (resolvedModelApiKeys[key] ?? '').trim();
    const maxCalls =
      typeof rawPolicy?.max_calls === 'number' && Number.isFinite(rawPolicy.max_calls)
        ? Math.max(0, Math.floor(rawPolicy.max_calls))
        : null;
    const usedCallsRaw =
      typeof rawPolicy?.used_calls === 'number' && Number.isFinite(rawPolicy.used_calls)
        ? Math.max(0, Math.floor(rawPolicy.used_calls))
        : 0;
    const usedCalls = typeof maxCalls === 'number' ? Math.min(usedCallsRaw, maxCalls) : usedCallsRaw;

    resolvedPolicies[key] = {
      api_key: apiKey,
      expires_at: normalizeIsoDate(rawPolicy?.expires_at) ?? null,
      max_calls: maxCalls,
      used_calls: usedCalls,
      last_used_at: normalizeIsoDate(rawPolicy?.last_used_at) ?? null
    };
  }

  const resolvedLocalModelPath =
    (typeof stored?.local_model_path === 'string' ? stored.local_model_path.trim() : '') ||
    fallback.localModelPath ||
    resolveBundledLocalModelPath(framework);
  const resolvedLocalTrainCommand =
    (typeof stored?.local_train_command === 'string' ? stored.local_train_command.trim() : '') ||
    fallback.localTrainCommand ||
    bundledLocalRunnerCommands[framework].train;
  const resolvedLocalPredictCommand =
    (typeof stored?.local_predict_command === 'string' ? stored.local_predict_command.trim() : '') ||
    fallback.localPredictCommand ||
    bundledLocalRunnerCommands[framework].predict;

  return {
    endpoint:
      typeof stored?.endpoint === 'string' ? stored.endpoint.trim() : fallback.endpoint,
    apiKey:
      typeof stored?.api_key === 'string' ? stored.api_key.trim() : fallback.apiKey,
    defaultModelId:
      typeof stored?.default_model_id === 'string'
        ? stored.default_model_id.trim()
        : fallback.defaultModelId,
    defaultModelVersionId:
      typeof stored?.default_model_version_id === 'string'
        ? stored.default_model_version_id.trim()
        : fallback.defaultModelVersionId,
    modelApiKeys: resolvedModelApiKeys,
    modelApiKeyPolicies: resolvedPolicies,
    localModelPath: resolvedLocalModelPath,
    localTrainCommand: resolvedLocalTrainCommand,
    localPredictCommand: resolvedLocalPredictCommand
  };
};

const resolveRuntimeApiKeyForInput = (
  config: FrameworkRuntimeConfig,
  input: PredictInput
): {
  apiKey: string;
  binding: 'framework' | 'model' | 'model_version' | 'none';
  bindingKey: string | null;
  policy: RuntimeApiKeyPolicy | null;
} => {
  const modelVersionId = (input.modelVersionId ?? '').trim() || config.defaultModelVersionId;
  const modelId = (input.modelId ?? '').trim() || config.defaultModelId;
  const modelApiKeys = config.modelApiKeys ?? {};
  const modelApiKeyPolicies = config.modelApiKeyPolicies ?? {};

  if (modelVersionId) {
    const bindingKey = `model_version:${modelVersionId}`;
    const value = (modelApiKeys[bindingKey] ?? '').trim();
    if (value) {
      return {
        apiKey: value,
        binding: 'model_version',
        bindingKey,
        policy: modelApiKeyPolicies[bindingKey] ?? null
      };
    }
  }

  if (modelId) {
    const bindingKey = `model:${modelId}`;
    const value = (modelApiKeys[bindingKey] ?? '').trim();
    if (value) {
      return {
        apiKey: value,
        binding: 'model',
        bindingKey,
        policy: modelApiKeyPolicies[bindingKey] ?? null
      };
    }
  }

  if (config.apiKey.trim()) {
    return {
      apiKey: config.apiKey.trim(),
      binding: 'framework',
      bindingKey: null,
      policy: null
    };
  }

  return { apiKey: '', binding: 'none', bindingKey: null, policy: null };
};

const assertRuntimeApiKeyPolicyUsable = (
  framework: ModelFramework,
  bindingKey: string,
  policy: RuntimeApiKeyPolicy
): void => {
  const nowTime = Date.now();
  if (policy.expires_at) {
    const expiresAtMs = Date.parse(policy.expires_at);
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowTime) {
      throw new Error(
        `${framework} runtime API key expired for binding ${bindingKey}. expires_at=${policy.expires_at}`
      );
    }
  }
  if (typeof policy.max_calls === 'number' && Number.isFinite(policy.max_calls)) {
    const maxCalls = Math.max(0, Math.floor(policy.max_calls));
    const usedCalls =
      typeof policy.used_calls === 'number' && Number.isFinite(policy.used_calls)
        ? Math.max(0, Math.floor(policy.used_calls))
        : 0;
    if (usedCalls >= maxCalls) {
      throw new Error(
        `${framework} runtime API key quota exceeded for binding ${bindingKey}. used_calls=${usedCalls} max_calls=${maxCalls}`
      );
    }
  }
};

const recordRuntimeApiKeyUsage = async (
  framework: ModelFramework,
  bindingKey: string,
  resolvedApiKey: string
): Promise<void> => {
  const frameworkConfig = runtimeSettings.frameworks[framework];
  if (!frameworkConfig || !frameworkConfig.model_api_key_policies) {
    return;
  }
  const policy = frameworkConfig.model_api_key_policies[bindingKey];
  if (!policy) {
    return;
  }
  if ((policy.api_key ?? '').trim() !== resolvedApiKey.trim()) {
    return;
  }

  const nextUsedCalls =
    typeof policy.used_calls === 'number' && Number.isFinite(policy.used_calls)
      ? Math.max(0, Math.floor(policy.used_calls)) + 1
      : 1;
  const maxCalls =
    typeof policy.max_calls === 'number' && Number.isFinite(policy.max_calls)
      ? Math.max(0, Math.floor(policy.max_calls))
      : null;

  frameworkConfig.model_api_key_policies[bindingKey] = {
    ...policy,
    used_calls: typeof maxCalls === 'number' ? Math.min(nextUsedCalls, maxCalls) : nextUsedCalls,
    last_used_at: new Date().toISOString()
  };
  frameworkConfig.model_api_keys = Object.fromEntries(
    Object.entries(frameworkConfig.model_api_key_policies)
      .map(([key, item]) => [key, (item.api_key ?? '').trim()])
      .filter(([, keyValue]) => Boolean(keyValue))
  );
  runtimeSettings.updated_at = runtimeSettings.updated_at ?? new Date().toISOString();
  await persistRuntimeSettings();
};

const buildFrameworkCommandEnvOverrides = (
  framework: ModelFramework,
  config: FrameworkRuntimeConfig
): Record<string, string> => {
  const modelPath = (config.localModelPath ?? '').trim();
  if (!modelPath) {
    return {};
  }
  const resolvedModelPath = path.isAbsolute(modelPath)
    ? modelPath
    : path.resolve(process.cwd(), modelPath);

  if (framework === 'yolo') {
    return {
      YOLO_LOCAL_MODEL_PATH: resolvedModelPath,
      VISTRAL_YOLO_MODEL_PATH: resolvedModelPath
    };
  }

  if (framework === 'paddleocr') {
    return {
      PADDLEOCR_LOCAL_MODEL_PATH: resolvedModelPath
    };
  }

  return {
    DOCTR_LOCAL_MODEL_PATH: resolvedModelPath
  };
};

const resolveLocalModelPathForCommand = (modelPath: string | null | undefined): string => {
  const normalized = (modelPath ?? '').trim();
  if (!normalized) {
    return '';
  }
  return path.isAbsolute(normalized) ? normalized : path.resolve(process.cwd(), normalized);
};

const localRunnerTimeoutMs = (() => {
  const parsed = Number.parseInt(process.env.LOCAL_RUNNER_TIMEOUT_MS ?? '1800000', 10);
  if (!Number.isFinite(parsed) || parsed < 5000) {
    return 1800000;
  }
  return parsed;
})();

const parseBooleanFlag = (value: string | undefined, fallback = false): boolean => {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};

const resolveRuntimeControlSettings = (): {
  pythonBin: string;
  disableSimulatedTrainFallback: boolean;
  disableInferenceFallback: boolean;
} => {
  const fallback = runtimeSettings.updated_at
    ? {
        python_bin: '',
        disable_simulated_train_fallback: false,
        disable_inference_fallback: false
      }
    : {
        python_bin: (process.env.VISTRAL_PYTHON_BIN ?? process.env.PYTHON_BIN ?? '').trim(),
        disable_simulated_train_fallback: parseBooleanFlag(
          process.env.VISTRAL_DISABLE_SIMULATED_TRAIN_FALLBACK,
          false
        ),
        disable_inference_fallback: parseBooleanFlag(process.env.VISTRAL_DISABLE_INFERENCE_FALLBACK, false)
      };
  const controls = runtimeSettings.controls ?? fallback;
  return {
    pythonBin:
      typeof controls.python_bin === 'string' && controls.python_bin.trim()
        ? controls.python_bin.trim()
        : '',
    disableSimulatedTrainFallback:
      typeof controls.disable_simulated_train_fallback === 'boolean'
        ? controls.disable_simulated_train_fallback
        : fallback.disable_simulated_train_fallback,
    disableInferenceFallback:
      typeof controls.disable_inference_fallback === 'boolean'
        ? controls.disable_inference_fallback
        : fallback.disable_inference_fallback
  };
};

const trainingWorkspaceRoot = path.resolve(
  process.cwd(),
  (process.env.TRAINING_WORKDIR_ROOT ?? '.data/training-jobs').trim() || '.data/training-jobs'
);

const modelExportRoot = path.resolve(
  process.cwd(),
  (process.env.MODEL_EXPORT_ROOT ?? '.data/model-exports').trim() || '.data/model-exports'
);

const runtimeResponsePreviewMaxLength = 200;

const normalizeRuntimeResponsePreview = (rawText: string): string => {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return 'empty response body';
  }

  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith('<!doctype') || lowered.startsWith('<html')) {
    return 'non-JSON response body';
  }

  return trimmed.replace(/\s+/g, ' ').slice(0, runtimeResponsePreviewMaxLength);
};

const readJsonObjectFromResponse = async (
  response: Response
): Promise<{ payload: Record<string, unknown> | null; rawText: string }> => {
  const rawText = await response.text();
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { payload: null, rawText };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { payload: null, rawText };
    }
    return { payload: parsed as Record<string, unknown>, rawText };
  } catch {
    return { payload: null, rawText };
  }
};

const readRuntimeErrorMessage = (payload: Record<string, unknown>): string => {
  const errorPart = payload.error;
  if (errorPart && typeof errorPart === 'object' && !Array.isArray(errorPart)) {
    const nestedMessage = (errorPart as { message?: unknown }).message;
    if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
      return nestedMessage.trim();
    }
  }

  const message = payload.message;
  if (typeof message === 'string' && message.trim()) {
    return message.trim();
  }

  const detail = payload.detail;
  if (typeof detail === 'string' && detail.trim()) {
    return detail.trim();
  }

  return '';
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const interpolateTemplate = (template: string, values: Record<string, string>): string => {
  let rendered = template;
  Object.entries(values).forEach(([key, value]) => {
    rendered = rendered.split(`{{${key}}}`).join(shellQuote(value));
  });
  return rendered;
};

const tokenizeCommand = (command: string): string[] => {
  const tokens: string[] = [];
  let current = '';
  let activeQuote: "'" | '"' | null = null;
  let escaping = false;
  let tokenStarted = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaping) {
      current += char;
      escaping = false;
      tokenStarted = true;
      continue;
    }

    if (char === '\\' && activeQuote !== "'") {
      escaping = true;
      continue;
    }

    if (char === '"' || char === "'") {
      if (activeQuote === char) {
        activeQuote = null;
        tokenStarted = true;
        continue;
      }
      if (!activeQuote) {
        activeQuote = char;
        tokenStarted = true;
        continue;
      }
    }

    if (!activeQuote && /\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (escaping) {
    current += '\\';
    tokenStarted = true;
  }

  if (tokenStarted) {
    tokens.push(current);
  }

  return tokens;
};

type LocalCommandRunMode = 'direct' | 'shell';

interface LocalCommandContext {
  platform: string;
  attempted_command: string;
  command_template: string;
  run_mode: LocalCommandRunMode;
  shell_path?: string;
}

interface LocalCommandExecutionResult {
  logs: string[];
  output: string;
  context: LocalCommandContext;
}

const attachLocalCommandContext = (error: Error, context: LocalCommandContext): Error => {
  const enriched = error as Error & { localCommandContext?: LocalCommandContext };
  enriched.localCommandContext = context;
  return enriched;
};

const resolveShellCommand = (
  attemptedCommand: string
): { executable: string; args: string[]; shellPath: string } => {
  const configuredBashPath = (process.env.VISTRAL_BASH_PATH ?? '').trim();
  if (configuredBashPath) {
    return {
      executable: configuredBashPath,
      args: ['-lc', attemptedCommand],
      shellPath: configuredBashPath
    };
  }

  if (process.platform === 'win32') {
    const windowsShell = (process.env.ComSpec ?? 'cmd.exe').trim() || 'cmd.exe';
    return {
      executable: windowsShell,
      args: ['/d', '/s', '/c', attemptedCommand],
      shellPath: windowsShell
    };
  }

  const shellPath = (process.env.SHELL ?? '/bin/sh').trim() || '/bin/sh';
  const shellName = path.basename(shellPath).toLowerCase();
  const shellFlag =
    shellName.includes('bash') || shellName.includes('zsh') || shellName.includes('ksh')
      ? '-lc'
      : '-c';
  return {
    executable: shellPath,
    args: [shellFlag, attemptedCommand],
    shellPath
  };
};

const parseMetricsRecord = (raw: unknown): Record<string, number> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, number] =>
        typeof entry[0] === 'string' && typeof entry[1] === 'number' && Number.isFinite(entry[1])
    )
  );
};

const parseMetricSeries = (raw: unknown): Array<{ step: number; metrics: Record<string, number> }> => {
  if (!Array.isArray(raw)) {
    return [];
  }

  const parsed = raw
    .map((point) => {
      if (!point || typeof point !== 'object' || Array.isArray(point)) {
        return null;
      }

      const payload = point as Record<string, unknown>;
      const step = Number(payload.step);
      if (!Number.isFinite(step) || step < 1) {
        return null;
      }

      const metrics =
        payload.metrics && typeof payload.metrics === 'object' && !Array.isArray(payload.metrics)
          ? parseMetricsRecord(payload.metrics)
          : parseMetricsRecord(
              Object.fromEntries(
                Object.entries(payload).filter(([key]) => key !== 'step')
              )
            );
      if (Object.keys(metrics).length === 0) {
        return null;
      }

      return {
        step: Math.round(step),
        metrics
      };
    })
    .filter((point): point is { step: number; metrics: Record<string, number> } => Boolean(point));

  parsed.sort((left, right) => left.step - right.step);
  return parsed;
};

const parseMetricsBundle = (raw: unknown): {
  metrics: Record<string, number> | null;
  metricSeries: Array<{ step: number; metrics: Record<string, number> }>;
} => {
  const directMetrics = parseMetricsRecord(raw);
  if (Object.keys(directMetrics).length > 0) {
    return {
      metrics: directMetrics,
      metricSeries: []
    };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      metrics: null,
      metricSeries: []
    };
  }

  const payload = raw as Record<string, unknown>;
  const summary = parseMetricsRecord(payload.summary);
  const metricSeries = parseMetricSeries(payload.metric_series ?? payload.series);
  const fallbackFromSeries = metricSeries.length > 0 ? metricSeries[metricSeries.length - 1]?.metrics : null;

  return {
    metrics:
      Object.keys(summary).length > 0
        ? summary
        : fallbackFromSeries && Object.keys(fallbackFromSeries).length > 0
          ? fallbackFromSeries
          : null,
    metricSeries
  };
};

const readMetricsFile = async (
  metricsPath?: string
): Promise<{
  metrics: Record<string, number> | null;
  metricSeries: Array<{ step: number; metrics: Record<string, number> }>;
} | null> => {
  if (!metricsPath) {
    return null;
  }

  try {
    const content = await fs.readFile(metricsPath, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    return parseMetricsBundle(parsed);
  } catch {
    return null;
  }
};

const runLocalCommand = async (
  commandTemplate: string,
  options: {
    workingDir: string;
    values: Record<string, string>;
    envOverrides?: Record<string, string>;
    onLog?: (line: string) => void | Promise<void>;
  }
): Promise<LocalCommandExecutionResult> => {
  const attemptedCommand = interpolateTemplate(commandTemplate, options.values);
  const logs: string[] = [];

  await fs.mkdir(options.workingDir, { recursive: true });

  const tokens = tokenizeCommand(attemptedCommand);
  if (tokens.length === 0) {
    throw attachLocalCommandContext(
      new Error('Local runner command resolved to empty command.'),
      {
        platform: process.platform,
        attempted_command: attemptedCommand,
        command_template: commandTemplate,
        run_mode: 'shell'
      }
    );
  }

  const executableCandidate = path.basename(tokens[0]).toLowerCase();
  const isPythonExecutable =
    executableCandidate === 'python' ||
    executableCandidate === 'python3' ||
    executableCandidate === 'python.exe' ||
    executableCandidate === 'python3.exe' ||
    executableCandidate === 'py' ||
    executableCandidate === 'py.exe' ||
    executableCandidate.startsWith('python');
  const hasPythonScriptArg = tokens.slice(1).some((token) => token.toLowerCase().endsWith('.py'));
  const preferDirectExecution = isPythonExecutable && hasPythonScriptArg;
  const shellCommand = resolveShellCommand(attemptedCommand);
  const context: LocalCommandContext = preferDirectExecution
    ? {
        platform: process.platform,
        attempted_command: attemptedCommand,
        command_template: commandTemplate,
        run_mode: 'direct'
      }
    : {
        platform: process.platform,
        attempted_command: attemptedCommand,
        command_template: commandTemplate,
        run_mode: 'shell',
        shell_path: shellCommand.shellPath
      };

  const executable = preferDirectExecution ? tokens[0] : shellCommand.executable;
  const spawnArgs = preferDirectExecution ? tokens.slice(1) : shellCommand.args;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, spawnArgs, {
      cwd: options.workingDir,
      env: {
        ...process.env,
        ...options.envOverrides
      }
    });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(
        attachLocalCommandContext(
          new Error(
            `Local runner timed out after ${localRunnerTimeoutMs} ms. platform=${context.platform} attempted_command=${context.attempted_command} shell_path=${context.shell_path ?? 'n/a'}`
          ),
          context
        )
      );
    }, localRunnerTimeoutMs);

    const collect = (chunk: Buffer | string, stream: 'stdout' | 'stderr') => {
      const text = chunk.toString();
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `[${stream}] ${line}`);
      logs.push(...lines);
      lines.forEach((line) => {
        void options.onLog?.(line);
      });
    };

    child.stdout.on('data', (chunk) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(chunk, 'stderr'));
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(
        attachLocalCommandContext(
          new Error(
            `Local runner spawn failed: ${(error as Error).message}. platform=${context.platform} attempted_command=${context.attempted_command} shell_path=${context.shell_path ?? 'n/a'}`
          ),
          context
        )
      );
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(
          attachLocalCommandContext(
            new Error(
              `Local runner exited with code ${code ?? 'unknown'}. platform=${context.platform} attempted_command=${context.attempted_command} shell_path=${context.shell_path ?? 'n/a'}`
            ),
            context
          )
        );
      }
    });
  });

  return {
    logs: logs.slice(-120),
    output: logs
      .filter((line) => line.startsWith('[stdout] '))
      .map((line) => line.replace('[stdout] ', ''))
      .join('\n')
      .trim(),
    context
  };
};

const buildOutput = (
  framework: ModelFramework,
  input: PredictInput
): UnifiedInferenceOutput => {
  const base: UnifiedInferenceOutput = {
    image: {
      filename: input.filename,
      width: 1280,
      height: 720,
      source_attachment_id: input.inputAttachmentId
    },
    task_type: input.taskType,
    framework,
    model: {
      model_id: input.modelId,
      model_version_id: input.modelVersionId,
      name: `${framework}-model`,
      version: input.modelVersionId
    },
    boxes: [],
    rotated_boxes: [],
    polygons: [],
    masks: [],
    labels: [],
    ocr: {
      lines: [],
      words: []
    },
    raw_output: {
      framework,
      confidence: 0.91,
      task: input.taskType
    },
    normalized_output: {
      version: 'v1',
      framework,
      source: 'base_empty'
    }
  };
  return base;
};

const resolveArtifactMetricsFromWorkspace = async (
  workspaceDir: string
): Promise<Record<string, number> | null> => {
  const artifactDir = path.join(workspaceDir, 'artifacts');
  try {
    const entries = await fs.readdir(artifactDir);
    const candidates = entries
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => path.join(artifactDir, entry))
      .sort((left, right) => left.localeCompare(right));

    for (const candidatePath of candidates.reverse()) {
      const content = await fs.readFile(candidatePath, 'utf8');
      const parsed = JSON.parse(content) as unknown;
      const bundle = parseMetricsBundle(parsed);
      if (bundle.metrics && Object.keys(bundle.metrics).length > 0) {
        return bundle.metrics;
      }
    }
  } catch {
    return null;
  }

  return null;
};

const resolveEvaluationMetrics = async (
  trainingJobId: string
): Promise<Record<string, number>> => {
  const workspaceDir = path.join(trainingWorkspaceRoot, trainingJobId);
  const metricsPath = path.join(workspaceDir, 'metrics.json');
  const metricsBundle = await readMetricsFile(metricsPath);
  if (metricsBundle?.metrics && Object.keys(metricsBundle.metrics).length > 0) {
    return metricsBundle.metrics;
  }

  const artifactMetrics = await resolveArtifactMetricsFromWorkspace(workspaceDir);
  if (artifactMetrics && Object.keys(artifactMetrics).length > 0) {
    return artifactMetrics;
  }

  return {};
};

const resolveExistingModelArtifactPath = async (
  candidatePath: string
): Promise<string | null> => {
  if (!candidatePath.trim()) {
    return null;
  }
  const resolved = path.resolve(candidatePath.trim());
  try {
    const stats = await fs.stat(resolved);
    if (!stats.isFile()) {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
};

const parsePoint = (value: unknown): { x: number; y: number } | null => {
  const record = value as { x?: number; y?: number };
  if (typeof record?.x !== 'number' || typeof record?.y !== 'number') {
    return null;
  }

  return {
    x: record.x,
    y: record.y
  };
};

const parseRuntimeOutput = (
  framework: ModelFramework,
  input: PredictInput,
  payload: Record<string, unknown>
): UnifiedInferenceOutput => {
  const normalized = buildOutput(framework, input);
  normalized.raw_output = payload;
  normalized.normalized_output = {
    ...normalized.normalized_output,
    source: `${framework}_runtime`
  };

  const imagePayload = payload.image as { filename?: string; width?: number; height?: number } | undefined;
  if (imagePayload) {
    if (typeof imagePayload.filename === 'string' && imagePayload.filename.trim()) {
      normalized.image.filename = imagePayload.filename;
    }
    if (typeof imagePayload.width === 'number' && imagePayload.width > 0) {
      normalized.image.width = imagePayload.width;
    }
    if (typeof imagePayload.height === 'number' && imagePayload.height > 0) {
      normalized.image.height = imagePayload.height;
    }
  }

  const detectionList = (
    Array.isArray(payload.boxes)
      ? payload.boxes
      : Array.isArray(payload.detections)
        ? payload.detections
        : []
  ) as Array<Record<string, unknown>>;

  normalized.boxes = detectionList
    .map((entry) => {
      const x = entry.x;
      const y = entry.y;
      const width = entry.width;
      const height = entry.height;

      if (
        typeof x !== 'number' ||
        typeof y !== 'number' ||
        typeof width !== 'number' ||
        typeof height !== 'number'
      ) {
        return null;
      }

      return {
        x,
        y,
        width,
        height,
        label: typeof entry.label === 'string' ? entry.label : 'object',
        score: typeof entry.score === 'number' ? entry.score : 0.5
      };
    })
    .filter(
      (
        value
      ): value is { x: number; y: number; width: number; height: number; label: string; score: number } =>
        value !== null
    );

  const rotatedList = (Array.isArray(payload.rotated_boxes) ? payload.rotated_boxes : []) as Array<
    Record<string, unknown>
  >;
  normalized.rotated_boxes = rotatedList
    .map((entry) => {
      const cx = entry.cx;
      const cy = entry.cy;
      const width = entry.width;
      const height = entry.height;
      const angle = entry.angle;

      if (
        typeof cx !== 'number' ||
        typeof cy !== 'number' ||
        typeof width !== 'number' ||
        typeof height !== 'number' ||
        typeof angle !== 'number'
      ) {
        return null;
      }

      return {
        cx,
        cy,
        width,
        height,
        angle,
        label: typeof entry.label === 'string' ? entry.label : 'rotated_object',
        score: typeof entry.score === 'number' ? entry.score : 0.5
      };
    })
    .filter(
      (
        value
      ): value is {
        cx: number;
        cy: number;
        width: number;
        height: number;
        angle: number;
        label: string;
        score: number;
      } => value !== null
    );

  const polygonList = (Array.isArray(payload.polygons) ? payload.polygons : []) as Array<
    Record<string, unknown>
  >;
  normalized.polygons = polygonList
    .map((entry) => {
      const pointsRaw = Array.isArray(entry.points) ? entry.points : [];
      const points = pointsRaw.map(parsePoint).filter((point): point is { x: number; y: number } => point !== null);
      if (points.length < 3) {
        return null;
      }

      return {
        label: typeof entry.label === 'string' ? entry.label : 'region',
        score: typeof entry.score === 'number' ? entry.score : 0.5,
        points
      };
    })
    .filter(
      (value): value is { label: string; score: number; points: Array<{ x: number; y: number }> } =>
        value !== null
    );

  const classificationList = (Array.isArray(payload.labels) ? payload.labels : []) as Array<
    Record<string, unknown>
  >;
  normalized.labels = classificationList
    .map((entry) => {
      const label = entry.label;
      if (typeof label !== 'string') {
        return null;
      }

      return {
        label,
        score: typeof entry.score === 'number' ? entry.score : 0.5
      };
    })
    .filter((value): value is { label: string; score: number } => value !== null);

  const ocrPayload = payload.ocr as { lines?: unknown; words?: unknown } | undefined;
  const linesFromPayload =
    (ocrPayload && Array.isArray(ocrPayload.lines) ? ocrPayload.lines : null) ??
    (Array.isArray(payload.lines) ? payload.lines : null) ??
    (Array.isArray(payload.text_lines) ? payload.text_lines : null) ??
    [];

  const wordsFromPayload =
    (ocrPayload && Array.isArray(ocrPayload.words) ? ocrPayload.words : null) ??
    (Array.isArray(payload.words) ? payload.words : null) ??
    [];

  normalized.ocr.lines = linesFromPayload
    .map((entry) => {
      const record = entry as { text?: string; confidence?: number };
      if (!record.text) {
        return null;
      }
      return {
        text: record.text,
        confidence: typeof record.confidence === 'number' ? record.confidence : 0.5
      };
    })
    .filter((value): value is { text: string; confidence: number } => value !== null);

  normalized.ocr.words = wordsFromPayload
    .map((entry) => {
      const record = entry as { text?: string; confidence?: number };
      if (!record.text) {
        return null;
      }
      return {
        text: record.text,
        confidence: typeof record.confidence === 'number' ? record.confidence : 0.5
      };
    })
    .filter((value): value is { text: string; confidence: number } => value !== null);

  const masksList = (Array.isArray(payload.masks) ? payload.masks : []) as Array<Record<string, unknown>>;
  normalized.masks = masksList
    .map((entry) => {
      const encoding = entry.encoding;
      if (typeof encoding !== 'string' || !encoding.trim()) {
        return null;
      }

      return {
        label: typeof entry.label === 'string' ? entry.label : 'region',
        score: typeof entry.score === 'number' ? entry.score : 0.5,
        encoding
      };
    })
    .filter((value): value is { label: string; score: number; encoding: string } => value !== null);

  return normalized;
};

const callRuntimePredict = async (
  framework: ModelFramework,
  config: FrameworkRuntimeConfig,
  input: PredictInput
): Promise<UnifiedInferenceOutput> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    const runtimeAuth = resolveRuntimeApiKeyForInput(config, input);
    if (runtimeAuth.bindingKey && runtimeAuth.policy) {
      assertRuntimeApiKeyPolicyUsable(framework, runtimeAuth.bindingKey, runtimeAuth.policy);
    }

    if (runtimeAuth.apiKey) {
      headers.Authorization = `Bearer ${runtimeAuth.apiKey}`;
    }

    const resolvedModelId = (input.modelId ?? '').trim() || config.defaultModelId;
    const resolvedModelVersionId =
      (input.modelVersionId ?? '').trim() || config.defaultModelVersionId;
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        framework,
        model_id: resolvedModelId,
        model_version_id: resolvedModelVersionId,
        model_artifact_path: input.modelArtifactPath ?? null,
        input_attachment_id: input.inputAttachmentId,
        filename: input.filename,
        task_type: input.taskType
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const { payload, rawText } = await readJsonObjectFromResponse(response);
      const remoteMessage = payload ? readRuntimeErrorMessage(payload) : '';
      const reason = remoteMessage || normalizeRuntimeResponsePreview(rawText);
      throw new Error(`${framework} runtime returned ${response.status}: ${reason}`);
    }

    const { payload, rawText } = await readJsonObjectFromResponse(response);
    if (!payload) {
      throw new Error(
        `${framework} runtime returned invalid JSON: ${normalizeRuntimeResponsePreview(rawText)}`
      );
    }

    const parsed = parseRuntimeOutput(framework, input, payload);
    if (runtimeAuth.bindingKey && runtimeAuth.binding !== 'framework' && runtimeAuth.binding !== 'none') {
      await recordRuntimeApiKeyUsage(framework, runtimeAuth.bindingKey, runtimeAuth.apiKey);
    }
    parsed.raw_output = {
      ...parsed.raw_output,
      runtime_auth_binding: runtimeAuth.binding,
      runtime_auth_binding_key: runtimeAuth.bindingKey
    };
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
};

const readLocalCommandContext = (
  error: unknown,
  fallback: {
    attemptedCommand: string;
    commandTemplate: string;
    runMode: LocalCommandRunMode;
    shellPath?: string;
  }
): LocalCommandContext => {
  const maybeContext = (error as { localCommandContext?: LocalCommandContext }).localCommandContext;
  if (maybeContext) {
    return maybeContext;
  }

  return {
    platform: process.platform,
    attempted_command: fallback.attemptedCommand,
    command_template: fallback.commandTemplate,
    run_mode: fallback.runMode,
    shell_path: fallback.shellPath
  };
};

const buildLocalCommandFailedOutput = (
  framework: ModelFramework,
  input: PredictInput,
  options: {
    reason: string;
    context: LocalCommandContext;
  }
): UnifiedInferenceOutput => {
  const fallback = buildOutput(framework, input);
  if (input.taskType === 'ocr') {
    fallback.ocr.lines = [];
    fallback.ocr.words = [];
  }
  fallback.raw_output = {
    ...fallback.raw_output,
    local_command_fallback_reason: options.reason,
    local_command_framework: framework,
    platform: options.context.platform || process.platform,
    attempted_command: options.context.attempted_command
  };
  if (options.context.shell_path) {
    fallback.raw_output.local_command_shell_path = options.context.shell_path;
  }
  fallback.normalized_output = {
    ...fallback.normalized_output,
    source: 'explicit_fallback_local_command_failed'
  };
  return fallback;
};

const callLocalPredictCommand = async (
  framework: ModelFramework,
  config: FrameworkRuntimeConfig,
  input: PredictInput
): Promise<UnifiedInferenceOutput> => {
  const commandTemplate =
    config.localPredictCommand || bundledLocalRunnerCommands[framework].predict;

  if (!commandTemplate) {
    return buildLocalCommandFailedOutput(framework, input, {
      reason: `${framework} local predict command is not configured.`,
      context: {
        platform: process.platform,
        attempted_command: '',
        command_template: '',
        run_mode: 'shell'
      }
    });
  }

  const fallbackOutputPath = path.resolve(
    process.cwd(),
    '.data',
    'runtime-local-predict',
    `${framework}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  );
  const workingDir = path.resolve(process.cwd(), '.data', 'runtime-local-predict');
  const resolvedLocalModelPath = resolveLocalModelPathForCommand(config.localModelPath);
  const values = {
    repo_root: process.cwd(),
    python_bin: resolveLocalPythonBin(),
    framework,
    model_id: (input.modelId ?? '').trim() || config.defaultModelId,
    model_version_id: (input.modelVersionId ?? '').trim() || config.defaultModelVersionId,
    task_type: input.taskType,
    input_path: input.inputStoragePath ?? '',
    filename: input.filename,
    mime_type: input.inputMimeType ?? '',
    model_path: resolveLocalModelPathForCommand(input.modelArtifactPath) || resolvedLocalModelPath,
    local_model_path: resolvedLocalModelPath,
    output_path: fallbackOutputPath
  };

  const execution = await runLocalCommand(commandTemplate, {
    workingDir,
    values,
    envOverrides: buildFrameworkCommandEnvOverrides(framework, config)
  });

  let payloadRaw: unknown = null;
  if (execution.output) {
    try {
      payloadRaw = JSON.parse(execution.output) as unknown;
    } catch {
      payloadRaw = null;
    }
  }

  if (!payloadRaw) {
    try {
      const fileContent = await fs.readFile(fallbackOutputPath, 'utf8');
      payloadRaw = JSON.parse(fileContent) as unknown;
    } catch {
      payloadRaw = null;
    }
  }

  if (!payloadRaw || typeof payloadRaw !== 'object' || Array.isArray(payloadRaw)) {
    throw attachLocalCommandContext(
      new Error(
        `${framework} local predict command did not output valid JSON (stdout or {{output_path}}). platform=${execution.context.platform} attempted_command=${execution.context.attempted_command}`
      ),
      execution.context
    );
  }

  const payload = payloadRaw as Record<string, unknown>;
  const parsed = parseRuntimeOutput(framework, input, payload);
  const rawMeta =
    payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta)
      ? (payload.meta as Record<string, unknown>)
      : null;
  const templateFallbackReason =
    rawMeta && typeof rawMeta.fallback_reason === 'string' && rawMeta.fallback_reason.trim()
      ? rawMeta.fallback_reason.trim()
      : '';
  const templateReason =
    rawMeta && typeof rawMeta.template_reason === 'string' && rawMeta.template_reason.trim()
      ? rawMeta.template_reason.trim()
      : '';
  const existingLocalFallbackReason =
    typeof parsed.raw_output.local_command_fallback_reason === 'string' &&
    parsed.raw_output.local_command_fallback_reason.trim()
      ? parsed.raw_output.local_command_fallback_reason.trim()
      : '';
  const resolvedLocalFallbackReason = existingLocalFallbackReason || templateFallbackReason;
  const strictInferenceFallbackDisabled =
    resolveRuntimeControlSettings().disableInferenceFallback;
  if (
    strictInferenceFallbackDisabled &&
    (rawMeta?.mode === 'template' || Boolean(resolvedLocalFallbackReason))
  ) {
    throw attachLocalCommandContext(
      new Error(
        `${framework} local predict produced non-real template/fallback evidence while VISTRAL_DISABLE_INFERENCE_FALLBACK=1. fallback_reason=${resolvedLocalFallbackReason || 'none'}`
      ),
      execution.context
    );
  }
  parsed.normalized_output = {
    ...parsed.normalized_output,
    source: `${framework}_local_command`
  };
  parsed.raw_output = {
    ...parsed.raw_output,
    local_command: true,
    local_logs: execution.logs.slice(-24),
    attempted_command: execution.context.attempted_command,
    platform: execution.context.platform,
    local_command_run_mode: execution.context.run_mode,
    local_command_shell_path: execution.context.shell_path ?? null,
    local_command_template_mode: rawMeta?.mode === 'template',
    local_command_template_reason: templateReason || null,
    local_command_fallback_reason: resolvedLocalFallbackReason || null
  };
  return parsed;
};

const classifyConnectivityError = (error: unknown): RuntimeConnectivityErrorKind => {
  const detail = error as { name?: string; message?: string };
  const name = (detail.name ?? '').toLowerCase();
  const message = (detail.message ?? '').toLowerCase();

  if (
    name === 'aborterror' ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('aborted')
  ) {
    return 'timeout';
  }

  if (message.includes('runtime returned') || message.includes('status')) {
    return 'http_status';
  }

  if (message.includes('payload') && message.includes('invalid')) {
    return 'invalid_payload';
  }

  if (
    message.includes('fetch') ||
    message.includes('network') ||
    message.includes('failed to connect') ||
    message.includes('econnrefused') ||
    message.includes('enotfound')
  ) {
    return 'network';
  }

  return 'unknown';
};

const createPredictWithRuntimeBridge =
  (framework: ModelFramework) =>
  async (input: PredictInput): Promise<UnifiedInferenceOutput> => {
    const strictInferenceFallbackDisabled =
      resolveRuntimeControlSettings().disableInferenceFallback;
    const runtime = resolveEffectiveRuntimeConfig(framework);
    if (!runtime.endpoint) {
      await delay(80);
      try {
        return await callLocalPredictCommand(framework, runtime, input);
      } catch (error) {
        if (strictInferenceFallbackDisabled) {
          throw new Error(
            `${framework} inference failed and fallback output is disabled (VISTRAL_DISABLE_INFERENCE_FALLBACK=1): ${(error as Error).message}`
          );
        }
        const commandTemplate =
          runtime.localPredictCommand || bundledLocalRunnerCommands[framework].predict;
        const fallbackContext = readLocalCommandContext(error, {
          attemptedCommand: commandTemplate
            ? interpolateTemplate(commandTemplate, {
                repo_root: process.cwd(),
                python_bin: resolveLocalPythonBin(),
                framework,
                model_id: input.modelId,
                model_version_id: input.modelVersionId,
                task_type: input.taskType,
                input_path: input.inputStoragePath ?? '',
                filename: input.filename,
                mime_type: input.inputMimeType ?? '',
                model_path: input.modelArtifactPath ?? '',
                output_path: path.resolve(
                  process.cwd(),
                  '.data',
                  'runtime-local-predict',
                  `${framework}-fallback.json`
                )
              })
            : '',
          commandTemplate,
          runMode: 'shell'
        });
        return buildLocalCommandFailedOutput(framework, input, {
          reason: (error as Error).message,
          context: fallbackContext
        });
      }
    }

    try {
      return await callRuntimePredict(framework, runtime, input);
    } catch (error) {
      if (strictInferenceFallbackDisabled) {
        throw new Error(
          `${framework} runtime predict failed and fallback output is disabled (VISTRAL_DISABLE_INFERENCE_FALLBACK=1): ${(error as Error).message}`
        );
      }
      const fallback = buildOutput(framework, input);
      fallback.raw_output = {
        ...fallback.raw_output,
        runtime_fallback_reason: (error as Error).message,
        runtime_framework: framework,
        platform: process.platform
      };
      fallback.normalized_output = {
        ...fallback.normalized_output,
        source: 'explicit_fallback_runtime_failed'
      };
      return fallback;
    }
  };

const buildConnectivityProbeInput = (framework: ModelFramework): PredictInput => ({
  modelId: `runtime-probe-${framework}`,
  modelVersionId: `runtime-probe-${framework}-v1`,
  inputAttachmentId: `runtime-probe-${framework}-file`,
  filename: `${framework}-runtime-probe.jpg`,
  taskType: framework === 'yolo' ? 'detection' : 'ocr'
});

export const checkRuntimeConnectivity = async (
  framework: ModelFramework
): Promise<RuntimeConnectivityRecord> => {
  const runtime = resolveEffectiveRuntimeConfig(framework);
  const checkedAt = new Date().toISOString();

  if (!runtime.endpoint) {
    return {
      framework,
      configured: false,
      reachable: false,
      endpoint: null,
      source: 'not_configured',
      error_kind: 'none',
      checked_at: checkedAt,
      message: 'Runtime endpoint is not configured.'
    };
  }

  try {
    await callRuntimePredict(framework, runtime, buildConnectivityProbeInput(framework));
    return {
      framework,
      configured: true,
      reachable: true,
      endpoint: runtime.endpoint,
      source: 'reachable',
      error_kind: 'none',
      checked_at: checkedAt,
      message: 'Runtime endpoint responded with compatible payload.'
    };
  } catch (error) {
    return {
      framework,
      configured: true,
      reachable: false,
      endpoint: runtime.endpoint,
      source: 'unreachable',
      error_kind: classifyConnectivityError(error),
      checked_at: checkedAt,
      message: (error as Error).message
    };
  }
};

export const probeRuntimeEndpointConnectivity = async (
  framework: ModelFramework,
  endpoint: string,
  apiKey = ''
): Promise<RuntimeConnectivityRecord> => {
  const checkedAt = new Date().toISOString();
  const normalizedEndpoint = endpoint.trim();
  if (!normalizedEndpoint) {
    return {
      framework,
      configured: false,
      reachable: false,
      endpoint: null,
      source: 'not_configured',
      error_kind: 'none',
      checked_at: checkedAt,
      message: 'Runtime endpoint is not configured.'
    };
  }

  const runtime: FrameworkRuntimeConfig = {
    endpoint: normalizedEndpoint,
    apiKey: apiKey.trim(),
    defaultModelId: '',
    defaultModelVersionId: '',
    modelApiKeys: {},
    modelApiKeyPolicies: {},
    localModelPath: '',
    localTrainCommand: '',
    localPredictCommand: ''
  };

  try {
    await callRuntimePredict(framework, runtime, buildConnectivityProbeInput(framework));
    return {
      framework,
      configured: true,
      reachable: true,
      endpoint: normalizedEndpoint,
      source: 'reachable',
      error_kind: 'none',
      checked_at: checkedAt,
      message: 'Runtime endpoint responded with compatible payload.'
    };
  } catch (error) {
    return {
      framework,
      configured: true,
      reachable: false,
      endpoint: normalizedEndpoint,
      source: 'unreachable',
      error_kind: classifyConnectivityError(error),
      checked_at: checkedAt,
      message: (error as Error).message
    };
  }
};

const createTrainer = (
  framework: ModelFramework,
  supportedTasks: TaskType[],
  options?: {
    predictOverride?: (input: PredictInput) => Promise<UnifiedInferenceOutput>;
  }
): UnifiedTrainer => ({
  framework,
  supportedTasks,

  async validate_dataset(input: ValidateDatasetInput): Promise<ValidateDatasetResult> {
    await delay(80);
    return {
      valid: supportedTasks.includes(input.taskType),
      warnings: supportedTasks.includes(input.taskType)
        ? []
        : [`${framework} does not support ${input.taskType} in current prototype.`]
    };
  },

  async train(input: TrainInput): Promise<TrainResult> {
    const strictSimulatedTrainFallbackDisabled =
      resolveRuntimeControlSettings().disableSimulatedTrainFallback;
    const runtime = resolveEffectiveRuntimeConfig(framework);
    const usingBundledTemplate = !runtime.localTrainCommand;
    const commandTemplate =
      runtime.localTrainCommand || bundledLocalRunnerCommands[framework].train;

    if (!commandTemplate) {
      if (strictSimulatedTrainFallbackDisabled) {
        throw new Error(
          `${framework} local train command is not configured and simulated fallback is disabled (VISTRAL_DISABLE_SIMULATED_TRAIN_FALLBACK=1).`
        );
      }
      await delay(150);
      input.onExecutionMode?.('simulated');
      return {
        accepted: true,
        logPreview: `${framework} accepted job ${input.trainingJobId} with base model ${input.baseModel}.`,
        execution_mode: 'simulated'
      };
    }

    const configValues = Object.fromEntries(
      Object.entries(input.config).map(([key, value]) => [
        `config_${key.trim().replace(/[^a-zA-Z0-9_]+/g, '_')}`,
        String(value)
      ])
    );
    const values: Record<string, string> = {
      repo_root: process.cwd(),
      python_bin: resolveLocalPythonBin(),
      framework,
      job_id: input.trainingJobId,
      dataset_id: input.datasetId,
      task_type: input.taskType,
      base_model: input.baseModel,
      local_model_path: resolveLocalModelPathForCommand(runtime.localModelPath),
      workspace_dir: input.workspaceDir ?? '',
      config_path: input.configPath ?? '',
      summary_path: input.summaryPath ?? '',
      metrics_path: input.metricsPath ?? '',
      artifact_path: input.artifactPath ?? '',
      ...configValues
    };
    input.onExecutionMode?.('local_command');
    let execution;
    try {
      execution = await runLocalCommand(commandTemplate, {
        workingDir:
          input.workspaceDir ?? path.resolve(process.cwd(), '.data', 'training-jobs', input.trainingJobId),
        values,
        envOverrides: buildFrameworkCommandEnvOverrides(framework, runtime),
        onLog: input.onLog
      });
    } catch (error) {
      if (usingBundledTemplate) {
        if (strictSimulatedTrainFallbackDisabled) {
          throw new Error(
            `${framework} bundled local runner unavailable and simulated fallback is disabled (VISTRAL_DISABLE_SIMULATED_TRAIN_FALLBACK=1): ${(error as Error).message}`
          );
        }
        input.onExecutionMode?.('simulated');
        return {
          accepted: true,
          logPreview: `${framework} bundled local runner unavailable, falling back to simulated executor: ${(error as Error).message}`,
          execution_mode: 'simulated'
        };
      }
      throw error;
    }
    const metricsBundle = await readMetricsFile(input.metricsPath);

    return {
      accepted: true,
      logPreview: execution.logs.at(-1) ?? `${framework} local train command finished.`,
      execution_mode: 'local_command',
      logs: execution.logs,
      metrics: metricsBundle?.metrics ?? undefined,
      metric_series: metricsBundle?.metricSeries.length ? metricsBundle.metricSeries : undefined
    };
  },

  async evaluate(input: EvaluateInput): Promise<EvaluateResult> {
    await delay(120);
    return {
      metrics: await resolveEvaluationMetrics(input.trainingJobId)
    };
  },

  async predict(input: PredictInput): Promise<UnifiedInferenceOutput> {
    if (options?.predictOverride) {
      return options.predictOverride(input);
    }

    await delay(100);
    return buildOutput(framework, input);
  },

  async export(input: ExportInput): Promise<ExportResult> {
    await delay(80);
    const exportDir = path.join(modelExportRoot, framework, input.modelVersionId);
    await fs.mkdir(exportDir, { recursive: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sourcePath = await resolveExistingModelArtifactPath(input.modelArtifactPath ?? '');

    if (sourcePath) {
      const ext = path.extname(sourcePath) || '.bin';
      const exportedFilePath = path.join(exportDir, `model-${stamp}${ext}`);
      await fs.copyFile(sourcePath, exportedFilePath);
      const manifestPath = path.join(exportDir, `model-${stamp}.manifest.json`);
      await fs.writeFile(
        manifestPath,
        JSON.stringify(
          {
            framework,
            model_version_id: input.modelVersionId,
            exported_at: new Date().toISOString(),
            export_mode: 'file_copy',
            source_artifact_path: sourcePath,
            artifact_path: exportedFilePath
          },
          null,
          2
        ),
        'utf8'
      );
      return {
        artifactPath: exportedFilePath
      };
    }

    const manifestOnlyPath = path.join(exportDir, `model-${stamp}.manifest.json`);
    await fs.writeFile(
      manifestOnlyPath,
      JSON.stringify(
        {
          framework,
          model_version_id: input.modelVersionId,
          exported_at: new Date().toISOString(),
          export_mode: 'metadata_only',
          export_reason: 'model_artifact_not_found'
        },
        null,
        2
      ),
      'utf8'
    );
    return {
      artifactPath: manifestOnlyPath
    };
  },

  async load_model(input: LoadModelInput): Promise<LoadedModelRef> {
    await delay(60);
    const explicitArtifactPath = await resolveExistingModelArtifactPath(input.modelArtifactPath ?? '');
    if (explicitArtifactPath) {
      return {
        handle: `local_file:${explicitArtifactPath}`
      };
    }

    const frameworkExportDir = path.join(modelExportRoot, framework, input.modelVersionId);
    try {
      const entries = (await fs.readdir(frameworkExportDir))
        .filter((entry) => !entry.endsWith('.manifest.json'))
        .sort((left, right) => right.localeCompare(left));
      const selected = entries[0];
      if (selected) {
        const resolved = path.join(frameworkExportDir, selected);
        const stats = await fs.stat(resolved);
        if (stats.isFile()) {
          return {
            handle: `local_file:${resolved}`
          };
        }
      }
    } catch {
      // fall through
    }

    throw new Error(
      `Model artifact not found for load_model. framework=${framework} model_version_id=${input.modelVersionId}`
    );
  }
});

const adapters: Record<ModelFramework, UnifiedTrainer> = {
  paddleocr: createTrainer('paddleocr', ['ocr'], {
    predictOverride: createPredictWithRuntimeBridge('paddleocr')
  }),
  doctr: createTrainer('doctr', ['ocr'], {
    predictOverride: createPredictWithRuntimeBridge('doctr')
  }),
  yolo: createTrainer('yolo', ['detection', 'classification', 'segmentation', 'obb'], {
    predictOverride: createPredictWithRuntimeBridge('yolo')
  })
};

export const getTrainerByFramework = (framework: ModelFramework): UnifiedTrainer => adapters[framework];
