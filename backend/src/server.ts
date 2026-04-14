import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { URL } from 'node:url';
import { UPLOAD_SOFT_LIMIT_BYTES, UPLOAD_SOFT_LIMIT_LABEL } from '../../shared/uploadLimits';
import type {
  CreateTrainingJobInput,
  InferenceFeedbackInput,
  LlmConfig,
  ModelFramework,
  RunInferenceInput,
  TaskType
} from '../../shared/domain';
import { normalizeApiError } from './apiError';
import * as handlers from './handlers';
import {
  loadPersistedAppState,
  loadPersistedLlmConfigs,
  loadPersistedRuntimeSettings,
  persistAppState
} from './store';
import { bootstrapLocalRuntimeAssets } from './runtimeBootstrap';

type ApiSuccess<T> = {
  success: true;
  data: T;
};

type ApiFailure = {
  success: false;
  error: {
    code: string;
    message: string;
  };
};

type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

const json = <T>(data: T): ApiSuccess<T> => ({ success: true, data });

const errorJson = (message: string, code = 'BAD_REQUEST'): ApiFailure => ({
  success: false,
  error: { code, message }
});

const sendJson = <T>(res: ServerResponse, status: number, payload: ApiResponse<T>): void => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
};

const uploadTooLargeMessage = `Upload payload exceeds ${UPLOAD_SOFT_LIMIT_LABEL}. Keep each file under ${UPLOAD_SOFT_LIMIT_LABEL} and retry.`;

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body.');
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeAttachmentIdsInput = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
};

const validTaskTypes: TaskType[] = ['ocr', 'detection', 'classification', 'segmentation', 'obb'];
const validFrameworks: ModelFramework[] = ['paddleocr', 'doctr', 'yolo'];
const validTrainingWorkerStatuses = ['online', 'offline', 'draining'] as const;
const validAnnotationStatuses = [
  'unannotated',
  'in_progress',
  'annotated',
  'in_review',
  'approved',
  'rejected'
] as const;
const validAnnotationSources = ['manual', 'import', 'pre_annotation'] as const;
const validReviewReasonCodes = [
  'box_mismatch',
  'label_error',
  'text_error',
  'missing_object',
  'polygon_issue',
  'other'
] as const;
const validDatasetItemSplits = ['train', 'val', 'test', 'unassigned'] as const;
const validDatasetItemStatuses = ['uploading', 'processing', 'ready', 'error'] as const;
const validModelVisibility = ['private', 'workspace', 'public'] as const;
const validImportExportFormats = ['yolo', 'coco', 'labelme', 'ocr'] as const;
const validWorkerDeploymentModes = ['docker', 'script'] as const;
const validWorkerProfiles = ['yolo', 'paddleocr', 'doctr', 'mixed'] as const;

const isTaskType = (value: unknown): value is TaskType =>
  typeof value === 'string' && validTaskTypes.includes(value as TaskType);

const isFramework = (value: unknown): value is ModelFramework =>
  typeof value === 'string' && validFrameworks.includes(value as ModelFramework);

const toNonEmptyString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const toOptionalTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
};

const toOptionalNullableTrimmedString = (value: unknown): string | null | undefined => {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || null;
};

const toOptionalFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
};

const normalizeTrainingConfigInput = (value: unknown): Record<string, string> => {
  if (!isPlainObject(value)) {
    return {};
  }
  return Object.entries(value).reduce<Record<string, string>>((acc, [rawKey, rawValue]) => {
    const key = rawKey.trim();
    if (!key) {
      return acc;
    }
    if (typeof rawValue === 'string') {
      acc[key] = rawValue;
      return acc;
    }
    if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      acc[key] = String(rawValue);
      return acc;
    }
    if (rawValue === null || rawValue === undefined) {
      acc[key] = '';
      return acc;
    }
    try {
      acc[key] = JSON.stringify(rawValue);
    } catch {
      acc[key] = String(rawValue);
    }
    return acc;
  }, {});
};

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

const parseStartConversationBody = (
  raw: unknown
): ParseResult<{
  model_id: string;
  initial_message: string;
  attachment_ids: string[];
  llm_config?: LlmConfig | null;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Conversation start payload must be a JSON object.'
    };
  }

  const modelId = typeof raw.model_id === 'string' ? raw.model_id.trim() : '';
  if (!modelId) {
    return {
      ok: false,
      message: 'model_id is required.'
    };
  }

  const initialMessage = typeof raw.initial_message === 'string' ? raw.initial_message.trim() : '';
  if (!initialMessage) {
    return {
      ok: false,
      message: 'initial_message is required.'
    };
  }

  return {
    ok: true,
    value: {
      model_id: modelId,
      initial_message: initialMessage,
      attachment_ids: normalizeAttachmentIdsInput(raw.attachment_ids),
      llm_config:
        raw.llm_config === null
          ? null
          : parseLlmConfigInput(raw.llm_config) ?? undefined
    }
  };
};

const parseConversationMessageBody = (
  raw: unknown
): ParseResult<{
  conversation_id: string;
  content: string;
  attachment_ids: string[];
  llm_config?: LlmConfig | null;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Conversation message payload must be a JSON object.'
    };
  }

  const conversationId = typeof raw.conversation_id === 'string' ? raw.conversation_id.trim() : '';
  if (!conversationId) {
    return {
      ok: false,
      message: 'conversation_id is required.'
    };
  }

  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  if (!content) {
    return {
      ok: false,
      message: 'content is required.'
    };
  }

  return {
    ok: true,
    value: {
      conversation_id: conversationId,
      content,
      attachment_ids: normalizeAttachmentIdsInput(raw.attachment_ids),
      llm_config:
        raw.llm_config === null
          ? null
          : parseLlmConfigInput(raw.llm_config) ?? undefined
    }
  };
};

const parseCreateTrainingJobBody = (raw: unknown): ParseResult<CreateTrainingJobInput> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Training job payload must be a JSON object.'
    };
  }

  const name = toNonEmptyString(raw.name);
  if (!name) {
    return {
      ok: false,
      message: 'name is required.'
    };
  }

  if (!isTaskType(raw.task_type)) {
    return {
      ok: false,
      message: 'task_type is invalid.'
    };
  }

  if (!isFramework(raw.framework)) {
    return {
      ok: false,
      message: 'framework is invalid.'
    };
  }

  const datasetId = toNonEmptyString(raw.dataset_id);
  if (!datasetId) {
    return {
      ok: false,
      message: 'dataset_id is required.'
    };
  }

  const datasetVersionId = toNonEmptyString(raw.dataset_version_id);
  if (!datasetVersionId) {
    return {
      ok: false,
      message: 'dataset_version_id is required.'
    };
  }

  const baseModel = toNonEmptyString(raw.base_model);
  if (!baseModel) {
    return {
      ok: false,
      message: 'base_model is required.'
    };
  }

  return {
    ok: true,
    value: {
      name,
      task_type: raw.task_type,
      framework: raw.framework,
      dataset_id: datasetId,
      dataset_version_id: datasetVersionId,
      base_model: baseModel,
      config: normalizeTrainingConfigInput(raw.config)
    }
  };
};

const parseRunInferenceBody = (raw: unknown): ParseResult<RunInferenceInput> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Inference run payload must be a JSON object.'
    };
  }

  const modelVersionId = toNonEmptyString(raw.model_version_id);
  if (!modelVersionId) {
    return {
      ok: false,
      message: 'model_version_id is required.'
    };
  }

  const inputAttachmentId = toNonEmptyString(raw.input_attachment_id);
  if (!inputAttachmentId) {
    return {
      ok: false,
      message: 'input_attachment_id is required.'
    };
  }

  if (!isTaskType(raw.task_type)) {
    return {
      ok: false,
      message: 'task_type is invalid.'
    };
  }

  return {
    ok: true,
    value: {
      model_version_id: modelVersionId,
      input_attachment_id: inputAttachmentId,
      task_type: raw.task_type
    }
  };
};

const parseInferenceFeedbackBody = (
  runId: string,
  raw: unknown
): ParseResult<InferenceFeedbackInput> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Inference feedback payload must be a JSON object.'
    };
  }

  const datasetId = toNonEmptyString(raw.dataset_id);
  if (!datasetId) {
    return {
      ok: false,
      message: 'dataset_id is required.'
    };
  }

  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';

  return {
    ok: true,
    value: {
      run_id: runId,
      dataset_id: datasetId,
      reason
    }
  };
};

const normalizeStringMapInput = (value: unknown): Record<string, string> => {
  if (!isPlainObject(value)) {
    return {};
  }
  return Object.entries(value).reduce<Record<string, string>>((acc, [rawKey, rawValue]) => {
    const key = rawKey.trim();
    if (!key) {
      return acc;
    }
    if (typeof rawValue === 'string') {
      acc[key] = rawValue;
      return acc;
    }
    if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      acc[key] = String(rawValue);
      return acc;
    }
    if (rawValue === null || rawValue === undefined) {
      acc[key] = '';
      return acc;
    }
    try {
      acc[key] = JSON.stringify(rawValue);
    } catch {
      acc[key] = String(rawValue);
    }
    return acc;
  }, {});
};

const parseTaskDraftBody = (raw: unknown): ParseResult<{ description: string }> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Task draft payload must be a JSON object.'
    };
  }
  const description = toNonEmptyString(raw.description);
  if (!description) {
    return {
      ok: false,
      message: 'description is required.'
    };
  }
  return {
    ok: true,
    value: { description }
  };
};

const parseRegisterModelVersionBody = (
  raw: unknown
): ParseResult<{
  model_id: string;
  training_job_id: string;
  version_name: string;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Model version registration payload must be a JSON object.'
    };
  }
  const modelId = toNonEmptyString(raw.model_id);
  if (!modelId) {
    return {
      ok: false,
      message: 'model_id is required.'
    };
  }
  const trainingJobId = toNonEmptyString(raw.training_job_id);
  if (!trainingJobId) {
    return {
      ok: false,
      message: 'training_job_id is required.'
    };
  }
  const versionName = toNonEmptyString(raw.version_name);
  if (!versionName) {
    return {
      ok: false,
      message: 'version_name is required.'
    };
  }
  return {
    ok: true,
    value: {
      model_id: modelId,
      training_job_id: trainingJobId,
      version_name: versionName
    }
  };
};

const parseSubmitApprovalRequestBody = (
  raw: unknown
): ParseResult<{
  model_id: string;
  review_notes?: string;
  parameter_snapshot: Record<string, string>;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Approval submission payload must be a JSON object.'
    };
  }
  const modelId = toNonEmptyString(raw.model_id);
  if (!modelId) {
    return {
      ok: false,
      message: 'model_id is required.'
    };
  }
  if (raw.review_notes !== undefined && typeof raw.review_notes !== 'string') {
    return {
      ok: false,
      message: 'review_notes must be a string when provided.'
    };
  }
  const reviewNotes = typeof raw.review_notes === 'string' ? raw.review_notes : undefined;
  return {
    ok: true,
    value: {
      model_id: modelId,
      review_notes: reviewNotes,
      parameter_snapshot: normalizeStringMapInput(raw.parameter_snapshot)
    }
  };
};

