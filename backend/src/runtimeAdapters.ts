import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ModelFramework,
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
import { runtimeSettings } from './store';

const delay = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

interface FrameworkRuntimeConfig {
  endpoint: string;
  apiKey: string;
  localTrainCommand: string;
  localPredictCommand: string;
}

const emptyFrameworkRuntimeConfig: FrameworkRuntimeConfig = {
  endpoint: '',
  apiKey: '',
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
      localTrainCommand: (process.env.PADDLEOCR_LOCAL_TRAIN_COMMAND ?? '').trim(),
      localPredictCommand: (process.env.PADDLEOCR_LOCAL_PREDICT_COMMAND ?? '').trim()
    };
  }

  if (framework === 'doctr') {
    return {
      endpoint: (process.env.DOCTR_RUNTIME_ENDPOINT ?? '').trim(),
      apiKey: (process.env.DOCTR_RUNTIME_API_KEY ?? '').trim(),
      localTrainCommand: (process.env.DOCTR_LOCAL_TRAIN_COMMAND ?? '').trim(),
      localPredictCommand: (process.env.DOCTR_LOCAL_PREDICT_COMMAND ?? '').trim()
    };
  }

  return {
    endpoint: (process.env.YOLO_RUNTIME_ENDPOINT ?? '').trim(),
    apiKey: (process.env.YOLO_RUNTIME_API_KEY ?? '').trim(),
    localTrainCommand: (process.env.YOLO_LOCAL_TRAIN_COMMAND ?? '').trim(),
    localPredictCommand: (process.env.YOLO_LOCAL_PREDICT_COMMAND ?? '').trim()
  };
};

const resolveEffectiveRuntimeConfig = (
  framework: ModelFramework
): FrameworkRuntimeConfig => {
  const fallback = runtimeSettings.updated_at
    ? emptyFrameworkRuntimeConfig
    : resolveFrameworkRuntimeConfigFromEnv(framework);
  const stored = runtimeSettings.frameworks[framework];
  return {
    endpoint:
      typeof stored?.endpoint === 'string' ? stored.endpoint.trim() : fallback.endpoint,
    apiKey:
      typeof stored?.api_key === 'string' ? stored.api_key.trim() : fallback.apiKey,
    localTrainCommand:
      typeof stored?.local_train_command === 'string'
        ? stored.local_train_command.trim()
        : fallback.localTrainCommand,
    localPredictCommand:
      typeof stored?.local_predict_command === 'string'
        ? stored.local_predict_command.trim()
        : fallback.localPredictCommand
  };
};

const bundledLocalRunnerCommands: Record<
  ModelFramework,
  {
    train: string;
    predict: string;
  }
> = {
  paddleocr: {
    train:
      'python3 {{repo_root}}/scripts/local-runners/paddleocr_train_runner.py --job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} --base-model {{base_model}} --workspace-dir {{workspace_dir}} --config-path {{config_path}} --summary-path {{summary_path}} --metrics-path {{metrics_path}} --artifact-path {{artifact_path}}',
    predict:
      'python3 {{repo_root}}/scripts/local-runners/paddleocr_predict_runner.py --model-id {{model_id}} --model-version-id {{model_version_id}} --task-type {{task_type}} --input-path {{input_path}} --filename {{filename}} --model-path {{model_path}} --output-path {{output_path}}'
  },
  doctr: {
    train:
      'python3 {{repo_root}}/scripts/local-runners/doctr_train_runner.py --job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} --base-model {{base_model}} --workspace-dir {{workspace_dir}} --config-path {{config_path}} --summary-path {{summary_path}} --metrics-path {{metrics_path}} --artifact-path {{artifact_path}}',
    predict:
      'python3 {{repo_root}}/scripts/local-runners/doctr_predict_runner.py --model-id {{model_id}} --model-version-id {{model_version_id}} --task-type {{task_type}} --input-path {{input_path}} --filename {{filename}} --model-path {{model_path}} --output-path {{output_path}}'
  },
  yolo: {
    train:
      'python3 {{repo_root}}/scripts/local-runners/yolo_train_runner.py --job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} --base-model {{base_model}} --workspace-dir {{workspace_dir}} --config-path {{config_path}} --summary-path {{summary_path}} --metrics-path {{metrics_path}} --artifact-path {{artifact_path}}',
    predict:
      'python3 {{repo_root}}/scripts/local-runners/yolo_predict_runner.py --model-id {{model_id}} --model-version-id {{model_version_id}} --task-type {{task_type}} --input-path {{input_path}} --filename {{filename}} --model-path {{model_path}} --output-path {{output_path}}'
  }
};

const localRunnerTimeoutMs = (() => {
  const parsed = Number.parseInt(process.env.LOCAL_RUNNER_TIMEOUT_MS ?? '1800000', 10);
  if (!Number.isFinite(parsed) || parsed < 5000) {
    return 1800000;
  }
  return parsed;
})();

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
      env: process.env
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

    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        framework,
        model_id: input.modelId,
        model_version_id: input.modelVersionId,
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

    return parseRuntimeOutput(framework, input, payload);
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
  const values = {
    repo_root: process.cwd(),
    framework,
    model_id: input.modelId,
    model_version_id: input.modelVersionId,
    task_type: input.taskType,
    input_path: input.inputStoragePath ?? '',
    filename: input.filename,
    mime_type: input.inputMimeType ?? '',
    model_path: input.modelArtifactPath ?? '',
    output_path: fallbackOutputPath
  };

  const execution = await runLocalCommand(commandTemplate, {
    workingDir,
    values
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
    const runtime = resolveEffectiveRuntimeConfig(framework);
    if (!runtime.endpoint) {
      await delay(80);
      try {
        return await callLocalPredictCommand(framework, runtime, input);
      } catch (error) {
        const commandTemplate =
          runtime.localPredictCommand || bundledLocalRunnerCommands[framework].predict;
        const fallbackContext = readLocalCommandContext(error, {
          attemptedCommand: commandTemplate
            ? interpolateTemplate(commandTemplate, {
                repo_root: process.cwd(),
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
    const runtime = resolveEffectiveRuntimeConfig(framework);
    const usingBundledTemplate = !runtime.localTrainCommand;
    const commandTemplate =
      runtime.localTrainCommand || bundledLocalRunnerCommands[framework].train;

    if (!commandTemplate) {
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
      framework,
      job_id: input.trainingJobId,
      dataset_id: input.datasetId,
      task_type: input.taskType,
      base_model: input.baseModel,
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
        onLog: input.onLog
      });
    } catch (error) {
      if (usingBundledTemplate) {
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
