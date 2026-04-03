import { createHash } from 'node:crypto';
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

const delay = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

interface FrameworkRuntimeConfig {
  endpoint: string;
  apiKey: string;
  localTrainCommand: string;
  localPredictCommand: string;
}

const runtimeConfigs: Record<ModelFramework, FrameworkRuntimeConfig> = {
  paddleocr: {
    endpoint: (process.env.PADDLEOCR_RUNTIME_ENDPOINT ?? '').trim(),
    apiKey: (process.env.PADDLEOCR_RUNTIME_API_KEY ?? '').trim(),
    localTrainCommand: (process.env.PADDLEOCR_LOCAL_TRAIN_COMMAND ?? '').trim(),
    localPredictCommand: (process.env.PADDLEOCR_LOCAL_PREDICT_COMMAND ?? '').trim()
  },
  doctr: {
    endpoint: (process.env.DOCTR_RUNTIME_ENDPOINT ?? '').trim(),
    apiKey: (process.env.DOCTR_RUNTIME_API_KEY ?? '').trim(),
    localTrainCommand: (process.env.DOCTR_LOCAL_TRAIN_COMMAND ?? '').trim(),
    localPredictCommand: (process.env.DOCTR_LOCAL_PREDICT_COMMAND ?? '').trim()
  },
  yolo: {
    endpoint: (process.env.YOLO_RUNTIME_ENDPOINT ?? '').trim(),
    apiKey: (process.env.YOLO_RUNTIME_API_KEY ?? '').trim(),
    localTrainCommand: (process.env.YOLO_LOCAL_TRAIN_COMMAND ?? '').trim(),
    localPredictCommand: (process.env.YOLO_LOCAL_PREDICT_COMMAND ?? '').trim()
  }
};

const localRunnerTimeoutMs = (() => {
  const parsed = Number.parseInt(process.env.LOCAL_RUNNER_TIMEOUT_MS ?? '1800000', 10);
  if (!Number.isFinite(parsed) || parsed < 5000) {
    return 1800000;
  }
  return parsed;
})();

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
  }
): Promise<{ logs: string[]; output: string }> => {
  const command = interpolateTemplate(commandTemplate, options.values);
  const logs: string[] = [];

  await fs.mkdir(options.workingDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: options.workingDir,
      env: process.env
    });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Local runner timed out after ${localRunnerTimeoutMs} ms.`));
    }, localRunnerTimeoutMs);

    const collect = (chunk: Buffer | string, stream: 'stdout' | 'stderr') => {
      const text = chunk.toString();
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `[${stream}] ${line}`);
      logs.push(...lines);
    };

    child.stdout.on('data', (chunk) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(chunk, 'stderr'));
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Local runner exited with code ${code ?? 'unknown'}.`));
      }
    });
  });

  return {
    logs: logs.slice(-120),
    output: logs
      .filter((line) => line.startsWith('[stdout] '))
      .map((line) => line.replace('[stdout] ', ''))
      .join('\n')
      .trim()
  };
};

const buildMetrics = (taskType: TaskType): Record<string, number> => {
  if (taskType === 'ocr') {
    return {
      accuracy: 0.93,
      cer: 0.08,
      wer: 0.11
    };
  }

  if (taskType === 'detection' || taskType === 'obb') {
    return {
      map: 0.81,
      precision: 0.87,
      recall: 0.79
    };
  }

  if (taskType === 'segmentation') {
    return {
      miou: 0.77,
      dice: 0.82
    };
  }

  return {
    accuracy: 0.89,
    f1: 0.85
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
      source: 'mock_default'
    }
  };

  if (input.taskType === 'ocr') {
    base.ocr.lines = [
      { text: 'Invoice No. 2026-0402', confidence: 0.93 },
      { text: 'Total: 458.30', confidence: 0.91 }
    ];
    base.ocr.words = [
      { text: 'Invoice', confidence: 0.94 },
      { text: 'Total', confidence: 0.92 }
    ];
    return base;
  }

  if (input.taskType === 'detection') {
    base.boxes = [
      { x: 182, y: 204, width: 168, height: 102, label: 'defect', score: 0.9 },
      { x: 540, y: 350, width: 210, height: 120, label: 'scratch', score: 0.86 }
    ];
    return base;
  }

  if (input.taskType === 'obb') {
    base.rotated_boxes = [
      {
        cx: 320,
        cy: 260,
        width: 200,
        height: 90,
        angle: 15,
        label: 'rotated-target',
        score: 0.88
      }
    ];
    return base;
  }

  if (input.taskType === 'segmentation') {
    base.polygons = [
      {
        label: 'region',
        score: 0.84,
        points: [
          { x: 120, y: 90 },
          { x: 300, y: 140 },
          { x: 260, y: 320 },
          { x: 110, y: 300 }
        ]
      }
    ];
    base.masks = [{ label: 'region', score: 0.84, encoding: 'mock-rle' }];
    return base;
  }

  base.labels = [
    { label: 'normal', score: 0.78 },
    { label: 'abnormal', score: 0.22 }
  ];
  return base;
};

const toSeed = async (input: PredictInput): Promise<number> => {
  const hash = createHash('sha256');
  hash.update(input.filename);
  hash.update(input.modelVersionId);
  hash.update(input.taskType);

  if (input.inputStoragePath) {
    try {
      const content = await fs.readFile(input.inputStoragePath);
      hash.update(content);
    } catch {
      hash.update('missing-storage-content');
    }
  }

  const digest = hash.digest();
  return digest.readUInt32BE(0);
};