const parseRejectApprovalBody = (
  approvalId: string,
  raw: unknown
): ParseResult<{
  approval_id: string;
  reason: string;
  notes?: string;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Approval reject payload must be a JSON object.'
    };
  }
  const reason = toNonEmptyString(raw.reason);
  if (!reason) {
    return {
      ok: false,
      message: 'reason is required.'
    };
  }
  if (raw.notes !== undefined && typeof raw.notes !== 'string') {
    return {
      ok: false,
      message: 'notes must be a string when provided.'
    };
  }
  const notes = typeof raw.notes === 'string' ? raw.notes : undefined;
  return {
    ok: true,
    value: {
      approval_id: approvalId,
      reason,
      notes
    }
  };
};

function parseLlmConfigInput(value: unknown): LlmConfig | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const safeTemperature =
    typeof value.temperature === 'number' && Number.isFinite(value.temperature)
      ? value.temperature
      : 0.2;
  return {
    enabled: Boolean(value.enabled),
    provider: 'chatanywhere',
    base_url: typeof value.base_url === 'string' ? value.base_url : '',
    api_key: typeof value.api_key === 'string' ? value.api_key : '',
    model: typeof value.model === 'string' ? value.model : '',
    temperature: safeTemperature
  };
}

const parseSaveLlmConfigBody = (
  raw: unknown
): ParseResult<{
  llm_config: LlmConfig;
  keep_existing_api_key?: boolean;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'LLM settings payload must be a JSON object.'
    };
  }
  const llmConfig = parseLlmConfigInput(raw.llm_config);
  if (!llmConfig) {
    return {
      ok: false,
      message: 'llm_config is required.'
    };
  }
  if (
    raw.keep_existing_api_key !== undefined &&
    typeof raw.keep_existing_api_key !== 'boolean'
  ) {
    return {
      ok: false,
      message: 'keep_existing_api_key must be boolean when provided.'
    };
  }
  return {
    ok: true,
    value: {
      llm_config: llmConfig,
      keep_existing_api_key:
        typeof raw.keep_existing_api_key === 'boolean' ? raw.keep_existing_api_key : undefined
    }
  };
};

const parseTestLlmConfigBody = (
  raw: unknown
): ParseResult<{
  llm_config: LlmConfig;
  use_stored_api_key?: boolean;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'LLM test payload must be a JSON object.'
    };
  }
  const llmConfig = parseLlmConfigInput(raw.llm_config);
  if (!llmConfig) {
    return {
      ok: false,
      message: 'llm_config is required.'
    };
  }
  if (raw.use_stored_api_key !== undefined && typeof raw.use_stored_api_key !== 'boolean') {
    return {
      ok: false,
      message: 'use_stored_api_key must be boolean when provided.'
    };
  }
  return {
    ok: true,
    value: {
      llm_config: llmConfig,
      use_stored_api_key:
        typeof raw.use_stored_api_key === 'boolean' ? raw.use_stored_api_key : undefined
    }
  };
};

const parseRuntimeFrameworkConfigInput = (value: unknown): {
  endpoint: string;
  api_key: string;
  default_model_id: string;
  default_model_version_id: string;
  model_api_keys: Record<string, string>;
  model_api_key_policies: Record<
    string,
    {
      api_key: string;
      expires_at: string | null;
      max_calls: number | null;
      used_calls: number;
      last_used_at: string | null;
    }
  >;
  local_model_path: string;
  local_train_command: string;
  local_predict_command: string;
} => {
  const parseModelApiKeys = (raw: unknown): Record<string, string> => {
    if (!isPlainObject(raw)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(raw)) {
      const normalizedKey = key.trim();
      if (!normalizedKey || typeof entry !== 'string') {
        continue;
      }
      result[normalizedKey] = entry;
    }
    return result;
  };
  const parseModelApiKeyPolicies = (
    raw: unknown
  ): Record<
    string,
    {
      api_key: string;
      expires_at: string | null;
      max_calls: number | null;
      used_calls: number;
      last_used_at: string | null;
    }
  > => {
    if (!isPlainObject(raw)) {
      return {};
    }
    const result: Record<
      string,
      {
        api_key: string;
        expires_at: string | null;
        max_calls: number | null;
        used_calls: number;
        last_used_at: string | null;
      }
    > = {};
    for (const [key, entry] of Object.entries(raw)) {
      const normalizedKey = key.trim();
      if (!normalizedKey || !isPlainObject(entry)) {
        continue;
      }
      const normalizedMaxCalls =
        typeof entry.max_calls === 'number' && Number.isFinite(entry.max_calls)
          ? Math.max(0, Math.floor(entry.max_calls))
          : null;
      const normalizedUsedCalls =
        typeof entry.used_calls === 'number' && Number.isFinite(entry.used_calls)
          ? Math.max(0, Math.floor(entry.used_calls))
          : 0;
      result[normalizedKey] = {
        api_key: typeof entry.api_key === 'string' ? entry.api_key : '',
        expires_at: typeof entry.expires_at === 'string' ? entry.expires_at : null,
        max_calls: normalizedMaxCalls,
        used_calls:
          typeof normalizedMaxCalls === 'number'
            ? Math.min(normalizedUsedCalls, normalizedMaxCalls)
            : normalizedUsedCalls,
        last_used_at: typeof entry.last_used_at === 'string' ? entry.last_used_at : null
      };
    }
    return result;
  };
  if (!isPlainObject(value)) {
    return {
      endpoint: '',
      api_key: '',
      default_model_id: '',
      default_model_version_id: '',
      model_api_keys: {},
      model_api_key_policies: {},
      local_model_path: '',
      local_train_command: '',
      local_predict_command: ''
    };
  }
  return {
    endpoint: typeof value.endpoint === 'string' ? value.endpoint : '',
    api_key: typeof value.api_key === 'string' ? value.api_key : '',
    default_model_id:
      typeof value.default_model_id === 'string' ? value.default_model_id : '',
    default_model_version_id:
      typeof value.default_model_version_id === 'string' ? value.default_model_version_id : '',
    model_api_keys: parseModelApiKeys(value.model_api_keys),
    model_api_key_policies: parseModelApiKeyPolicies(value.model_api_key_policies),
    local_model_path:
      typeof value.local_model_path === 'string' ? value.local_model_path : '',
    local_train_command:
      typeof value.local_train_command === 'string' ? value.local_train_command : '',
    local_predict_command:
      typeof value.local_predict_command === 'string' ? value.local_predict_command : ''
  };
};

const parseSaveRuntimeSettingsBody = (
  raw: unknown
): ParseResult<{
  runtime_config: {
    paddleocr: ReturnType<typeof parseRuntimeFrameworkConfigInput>;
    doctr: ReturnType<typeof parseRuntimeFrameworkConfigInput>;
    yolo: ReturnType<typeof parseRuntimeFrameworkConfigInput>;
  };
  runtime_controls?: {
    python_bin?: string;
    disable_simulated_train_fallback?: boolean;
    disable_inference_fallback?: boolean;
  };
  keep_existing_api_keys?: boolean;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Runtime settings payload must be a JSON object.'
    };
  }
  if (raw.runtime_config !== undefined && !isPlainObject(raw.runtime_config)) {
    return {
      ok: false,
      message: 'runtime_config must be a JSON object when provided.'
    };
  }
  if (raw.runtime_controls !== undefined && !isPlainObject(raw.runtime_controls)) {
    return {
      ok: false,
      message: 'runtime_controls must be a JSON object when provided.'
    };
  }
  if (
    raw.keep_existing_api_keys !== undefined &&
    typeof raw.keep_existing_api_keys !== 'boolean'
  ) {
    return {
      ok: false,
      message: 'keep_existing_api_keys must be boolean when provided.'
    };
  }
  const runtimeConfig = isPlainObject(raw.runtime_config) ? raw.runtime_config : {};
  const runtimeControls = isPlainObject(raw.runtime_controls) ? raw.runtime_controls : {};
  const frameworkKeys = ['paddleocr', 'doctr', 'yolo'] as const;
  for (const framework of frameworkKeys) {
    const entry = runtimeConfig[framework];
    if (!isPlainObject(entry)) {
      continue;
    }
    const modelApiKeys = entry.model_api_keys;
    if (modelApiKeys !== undefined && !isPlainObject(modelApiKeys)) {
      return {
        ok: false,
        message: `runtime_config.${framework}.model_api_keys must be a JSON object when provided.`
      };
    }
    if (isPlainObject(modelApiKeys)) {
      const invalid = Object.values(modelApiKeys).some((value) => typeof value !== 'string');
      if (invalid) {
        return {
          ok: false,
          message: `runtime_config.${framework}.model_api_keys values must be strings when provided.`
        };
      }
    }
    const modelApiKeyPolicies = entry.model_api_key_policies;
    if (modelApiKeyPolicies !== undefined && !isPlainObject(modelApiKeyPolicies)) {
      return {
        ok: false,
        message: `runtime_config.${framework}.model_api_key_policies must be a JSON object when provided.`
      };
    }
    if (isPlainObject(modelApiKeyPolicies)) {
      for (const [bindingKey, policy] of Object.entries(modelApiKeyPolicies)) {
        if (!isPlainObject(policy)) {
          return {
            ok: false,
            message: `runtime_config.${framework}.model_api_key_policies.${bindingKey} must be a JSON object.`
          };
        }
        if (policy.api_key !== undefined && typeof policy.api_key !== 'string') {
          return {
            ok: false,
            message: `runtime_config.${framework}.model_api_key_policies.${bindingKey}.api_key must be string when provided.`
          };
        }
        if (
          policy.expires_at !== undefined &&
          policy.expires_at !== null &&
          typeof policy.expires_at !== 'string'
        ) {
          return {
            ok: false,
            message: `runtime_config.${framework}.model_api_key_policies.${bindingKey}.expires_at must be string|null when provided.`
          };
        }
        if (
          policy.max_calls !== undefined &&
          policy.max_calls !== null &&
          (typeof policy.max_calls !== 'number' || !Number.isFinite(policy.max_calls))
        ) {
          return {
            ok: false,
            message: `runtime_config.${framework}.model_api_key_policies.${bindingKey}.max_calls must be number|null when provided.`
          };
        }
        if (
          policy.used_calls !== undefined &&
          (typeof policy.used_calls !== 'number' || !Number.isFinite(policy.used_calls))
        ) {
          return {
            ok: false,
            message: `runtime_config.${framework}.model_api_key_policies.${bindingKey}.used_calls must be number when provided.`
          };
        }
        if (
          policy.last_used_at !== undefined &&
          policy.last_used_at !== null &&
          typeof policy.last_used_at !== 'string'
        ) {
          return {
            ok: false,
            message: `runtime_config.${framework}.model_api_key_policies.${bindingKey}.last_used_at must be string|null when provided.`
          };
        }
      }
    }
  }
  if (runtimeControls.python_bin !== undefined && typeof runtimeControls.python_bin !== 'string') {
    return {
      ok: false,
      message: 'runtime_controls.python_bin must be a string when provided.'
    };
  }
  if (
    runtimeControls.disable_simulated_train_fallback !== undefined &&
    typeof runtimeControls.disable_simulated_train_fallback !== 'boolean'
  ) {
    return {
      ok: false,
      message: 'runtime_controls.disable_simulated_train_fallback must be boolean when provided.'
    };
  }
  if (
    runtimeControls.disable_inference_fallback !== undefined &&
    typeof runtimeControls.disable_inference_fallback !== 'boolean'
  ) {
    return {
      ok: false,
      message: 'runtime_controls.disable_inference_fallback must be boolean when provided.'
    };
  }
  return {
    ok: true,
    value: {
      runtime_config: {
        paddleocr: parseRuntimeFrameworkConfigInput(runtimeConfig.paddleocr),
        doctr: parseRuntimeFrameworkConfigInput(runtimeConfig.doctr),
        yolo: parseRuntimeFrameworkConfigInput(runtimeConfig.yolo)
      },
      runtime_controls: {
        python_bin: typeof runtimeControls.python_bin === 'string' ? runtimeControls.python_bin : undefined,
        disable_simulated_train_fallback:
          typeof runtimeControls.disable_simulated_train_fallback === 'boolean'
            ? runtimeControls.disable_simulated_train_fallback
            : undefined,
        disable_inference_fallback:
          typeof runtimeControls.disable_inference_fallback === 'boolean'
            ? runtimeControls.disable_inference_fallback
            : undefined
      },
      keep_existing_api_keys:
        typeof raw.keep_existing_api_keys === 'boolean' ? raw.keep_existing_api_keys : undefined
    }
  };
};

