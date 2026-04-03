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
}

const runtimeConfigs: Record<ModelFramework, FrameworkRuntimeConfig> = {
  paddleocr: {
    endpoint: (process.env.PADDLEOCR_RUNTIME_ENDPOINT ?? '').trim(),
    apiKey: (process.env.PADDLEOCR_RUNTIME_API_KEY ?? '').trim()
  },
  doctr: {
    endpoint: (process.env.DOCTR_RUNTIME_ENDPOINT ?? '').trim(),
    apiKey: (process.env.DOCTR_RUNTIME_API_KEY ?? '').trim()
  },
  yolo: {
    endpoint: (process.env.YOLO_RUNTIME_ENDPOINT ?? '').trim(),
    apiKey: (process.env.YOLO_RUNTIME_API_KEY ?? '').trim()
  }
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
      framework
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
      throw new Error(`${framework} runtime returned ${response.status}.`);
    }

    const payloadRaw = await response.json();
    if (typeof payloadRaw !== 'object' || payloadRaw === null || Array.isArray(payloadRaw)) {
      throw new Error('Runtime response payload is invalid.');
    }

    const payload = payloadRaw as Record<string, unknown>;
    return parseRuntimeOutput(framework, input, payload);
  } finally {
    clearTimeout(timeout);
  }
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
      await delay(100);
      return buildOutput(framework, input);
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
    await delay(150);
    return {
      accepted: true,
      logPreview: `${framework} accepted job ${input.trainingJobId} with base model ${input.baseModel}.`
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
