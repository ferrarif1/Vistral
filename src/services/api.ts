import type {
  AnnotationWithReview,
  ApprovalRequest,
  AuditLogRecord,
  ConversationRecord,
  DatasetItemRecord,
  DatasetRecord,
  DatasetVersionRecord,
  FileAttachment,
  InferenceRunRecord,
  LlmConfig,
  LlmConfigView,
  LoginInput,
  MessageRecord,
  ModelRecord,
  ModelVersionRecord,
  RegisterInput,
  RequirementTaskDraft,
  ReviewAnnotationInput,
  RuntimeConnectivityRecord,
  RuntimeMetricsRetentionSummary,
  SubmitApprovalInput,
  TrainingJobRecord,
  TrainingMetricRecord,
  TrainingMetricsExport,
  UpsertAnnotationInput,
  VerificationReportRecord,
  User
} from '../../shared/domain';

type ApiEnvelope<T> =
  | {
      success: true;
      data: T;
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

let csrfToken: string | null = null;

const csrfExemptPaths = new Set(['/api/auth/login', '/api/auth/register', '/api/auth/csrf']);
const responsePreviewMaxLength = 180;

const isMutationMethod = (method: string) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

const normalizeResponsePreview = (rawText: string): string => {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return 'empty response body (API service may be unavailable or proxy failed)';
  }

  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith('<!doctype') || lowered.startsWith('<html')) {
    return 'non-JSON response body';
  }

  return trimmed.replace(/\s+/g, ' ').slice(0, responsePreviewMaxLength);
};

const buildRequestErrorMessage = (status: number, rawText: string): string =>
  `Request failed (${status}): ${normalizeResponsePreview(rawText)}`;

const readApiEnvelope = async <T>(
  response: Response
): Promise<{ envelope: ApiEnvelope<T> | null; rawText: string }> => {
  const rawText = await response.text();
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { envelope: null, rawText };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || !('success' in parsed)) {
      return { envelope: null, rawText };
    }

    return { envelope: parsed as ApiEnvelope<T>, rawText };
  } catch {
    return { envelope: null, rawText };
  }
};

async function fetchCsrfToken(): Promise<string> {
  const response = await fetch('/api/auth/csrf', {
    method: 'GET',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json'
    }
  });

  const { envelope, rawText } = await readApiEnvelope<{ csrf_token: string }>(response);
  if (!response.ok) {
    if (envelope && !envelope.success) {
      throw new Error(envelope.error.message);
    }

    throw new Error(
      `Failed to fetch CSRF token (${response.status}): ${normalizeResponsePreview(rawText)}`
    );
  }

  if (!envelope || !envelope.success) {
    if (envelope && !envelope.success) {
      throw new Error(envelope.error.message);
    }

    throw new Error(
      `Failed to fetch CSRF token: ${normalizeResponsePreview(rawText)}`
    );
  }

  csrfToken = envelope.data.csrf_token;
  return csrfToken;
}

async function ensureCsrfToken(): Promise<string> {
  if (csrfToken) {
    return csrfToken;
  }

  return fetchCsrfToken();
}

function invalidateCsrfToken(): void {
  csrfToken = null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers ?? {});
  const isFormDataBody =
    typeof FormData !== 'undefined' && init?.body instanceof FormData;

  if (!isFormDataBody && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (isMutationMethod(method) && !csrfExemptPaths.has(path)) {
    const token = await ensureCsrfToken();
    headers.set('X-CSRF-Token', token);
  }

  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    method,
    headers
  });

  const { envelope, rawText } = await readApiEnvelope<T>(response);

  if (!response.ok) {
    if (envelope && !envelope.success) {
      throw new Error(envelope.error.message);
    }

    throw new Error(buildRequestErrorMessage(response.status, rawText));
  }

  if (!envelope) {
    throw new Error(buildRequestErrorMessage(response.status, rawText));
  }

  if (!envelope.success) {
    throw new Error(envelope.error.message);
  }

  return envelope.data;
}

const parseDownloadFilename = (contentDisposition: string | null): string | null => {
  if (!contentDisposition) {
    return null;
  }

  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1] ?? null;
};