const parseActivateRuntimeProfileBody = (raw: unknown): ParseResult<{ profile_id: string }> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Runtime profile activation payload must be a JSON object.'
    };
  }
  const profileId = toNonEmptyString(raw.profile_id);
  if (!profileId) {
    return {
      ok: false,
      message: 'profile_id is required.'
    };
  }
  return {
    ok: true,
    value: { profile_id: profileId }
  };
};

const parseAutoConfigureRuntimeSettingsBody = (
  raw: unknown
): ParseResult<{ overwrite_endpoint?: boolean }> => {
  if (raw === undefined || raw === null) {
    return {
      ok: true,
      value: {}
    };
  }
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Runtime auto-config payload must be a JSON object when provided.'
    };
  }
  if (raw.overwrite_endpoint !== undefined && typeof raw.overwrite_endpoint !== 'boolean') {
    return {
      ok: false,
      message: 'overwrite_endpoint must be boolean when provided.'
    };
  }
  return {
    ok: true,
    value: {
      overwrite_endpoint:
        typeof raw.overwrite_endpoint === 'boolean' ? raw.overwrite_endpoint : undefined
    }
  };
};

const parseGenerateRuntimeApiKeyBody = (raw: unknown): ParseResult<Record<string, never>> => {
  if (raw === undefined || raw === null) {
    return {
      ok: true,
      value: {}
    };
  }
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Runtime API key generation payload must be a JSON object when provided.'
    };
  }
  return {
    ok: true,
    value: {}
  };
};

const parseRevokeRuntimeApiKeyBody = (
  raw: unknown
): ParseResult<{ framework: ModelFramework; binding_key?: string }> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Runtime API key revoke payload must be a JSON object.'
    };
  }
  const framework = toNonEmptyString(raw.framework);
  if (!framework) {
    return {
      ok: false,
      message: 'framework is required.'
    };
  }
  if (!validFrameworks.includes(framework as ModelFramework)) {
    return {
      ok: false,
      message: 'framework is invalid.'
    };
  }
  if (raw.binding_key !== undefined && typeof raw.binding_key !== 'string') {
    return {
      ok: false,
      message: 'binding_key must be string when provided.'
    };
  }
  const bindingKey = typeof raw.binding_key === 'string' ? raw.binding_key.trim() : '';
  return {
    ok: true,
    value: {
      framework: framework as ModelFramework,
      binding_key: bindingKey || undefined
    }
  };
};

const parseRotateRuntimeApiKeyBody = (
  raw: unknown
): ParseResult<{ framework: ModelFramework; binding_key?: string }> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Runtime API key rotate payload must be a JSON object.'
    };
  }
  const framework = toNonEmptyString(raw.framework);
  if (!framework) {
    return {
      ok: false,
      message: 'framework is required.'
    };
  }
  if (!validFrameworks.includes(framework as ModelFramework)) {
    return {
      ok: false,
      message: 'framework is invalid.'
    };
  }
  if (raw.binding_key !== undefined && typeof raw.binding_key !== 'string') {
    return {
      ok: false,
      message: 'binding_key must be string when provided.'
    };
  }
  const bindingKey = typeof raw.binding_key === 'string' ? raw.binding_key.trim() : '';
  return {
    ok: true,
    value: {
      framework: framework as ModelFramework,
      binding_key: bindingKey || undefined
    }
  };
};

const parsePairingTokenBody = (raw: unknown): ParseResult<{ pairing_token: string }> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Pairing payload must be a JSON object.'
    };
  }
  const pairingToken = toNonEmptyString(raw.pairing_token);
  if (!pairingToken) {
    return {
      ok: false,
      message: 'pairing_token is required.'
    };
  }
  return {
    ok: true,
    value: { pairing_token: pairingToken }
  };
};

const parseCredentialsBody = (
  raw: unknown,
  payloadLabel: string
): ParseResult<{ username: string; password: string }> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: `${payloadLabel} must be a JSON object.`
    };
  }
  const username = toNonEmptyString(raw.username);
  if (!username) {
    return {
      ok: false,
      message: 'username is required.'
    };
  }
  const password = toNonEmptyString(raw.password);
  if (!password) {
    return {
      ok: false,
      message: 'password is required.'
    };
  }
  return {
    ok: true,
    value: {
      username,
      password
    }
  };
};

const parseChangePasswordBody = (
  raw: unknown
): ParseResult<{
  current_password: string;
  new_password: string;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Password change payload must be a JSON object.'
    };
  }
  const currentPassword = toNonEmptyString(raw.current_password);
  if (!currentPassword) {
    return {
      ok: false,
      message: 'current_password is required.'
    };
  }
  const newPassword = toNonEmptyString(raw.new_password);
  if (!newPassword) {
    return {
      ok: false,
      message: 'new_password is required.'
    };
  }
  return {
    ok: true,
    value: {
      current_password: currentPassword,
      new_password: newPassword
    }
  };
};

const parseCreateUserBody = (
  raw: unknown
): ParseResult<{
  username: string;
  password: string;
  role: 'user' | 'admin';
}> => {
  const credentialsParsed = parseCredentialsBody(raw, 'Create user payload');
  if (!credentialsParsed.ok) {
    return credentialsParsed;
  }
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Create user payload must be a JSON object.'
    };
  }
  const role = toNonEmptyString(raw.role);
  if (role !== 'user' && role !== 'admin') {
    return {
      ok: false,
      message: 'role must be user or admin.'
    };
  }
  return {
    ok: true,
    value: {
      ...credentialsParsed.value,
      role
    }
  };
};

const parseResetPasswordBody = (
  raw: unknown
): ParseResult<{
  new_password: string;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Password reset payload must be a JSON object.'
    };
  }
  const nextPassword = toNonEmptyString(raw.new_password);
  if (!nextPassword) {
    return {
      ok: false,
      message: 'new_password is required.'
    };
  }
  return {
    ok: true,
    value: {
      new_password: nextPassword
    }
  };
};

const parseUpdateUserStatusBody = (
  raw: unknown
): ParseResult<{
  status: 'active' | 'disabled';
  reason?: string | null;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'User status payload must be a JSON object.'
    };
  }
  const status = toNonEmptyString(raw.status);
  if (status !== 'active' && status !== 'disabled') {
    return {
      ok: false,
      message: 'status must be active or disabled.'
    };
  }
  const reason = toOptionalNullableTrimmedString(raw.reason);
  if (status === 'disabled' && (!reason || typeof reason !== 'string' || !reason.trim())) {
    return {
      ok: false,
      message: 'reason is required when status=disabled.'
    };
  }
  return {
    ok: true,
    value: {
      status,
      ...(reason !== undefined ? { reason } : {})
    }
  };
};

const parseTrainingWorkerInputBase = (
  raw: unknown,
  requireName: boolean
): ParseResult<{
  name?: string;
  endpoint?: string | null;
  status?: 'online' | 'offline' | 'draining';
  enabled?: boolean;
  max_concurrency?: number;
  capabilities?: string[];
  metadata?: Record<string, string>;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Training worker payload must be a JSON object.'
    };
  }
  if (
    raw.endpoint !== undefined &&
    raw.endpoint !== null &&
    typeof raw.endpoint !== 'string'
  ) {
    return {
      ok: false,
      message: 'endpoint must be a string or null.'
    };
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    return {
      ok: false,
      message: 'enabled must be boolean.'
    };
  }
  const name = toOptionalTrimmedString(raw.name);
  if (requireName && !name) {
    return {
      ok: false,
      message: 'name is required.'
    };
  }
  if (raw.status !== undefined) {
    const status = toNonEmptyString(raw.status);
    if (
      !validTrainingWorkerStatuses.includes(
        status as (typeof validTrainingWorkerStatuses)[number]
      )
    ) {
      return {
        ok: false,
        message: 'status is invalid.'
      };
    }
  }
  const maxConcurrency = toOptionalFiniteNumber(raw.max_concurrency);
  if (raw.max_concurrency !== undefined && maxConcurrency === undefined) {
    return {
      ok: false,
      message: 'max_concurrency must be a finite number.'
    };
  }
  if (raw.capabilities !== undefined && !Array.isArray(raw.capabilities)) {
    return {
      ok: false,
      message: 'capabilities must be a string array.'
    };
  }
  if (Array.isArray(raw.capabilities) && raw.capabilities.some((item) => typeof item !== 'string')) {
    return {
      ok: false,
      message: 'capabilities must be a string array.'
    };
  }
  if (raw.metadata !== undefined && !isPlainObject(raw.metadata)) {
    return {
      ok: false,
      message: 'metadata must be a JSON object.'
    };
  }
  const capabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : undefined;
  return {
    ok: true,
    value: {
      ...(name ? { name } : {}),
      ...(raw.endpoint !== undefined ? { endpoint: toOptionalNullableTrimmedString(raw.endpoint) ?? null } : {}),
      ...(raw.status !== undefined
        ? {
            status: toNonEmptyString(raw.status) as
              | 'online'
              | 'offline'
              | 'draining'
          }
        : {}),
      ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
      ...(maxConcurrency !== undefined ? { max_concurrency: maxConcurrency } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
      ...(raw.metadata !== undefined ? { metadata: normalizeStringMapInput(raw.metadata) } : {})
    }
  };
};

