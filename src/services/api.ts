import type {
  ActivateTrainingWorkerResult,
  AnnotationWithReview,
  ApprovalRequest,
  AuditLogRecord,
  ChangePasswordInput,
  ClaimTrainingWorkerBootstrapSessionInput,
  ClaimTrainingWorkerBootstrapSessionResult,
  CreateTrainingWorkerInput,
  CreateTrainingWorkerBootstrapSessionInput,
  ConversationRecord,
  CreateUserInput,
  DatasetItemRecord,
  DatasetRecord,
  DatasetVersionRecord,
  FileAttachment,
  InferenceRunRecord,
  LlmConfig,
  LlmConfigView,
  RuntimeSettingsRecord,
  RuntimeSettingsView,
  LoginInput,
  MessageRecord,
  ModelRecord,
  ModelVersionRecord,
  RequirementTaskDraft,
  ResetUserPasswordInput,
  ReviewAnnotationInput,
  RuntimeConnectivityRecord,
  RuntimeDeviceAccessIssueResult,
  RuntimeDeviceLifecycleSnapshot,
  RuntimeDeviceAccessRecord,
  RuntimeReadinessReport,
  RuntimeMetricsRetentionSummary,
  SubmitApprovalInput,
  TrainingArtifactSummary,
  TrainingJobRecord,
  TrainingMetricRecord,
  TrainingMetricsExport,
  TrainingWorkerBootstrapSessionRecord,
  TrainingWorkerNodeView,
  UpsertAnnotationInput,
  UpdateTrainingWorkerInput,
  UpdateUserStatusInput,
  VerificationReportRecord,
  VisionModelingTaskRecord,
  User
} from '../../shared/domain';
import {
  filterVisibleAttachments,
  filterVisibleDatasets,
  filterVisibleModels,
  filterVisibleModelVersions,
  filterVisibleTrainingJobs
} from '../../shared/catalogFixtures';
import {
  UPLOAD_SOFT_LIMIT_BYTES,
  UPLOAD_SOFT_LIMIT_LABEL,
  formatByteSize
} from '../../shared/uploadLimits';

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

type RotateRuntimeApiKeyResponse = {
  api_key: string;
  settings: RuntimeSettingsView;
};

let csrfToken: string | null = null;

const csrfExemptPaths = new Set(['/api/auth/login', '/api/auth/register', '/api/auth/csrf']);
const responsePreviewMaxLength = 180;

export { UPLOAD_SOFT_LIMIT_LABEL } from '../../shared/uploadLimits';

const isMutationMethod = (method: string) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

const normalizeResponsePreview = (rawText: string): string => {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return 'empty response body (API unavailable/restarting or proxy upstream failed; Docker mode should use http://127.0.0.1:8080/api/*)';
  }

  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith('<!doctype') || lowered.startsWith('<html')) {
    return 'non-JSON response body';
  }

  return trimmed.replace(/\s+/g, ' ').slice(0, responsePreviewMaxLength);
};

const buildRequestErrorMessage = (status: number, rawText: string): string => {
  if (status === 413) {
    return `Request failed (413): upload rejected before reaching API or hit the API upload guard. Keep each file under ${UPLOAD_SOFT_LIMIT_LABEL}. If you use Docker, restart the stack after nginx config changes and retry.`;
  }

  return `Request failed (${status}): ${normalizeResponsePreview(rawText)}`;
};

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