export const api = {
  health: () => request<{ status: string }>('/api/health'),

  register: async (input: RegisterInput) => {
    const user = await request<User>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(input)
    });
    invalidateCsrfToken();
    return user;
  },

  login: async (input: LoginInput) => {
    const user = await request<User>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(input)
    });
    invalidateCsrfToken();
    return user;
  },

  logout: async () => {
    const result = await request<{ logged_out: boolean }>('/api/auth/logout', {
      method: 'POST'
    });
    invalidateCsrfToken();
    return result;
  },

  me: () => request<User>('/api/users/me'),

  listModels: () => request<ModelRecord[]>('/api/models'),
  listMyModels: () => request<ModelRecord[]>('/api/models/my'),

  createModelDraft: (input: {
    name: string;
    description: string;
    model_type: 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb';
    visibility: 'private' | 'workspace' | 'public';
  }) =>
    request<ModelRecord>('/api/models/draft', {
      method: 'POST',
      body: JSON.stringify(input)
    }),

  listConversationAttachments: () => request<FileAttachment[]>('/api/files/conversation'),

  uploadConversationAttachment: (filename: string) =>
    request<FileAttachment>('/api/files/conversation/upload', {
      method: 'POST',
      body: JSON.stringify({ filename })
    }),

  uploadConversationFile: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return request<FileAttachment>('/api/files/conversation/upload', {
      method: 'POST',
      body: formData
    });
  },

  listModelAttachments: (modelId: string) =>
    request<FileAttachment[]>(`/api/files/model/${encodeURIComponent(modelId)}`),

  uploadModelAttachment: (modelId: string, filename: string) =>
    request<FileAttachment>(`/api/files/model/${encodeURIComponent(modelId)}/upload`, {
      method: 'POST',
      body: JSON.stringify({ filename })
    }),

  uploadModelFile: (modelId: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return request<FileAttachment>(`/api/files/model/${encodeURIComponent(modelId)}/upload`, {
      method: 'POST',
      body: formData
    });
  },

  listDatasetAttachments: (datasetId: string) =>
    request<FileAttachment[]>(`/api/files/dataset/${encodeURIComponent(datasetId)}`),

  uploadDatasetAttachment: (datasetId: string, filename: string) =>
    request<FileAttachment>(`/api/files/dataset/${encodeURIComponent(datasetId)}/upload`, {
      method: 'POST',
      body: JSON.stringify({ filename })
    }),

  uploadDatasetFile: (datasetId: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return request<FileAttachment>(`/api/files/dataset/${encodeURIComponent(datasetId)}/upload`, {
      method: 'POST',
      body: formData
    });
  },

  removeAttachment: (attachmentId: string) =>
    request<{ deleted: boolean }>(`/api/files/${encodeURIComponent(attachmentId)}`, {
      method: 'DELETE'
    }),

  attachmentContentUrl: (attachmentId: string) =>
    `/api/files/${encodeURIComponent(attachmentId)}/content`,

  startConversation: (input: {
    model_id: string;
    initial_message: string;
    attachment_ids: string[];
  }) =>
    request<{ conversation: ConversationRecord; messages: MessageRecord[] }>(
      '/api/conversations/start',
      {
        method: 'POST',
        body: JSON.stringify(input)
      }
    ),

  listConversations: () => request<ConversationRecord[]>('/api/conversations'),

  getConversationDetail: (conversationId: string) =>
    request<{ conversation: ConversationRecord; messages: MessageRecord[] }>(
      `/api/conversations/${encodeURIComponent(conversationId)}`
    ),

  renameConversation: (conversationId: string, title: string) =>
    request<ConversationRecord>(`/api/conversations/${encodeURIComponent(conversationId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title })
    }),

  sendConversationMessage: (input: {
    conversation_id: string;
    content: string;
    attachment_ids: string[];
  }) =>
    request<{ messages: MessageRecord[] }>('/api/conversations/message', {
      method: 'POST',
      body: JSON.stringify(input)
    }),

  listDatasets: () => request<DatasetRecord[]>('/api/datasets'),

  createDataset: (input: {
    name: string;
    description: string;
    task_type: 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb';
    label_schema: {
      classes: string[];
    };
  }) =>
    request<DatasetRecord>('/api/datasets', {
      method: 'POST',
      body: JSON.stringify(input)
    }),

  getDatasetDetail: (datasetId: string) =>
    request<{
      dataset: DatasetRecord;
      attachments: FileAttachment[];
      items: DatasetItemRecord[];
      versions: DatasetVersionRecord[];
    }>(`/api/datasets/${encodeURIComponent(datasetId)}`),

  listDatasetItems: (datasetId: string) =>
    request<DatasetItemRecord[]>(`/api/datasets/${encodeURIComponent(datasetId)}/items`),

  splitDataset: (input: {
    dataset_id: string;
    train_ratio: number;
    val_ratio: number;
    test_ratio: number;
    seed: number;
  }) =>
    request<{ split_summary: { train: number; val: number; test: number; unassigned: number } }>(
      `/api/datasets/${encodeURIComponent(input.dataset_id)}/split`,
      {
        method: 'POST',
        body: JSON.stringify({
          train_ratio: input.train_ratio,
          val_ratio: input.val_ratio,
          test_ratio: input.test_ratio,
          seed: input.seed
        })
      }
    ),

  listDatasetVersions: (datasetId: string) =>
    request<DatasetVersionRecord[]>(`/api/datasets/${encodeURIComponent(datasetId)}/versions`),

  createDatasetVersion: (datasetId: string, versionName?: string) =>
    request<DatasetVersionRecord>(`/api/datasets/${encodeURIComponent(datasetId)}/versions`, {
      method: 'POST',
      body: JSON.stringify({ version_name: versionName })
    }),

  importDatasetAnnotations: (input: {
    dataset_id: string;
    format: 'yolo' | 'coco' | 'labelme' | 'ocr';
    attachment_id: string;
  }) =>
    request<{ format: string; imported: number; updated: number; status: 'completed' }>(
      `/api/datasets/${encodeURIComponent(input.dataset_id)}/import`,
      {
        method: 'POST',
        body: JSON.stringify({
          format: input.format,
          attachment_id: input.attachment_id
        })
      }
    ),

  exportDatasetAnnotations: (input: {
    dataset_id: string;
    format: 'yolo' | 'coco' | 'labelme' | 'ocr';
  }) =>
    request<{
      format: string;
      exported: number;
      attachment_id: string;
      filename: string;
      status: 'ready';
    }>(`/api/datasets/${encodeURIComponent(input.dataset_id)}/export`, {
      method: 'POST',
      body: JSON.stringify({
        format: input.format
      })
    }),

  listDatasetAnnotations: (datasetId: string) =>
    request<AnnotationWithReview[]>(`/api/datasets/${encodeURIComponent(datasetId)}/annotations`),

  upsertDatasetAnnotation: (datasetId: string, input: UpsertAnnotationInput) =>
    request<AnnotationWithReview>(`/api/datasets/${encodeURIComponent(datasetId)}/annotations`, {
      method: 'POST',
      body: JSON.stringify(input)
    }),

  submitAnnotationForReview: (datasetId: string, annotationId: string) =>
    request<AnnotationWithReview>(
      `/api/datasets/${encodeURIComponent(datasetId)}/annotations/${encodeURIComponent(annotationId)}/submit-review`,
      {
        method: 'POST'
      }
    ),

  reviewDatasetAnnotation: (datasetId: string, annotationId: string, input: ReviewAnnotationInput) =>
    request<AnnotationWithReview>(
      `/api/datasets/${encodeURIComponent(datasetId)}/annotations/${encodeURIComponent(annotationId)}/review`,
      {
        method: 'POST',
        body: JSON.stringify(input)
      }
    ),

  runDatasetPreAnnotations: (datasetId: string, modelVersionId?: string) =>
    request<{ created: number; updated: number; annotations: AnnotationWithReview[] }>(
      `/api/datasets/${encodeURIComponent(datasetId)}/pre-annotations`,
      {
        method: 'POST',
        body: JSON.stringify({ model_version_id: modelVersionId })
      }
    ),

  draftTaskFromRequirement: (description: string) =>
    request<RequirementTaskDraft>('/api/task-drafts/from-requirement', {
      method: 'POST',
      body: JSON.stringify({ description })
    }),

  listTrainingJobs: () => request<TrainingJobRecord[]>('/api/training/jobs'),

  createTrainingJob: (input: {
    name: string;
    task_type: 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb';
    framework: 'paddleocr' | 'doctr' | 'yolo';
    dataset_id: string;
    dataset_version_id?: string | null;
    base_model: string;
    config: Record<string, string>;
  }) =>
    request<TrainingJobRecord>('/api/training/jobs', {
      method: 'POST',
      body: JSON.stringify(input)
    }),

  getTrainingJobDetail: (jobId: string) =>
    request<{
      job: TrainingJobRecord;
      metrics: TrainingMetricRecord[];
      logs: string[];
      artifact_attachment_id: string | null;
      workspace_dir: string | null;
    }>(
      `/api/training/jobs/${encodeURIComponent(jobId)}`
    ),

  exportTrainingJobMetrics: (jobId: string) =>
    request<TrainingMetricsExport>(`/api/training/jobs/${encodeURIComponent(jobId)}/metrics-export`),

  downloadTrainingJobMetricsCsv: async (jobId: string) => {
    const path = `/api/training/jobs/${encodeURIComponent(jobId)}/metrics-export?format=csv`;
    const response = await fetch(path, {
      method: 'GET',
      credentials: 'include'
    });

    if (!response.ok) {
      const { envelope, rawText } = await readApiEnvelope<unknown>(response);
      if (envelope && !envelope.success) {
        throw new Error(envelope.error.message);
      }

      throw new Error(buildRequestErrorMessage(response.status, rawText));
    }

    const blob = await response.blob();
    const filename =
      parseDownloadFilename(response.headers.get('Content-Disposition')) ??
      `training-metrics-${jobId}.csv`;
    return { blob, filename };
  },

  cancelTrainingJob: (jobId: string) =>
    request<TrainingJobRecord>(`/api/training/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST'
    }),

  retryTrainingJob: (jobId: string) =>
    request<TrainingJobRecord>(`/api/training/jobs/${encodeURIComponent(jobId)}/retry`, {
      method: 'POST'
    }),

  listModelVersions: () => request<ModelVersionRecord[]>('/api/model-versions'),

  getModelVersion: (versionId: string) =>
    request<ModelVersionRecord>(`/api/model-versions/${encodeURIComponent(versionId)}`),

  registerModelVersion: (input: {
    model_id: string;
    training_job_id: string;
    version_name: string;
  }) =>
    request<ModelVersionRecord>('/api/model-versions/register', {
      method: 'POST',
      body: JSON.stringify(input)
    }),

  listInferenceRuns: () => request<InferenceRunRecord[]>('/api/inference/runs'),

  runInference: (input: {
    model_version_id: string;
    input_attachment_id: string;
    task_type: 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb';
  }) =>
    request<InferenceRunRecord>('/api/inference/runs', {
      method: 'POST',
      body: JSON.stringify(input)
    }),

  getInferenceRun: (runId: string) =>
    request<InferenceRunRecord>(`/api/inference/runs/${encodeURIComponent(runId)}`),

  getRuntimeConnectivity: (framework?: 'paddleocr' | 'doctr' | 'yolo') =>
    request<RuntimeConnectivityRecord[]>(
      `/api/runtime/connectivity${
        framework ? `?framework=${encodeURIComponent(framework)}` : ''
      }`
    ),

  getRuntimeMetricsRetentionSummary: () =>
    request<RuntimeMetricsRetentionSummary>('/api/runtime/metrics-retention'),

  sendInferenceFeedback: (input: { run_id: string; dataset_id: string; reason: string }) =>
    request<InferenceRunRecord>(`/api/inference/runs/${encodeURIComponent(input.run_id)}/feedback`, {
      method: 'POST',
      body: JSON.stringify({
        dataset_id: input.dataset_id,
        reason: input.reason
      })
    }),

  listApprovalRequests: () => request<ApprovalRequest[]>('/api/approvals'),

  submitApprovalRequest: (input: SubmitApprovalInput) =>
    request<ApprovalRequest>('/api/approvals/submit', {
      method: 'POST',
      body: JSON.stringify(input)
    }),

  approveRequest: (approvalId: string, notes?: string) =>
    request<ApprovalRequest>(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ notes })
    }),

  rejectRequest: (approvalId: string, reason: string, notes?: string) =>
    request<ApprovalRequest>(`/api/approvals/${encodeURIComponent(approvalId)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason, notes })
    }),

  listAuditLogs: () => request<AuditLogRecord[]>('/api/audit/logs'),

  listVerificationReports: () =>
    request<VerificationReportRecord[]>('/api/admin/verification-reports'),

  getLlmConfig: () => request<LlmConfigView>('/api/settings/llm'),

  saveLlmConfig: (llmConfig: LlmConfig, keepExistingApiKey = false) =>
    request<LlmConfigView>('/api/settings/llm', {
      method: 'POST',
      body: JSON.stringify({
        llm_config: llmConfig,
        keep_existing_api_key: keepExistingApiKey
      })
    }),

  clearLlmConfig: () =>
    request<LlmConfigView>('/api/settings/llm', {
      method: 'DELETE'
    }),

  testLlmConnection: (llmConfig: LlmConfig) =>
    request<{ preview: string }>('/api/settings/llm/test', {
      method: 'POST',
      body: JSON.stringify({ llm_config: llmConfig })
    })
};