const parseTrainingWorkerBootstrapSessionBody = (
  raw: unknown
): ParseResult<{
  deployment_mode: 'docker' | 'script';
  worker_profile: 'yolo' | 'paddleocr' | 'doctr' | 'mixed';
  control_plane_base_url: string;
  worker_name?: string;
  worker_public_host?: string;
  worker_bind_port?: number;
  max_concurrency?: number;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Training worker bootstrap payload must be a JSON object.'
    };
  }
  const deploymentMode = toNonEmptyString(raw.deployment_mode);
  if (
    !validWorkerDeploymentModes.includes(
      deploymentMode as (typeof validWorkerDeploymentModes)[number]
    )
  ) {
    return {
      ok: false,
      message: 'deployment_mode is invalid.'
    };
  }
  const workerProfile = toNonEmptyString(raw.worker_profile);
  if (!validWorkerProfiles.includes(workerProfile as (typeof validWorkerProfiles)[number])) {
    return {
      ok: false,
      message: 'worker_profile is invalid.'
    };
  }
  const controlPlaneBaseUrl = toNonEmptyString(raw.control_plane_base_url);
  if (!controlPlaneBaseUrl) {
    return {
      ok: false,
      message: 'control_plane_base_url is required.'
    };
  }
  const workerBindPort = toOptionalFiniteNumber(raw.worker_bind_port);
  if (raw.worker_bind_port !== undefined && workerBindPort === undefined) {
    return {
      ok: false,
      message: 'worker_bind_port must be a finite number.'
    };
  }
  const maxConcurrency = toOptionalFiniteNumber(raw.max_concurrency);
  if (raw.max_concurrency !== undefined && maxConcurrency === undefined) {
    return {
      ok: false,
      message: 'max_concurrency must be a finite number.'
    };
  }
  return {
    ok: true,
    value: {
      deployment_mode: deploymentMode as 'docker' | 'script',
      worker_profile: workerProfile as 'yolo' | 'paddleocr' | 'doctr' | 'mixed',
      control_plane_base_url: controlPlaneBaseUrl,
      ...(toOptionalTrimmedString(raw.worker_name) ? { worker_name: toOptionalTrimmedString(raw.worker_name) } : {}),
      ...(toOptionalTrimmedString(raw.worker_public_host)
        ? { worker_public_host: toOptionalTrimmedString(raw.worker_public_host) }
        : {}),
      ...(workerBindPort !== undefined ? { worker_bind_port: workerBindPort } : {}),
      ...(maxConcurrency !== undefined ? { max_concurrency: maxConcurrency } : {})
    }
  };
};

const parseCreateModelDraftBody = (
  raw: unknown
): ParseResult<{
  name: string;
  description: string;
  model_type: TaskType;
  visibility: 'private' | 'workspace' | 'public';
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Model draft payload must be a JSON object.'
    };
  }
  const name = toNonEmptyString(raw.name);
  if (!name) {
    return {
      ok: false,
      message: 'name is required.'
    };
  }
  if (!isTaskType(raw.model_type)) {
    return {
      ok: false,
      message: 'model_type is invalid.'
    };
  }
  const visibility = toNonEmptyString(raw.visibility);
  if (!validModelVisibility.includes(visibility as (typeof validModelVisibility)[number])) {
    return {
      ok: false,
      message: 'visibility is invalid.'
    };
  }
  return {
    ok: true,
    value: {
      name,
      description: typeof raw.description === 'string' ? raw.description : '',
      model_type: raw.model_type,
      visibility: visibility as 'private' | 'workspace' | 'public'
    }
  };
};

const parseCreateDatasetBody = (
  raw: unknown
): ParseResult<{
  name: string;
  description: string;
  task_type: TaskType;
  label_schema: { classes: string[] };
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Dataset payload must be a JSON object.'
    };
  }
  const name = toNonEmptyString(raw.name);
  if (!name) {
    return {
      ok: false,
      message: 'name is required.'
    };
  }
  if (!isTaskType(raw.task_type)) {
    return {
      ok: false,
      message: 'task_type is invalid.'
    };
  }
  const classes = isPlainObject(raw.label_schema) && Array.isArray(raw.label_schema.classes)
    ? raw.label_schema.classes
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
  return {
    ok: true,
    value: {
      name,
      description: typeof raw.description === 'string' ? raw.description : '',
      task_type: raw.task_type,
      label_schema: { classes }
    }
  };
};

const parseDatasetItemMutationBody = (
  raw: unknown,
  options: { requireAttachmentOrFilename: boolean }
): ParseResult<{
  attachment_id?: string;
  filename?: string;
  split?: 'train' | 'val' | 'test' | 'unassigned';
  status?: 'uploading' | 'processing' | 'ready' | 'error';
  metadata?: Record<string, string>;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Dataset item payload must be a JSON object.'
    };
  }
  const attachmentId = toOptionalTrimmedString(raw.attachment_id);
  const filename = toOptionalTrimmedString(raw.filename);
  if (options.requireAttachmentOrFilename && !attachmentId && !filename) {
    return {
      ok: false,
      message: 'attachment_id or filename is required.'
    };
  }
  if (raw.split !== undefined) {
    const split = toNonEmptyString(raw.split);
    if (!validDatasetItemSplits.includes(split as (typeof validDatasetItemSplits)[number])) {
      return {
        ok: false,
        message: 'split is invalid.'
      };
    }
  }
  if (raw.status !== undefined) {
    const status = toNonEmptyString(raw.status);
    if (!validDatasetItemStatuses.includes(status as (typeof validDatasetItemStatuses)[number])) {
      return {
        ok: false,
        message: 'status is invalid.'
      };
    }
  }
  return {
    ok: true,
    value: {
      ...(attachmentId ? { attachment_id: attachmentId } : {}),
      ...(filename ? { filename } : {}),
      ...(raw.split !== undefined
        ? { split: toNonEmptyString(raw.split) as 'train' | 'val' | 'test' | 'unassigned' }
        : {}),
      ...(raw.status !== undefined
        ? { status: toNonEmptyString(raw.status) as 'uploading' | 'processing' | 'ready' | 'error' }
        : {}),
      ...(raw.metadata !== undefined ? { metadata: normalizeStringMapInput(raw.metadata) } : {})
    }
  };
};

const parseDatasetSplitBody = (
  raw: unknown
): ParseResult<{
  train_ratio: number;
  val_ratio: number;
  test_ratio: number;
  seed: number;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Dataset split payload must be a JSON object.'
    };
  }
  const trainRatio = toOptionalFiniteNumber(raw.train_ratio);
  const valRatio = toOptionalFiniteNumber(raw.val_ratio);
  const testRatio = toOptionalFiniteNumber(raw.test_ratio);
  const seed = toOptionalFiniteNumber(raw.seed);
  if (
    trainRatio === undefined ||
    valRatio === undefined ||
    testRatio === undefined ||
    seed === undefined
  ) {
    return {
      ok: false,
      message: 'train_ratio, val_ratio, test_ratio, and seed must be finite numbers.'
    };
  }
  return {
    ok: true,
    value: {
      train_ratio: trainRatio,
      val_ratio: valRatio,
      test_ratio: testRatio,
      seed
    }
  };
};

const parseDatasetVersionBody = (
  raw: unknown
): ParseResult<{
  version_name?: string;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Dataset version payload must be a JSON object.'
    };
  }
  if (raw.version_name !== undefined && typeof raw.version_name !== 'string') {
    return {
      ok: false,
      message: 'version_name must be a string when provided.'
    };
  }
  return {
    ok: true,
    value: {
      ...(toOptionalTrimmedString(raw.version_name)
        ? { version_name: toOptionalTrimmedString(raw.version_name) }
        : {})
    }
  };
};

const parseDatasetImportBody = (
  raw: unknown
): ParseResult<{
  format: 'yolo' | 'coco' | 'labelme' | 'ocr';
  attachment_id: string;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Dataset import payload must be a JSON object.'
    };
  }
  const format = toNonEmptyString(raw.format);
  if (
    !validImportExportFormats.includes(format as (typeof validImportExportFormats)[number])
  ) {
    return {
      ok: false,
      message: 'format is invalid.'
    };
  }
  const attachmentId = toNonEmptyString(raw.attachment_id);
  if (!attachmentId) {
    return {
      ok: false,
      message: 'attachment_id is required.'
    };
  }
  return {
    ok: true,
    value: {
      format: format as 'yolo' | 'coco' | 'labelme' | 'ocr',
      attachment_id: attachmentId
    }
  };
};

const parseDatasetExportBody = (
  raw: unknown
): ParseResult<{
  format: 'yolo' | 'coco' | 'labelme' | 'ocr';
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Dataset export payload must be a JSON object.'
    };
  }
  const format = toNonEmptyString(raw.format);
  if (
    !validImportExportFormats.includes(format as (typeof validImportExportFormats)[number])
  ) {
    return {
      ok: false,
      message: 'format is invalid.'
    };
  }
  return {
    ok: true,
    value: {
      format: format as 'yolo' | 'coco' | 'labelme' | 'ocr'
    }
  };
};

const parseUpsertAnnotationBody = (
  raw: unknown
): ParseResult<{
  dataset_item_id: string;
  task_type: TaskType;
  source: 'manual' | 'import' | 'pre_annotation';
  status: 'unannotated' | 'in_progress' | 'annotated' | 'in_review' | 'approved' | 'rejected';
  payload: Record<string, unknown>;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Dataset annotation payload must be a JSON object.'
    };
  }
  const datasetItemId = toNonEmptyString(raw.dataset_item_id);
  if (!datasetItemId) {
    return {
      ok: false,
      message: 'dataset_item_id is required.'
    };
  }
  if (!isTaskType(raw.task_type)) {
    return {
      ok: false,
      message: 'task_type is invalid.'
    };
  }
  const source = toNonEmptyString(raw.source);
  if (
    !validAnnotationSources.includes(source as (typeof validAnnotationSources)[number])
  ) {
    return {
      ok: false,
      message: 'source is invalid.'
    };
  }
  const status = toNonEmptyString(raw.status);
  if (
    !validAnnotationStatuses.includes(status as (typeof validAnnotationStatuses)[number])
  ) {
    return {
      ok: false,
      message: 'status is invalid.'
    };
  }
  if (!isPlainObject(raw.payload)) {
    return {
      ok: false,
      message: 'payload must be a JSON object.'
    };
  }
  return {
    ok: true,
    value: {
      dataset_item_id: datasetItemId,
      task_type: raw.task_type,
      source: source as 'manual' | 'import' | 'pre_annotation',
      status: status as
        | 'unannotated'
        | 'in_progress'
        | 'annotated'
        | 'in_review'
        | 'approved'
        | 'rejected',
      payload: raw.payload
    }
  };
};

