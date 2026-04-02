import type {
  ModelFramework,
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
const yoloRuntimeEndpoint = (process.env.YOLO_RUNTIME_ENDPOINT ?? '').trim();
const yoloRuntimeApiKey = (process.env.YOLO_RUNTIME_API_KEY ?? '').trim();

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

const parseYoloRuntimeOutput = (
  input: PredictInput,
  payload: Record<string, unknown>
): UnifiedInferenceOutput => {
  const normalized = buildOutput('yolo', input);
  normalized.raw_output = payload;
  normalized.normalized_output = {
    ...normalized.normalized_output,
    source: 'yolo_runtime'
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
  if (ocrPayload) {
    const linesRaw = Array.isArray(ocrPayload.lines) ? ocrPayload.lines : [];
    const wordsRaw = Array.isArray(ocrPayload.words) ? ocrPayload.words : [];

    normalized.ocr.lines = linesRaw
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

    normalized.ocr.words = wordsRaw
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
  }

  return normalized;
};

const callYoloRuntimePredict = async (input: PredictInput): Promise<UnifiedInferenceOutput> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (yoloRuntimeApiKey) {
      headers.Authorization = `Bearer ${yoloRuntimeApiKey}`;
    }

    const response = await fetch(yoloRuntimeEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model_id: input.modelId,
        model_version_id: input.modelVersionId,
        input_attachment_id: input.inputAttachmentId,
        filename: input.filename,
        task_type: input.taskType
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`YOLO runtime returned ${response.status}.`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return parseYoloRuntimeOutput(input, payload);
  } finally {
    clearTimeout(timeout);
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
  paddleocr: createTrainer('paddleocr', ['ocr']),
  doctr: createTrainer('doctr', ['ocr']),
  yolo: createTrainer('yolo', ['detection', 'classification', 'segmentation', 'obb'], {
    predictOverride: async (input) => {
      if (!yoloRuntimeEndpoint) {
        await delay(100);
        return buildOutput('yolo', input);
      }

      try {
        return await callYoloRuntimePredict(input);
      } catch (error) {
        const fallback = buildOutput('yolo', input);
        fallback.raw_output = {
          ...fallback.raw_output,
          runtime_fallback_reason: (error as Error).message
        };
        fallback.normalized_output = {
          ...fallback.normalized_output,
          source: 'mock_fallback'
        };
        return fallback;
      }
    }
  })
};

export const getTrainerByFramework = (framework: ModelFramework): UnifiedTrainer => adapters[framework];