const pickFromSeed = (seed: number, min: number, max: number): number => {
  const safeSeed = Math.abs(seed % 10000);
  const ratio = safeSeed / 10000;
  return min + (max - min) * ratio;
};

const readTextLinesFromInput = async (input: PredictInput): Promise<string[]> => {
  if (!input.inputStoragePath) {
    return [];
  }

  const lowerFilename = input.filename.toLowerCase();
  const textLike =
    input.inputMimeType?.includes('text') ||
    lowerFilename.endsWith('.txt') ||
    lowerFilename.endsWith('.md') ||
    lowerFilename.endsWith('.csv') ||
    lowerFilename.endsWith('.json');
  if (!textLike) {
    return [];
  }

  try {
    const raw = await fs.readFile(input.inputStoragePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 3);
  } catch {
    return [];
  }
};

const buildLocalOutput = async (
  framework: ModelFramework,
  input: PredictInput
): Promise<UnifiedInferenceOutput> => {
  const seed = await toSeed(input);
  const base = buildOutput(framework, input);
  base.normalized_output = {
    ...base.normalized_output,
    source: `${framework}_local`
  };
  base.raw_output = {
    ...base.raw_output,
    local_seed: seed,
    local_mode: true
  };
  base.image = {
    ...base.image,
    width: Math.round(pickFromSeed(seed, 960, 1920)),
    height: Math.round(pickFromSeed(seed >>> 3, 540, 1080))
  };

  if (input.taskType === 'detection') {
    const x = Math.round(pickFromSeed(seed >>> 5, 80, 420));
    const y = Math.round(pickFromSeed(seed >>> 7, 70, 300));
    const width = Math.round(pickFromSeed(seed >>> 9, 120, 280));
    const height = Math.round(pickFromSeed(seed >>> 11, 80, 190));
    const score = Number(pickFromSeed(seed >>> 13, 0.72, 0.96).toFixed(3));
    base.boxes = [
      {
        x,
        y,
        width,
        height,
        label: 'detected_object',
        score
      }
    ];
    return base;
  }

  if (input.taskType === 'ocr') {
    const textLines = await readTextLinesFromInput(input);
    if (textLines.length > 0) {
      base.ocr.lines = textLines.map((line, index) => ({
        text: line,
        confidence: Number(pickFromSeed(seed >>> (index + 2), 0.78, 0.98).toFixed(3))
      }));
      base.ocr.words = textLines
        .flatMap((line) => line.split(/\s+/).filter(Boolean))
        .slice(0, 8)
        .map((word, index) => ({
          text: word,
          confidence: Number(pickFromSeed(seed >>> (index + 4), 0.75, 0.97).toFixed(3))
        }));
    }
    return base;
  }

  if (input.taskType === 'classification') {
    base.labels = [
      { label: 'normal', score: Number(pickFromSeed(seed >>> 2, 0.52, 0.95).toFixed(3)) },
      { label: 'abnormal', score: Number(pickFromSeed(seed >>> 6, 0.05, 0.48).toFixed(3)) }
    ];
  }

  return base;
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

const callLocalPredictCommand = async (
  framework: ModelFramework,
  config: FrameworkRuntimeConfig,
  input: PredictInput
): Promise<UnifiedInferenceOutput> => {
  if (!config.localPredictCommand) {
    return buildLocalOutput(framework, input);
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
    output_path: fallbackOutputPath
  };

  const execution = await runLocalCommand(config.localPredictCommand, {
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
    throw new Error(
      `${framework} local predict command did not output valid JSON (stdout or {{output_path}}).`
    );
  }

  const payload = payloadRaw as Record<string, unknown>;
  const parsed = parseRuntimeOutput(framework, input, payload);
  parsed.normalized_output = {
    ...parsed.normalized_output,
    source: `${framework}_local_command`
  };
  parsed.raw_output = {
    ...parsed.raw_output,
    local_command: true,
    local_logs: execution.logs.slice(-24)
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
    const runtime = runtimeConfigs[framework];
    if (!runtime.endpoint) {
      await delay(80);
      try {
        return await callLocalPredictCommand(framework, runtime, input);
      } catch (error) {
        const fallback = await buildLocalOutput(framework, input);
        fallback.raw_output = {
          ...fallback.raw_output,
          local_command_fallback_reason: (error as Error).message,
          local_command_framework: framework
        };
        return fallback;
      }
    }

    try {
      return await callRuntimePredict(framework, runtime, input);
    } catch (error) {
      const fallback = buildOutput(framework, input);
      fallback.raw_output = {
        ...fallback.raw_output,
        runtime_fallback_reason: (error as Error).message,
        runtime_framework: framework
      };
      fallback.normalized_output = {
        ...fallback.normalized_output,
        source: 'mock_fallback'
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
  const runtime = runtimeConfigs[framework];
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
    const runtime = runtimeConfigs[framework];
    if (!runtime.localTrainCommand) {
      await delay(150);
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
    const execution = await runLocalCommand(runtime.localTrainCommand, {
      workingDir:
        input.workspaceDir ?? path.resolve(process.cwd(), '.data', 'training-jobs', input.trainingJobId),
      values
    });
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
    const marker = input.trainingJobId.toLowerCase();
    const inferredTask: TaskType = marker.includes('ocr')
      ? 'ocr'
      : marker.includes('det')
        ? 'detection'
        : 'classification';

    return {
      metrics: buildMetrics(inferredTask)
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
    return {
      artifactPath: `/mock-artifacts/${framework}/${input.modelVersionId}.zip`
    };
  },

  async load_model(input: LoadModelInput): Promise<LoadedModelRef> {
    await delay(60);
    return {
      handle: `${framework}:${input.modelVersionId}`
    };
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