const parseReviewAnnotationBody = (
  raw: unknown
): ParseResult<{
  status: 'approved' | 'rejected';
  review_reason_code?:
    | 'box_mismatch'
    | 'label_error'
    | 'text_error'
    | 'missing_object'
    | 'polygon_issue'
    | 'other'
    | null;
  quality_score?: number | null;
  review_comment?: string | null;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Annotation review payload must be a JSON object.'
    };
  }
  const status = toNonEmptyString(raw.status);
  if (status !== 'approved' && status !== 'rejected') {
    return {
      ok: false,
      message: 'status must be approved or rejected.'
    };
  }
  const reviewReasonCodeRaw = raw.review_reason_code;
  if (reviewReasonCodeRaw !== undefined && reviewReasonCodeRaw !== null) {
    const reviewReasonCode = toNonEmptyString(reviewReasonCodeRaw);
    if (
      !validReviewReasonCodes.includes(
        reviewReasonCode as (typeof validReviewReasonCodes)[number]
      )
    ) {
      return {
        ok: false,
        message: 'review_reason_code is invalid.'
      };
    }
  }
  if (
    raw.quality_score !== undefined &&
    raw.quality_score !== null &&
    toOptionalFiniteNumber(raw.quality_score) === undefined
  ) {
    return {
      ok: false,
      message: 'quality_score must be a finite number or null.'
    };
  }
  return {
    ok: true,
    value: {
      status: status as 'approved' | 'rejected',
      ...(reviewReasonCodeRaw !== undefined
        ? {
            review_reason_code:
              reviewReasonCodeRaw === null
                ? null
                : (toNonEmptyString(reviewReasonCodeRaw) as
                    | 'box_mismatch'
                    | 'label_error'
                    | 'text_error'
                    | 'missing_object'
                    | 'polygon_issue'
                    | 'other')
          }
        : {}),
      ...(raw.quality_score !== undefined
        ? {
            quality_score:
              raw.quality_score === null ? null : (toOptionalFiniteNumber(raw.quality_score) as number)
          }
        : {}),
      ...(raw.review_comment !== undefined
        ? { review_comment: toOptionalNullableTrimmedString(raw.review_comment) ?? null }
        : {})
    }
  };
};

const parseDatasetPreAnnotationsBody = (
  raw: unknown
): ParseResult<{
  model_version_id?: string;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Pre-annotation payload must be a JSON object.'
    };
  }
  if (raw.model_version_id !== undefined && typeof raw.model_version_id !== 'string') {
    return {
      ok: false,
      message: 'model_version_id must be a string when provided.'
    };
  }
  return {
    ok: true,
    value: {
      ...(toOptionalTrimmedString(raw.model_version_id)
        ? { model_version_id: toOptionalTrimmedString(raw.model_version_id) }
        : {})
    }
  };
};

const parseFilenameBody = (
  raw: unknown,
  payloadLabel: string
): ParseResult<{
  filename: string;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: `${payloadLabel} must be a JSON object.`
    };
  }
  const filename = toNonEmptyString(raw.filename);
  if (!filename) {
    return {
      ok: false,
      message: 'filename is required.'
    };
  }
  return {
    ok: true,
    value: { filename }
  };
};

const parseRenameConversationBody = (
  raw: unknown
): ParseResult<{
  title: string;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Rename conversation payload must be a JSON object.'
    };
  }
  const title = toNonEmptyString(raw.title);
  if (!title) {
    return {
      ok: false,
      message: 'title is required.'
    };
  }
  return {
    ok: true,
    value: { title }
  };
};

const parseTrainingWorkerHeartbeatBody = (
  raw: unknown
): ParseResult<{
  worker_id?: string;
  name: string;
  endpoint?: string | null;
  status?: 'online' | 'offline' | 'draining';
  enabled?: boolean;
  max_concurrency?: number;
  reported_load?: number | null;
  capabilities?: string[];
  metadata?: Record<string, string>;
}> => {
  const workerParsed = parseTrainingWorkerInputBase(raw, true);
  if (!workerParsed.ok) {
    return workerParsed;
  }
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Training worker heartbeat payload must be a JSON object.'
    };
  }
  const workerId = toOptionalTrimmedString(raw.worker_id);
  const reportedLoad = toOptionalFiniteNumber(raw.reported_load);
  if (raw.reported_load !== undefined && raw.reported_load !== null && reportedLoad === undefined) {
    return {
      ok: false,
      message: 'reported_load must be a finite number or null.'
    };
  }
  if (!workerParsed.value.name) {
    return {
      ok: false,
      message: 'name is required.'
    };
  }
  return {
    ok: true,
    value: {
      ...workerParsed.value,
      name: workerParsed.value.name,
      ...(workerId ? { worker_id: workerId } : {}),
      ...(raw.reported_load !== undefined
        ? { reported_load: raw.reported_load === null ? null : (reportedLoad as number) }
        : {})
    }
  };
};

const parseApprovalApproveBody = (
  raw: unknown
): ParseResult<{
  notes?: string;
}> => {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'Approval approve payload must be a JSON object.'
    };
  }
  if (raw.notes !== undefined && typeof raw.notes !== 'string') {
    return {
      ok: false,
      message: 'notes must be a string when provided.'
    };
  }
  return {
    ok: true,
    value: {
      ...(toOptionalTrimmedString(raw.notes) ? { notes: toOptionalTrimmedString(raw.notes) } : {})
    }
  };
};

const readMultipartFileUpload = async (
  req: IncomingMessage
): Promise<{ filename: string; byte_size: number; mime_type: string; content: Buffer }> => {
  const requestInit: RequestInit & { duplex: 'half' } = {
    method: req.method,
    headers: req.headers as HeadersInit,
    body: Readable.toWeb(req) as unknown as BodyInit,
    duplex: 'half'
  };

  const proxyRequest = new Request('http://localhost/internal-upload', requestInit);
  const formData = await proxyRequest.formData();
  const filePart = formData.get('file');
  if (
    !filePart ||
    typeof filePart === 'string' ||
    typeof (filePart as { arrayBuffer?: unknown }).arrayBuffer !== 'function'
  ) {
    throw new Error('Upload file is required.');
  }

  const fileMeta = filePart as Blob & { name?: unknown; size?: unknown; type?: unknown };
  const rawBuffer = await fileMeta.arrayBuffer();
  const content = Buffer.from(rawBuffer);
  const filename =
    typeof fileMeta.name === 'string' && fileMeta.name.trim()
      ? fileMeta.name.trim()
      : `file-${Date.now()}.bin`;
  const byteSize =
    typeof fileMeta.size === 'number' && Number.isFinite(fileMeta.size) ? fileMeta.size : 0;
  const mimeType =
    typeof fileMeta.type === 'string' && fileMeta.type.trim()
      ? fileMeta.type.trim()
      : 'application/octet-stream';

  if (content.byteLength > UPLOAD_SOFT_LIMIT_BYTES) {
    throw new Error(uploadTooLargeMessage);
  }

  return {
    filename,
    byte_size: content.byteLength || byteSize,
    mime_type: mimeType,
    content
  };
};

