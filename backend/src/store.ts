import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AnnotationRecord,
  AnnotationReviewRecord,
  ApprovalRequest,
  AuditLogRecord,
  ConversationRecord,
  DatasetItemRecord,
  DatasetRecord,
  DatasetVersionRecord,
  FileAttachment,
  InferenceRunRecord,
  LlmConfig,
  MessageRecord,
  ModelRecord,
  ModelVersionRecord,
  TrainingJobRecord,
  TrainingMetricRecord,
  User
} from '../../shared/domain';

const now = () => new Date().toISOString();

const llmConfigDataFile = path.resolve(process.cwd(), '.data', 'llm-config.enc.json');
const devFallbackSecret = 'vistral-dev-only-secret-change-me';

interface EncryptedPayload {
  iv: string;
  tag: string;
  data: string;
}

const deriveKey = (): Buffer => {
  const secret = process.env.LLM_CONFIG_SECRET ?? devFallbackSecret;
  return createHash('sha256').update(secret).digest();
};

const encryptText = (plainText: string): EncryptedPayload => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64')
  };
};

const decryptText = (payload: EncryptedPayload): string => {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(),
    Buffer.from(payload.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
};

export const users: User[] = [
  {
    id: 'u-1',
    email: 'user@vistral.dev',
    username: 'alice',
    role: 'user',
    capabilities: ['manage_models'],
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'u-2',
    email: 'admin@vistral.dev',
    username: 'admin',
    role: 'admin',
    capabilities: ['manage_models', 'global_governance'],
    created_at: now(),
    updated_at: now()
  }
];

export const models: ModelRecord[] = [
  {
    id: 'm-1',
    name: 'Road Damage Detector',
    description: 'Detects road cracks from photos.',
    model_type: 'detection',
    owner_user_id: 'u-1',
    visibility: 'workspace',
    status: 'published',
    metadata: { framework: 'yolo' },
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'm-2',
    name: 'Factory PPE Checker',
    description: 'Checks PPE compliance in factory floor images.',
    model_type: 'classification',
    owner_user_id: 'u-2',
    visibility: 'private',
    status: 'draft',
    metadata: { framework: 'yolo' },
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'm-3',
    name: 'Invoice OCR Assistant',
    description: 'Extracts invoice text and fields.',
    model_type: 'ocr',
    owner_user_id: 'u-1',
    visibility: 'workspace',
    status: 'published',
    metadata: { framework: 'paddleocr' },
    created_at: now(),
    updated_at: now()
  }
];

export const conversations: ConversationRecord[] = [];
export const messages: MessageRecord[] = [];

export const attachments: FileAttachment[] = [
  {
    id: 'f-1',
    filename: 'inspection-01.jpg',
    status: 'ready',
    owner_user_id: 'u-1',
    attached_to_type: 'Conversation',
    attached_to_id: null,
    upload_error: null,
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'f-2',
    filename: 'notes.pdf',
    status: 'processing',
    owner_user_id: 'u-1',
    attached_to_type: 'Conversation',
    attached_to_id: null,
    upload_error: null,
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'f-3',
    filename: 'invoice-001.jpg',
    status: 'ready',
    owner_user_id: 'u-1',
    attached_to_type: 'Dataset',
    attached_to_id: 'd-1',
    upload_error: null,
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'f-4',
    filename: 'defect-001.jpg',
    status: 'ready',
    owner_user_id: 'u-1',
    attached_to_type: 'Dataset',
    attached_to_id: 'd-2',
    upload_error: null,
    created_at: now(),
    updated_at: now()
  }
];

export const datasets: DatasetRecord[] = [
  {
    id: 'd-1',
    name: 'Invoice OCR Dataset',
    description: 'OCR training samples for invoices.',
    task_type: 'ocr',
    status: 'ready',
    owner_user_id: 'u-1',
    label_schema: {
      classes: ['text_line', 'table', 'stamp']
    },
    metadata: { source: 'internal' },
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'd-2',
    name: 'Surface Defect Dataset',
    description: 'Detection samples for scratches and dents.',
    task_type: 'detection',
    status: 'draft',
    owner_user_id: 'u-1',
    label_schema: {
      classes: ['defect', 'scratch']
    },
    metadata: { source: 'line-a' },
    created_at: now(),
    updated_at: now()
  }
];

export const datasetItems: DatasetItemRecord[] = [
  {
    id: 'di-1',
    dataset_id: 'd-1',
    attachment_id: 'f-3',
    split: 'train',
    status: 'ready',
    metadata: { page: '1' },
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'di-2',
    dataset_id: 'd-2',
    attachment_id: 'f-4',
    split: 'train',
    status: 'ready',
    metadata: { line: 'A1' },
    created_at: now(),
    updated_at: now()
  }
];

export const annotations: AnnotationRecord[] = [
  {
    id: 'ann-1',
    dataset_item_id: 'di-1',
    task_type: 'ocr',
    source: 'manual',
    status: 'approved',
    payload: {
      lines: [{ text: 'Invoice No. 2026-0402', confidence: 0.99 }]
    },
    annotated_by: 'u-1',
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'ann-2',
    dataset_item_id: 'di-2',
    task_type: 'detection',
    source: 'manual',
    status: 'annotated',
    payload: {
      boxes: [{ x: 182, y: 204, width: 168, height: 102, label: 'defect' }]
    },
    annotated_by: 'u-1',
    created_at: now(),
    updated_at: now()
  }
];

export const annotationReviews: AnnotationReviewRecord[] = [
  {
    id: 'arv-1',
    annotation_id: 'ann-1',
    reviewer_user_id: 'u-2',
    status: 'approved',
    quality_score: 0.97,
    review_comment: 'Good OCR quality.',
    created_at: now()
  }
];

export const datasetVersions: DatasetVersionRecord[] = [
  {
    id: 'dv-1',
    dataset_id: 'd-1',
    version_name: 'v1',
    split_summary: {
      train: 1,
      val: 0,
      test: 0,
      unassigned: 0
    },
    item_count: 1,
    annotation_coverage: 1,
    created_by: 'u-1',
    created_at: now()
  },
  {
    id: 'dv-2',
    dataset_id: 'd-2',
    version_name: 'v1',
    split_summary: {
      train: 1,
      val: 0,
      test: 0,
      unassigned: 0
    },
    item_count: 1,
    annotation_coverage: 1,
    created_by: 'u-1',
    created_at: now()
  }
];

export const trainingJobs: TrainingJobRecord[] = [
  {
    id: 'tj-ocr-1',
    name: 'invoice-ocr-finetune',
    task_type: 'ocr',
    framework: 'paddleocr',
    status: 'completed',
    dataset_id: 'd-1',
    dataset_version_id: 'dv-1',
    base_model: 'paddleocr-PP-OCRv4',
    config: {
      epochs: '20',
      batch_size: '16',
      learning_rate: '0.001'
    },
    log_excerpt: 'Training completed with stable CER improvement.',
    submitted_by: 'u-1',
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'tj-det-1',
    name: 'defect-det-finetune',
    task_type: 'detection',
    framework: 'yolo',
    status: 'running',
    dataset_id: 'd-2',
    dataset_version_id: 'dv-2',
    base_model: 'yolo11n',
    config: {
      epochs: '80',
      batch_size: '8',
      learning_rate: '0.0005'
    },
    log_excerpt: 'Epoch 12/80, improving recall.',
    submitted_by: 'u-1',
    created_at: now(),
    updated_at: now()
  }
];

export const trainingMetrics: TrainingMetricRecord[] = [
  {
    id: 'tm-1',
    training_job_id: 'tj-ocr-1',
    metric_name: 'accuracy',
    metric_value: 0.93,
    step: 20,
    recorded_at: now()
  },
  {
    id: 'tm-2',
    training_job_id: 'tj-ocr-1',
    metric_name: 'cer',
    metric_value: 0.08,
    step: 20,
    recorded_at: now()
  },
  {
    id: 'tm-3',
    training_job_id: 'tj-det-1',
    metric_name: 'map',
    metric_value: 0.71,
    step: 12,
    recorded_at: now()
  }
];

export const modelVersions: ModelVersionRecord[] = [
  {
    id: 'mv-1',
    model_id: 'm-3',
    training_job_id: 'tj-ocr-1',
    version_name: 'ocr-v1',
    task_type: 'ocr',
    framework: 'paddleocr',
    status: 'registered',
    metrics_summary: {
      accuracy: '0.93',
      cer: '0.08',
      wer: '0.11'
    },
    artifact_attachment_id: null,
    created_by: 'u-1',
    created_at: now()
  },
  {
    id: 'mv-2',
    model_id: 'm-1',
    training_job_id: 'tj-det-1',
    version_name: 'det-v1',
    task_type: 'detection',
    framework: 'yolo',
    status: 'registered',
    metrics_summary: {
      map: '0.71',
      precision: '0.82',
      recall: '0.75'
    },
    artifact_attachment_id: null,
    created_by: 'u-1',
    created_at: now()
  }
];

export const inferenceRuns: InferenceRunRecord[] = [];

export const approvalRequests: ApprovalRequest[] = [];
export const auditLogs: AuditLogRecord[] = [];

export const llmConfigsByUser: Record<string, LlmConfig> = {};

export const loadPersistedLlmConfigs = async (): Promise<void> => {
  try {
    const file = await fs.readFile(llmConfigDataFile, 'utf8');
    const encrypted = JSON.parse(file) as EncryptedPayload;
    const decrypted = decryptText(encrypted);
    const parsed = JSON.parse(decrypted) as Record<string, LlmConfig>;

    Object.assign(llmConfigsByUser, parsed);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }

    // Keep service usable even when local encrypted store is unreadable.
    console.warn('[vistral-api] Failed to load encrypted LLM config store:', (error as Error).message);
  }
};

export const persistLlmConfigs = async (): Promise<void> => {
  const serialized = JSON.stringify(llmConfigsByUser);
  const encrypted = encryptText(serialized);

  await fs.mkdir(path.dirname(llmConfigDataFile), { recursive: true });
  await fs.writeFile(llmConfigDataFile, JSON.stringify(encrypted), 'utf8');
};