const assertFileUploadWithinLimit = (file: Pick<File, 'name' | 'size'>): void => {
  if (!Number.isFinite(file.size) || file.size <= UPLOAD_SOFT_LIMIT_BYTES) {
    return;
  }

  const filename = file.name?.trim() || 'upload';
  throw new Error(
    `File ${filename} is ${formatByteSize(file.size)}. Keep each upload under ${UPLOAD_SOFT_LIMIT_LABEL} to avoid proxy rejection (413).`
  );
};

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
  changeMyPassword: (input: ChangePasswordInput) =>
    request<{ updated: true }>('/api/users/me/password', {
      method: 'POST',
      body: JSON.stringify(input)
    }),
  listUsers: () => request<User[]>('/api/admin/users'),
  createUserAccount: (input: CreateUserInput) =>
    request<User>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(input)
    }),
  resetUserPassword: (userId: string, input: ResetUserPasswordInput) =>
    request<User>(`/api/admin/users/${encodeURIComponent(userId)}/password-reset`, {
      method: 'POST',
      body: JSON.stringify(input)
    }),
  updateUserStatus: (userId: string, input: UpdateUserStatusInput) =>
    request<User>(`/api/admin/users/${encodeURIComponent(userId)}/status`, {
      method: 'POST',
      body: JSON.stringify(input)
    }),
  listTrainingWorkers: () => request<TrainingWorkerNodeView[]>('/api/admin/training-workers'),
  createTrainingWorker: (input: CreateTrainingWorkerInput) =>
    request<TrainingWorkerNodeView>('/api/admin/training-workers', {
      method: 'POST',
      body: JSON.stringify(input)
    }),
  updateTrainingWorker: (workerId: string, input: UpdateTrainingWorkerInput) =>
    request<TrainingWorkerNodeView>(`/api/admin/training-workers/${encodeURIComponent(workerId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input)
    }),
  removeTrainingWorker: (workerId: string) =>
    request<{ removed: true }>(`/api/admin/training-workers/${encodeURIComponent(workerId)}`, {
      method: 'DELETE'
    }),
  listTrainingWorkerBootstrapSessions: () =>
    request<TrainingWorkerBootstrapSessionRecord[]>('/api/admin/training-workers/bootstrap-sessions'),
  createTrainingWorkerBootstrapSession: (input: CreateTrainingWorkerBootstrapSessionInput) =>
    request<TrainingWorkerBootstrapSessionRecord>('/api/admin/training-workers/bootstrap-sessions', {
      method: 'POST',
      body: JSON.stringify(input)
    }),
  downloadTrainingWorkerBootstrapBundle: async (sessionId: string) => {
    const path = `/api/admin/training-workers/bootstrap-sessions/${encodeURIComponent(sessionId)}/bundle`;
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
      `worker-bootstrap-${sessionId}.sh`;
    return { blob, filename };
  },
  validateTrainingWorkerBootstrapCallback: (sessionId: string) =>
    request<TrainingWorkerBootstrapSessionRecord>(
      `/api/admin/training-workers/bootstrap-sessions/${encodeURIComponent(sessionId)}/validate-callback`,
      {
        method: 'POST'
      }
    ),
  activateTrainingWorker: (workerId: string) =>
    request<ActivateTrainingWorkerResult>(
      `/api/admin/training-workers/${encodeURIComponent(workerId)}/activate`,
      {
        method: 'POST'
      }
    ),
  createTrainingWorkerReconfigureSession: (workerId: string) =>
    request<TrainingWorkerBootstrapSessionRecord>(
      `/api/admin/training-workers/${encodeURIComponent(workerId)}/reconfigure-session`,
      {
        method: 'POST'
      }
    ),
  claimTrainingWorkerBootstrapSession: (input: ClaimTrainingWorkerBootstrapSessionInput) =>
    request<ClaimTrainingWorkerBootstrapSessionResult>(
      '/api/runtime/training-workers/bootstrap-sessions/claim',
      {
        method: 'POST',
        body: JSON.stringify(input)
      }
    ),

  listModels: async () => filterVisibleModels(await request<ModelRecord[]>('/api/models')),
  listMyModels: async () => filterVisibleModels(await request<ModelRecord[]>('/api/models/my')),

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
  removeModelByAdmin: (modelId: string) =>
    request<{ removed: true }>(`/api/admin/models/${encodeURIComponent(modelId)}`, {
      method: 'DELETE'
    }),

  listConversationAttachments: async () =>
    filterVisibleAttachments(await request<FileAttachment[]>('/api/files/conversation')),

  uploadConversationAttachment: (filename: string) =>
    request<FileAttachment>('/api/files/conversation/upload', {
      method: 'POST',
      body: JSON.stringify({ filename })
    }),

  uploadConversationFile: (file: File) => {
    assertFileUploadWithinLimit(file);
    const formData = new FormData();
    formData.append('file', file);
    return request<FileAttachment>('/api/files/conversation/upload', {
      method: 'POST',
      body: formData
    });
  },

  listInferenceAttachments: async () =>
    filterVisibleAttachments(await request<FileAttachment[]>('/api/files/inference')),

  uploadInferenceAttachment: (filename: string) =>
    request<FileAttachment>('/api/files/inference/upload', {
      method: 'POST',
      body: JSON.stringify({ filename })
    }),

  uploadInferenceFile: (file: File) => {
    assertFileUploadWithinLimit(file);
    const formData = new FormData();
    formData.append('file', file);
    return request<FileAttachment>('/api/files/inference/upload', {
      method: 'POST',
      body: formData
    });
  },

  listModelAttachments: async (modelId: string) =>
    filterVisibleAttachments(
      await request<FileAttachment[]>(`/api/files/model/${encodeURIComponent(modelId)}`)
    ),

  uploadModelAttachment: (modelId: string, filename: string) =>
    request<FileAttachment>(`/api/files/model/${encodeURIComponent(modelId)}/upload`, {
      method: 'POST',
      body: JSON.stringify({ filename })
    }),

  uploadModelFile: (modelId: string, file: File) => {
    assertFileUploadWithinLimit(file);
    const formData = new FormData();
    formData.append('file', file);
    return request<FileAttachment>(`/api/files/model/${encodeURIComponent(modelId)}/upload`, {
      method: 'POST',
      body: formData
    });
  },

  listDatasetAttachments: async (datasetId: string) =>
    filterVisibleAttachments(
      await request<FileAttachment[]>(`/api/files/dataset/${encodeURIComponent(datasetId)}`)
    ),

  uploadDatasetAttachment: (datasetId: string, filename: string) =>
    request<FileAttachment>(`/api/files/dataset/${encodeURIComponent(datasetId)}/upload`, {
      method: 'POST',
      body: JSON.stringify({ filename })
    }),

  uploadDatasetFile: (datasetId: string, file: File) => {
    assertFileUploadWithinLimit(file);
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

  deleteConversation: (conversationId: string) =>
    request<{ deleted: boolean }>(`/api/conversations/${encodeURIComponent(conversationId)}`, {
      method: 'DELETE'
    }),

  clearConversations: () =>
    request<{ deleted_ids: string[]; failed_ids: string[] }>('/api/conversations/clear', {
      method: 'POST'
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

  listDatasets: async () => filterVisibleDatasets(await request<DatasetRecord[]>('/api/datasets')),

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

  getDatasetDetail: async (datasetId: string) => {
    const detail = await request<{
      dataset: DatasetRecord;
      attachments: FileAttachment[];
      items: DatasetItemRecord[];
      versions: DatasetVersionRecord[];
    }>(`/api/datasets/${encodeURIComponent(datasetId)}`);

    return {
      ...detail,
      attachments: filterVisibleAttachments(detail.attachments)
    };
  },

  listDatasetItems: (datasetId: string) =>
    request<DatasetItemRecord[]>(`/api/datasets/${encodeURIComponent(datasetId)}/items`),

  createDatasetItem: (
    datasetId: string,
    input: {
      attachment_id?: string;
      filename?: string;
      split?: 'train' | 'val' | 'test' | 'unassigned';
      status?: 'uploading' | 'processing' | 'ready' | 'error';
      metadata?: Record<string, string>;
    }
  ) =>
    request<DatasetItemRecord>(`/api/datasets/${encodeURIComponent(datasetId)}/items`, {
      method: 'POST',
      body: JSON.stringify(input)
    }),

  updateDatasetItem: (
    datasetId: string,
    itemId: string,
    input: {
      split?: 'train' | 'val' | 'test' | 'unassigned';
      status?: 'uploading' | 'processing' | 'ready' | 'error';
      metadata?: Record<string, string>;
    }
  ) =>
    request<DatasetItemRecord>(
      `/api/datasets/${encodeURIComponent(datasetId)}/items/${encodeURIComponent(itemId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(input)
      }
    ),

  deleteDatasetItem: (datasetId: string, itemId: string) =>
    request<{ deleted: boolean }>(
      `/api/datasets/${encodeURIComponent(datasetId)}/items/${encodeURIComponent(itemId)}`,
      {
        method: 'DELETE'
      }
    ),

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
    request<{ format: string; imported: number; updated: number; created_items: number; status: 'completed' }>(
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

  understandVisionTask: (input: {
    prompt: string;
    attachment_ids?: string[];
    dataset_id?: string;
    dataset_version_id?: string;
  }) =>
    request<{ task: VisionModelingTaskRecord; can_start_training: boolean }>(
      '/api/vision/tasks/understand',
      {
        method: 'POST',
        body: JSON.stringify(input)
      }
    ),

  listVisionTasks: () => request<VisionModelingTaskRecord[]>('/api/vision/tasks'),

  getVisionTask: (taskId: string) =>
    request<VisionModelingTaskRecord>(`/api/vision/tasks/${encodeURIComponent(taskId)}`),

  generateVisionTaskFeedbackDataset: (taskId: string, input?: { max_samples?: number }) =>
    request<{
      task: VisionModelingTaskRecord;
      dataset_id: string;
      selected_run_ids: string[];
      sample_count: number;
    }>(`/api/vision/tasks/${encodeURIComponent(taskId)}/feedback-dataset`, {
      method: 'POST',
      body: JSON.stringify(input ?? {})
    }),

  autoContinueVisionTask: (
    taskId: string,
    input?: {
      max_rounds?: number;
      force?: boolean;
    }
  ) =>
    request<{
      task: VisionModelingTaskRecord;
      launched: boolean;
      reason: string;
      next_round: number | null;
      training_job_id: string | null;
    }>(`/api/vision/tasks/${encodeURIComponent(taskId)}/auto-continue`, {
      method: 'POST',
      body: JSON.stringify(input ?? {})
    }),

  autoAdvanceVisionTask: (
    taskId: string,
    input?: {
      max_rounds?: number;
      force?: boolean;
    }
  ) =>
    request<{
      task: VisionModelingTaskRecord;
      action: 'requires_input' | 'training_started' | 'waiting_training' | 'registered' | 'feedback_mined' | 'completed';
      message: string;
      training_job_id: string | null;
      model_version_id: string | null;
      feedback_dataset_id: string | null;
    }>(`/api/vision/tasks/${encodeURIComponent(taskId)}/auto-advance`, {
      method: 'POST',
      body: JSON.stringify(input ?? {})
    }),

  registerVisionTaskModel: (
    taskId: string,
    input?: {
      version_name?: string;
      model_id?: string;
      allow_ocr_calibrated_registration?: boolean;
      require_pure_real_evidence?: boolean;
    }
  ) =>
    request<{
      task: VisionModelingTaskRecord;
      model_version: ModelVersionRecord;
    }>(`/api/vision/tasks/${encodeURIComponent(taskId)}/register-model`, {
      method: 'POST',
      body: JSON.stringify(input ?? {})
    }),

  listTrainingJobs: async () =>
    filterVisibleTrainingJobs(await request<TrainingJobRecord[]>('/api/training/jobs')),

  createTrainingJob: (input: {
    name: string;
    task_type: 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb';
    framework: 'paddleocr' | 'doctr' | 'yolo';
    dataset_id: string;
    dataset_version_id: string;
    base_model: string;
    config: Record<string, string>;
    execution_target?: 'control_plane' | 'worker';
    worker_id?: string;
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
      artifact_summary: TrainingArtifactSummary | null;
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

  retryTrainingJob: (
    jobId: string,
    input?: {
      execution_target?: 'control_plane' | 'worker';
      worker_id?: string;
    }
  ) =>
    request<TrainingJobRecord>(`/api/training/jobs/${encodeURIComponent(jobId)}/retry`, {
      method: 'POST',
      body: JSON.stringify(input ?? {})
    }),

  listModelVersions: async () =>
    filterVisibleModelVersions(await request<ModelVersionRecord[]>('/api/model-versions')),

  getModelVersion: (versionId: string) =>
    request<ModelVersionRecord>(`/api/model-versions/${encodeURIComponent(versionId)}`),

  registerModelVersion: (input: {
    model_id: string;
    training_job_id: string;
    version_name: string;
    allow_ocr_calibrated_registration?: boolean;
    require_pure_real_evidence?: boolean;
  }) => {
    const payload = {
      model_id: input.model_id,
      training_job_id: input.training_job_id,
      version_name: input.version_name,
      ...(typeof input.allow_ocr_calibrated_registration === 'boolean'
        ? {
            allow_ocr_calibrated_registration: input.allow_ocr_calibrated_registration
          }
        : {}),
      ...(typeof input.require_pure_real_evidence === 'boolean'
        ? { require_pure_real_evidence: input.require_pure_real_evidence }
        : {})
    };
    return request<ModelVersionRecord>('/api/model-versions/register', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

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
  getRuntimeReadiness: () => request<RuntimeReadinessReport>('/api/runtime/readiness'),

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

  testLlmConnection: (llmConfig: LlmConfig, useStoredApiKey = false) =>
    request<{ preview: string }>('/api/settings/llm/test', {
      method: 'POST',
      body: JSON.stringify({
        llm_config: llmConfig,
        use_stored_api_key: useStoredApiKey
      })
    }),

  getRuntimeSettings: () => request<RuntimeSettingsView>('/api/settings/runtime'),

  saveRuntimeSettings: (
    runtimeConfig: RuntimeSettingsRecord['frameworks'],
    runtimeControls: RuntimeSettingsRecord['controls'],
    keepExistingApiKeys = true
  ) =>
    request<RuntimeSettingsView>('/api/settings/runtime', {
      method: 'POST',
      body: JSON.stringify({
        runtime_config: runtimeConfig,
        runtime_controls: runtimeControls,
        keep_existing_api_keys: keepExistingApiKeys
      })
    }),

  clearRuntimeSettings: () =>
    request<RuntimeSettingsView>('/api/settings/runtime', {
      method: 'DELETE'
    }),

  activateRuntimeProfile: (profileId: string) =>
    request<RuntimeSettingsView>('/api/settings/runtime/activate-profile', {
      method: 'POST',
      body: JSON.stringify({
        profile_id: profileId
      })
    }),

  autoConfigureRuntimeSettings: (overwriteEndpoint = false) =>
    request<RuntimeSettingsView>('/api/settings/runtime/auto-configure', {
      method: 'POST',
      body: JSON.stringify({
        overwrite_endpoint: overwriteEndpoint
      })
    }),

  generateRuntimeApiKey: () =>
    request<{ api_key: string }>('/api/settings/runtime/generate-api-key', {
      method: 'POST',
      body: JSON.stringify({})
    }),

  revokeRuntimeApiKey: (
    framework: 'paddleocr' | 'doctr' | 'yolo',
    bindingKey?: string
  ) =>
    request<RuntimeSettingsView>('/api/settings/runtime/revoke-api-key', {
      method: 'POST',
      body: JSON.stringify({
        framework,
        binding_key: bindingKey ?? 'framework'
      })
    }),

  rotateRuntimeApiKey: (
    framework: 'paddleocr' | 'doctr' | 'yolo',
    bindingKey?: string
  ) =>
    request<RotateRuntimeApiKeyResponse>('/api/settings/runtime/rotate-api-key', {
      method: 'POST',
      body: JSON.stringify({
        framework,
        binding_key: bindingKey ?? 'framework'
      })
    }),

  listRuntimeDeviceAccess: (modelVersionId: string) =>
    request<RuntimeDeviceAccessRecord[]>(
      `/api/runtime/device-access?model_version_id=${encodeURIComponent(modelVersionId)}`
    ),

  getRuntimeDeviceLifecycle: (modelVersionId: string) =>
    request<RuntimeDeviceLifecycleSnapshot>(
      `/api/runtime/device-access/lifecycle?model_version_id=${encodeURIComponent(modelVersionId)}`
    ),

  issueRuntimeDeviceAccess: (input: {
    model_version_id: string;
    device_name: string;
    expires_at?: string | null;
    max_calls?: number | null;
  }) =>
    request<RuntimeDeviceAccessIssueResult>('/api/runtime/device-access/issue', {
      method: 'POST',
      body: JSON.stringify(input)
    }),

  rotateRuntimeDeviceAccess: (input: { model_version_id: string; binding_key: string }) =>
    request<RuntimeDeviceAccessIssueResult>('/api/runtime/device-access/rotate', {
      method: 'POST',
      body: JSON.stringify(input)
    }),

  revokeRuntimeDeviceAccess: (input: { model_version_id: string; binding_key: string }) =>
    request<RuntimeDeviceAccessRecord[]>('/api/runtime/device-access/revoke', {
      method: 'POST',
      body: JSON.stringify(input)
    })
};