const readContentLength = (req: IncomingMessage): number | null => {
  const contentLengthHeader = req.headers['content-length'];
  const rawValue = Array.isArray(contentLengthHeader)
    ? contentLengthHeader[0] ?? ''
    : contentLengthHeader ?? '';

  if (!rawValue) {
    return null;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const assertUploadPayloadWithinLimit = (req: IncomingMessage): void => {
  const contentLength = readContentLength(req);
  if (contentLength !== null && contentLength > UPLOAD_SOFT_LIMIT_BYTES) {
    throw new Error(uploadTooLargeMessage);
  }
};

const toSafeAttachmentFilename = (filename: string): string =>
  filename.trim().replace(/[\r\n"]/g, '_') || 'attachment.bin';

const readContentType = (req: IncomingMessage): string => {
  const contentTypeHeader = req.headers['content-type'];
  const fromHeaders = Array.isArray(contentTypeHeader)
    ? contentTypeHeader[0] ?? ''
    : contentTypeHeader ?? '';
  if (fromHeaders) {
    return fromHeaders;
  }

  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const key = req.rawHeaders[index];
    const value = req.rawHeaders[index + 1];
    if (typeof key === 'string' && key.toLowerCase() === 'content-type' && typeof value === 'string') {
      return value;
    }
  }

  return '';
};

const notFound = (res: ServerResponse) => {
  sendJson(res, 404, errorJson('Endpoint not found.', 'RESOURCE_NOT_FOUND'));
};

const methodNotAllowed = (res: ServerResponse) => {
  sendJson(res, 405, errorJson('Method not allowed.', 'METHOD_NOT_ALLOWED'));
};

const stringifyProcessError = (value: unknown): string => {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const sendError = (res: ServerResponse, error: unknown): void => {
  const normalized = normalizeApiError(error);
  sendJson(res, normalized.status, errorJson(normalized.message, normalized.code));
};

const withHandler = async (res: ServerResponse, fn: () => Promise<unknown>) => {
  try {
    const data = await fn();
    sendJson(res, 200, json(data));
  } catch (error) {
    sendError(res, error);
  }
};

const sessionCookieName = 'vistral_session';
const sessionTtlSeconds = 7 * 24 * 60 * 60;
const defaultUserId = process.env.DEFAULT_USER_ID ?? 'u-1';

interface SessionState {
  userId: string | null;
  expiresAt: number;
  csrfToken: string;
}

const sessions = new Map<string, SessionState>();

const parseCookies = (cookieHeader?: string): Record<string, string> => {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, item) => {
      const separator = item.indexOf('=');
      if (separator === -1) {
        return acc;
      }

      const key = item.slice(0, separator).trim();
      const value = item.slice(separator + 1).trim();
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
};

const writeSessionCookie = (res: ServerResponse, sessionId: string): void => {
  res.setHeader(
    'Set-Cookie',
    `${sessionCookieName}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionTtlSeconds}`
  );
};

const setSessionCookie = (res: ServerResponse, userId: string | null): string => {
  const sessionId = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + sessionTtlSeconds * 1000;
  const csrfToken = randomBytes(24).toString('hex');
  sessions.set(sessionId, { userId, expiresAt, csrfToken });

  writeSessionCookie(res, sessionId);
  return sessionId;
};

const cleanupExpiredSessions = (): void => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(sessionId);
    }
  }
};

const invalidateSessionsForUser = (userId: string): void => {
  for (const [sessionId, session] of sessions.entries()) {
    if (session.userId !== userId) {
      continue;
    }

    sessions.set(sessionId, {
      userId: null,
      expiresAt: Date.now() + sessionTtlSeconds * 1000,
      csrfToken: randomBytes(24).toString('hex')
    });
  }
};

const resolveSession = (
  req: IncomingMessage,
  res: ServerResponse
): { sessionId: string; state: SessionState } => {
  cleanupExpiredSessions();
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[sessionCookieName];

  if (sessionId) {
    const state = sessions.get(sessionId);
    if (state && state.expiresAt > Date.now()) {
      state.expiresAt = Date.now() + sessionTtlSeconds * 1000;
      sessions.set(sessionId, state);
      writeSessionCookie(res, sessionId);
      return { sessionId, state };
    }
  }

  const newSessionId = setSessionCookie(res, defaultUserId);
  const state = sessions.get(newSessionId);
  if (!state) {
    throw new Error('Failed to initialize session.');
  }
  return { sessionId: newSessionId, state };
};

const withUser = async (
  req: IncomingMessage,
  res: ServerResponse,
  fn: (userId: string) => Promise<unknown>
): Promise<void> => {
  const session = resolveSession(req, res);
  const userId = session.state.userId;
  if (!userId) {
    return sendError(res, new Error('Authentication required.'));
  }
  await withHandler(res, () => handlers.runAsUser(userId, () => fn(userId)));
};

const requireCsrf = (req: IncomingMessage, expectedToken: string): void => {
  const incoming = req.headers['x-csrf-token'];
  const token = Array.isArray(incoming) ? incoming[0] : incoming;
  if (!token || token !== expectedToken) {
    throw new Error('CSRF token mismatch.');
  }
};

const withUserMutation = async (
  req: IncomingMessage,
  res: ServerResponse,
  fn: (userId: string) => Promise<unknown>
): Promise<void> => {
  const session = resolveSession(req, res);
  const userId = session.state.userId;
  if (!userId) {
    return sendError(res, new Error('Authentication required.'));
  }
  try {
    requireCsrf(req, session.state.csrfToken);
  } catch (error) {
    return sendError(res, error);
  }

  await withHandler(res, () =>
    handlers.runAsUser(userId, () => fn(userId))
  );
};

const withUserDirect = async (
  req: IncomingMessage,
  res: ServerResponse,
  fn: (userId: string) => Promise<void>
): Promise<void> => {
  const session = resolveSession(req, res);
  const userId = session.state.userId;
  if (!userId) {
    return sendError(res, new Error('Authentication required.'));
  }
  try {
    await handlers.runAsUser(userId, () => fn(userId));
  } catch (error) {
    sendError(res, error);
  }
};

const readTrainingWorkerToken = (req: IncomingMessage): string | null => {
  const incomingHeader = req.headers['x-training-worker-token'];
  const incomingToken = Array.isArray(incomingHeader) ? incomingHeader[0] : incomingHeader;
  return incomingToken?.trim() || null;
};

const server = createServer(async (req, res) => {
  try {
    if (!req.url || !req.method) {
      return notFound(res);
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (path === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, json({ status: 'ok' }));
    }

    if (path === '/api/auth/register') {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const parsed = parseCredentialsBody(await readBody(req), 'Register payload');
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      try {
        const user = await handlers.register(parsed.value);
        setSessionCookie(res, user.id);
        return sendJson(res, 200, json(user));
      } catch (error) {
        return sendError(res, error);
      }
    }

    if (path === '/api/auth/login') {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const parsed = parseCredentialsBody(await readBody(req), 'Login payload');
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      try {
        const user = await handlers.login(parsed.value);
        setSessionCookie(res, user.id);
        return sendJson(res, 200, json(user));
      } catch (error) {
        return sendError(res, error);
      }
    }

    if (path === '/api/auth/logout') {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const session = resolveSession(req, res);
      try {
        requireCsrf(req, session.state.csrfToken);
      } catch (error) {
        return sendError(res, error);
      }

      sessions.delete(session.sessionId);
      setSessionCookie(res, null);
      return sendJson(res, 200, json({ logged_out: true }));
    }

    if (path === '/api/auth/csrf') {
      if (req.method !== 'GET') {
        return methodNotAllowed(res);
      }

      const session = resolveSession(req, res);
      return sendJson(
        res,
        200,
        json({
          csrf_token: session.state.csrfToken
        })
      );
    }

    if (path === '/api/users/me') {
      if (req.method === 'GET') {
        return withUser(req, res, () => handlers.me());
      }

      return methodNotAllowed(res);
    }

    if (path === '/api/users/me/password') {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const parsed = parseChangePasswordBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () => handlers.changeMyPassword(parsed.value));
    }

    if (path === '/api/admin/users') {
      if (req.method === 'GET') {
        return withUser(req, res, () => handlers.listUsers());
      }

      if (req.method === 'POST') {
        const parsed = parseCreateUserBody(await readBody(req));
        if (!parsed.ok) {
          return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
        }

        return withUserMutation(req, res, () => handlers.createUserByAdmin(parsed.value));
      }

      return methodNotAllowed(res);
    }

    const adminUserPasswordResetMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/password-reset$/);
    if (adminUserPasswordResetMatch) {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const userId = decodeURIComponent(adminUserPasswordResetMatch[1] ?? '');
      const parsed = parseResetPasswordBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () => handlers.resetUserPasswordByAdmin(userId, parsed.value));
    }

    const adminUserStatusMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/status$/);
    if (adminUserStatusMatch) {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const userId = decodeURIComponent(adminUserStatusMatch[1] ?? '');
      const parsed = parseUpdateUserStatusBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }
      const session = resolveSession(req, res);
      const actorUserId = session.state.userId;
      if (!actorUserId) {
        return sendError(res, new Error('Authentication required.'));
      }
      try {
        requireCsrf(req, session.state.csrfToken);
      } catch (error) {
        return sendError(res, error);
      }

      try {
        const updated = await handlers.runAsUser(actorUserId, () =>
          handlers.updateUserStatusByAdmin(userId, parsed.value)
        );
        if (updated.status === 'disabled') {
          invalidateSessionsForUser(updated.id);
        }
        return sendJson(res, 200, json(updated));
      } catch (error) {
        return sendError(res, error);
      }
    }

    if (path === '/api/admin/training-workers') {
      if (req.method === 'GET') {
        return withUser(req, res, () => handlers.listTrainingWorkersByAdmin());
      }

      if (req.method === 'POST') {
        const parsed = parseTrainingWorkerInputBase(await readBody(req), true);
        if (!parsed.ok) {
          return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
        }
        if (!parsed.value.name) {
          return sendJson(res, 400, errorJson('name is required.', 'VALIDATION_ERROR'));
        }
        const workerName = parsed.value.name;
        return withUserMutation(req, res, () =>
          handlers.createTrainingWorkerByAdmin({
            ...parsed.value,
            name: workerName
          })
        );
      }

      return methodNotAllowed(res);
    }

    if (path === '/api/admin/training-workers/bootstrap-sessions') {
      if (req.method === 'GET') {
        return withUser(req, res, () => handlers.listTrainingWorkerBootstrapSessionsByAdmin());
      }

      if (req.method === 'POST') {
        const parsed = parseTrainingWorkerBootstrapSessionBody(await readBody(req));
        if (!parsed.ok) {
          return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
        }
        return withUserMutation(req, res, () =>
          handlers.createTrainingWorkerBootstrapSessionByAdmin(parsed.value)
        );
      }

      return methodNotAllowed(res);
    }

    const adminTrainingWorkerBootstrapValidateMatch = path.match(
      /^\/api\/admin\/training-workers\/bootstrap-sessions\/([^/]+)\/validate-callback$/
    );
    if (adminTrainingWorkerBootstrapValidateMatch) {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }
      const sessionId = decodeURIComponent(adminTrainingWorkerBootstrapValidateMatch[1] ?? '');
      return withUserMutation(req, res, () =>
        handlers.validateTrainingWorkerBootstrapCallbackByAdmin(sessionId)
      );
    }

    const adminTrainingWorkerBootstrapBundleMatch = path.match(
      /^\/api\/admin\/training-workers\/bootstrap-sessions\/([^/]+)\/bundle$/
    );
    if (adminTrainingWorkerBootstrapBundleMatch) {
      if (req.method !== 'GET') {
        return methodNotAllowed(res);
      }
      const sessionId = decodeURIComponent(adminTrainingWorkerBootstrapBundleMatch[1] ?? '');
      return withUserDirect(req, res, async () => {
        const payload = await handlers.downloadTrainingWorkerBootstrapBundleByAdmin(sessionId);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/x-sh; charset=utf-8');
        const safeFilename = toSafeAttachmentFilename(payload.filename);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(payload.filename)}`
        );
        res.end(payload.content);
      });
    }

    const adminTrainingWorkerDetailMatch = path.match(/^\/api\/admin\/training-workers\/([^/]+)$/);
    const adminTrainingWorkerActivateMatch = path.match(
      /^\/api\/admin\/training-workers\/([^/]+)\/activate$/
    );
    const adminTrainingWorkerReconfigureSessionMatch = path.match(
      /^\/api\/admin\/training-workers\/([^/]+)\/reconfigure-session$/
    );
    if (adminTrainingWorkerActivateMatch) {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }
      const workerId = decodeURIComponent(adminTrainingWorkerActivateMatch[1] ?? '');
      return withUserMutation(req, res, () => handlers.activateTrainingWorkerByAdmin(workerId));
    }
    if (adminTrainingWorkerReconfigureSessionMatch) {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }
      const workerId = decodeURIComponent(adminTrainingWorkerReconfigureSessionMatch[1] ?? '');
      return withUserMutation(req, res, () =>
        handlers.createTrainingWorkerReconfigureSessionByAdmin(workerId)
      );
    }

    if (adminTrainingWorkerDetailMatch) {
      const workerId = decodeURIComponent(adminTrainingWorkerDetailMatch[1] ?? '');
      if (req.method === 'PATCH') {
        const parsed = parseTrainingWorkerInputBase(await readBody(req), false);
        if (!parsed.ok) {
          return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
        }
        return withUserMutation(req, res, () =>
          handlers.updateTrainingWorkerByAdmin(workerId, parsed.value)
        );
      }
      if (req.method === 'DELETE') {
        return withUserMutation(req, res, () => handlers.removeTrainingWorkerByAdmin(workerId));
      }
      return methodNotAllowed(res);
    }

    const adminModelDetailMatch = path.match(/^\/api\/admin\/models\/([^/]+)$/);
    if (adminModelDetailMatch) {
      const modelId = decodeURIComponent(adminModelDetailMatch[1] ?? '');
      if (req.method === 'DELETE') {
        return withUserMutation(req, res, () => handlers.removeModelByAdmin(modelId));
      }
      return methodNotAllowed(res);
    }

    if (path === '/api/models' && req.method === 'GET') {
      return withUser(req, res, () => handlers.listModels());
    }

    if (path === '/api/models/my' && req.method === 'GET') {
      return withUser(req, res, () => handlers.listMyModels());
    }

    if (path === '/api/models/draft') {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const parsed = parseCreateModelDraftBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () => handlers.createModelDraft(parsed.value));
    }

    if (path === '/api/datasets' && req.method === 'GET') {
      return withUser(req, res, () => handlers.listDatasets());
    }

    if (path === '/api/datasets' && req.method === 'POST') {
      const parsed = parseCreateDatasetBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () => handlers.createDataset(parsed.value));
    }

    const datasetDetailMatch = path.match(/^\/api\/datasets\/([^/]+)$/);
    if (datasetDetailMatch) {
      const datasetId = decodeURIComponent(datasetDetailMatch[1]);
      if (req.method !== 'GET') {
        return methodNotAllowed(res);
      }

      return withUser(req, res, () => handlers.getDatasetDetail(datasetId));
    }

    const datasetItemsMatch = path.match(/^\/api\/datasets\/([^/]+)\/items$/);
    if (datasetItemsMatch) {
      const datasetId = decodeURIComponent(datasetItemsMatch[1]);
      if (req.method === 'GET') {
        return withUser(req, res, () => handlers.listDatasetItems(datasetId));
      }

      if (req.method === 'POST') {
        const parsed = parseDatasetItemMutationBody(await readBody(req), {
          requireAttachmentOrFilename: true
        });
        if (!parsed.ok) {
          return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
        }
        return withUserMutation(req, res, () => handlers.createDatasetItem(datasetId, parsed.value));
      }

      return methodNotAllowed(res);
    }

    const datasetItemDetailMatch = path.match(/^\/api\/datasets\/([^/]+)\/items\/([^/]+)$/);
    if (datasetItemDetailMatch) {
      const datasetId = decodeURIComponent(datasetItemDetailMatch[1]);
      const itemId = decodeURIComponent(datasetItemDetailMatch[2]);
      if (req.method !== 'PATCH') {
        return methodNotAllowed(res);
      }

      const parsed = parseDatasetItemMutationBody(await readBody(req), {
        requireAttachmentOrFilename: false
      });
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }
      return withUserMutation(req, res, () =>
        handlers.updateDatasetItem(datasetId, itemId, parsed.value)
      );
    }

    const datasetSplitMatch = path.match(/^\/api\/datasets\/([^/]+)\/split$/);
    if (datasetSplitMatch) {
      const datasetId = decodeURIComponent(datasetSplitMatch[1]);
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const parsed = parseDatasetSplitBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () =>
        handlers.splitDataset({
          dataset_id: datasetId,
          train_ratio: parsed.value.train_ratio,
          val_ratio: parsed.value.val_ratio,
          test_ratio: parsed.value.test_ratio,
          seed: parsed.value.seed
        })
      );
    }

    const datasetVersionsMatch = path.match(/^\/api\/datasets\/([^/]+)\/versions$/);
    if (datasetVersionsMatch) {
      const datasetId = decodeURIComponent(datasetVersionsMatch[1]);
      if (req.method === 'GET') {
        return withUser(req, res, () => handlers.listDatasetVersions(datasetId));
      }

      if (req.method === 'POST') {
        const parsed = parseDatasetVersionBody(await readBody(req));
        if (!parsed.ok) {
          return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
        }
        return withUserMutation(req, res, () =>
          handlers.createDatasetVersion({
            dataset_id: datasetId,
            version_name: parsed.value.version_name
          })
        );
      }

      return methodNotAllowed(res);
    }

    const datasetImportMatch = path.match(/^\/api\/datasets\/([^/]+)\/import$/);
    if (datasetImportMatch) {
      const datasetId = decodeURIComponent(datasetImportMatch[1]);
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const parsed = parseDatasetImportBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () =>
        handlers.importDatasetAnnotations(datasetId, parsed.value)
      );
    }

    const datasetExportMatch = path.match(/^\/api\/datasets\/([^/]+)\/export$/);
    if (datasetExportMatch) {
      const datasetId = decodeURIComponent(datasetExportMatch[1]);
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const parsed = parseDatasetExportBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () =>
        handlers.exportDatasetAnnotations(datasetId, parsed.value)
      );
    }

    const datasetAnnotationsMatch = path.match(/^\/api\/datasets\/([^/]+)\/annotations$/);
    if (datasetAnnotationsMatch) {
      const datasetId = decodeURIComponent(datasetAnnotationsMatch[1]);
      if (req.method === 'GET') {
        return withUser(req, res, () => handlers.listDatasetAnnotations(datasetId));
      }

      if (req.method === 'POST') {
        const parsed = parseUpsertAnnotationBody(await readBody(req));
        if (!parsed.ok) {
          return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
        }

        return withUserMutation(req, res, () =>
          handlers.upsertDatasetAnnotation(datasetId, parsed.value)
        );
      }

      return methodNotAllowed(res);
    }

    const submitReviewMatch = path.match(
      /^\/api\/datasets\/([^/]+)\/annotations\/([^/]+)\/submit-review$/
    );
    if (submitReviewMatch) {
      const datasetId = decodeURIComponent(submitReviewMatch[1]);
      const annotationId = decodeURIComponent(submitReviewMatch[2]);
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      return withUserMutation(req, res, () =>
        handlers.submitAnnotationForReview(datasetId, annotationId)
      );
    }

    const reviewAnnotationMatch = path.match(/^\/api\/datasets\/([^/]+)\/annotations\/([^/]+)\/review$/);
    if (reviewAnnotationMatch) {
      const datasetId = decodeURIComponent(reviewAnnotationMatch[1]);
      const annotationId = decodeURIComponent(reviewAnnotationMatch[2]);
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const parsed = parseReviewAnnotationBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () =>
        handlers.reviewDatasetAnnotation(datasetId, annotationId, parsed.value)
      );
    }

    const preAnnotationsMatch = path.match(/^\/api\/datasets\/([^/]+)\/pre-annotations$/);
    if (preAnnotationsMatch) {
      const datasetId = decodeURIComponent(preAnnotationsMatch[1]);
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const parsed = parseDatasetPreAnnotationsBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () =>
        handlers.runDatasetPreAnnotations(datasetId, parsed.value)
      );
    }

    if (path === '/api/files/conversation' && req.method === 'GET') {
      return withUser(req, res, () => handlers.listConversationAttachments());
    }

    if (path === '/api/files/conversation/upload') {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const contentType = readContentType(req);

      if (contentType.toLowerCase().includes('multipart/form-data')) {
        return withUserMutation(req, res, async () => {
          assertUploadPayloadWithinLimit(req);
          const fileUpload = await readMultipartFileUpload(req);
          return handlers.uploadConversationAttachment(fileUpload);
        });
      }

      const parsed = parseFilenameBody(await readBody(req), 'Conversation upload payload');
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }
      return withUserMutation(req, res, () =>
        handlers.uploadConversationAttachment(parsed.value.filename)
      );
    }

    if (path === '/api/files/inference' && req.method === 'GET') {
      return withUser(req, res, () => handlers.listInferenceInputAttachments());
    }

    if (path === '/api/files/inference/upload') {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const contentType = readContentType(req);
      if (contentType.toLowerCase().includes('multipart/form-data')) {
        return withUserMutation(req, res, async () => {
          assertUploadPayloadWithinLimit(req);
          const fileUpload = await readMultipartFileUpload(req);
          return handlers.uploadInferenceInputAttachment(fileUpload);
        });
      }

      const parsed = parseFilenameBody(await readBody(req), 'Inference upload payload');
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }
      return withUserMutation(req, res, () =>
        handlers.uploadInferenceInputAttachment(parsed.value.filename)
      );
    }

    if (path === '/api/conversations' && req.method === 'GET') {
      return withUser(req, res, () => handlers.listConversations());
    }

    const modelFilesMatch = path.match(/^\/api\/files\/model\/([^/]+)$/);
    if (modelFilesMatch) {
      const modelId = decodeURIComponent(modelFilesMatch[1]);
      if (req.method !== 'GET') {
        return methodNotAllowed(res);
      }

      return withUser(req, res, () => handlers.listModelAttachments(modelId));
    }

    const modelUploadMatch = path.match(/^\/api\/files\/model\/([^/]+)\/upload$/);
    if (modelUploadMatch) {
      const modelId = decodeURIComponent(modelUploadMatch[1]);
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const contentType = readContentType(req);
      if (contentType.toLowerCase().includes('multipart/form-data')) {
        return withUserMutation(req, res, async () => {
          assertUploadPayloadWithinLimit(req);
          const fileUpload = await readMultipartFileUpload(req);
          return handlers.uploadModelAttachment(modelId, fileUpload);
        });
      }

      const parsed = parseFilenameBody(await readBody(req), 'Model upload payload');
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }
      return withUserMutation(req, res, () =>
        handlers.uploadModelAttachment(modelId, parsed.value.filename)
      );
    }

    const datasetFilesMatch = path.match(/^\/api\/files\/dataset\/([^/]+)$/);
    if (datasetFilesMatch) {
      const datasetId = decodeURIComponent(datasetFilesMatch[1]);
      if (req.method !== 'GET') {
        return methodNotAllowed(res);
      }

      return withUser(req, res, () => handlers.listDatasetAttachments(datasetId));
    }

    const fileContentMatch = path.match(/^\/api\/files\/([^/]+)\/content$/);
    if (fileContentMatch) {
      if (req.method !== 'GET') {
        return methodNotAllowed(res);
      }

      const attachmentId = decodeURIComponent(fileContentMatch[1]);
      return withUserDirect(req, res, async () => {
        const payload = await handlers.getAttachmentContent(attachmentId);
        const safeFilename = toSafeAttachmentFilename(payload.filename);
        res.statusCode = 200;
        res.setHeader('Content-Type', payload.mime_type || 'application/octet-stream');
        res.setHeader('Content-Length', String(payload.byte_size));
        res.setHeader(
          'Content-Disposition',
          `inline; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(payload.filename)}`
        );
        res.end(payload.content);
      });
    }

    const datasetUploadMatch = path.match(/^\/api\/files\/dataset\/([^/]+)\/upload$/);
    if (datasetUploadMatch) {
      const datasetId = decodeURIComponent(datasetUploadMatch[1]);
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const contentType = readContentType(req);
      if (contentType.toLowerCase().includes('multipart/form-data')) {
        return withUserMutation(req, res, async () => {
          assertUploadPayloadWithinLimit(req);
          const fileUpload = await readMultipartFileUpload(req);
          return handlers.uploadDatasetAttachment(datasetId, fileUpload);
        });
      }

      const parsed = parseFilenameBody(await readBody(req), 'Dataset upload payload');
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }
      return withUserMutation(req, res, () =>
        handlers.uploadDatasetAttachment(datasetId, parsed.value.filename)
      );
    }

    const fileDeleteMatch = path.match(/^\/api\/files\/([^/]+)$/);
    if (fileDeleteMatch) {
      if (req.method !== 'DELETE') {
        return methodNotAllowed(res);
      }

      const attachmentId = decodeURIComponent(fileDeleteMatch[1]);
      return withUserMutation(req, res, async () => {
        await handlers.removeAttachment(attachmentId);
        return { deleted: true };
      });
    }

    if (path === '/api/conversations/start') {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const parsed = parseStartConversationBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () => handlers.startConversation(parsed.value));
    }

    if (path === '/api/conversations/message') {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const parsed = parseConversationMessageBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () => handlers.sendConversationMessage(parsed.value));
    }

    if (path === '/api/task-drafts/from-requirement') {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const parsed = parseTaskDraftBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () => handlers.draftTaskFromRequirement(parsed.value));
    }

    const conversationDetailMatch = path.match(/^\/api\/conversations\/([^/]+)$/);
    if (conversationDetailMatch) {
      const conversationId = decodeURIComponent(conversationDetailMatch[1]);
      if (req.method === 'GET') {
        return withUser(req, res, () => handlers.getConversationDetail(conversationId));
      }

      if (req.method === 'PATCH') {
        const parsed = parseRenameConversationBody(await readBody(req));
        if (!parsed.ok) {
          return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
        }
        return withUserMutation(req, res, () =>
          handlers.renameConversation(conversationId, parsed.value)
        );
      }

      if (req.method === 'DELETE') {
        return withUserMutation(req, res, async () => {
          await handlers.deleteConversation(conversationId);
          return { deleted: true };
        });
      }

      return methodNotAllowed(res);
    }

    if (path === '/api/training/jobs' && req.method === 'GET') {
      return withUser(req, res, () => handlers.listTrainingJobs());
    }

    if (path === '/api/training/jobs' && req.method === 'POST') {
      const parsed = parseCreateTrainingJobBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () => handlers.createTrainingJob(parsed.value));
    }

    const trainingDetailMatch = path.match(/^\/api\/training\/jobs\/([^/]+)$/);
    if (trainingDetailMatch) {
      const jobId = decodeURIComponent(trainingDetailMatch[1]);
      if (req.method !== 'GET') {
        return methodNotAllowed(res);
      }

      return withUser(req, res, () => handlers.getTrainingJobDetail(jobId));
    }

    const trainingMetricsExportMatch = path.match(/^\/api\/training\/jobs\/([^/]+)\/metrics-export$/);
    if (trainingMetricsExportMatch) {
      const jobId = decodeURIComponent(trainingMetricsExportMatch[1]);
      if (req.method !== 'GET') {
        return methodNotAllowed(res);
      }

      const format = (url.searchParams.get('format') ?? 'json').toLowerCase();
      if (!['json', 'csv'].includes(format)) {
        return sendJson(res, 400, errorJson('Invalid format query.', 'VALIDATION_ERROR'));
      }

      if (format === 'csv') {
        return withUserDirect(req, res, async () => {
          const payload = await handlers.exportTrainingJobMetricsCsv(jobId);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          const safeFilename = toSafeAttachmentFilename(payload.filename);
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(payload.filename)}`
          );
          res.end(payload.content);
        });
      }

      return withUser(req, res, () => handlers.exportTrainingJobMetrics(jobId));
    }

    const trainingCancelMatch = path.match(/^\/api\/training\/jobs\/([^/]+)\/cancel$/);
    if (trainingCancelMatch) {
      const jobId = decodeURIComponent(trainingCancelMatch[1]);
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      return withUserMutation(req, res, () => handlers.cancelTrainingJob(jobId));
    }

    const trainingRetryMatch = path.match(/^\/api\/training\/jobs\/([^/]+)\/retry$/);
    if (trainingRetryMatch) {
      const jobId = decodeURIComponent(trainingRetryMatch[1]);
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      return withUserMutation(req, res, () => handlers.retryTrainingJob(jobId));
    }

    if (path === '/api/model-versions' && req.method === 'GET') {
      return withUser(req, res, () => handlers.listModelVersions());
    }

    if (path === '/api/model-versions/register' && req.method === 'POST') {
      const parsed = parseRegisterModelVersionBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () => handlers.registerModelVersion(parsed.value));
    }

    const modelVersionDetailMatch = path.match(/^\/api\/model-versions\/([^/]+)$/);
    if (modelVersionDetailMatch) {
      const versionId = decodeURIComponent(modelVersionDetailMatch[1]);
      if (req.method !== 'GET') {
        return methodNotAllowed(res);
      }

      return withUser(req, res, () => handlers.getModelVersion(versionId));
    }

    if (path === '/api/inference/runs' && req.method === 'GET') {
      return withUser(req, res, () => handlers.listInferenceRuns());
    }

    if (path === '/api/inference/runs' && req.method === 'POST') {
      const parsed = parseRunInferenceBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () => handlers.runInference(parsed.value));
    }

    const inferenceDetailMatch = path.match(/^\/api\/inference\/runs\/([^/]+)$/);
    if (inferenceDetailMatch) {
      const runId = decodeURIComponent(inferenceDetailMatch[1]);
      if (req.method !== 'GET') {
        return methodNotAllowed(res);
      }

      return withUser(req, res, () => handlers.getInferenceRun(runId));
    }

    const inferenceFeedbackMatch = path.match(/^\/api\/inference\/runs\/([^/]+)\/feedback$/);
    if (inferenceFeedbackMatch) {
      const runId = decodeURIComponent(inferenceFeedbackMatch[1]);
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const parsed = parseInferenceFeedbackBody(runId, await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () => handlers.sendInferenceFeedback(parsed.value));
    }

    if (path === '/api/runtime/training-workers/heartbeat') {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }
      const parsed = parseTrainingWorkerHeartbeatBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }
      return withHandler(res, () =>
        handlers.heartbeatTrainingWorker(parsed.value, readTrainingWorkerToken(req))
      );
    }

    if (path === '/api/runtime/training-workers/bootstrap-sessions/claim') {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }
      const parsed = parsePairingTokenBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }
      return withHandler(res, () => handlers.claimTrainingWorkerBootstrapSession(parsed.value));
    }

    if (path === '/api/runtime/training-workers/bootstrap-sessions/status') {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }
      const parsed = parsePairingTokenBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }
      return withHandler(res, () => handlers.getTrainingWorkerBootstrapSessionStatus(parsed.value));
    }

    const workerDatasetPackageMatch = path.match(
      /^\/api\/runtime\/training-workers\/dataset-packages\/([^/]+)$/
    );
    if (workerDatasetPackageMatch) {
      if (req.method !== 'GET') {
        return methodNotAllowed(res);
      }
      const packageId = decodeURIComponent(workerDatasetPackageMatch[1] ?? '');
      return withHandler(res, () =>
        handlers.getTrainingWorkerDatasetPackageContent(packageId, readTrainingWorkerToken(req))
      );
    }

    if (path === '/api/runtime/connectivity') {
      if (req.method !== 'GET') {
        return methodNotAllowed(res);
      }

      const framework = url.searchParams.get('framework');
      if (framework && !['paddleocr', 'doctr', 'yolo'].includes(framework)) {
        return sendJson(res, 400, errorJson('Invalid framework query.', 'VALIDATION_ERROR'));
      }

      return withUser(req, res, () =>
        handlers.getRuntimeConnectivity(framework as 'paddleocr' | 'doctr' | 'yolo' | undefined)
      );
    }

    if (path === '/api/runtime/readiness') {
      if (req.method !== 'GET') {
        return methodNotAllowed(res);
      }

      return withUser(req, res, () => handlers.getRuntimeReadiness());
    }

    if (path === '/api/runtime/metrics-retention') {
      if (req.method !== 'GET') {
        return methodNotAllowed(res);
      }

      return withUser(req, res, () => handlers.getRuntimeMetricsRetentionSummary());
    }

    if (path === '/api/approvals' && req.method === 'GET') {
      return withUser(req, res, () => handlers.listApprovalRequests());
    }

    if (path === '/api/audit/logs' && req.method === 'GET') {
      return withUser(req, res, () => handlers.listAuditLogs());
    }

    if (path === '/api/admin/verification-reports' && req.method === 'GET') {
      return withUser(req, res, () => handlers.listVerificationReports());
    }

    if (path === '/api/approvals/submit') {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const parsed = parseSubmitApprovalRequestBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () => handlers.submitApprovalRequest(parsed.value));
    }

    const approvalApproveMatch = path.match(/^\/api\/approvals\/([^/]+)\/approve$/);
    if (approvalApproveMatch) {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const approvalId = decodeURIComponent(approvalApproveMatch[1]);
      const parsed = parseApprovalApproveBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () =>
        handlers.approveRequest({
          approval_id: approvalId,
          notes: parsed.value.notes
        })
      );
    }

    const approvalRejectMatch = path.match(/^\/api\/approvals\/([^/]+)\/reject$/);
    if (approvalRejectMatch) {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const approvalId = decodeURIComponent(approvalRejectMatch[1]);
      const parsed = parseRejectApprovalBody(approvalId, await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () => handlers.rejectRequest(parsed.value));
    }

    if (path === '/api/settings/llm' && req.method === 'GET') {
      return withUser(req, res, () => handlers.getLlmConfig());
    }

    if (path === '/api/settings/llm' && req.method === 'POST') {
      const parsed = parseSaveLlmConfigBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () => handlers.saveLlmConfig(parsed.value));
    }

    if (path === '/api/settings/llm' && req.method === 'DELETE') {
      return withUserMutation(req, res, () => handlers.clearLlmConfig());
    }

    if (path === '/api/settings/llm/test') {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const parsed = parseTestLlmConfigBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () => handlers.testLlmConnection(parsed.value));
    }

    if (path === '/api/settings/runtime' && req.method === 'GET') {
      return withUser(req, res, () => handlers.getRuntimeSettings());
    }

    if (path === '/api/settings/runtime' && req.method === 'POST') {
      const parsed = parseSaveRuntimeSettingsBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }

      return withUserMutation(req, res, () => handlers.saveRuntimeSettings(parsed.value));
    }

    if (path === '/api/settings/runtime/activate-profile' && req.method === 'POST') {
      const parsed = parseActivateRuntimeProfileBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }
      return withUserMutation(req, res, () => handlers.activateRuntimeProfile(parsed.value.profile_id));
    }

    if (path === '/api/settings/runtime/auto-configure' && req.method === 'POST') {
      const parsed = parseAutoConfigureRuntimeSettingsBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }
      return withUserMutation(req, res, () => handlers.autoConfigureRuntimeSettings(parsed.value));
    }

    if (path === '/api/settings/runtime/generate-api-key' && req.method === 'POST') {
      const parsed = parseGenerateRuntimeApiKeyBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }
      return withUserMutation(req, res, () => handlers.generateRuntimeApiKey());
    }

    if (path === '/api/settings/runtime/revoke-api-key' && req.method === 'POST') {
      const parsed = parseRevokeRuntimeApiKeyBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }
      return withUserMutation(req, res, () => handlers.revokeRuntimeApiKey(parsed.value));
    }

    if (path === '/api/settings/runtime/rotate-api-key' && req.method === 'POST') {
      const parsed = parseRotateRuntimeApiKeyBody(await readBody(req));
      if (!parsed.ok) {
        return sendJson(res, 400, errorJson(parsed.message, 'VALIDATION_ERROR'));
      }
      return withUserMutation(req, res, () => handlers.rotateRuntimeApiKey(parsed.value));
    }

    if (path === '/api/settings/runtime' && req.method === 'DELETE') {
      return withUserMutation(req, res, () => handlers.clearRuntimeSettings());
    }

    return notFound(res);
  } catch (error) {
    return sendError(res, error);
  }
});

const apiPort = Number(process.env.API_PORT ?? 8787);
const apiHost = process.env.API_HOST ?? '127.0.0.1';
const appStatePersistIntervalMs = (() => {
  const parsed = Number.parseInt(process.env.APP_STATE_PERSIST_INTERVAL_MS ?? '1200', 10);
  if (!Number.isFinite(parsed) || parsed < 400) {
    return 1200;
  }
  return parsed;
})();

(async () => {
  process.on('unhandledRejection', (reason) => {
    console.error(
      `[vistral-api] unhandledRejection: ${stringifyProcessError(reason)}`
    );
  });
  process.on('uncaughtException', (error) => {
    console.error(
      `[vistral-api] uncaughtException: ${stringifyProcessError(error)}`
    );
  });

  await loadPersistedAppState();
  await loadPersistedLlmConfigs();
  await loadPersistedRuntimeSettings();
  await bootstrapLocalRuntimeAssets();
  handlers.syncRuntimeIdSeed();
  const resumeSummary = handlers.resumePendingTrainingJobs();
  if (resumeSummary.resumed_job_ids.length > 0) {
    console.log(
      `[vistral-api] resumed training jobs after restart: ${resumeSummary.resumed_job_ids.join(', ')}`
    );
  }

  const persistInterval = setInterval(() => {
    void persistAppState().catch((error) => {
      console.warn('[vistral-api] Failed to persist app state:', (error as Error).message);
    });
  }, appStatePersistIntervalMs);
  persistInterval.unref();

  const shutdown = async () => {
    clearInterval(persistInterval);
    await persistAppState(true).catch((error) => {
      console.warn('[vistral-api] Failed to flush app state on shutdown:', (error as Error).message);
    });
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });

  server.listen(apiPort, apiHost, () => {
    console.log(`[vistral-api] listening on http://${apiHost}:${apiPort}`);
  });
})();
