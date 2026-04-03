import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { normalizeApiError } from './apiError';
import * as handlers from './handlers';
import { loadPersistedLlmConfigs } from './store';

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

const notFound = (res: ServerResponse) => {
  sendJson(res, 404, errorJson('Endpoint not found.', 'RESOURCE_NOT_FOUND'));
};

const methodNotAllowed = (res: ServerResponse) => {
  sendJson(res, 405, errorJson('Method not allowed.', 'METHOD_NOT_ALLOWED'));
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
  userId: string;
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

const setSessionCookie = (res: ServerResponse, userId: string): string => {
  const sessionId = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + sessionTtlSeconds * 1000;
  const csrfToken = randomBytes(24).toString('hex');
  sessions.set(sessionId, { userId, expiresAt, csrfToken });

  writeSessionCookie(res, sessionId);
  return sessionId;
};

const clearSessionCookie = (res: ServerResponse): void => {
  res.setHeader(
    'Set-Cookie',
    `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
};

const cleanupExpiredSessions = (): void => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(sessionId);
    }
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
  await withHandler(res, () => handlers.runAsUser(session.state.userId, () => fn(session.state.userId)));
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
  try {
    requireCsrf(req, session.state.csrfToken);
  } catch (error) {
    return sendError(res, error);
  }

  await withHandler(res, () =>
    handlers.runAsUser(session.state.userId, () => fn(session.state.userId))
  );
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

      const body = (await readBody(req)) as {
        username: string;
        password: string;
      };

      try {
        const user = await handlers.register(body);
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

      const body = (await readBody(req)) as { username: string; password: string };

      try {
        const user = await handlers.login(body);
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
      clearSessionCookie(res);
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
      if (req.method !== 'GET') {
        return methodNotAllowed(res);
      }

      return withUser(req, res, () => handlers.me());
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

      const body = (await readBody(req)) as {
        name: string;
        description: string;
        model_type: 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb';
        visibility: 'private' | 'workspace' | 'public';
      };

      return withUserMutation(req, res, () => handlers.createModelDraft(body));
    }

    if (path === '/api/datasets' && req.method === 'GET') {
      return withUser(req, res, () => handlers.listDatasets());
    }

    if (path === '/api/datasets' && req.method === 'POST') {
      const body = (await readBody(req)) as {
        name: string;
        description: string;
        task_type: 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb';
        label_schema: { classes: string[] };
      };

      return withUserMutation(req, res, () => handlers.createDataset(body));
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
      if (req.method !== 'GET') {
        return methodNotAllowed(res);
      }

      return withUser(req, res, () => handlers.listDatasetItems(datasetId));
    }

    const datasetSplitMatch = path.match(/^\/api\/datasets\/([^/]+)\/split$/);
    if (datasetSplitMatch) {
      const datasetId = decodeURIComponent(datasetSplitMatch[1]);
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const body = (await readBody(req)) as {
        train_ratio: number;
        val_ratio: number;
        test_ratio: number;
        seed: number;
      };

      return withUserMutation(req, res, () =>
        handlers.splitDataset({
          dataset_id: datasetId,
          train_ratio: body.train_ratio,
          val_ratio: body.val_ratio,
          test_ratio: body.test_ratio,
          seed: body.seed
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
        const body = (await readBody(req)) as { version_name?: string };
        return withUserMutation(req, res, () =>
          handlers.createDatasetVersion({
            dataset_id: datasetId,
            version_name: body.version_name
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

      const body = (await readBody(req)) as {
        format: 'yolo' | 'coco' | 'labelme' | 'ocr';
        attachment_id: string;
      };

      return withUserMutation(req, res, () => handlers.importDatasetAnnotations(datasetId, body));
    }

    const datasetExportMatch = path.match(/^\/api\/datasets\/([^/]+)\/export$/);
    if (datasetExportMatch) {
      const datasetId = decodeURIComponent(datasetExportMatch[1]);
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const body = (await readBody(req)) as {
        format: 'yolo' | 'coco' | 'labelme' | 'ocr';
      };

      return withUserMutation(req, res, () => handlers.exportDatasetAnnotations(datasetId, body));
    }

    const datasetAnnotationsMatch = path.match(/^\/api\/datasets\/([^/]+)\/annotations$/);
    if (datasetAnnotationsMatch) {
      const datasetId = decodeURIComponent(datasetAnnotationsMatch[1]);
      if (req.method === 'GET') {
        return withUser(req, res, () => handlers.listDatasetAnnotations(datasetId));
      }

      if (req.method === 'POST') {
        const body = (await readBody(req)) as {
          dataset_item_id: string;
          task_type: 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb';
          source: 'manual' | 'import' | 'pre_annotation';
          status: 'unannotated' | 'in_progress' | 'annotated' | 'in_review' | 'approved' | 'rejected';
          payload: Record<string, unknown>;
        };

        return withUserMutation(req, res, () =>
          handlers.upsertDatasetAnnotation(datasetId, body)
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

      const body = (await readBody(req)) as {
        status: 'approved' | 'rejected';
        quality_score?: number | null;
        review_comment?: string | null;
      };

      return withUserMutation(req, res, () =>
        handlers.reviewDatasetAnnotation(datasetId, annotationId, body)
      );
    }

    const preAnnotationsMatch = path.match(/^\/api\/datasets\/([^/]+)\/pre-annotations$/);
    if (preAnnotationsMatch) {
      const datasetId = decodeURIComponent(preAnnotationsMatch[1]);
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const body = (await readBody(req)) as {
        model_version_id?: string;
      };

      return withUserMutation(req, res, () =>
        handlers.runDatasetPreAnnotations(datasetId, body)
      );
    }

    if (path === '/api/files/conversation' && req.method === 'GET') {
      return withUser(req, res, () => handlers.listConversationAttachments());
    }

    if (path === '/api/files/conversation/upload') {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const body = (await readBody(req)) as { filename: string };
      return withUserMutation(req, res, () => handlers.uploadConversationAttachment(body.filename));
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

      const body = (await readBody(req)) as { filename: string };
      return withUserMutation(req, res, () => handlers.uploadModelAttachment(modelId, body.filename));
    }

    const datasetFilesMatch = path.match(/^\/api\/files\/dataset\/([^/]+)$/);
    if (datasetFilesMatch) {
      const datasetId = decodeURIComponent(datasetFilesMatch[1]);
      if (req.method !== 'GET') {
        return methodNotAllowed(res);
      }

      return withUser(req, res, () => handlers.listDatasetAttachments(datasetId));
    }

    const datasetUploadMatch = path.match(/^\/api\/files\/dataset\/([^/]+)\/upload$/);
    if (datasetUploadMatch) {
      const datasetId = decodeURIComponent(datasetUploadMatch[1]);
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const body = (await readBody(req)) as { filename: string };
      return withUserMutation(req, res, () => handlers.uploadDatasetAttachment(datasetId, body.filename));
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

      const body = (await readBody(req)) as {
        model_id: string;
        initial_message: string;
        attachment_ids: string[];
      };

      return withUserMutation(req, res, () => handlers.startConversation(body));
    }

    if (path === '/api/conversations/message') {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const body = (await readBody(req)) as {
        conversation_id: string;
        content: string;
        attachment_ids: string[];
      };

      return withUserMutation(req, res, () => handlers.sendConversationMessage(body));
    }

    const conversationDetailMatch = path.match(/^\/api\/conversations\/([^/]+)$/);
    if (conversationDetailMatch) {
      const conversationId = decodeURIComponent(conversationDetailMatch[1]);
      if (req.method === 'GET') {
        return withUser(req, res, () => handlers.getConversationDetail(conversationId));
      }

      if (req.method === 'PATCH') {
        const body = (await readBody(req)) as { title: string };
        return withUserMutation(req, res, () => handlers.renameConversation(conversationId, body));
      }

      return methodNotAllowed(res);
    }

    if (path === '/api/training/jobs' && req.method === 'GET') {
      return withUser(req, res, () => handlers.listTrainingJobs());
    }

    if (path === '/api/training/jobs' && req.method === 'POST') {
      const body = (await readBody(req)) as {
        name: string;
        task_type: 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb';
        framework: 'paddleocr' | 'doctr' | 'yolo';
        dataset_id: string;
        dataset_version_id?: string | null;
        base_model: string;
        config: Record<string, string>;
      };

      return withUserMutation(req, res, () => handlers.createTrainingJob(body));
    }

    const trainingDetailMatch = path.match(/^\/api\/training\/jobs\/([^/]+)$/);
    if (trainingDetailMatch) {
      const jobId = decodeURIComponent(trainingDetailMatch[1]);
      if (req.method !== 'GET') {
        return methodNotAllowed(res);
      }

      return withUser(req, res, () => handlers.getTrainingJobDetail(jobId));
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
      const body = (await readBody(req)) as {
        model_id: string;
        training_job_id: string;
        version_name: string;
      };

      return withUserMutation(req, res, () => handlers.registerModelVersion(body));
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
      const body = (await readBody(req)) as {
        model_version_id: string;
        input_attachment_id: string;
        task_type: 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb';
      };

      return withUserMutation(req, res, () => handlers.runInference(body));
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

      const body = (await readBody(req)) as { dataset_id: string; reason: string };
      return withUserMutation(req, res, () =>
        handlers.sendInferenceFeedback({
          run_id: runId,
          dataset_id: body.dataset_id,
          reason: body.reason
        })
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

      const body = (await readBody(req)) as {
        model_id: string;
        review_notes?: string;
        parameter_snapshot: Record<string, string>;
      };

      return withUserMutation(req, res, () => handlers.submitApprovalRequest(body));
    }

    const approvalApproveMatch = path.match(/^\/api\/approvals\/([^/]+)\/approve$/);
    if (approvalApproveMatch) {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const approvalId = decodeURIComponent(approvalApproveMatch[1]);
      const body = (await readBody(req)) as { notes?: string };

      return withUserMutation(req, res, () =>
        handlers.approveRequest({
          approval_id: approvalId,
          notes: body.notes
        })
      );
    }

    const approvalRejectMatch = path.match(/^\/api\/approvals\/([^/]+)\/reject$/);
    if (approvalRejectMatch) {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const approvalId = decodeURIComponent(approvalRejectMatch[1]);
      const body = (await readBody(req)) as { reason: string; notes?: string };

      return withUserMutation(req, res, () =>
        handlers.rejectRequest({
          approval_id: approvalId,
          reason: body.reason,
          notes: body.notes
        })
      );
    }

    if (path === '/api/settings/llm' && req.method === 'GET') {
      return withUser(req, res, () => handlers.getLlmConfig());
    }

    if (path === '/api/settings/llm' && req.method === 'POST') {
      const body = (await readBody(req)) as {
        llm_config: {
          enabled: boolean;
          provider: 'chatanywhere';
          base_url: string;
          api_key: string;
          model: string;
          temperature: number;
        };
        keep_existing_api_key?: boolean;
      };

      return withUserMutation(req, res, () => handlers.saveLlmConfig(body));
    }

    if (path === '/api/settings/llm' && req.method === 'DELETE') {
      return withUserMutation(req, res, () => handlers.clearLlmConfig());
    }

    if (path === '/api/settings/llm/test') {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const body = (await readBody(req)) as {
        llm_config: {
          enabled: boolean;
          provider: 'chatanywhere';
          base_url: string;
          api_key: string;
          model: string;
          temperature: number;
        };
      };

      return withUserMutation(req, res, () => handlers.testLlmConnection(body));
    }

    return notFound(res);
  } catch (error) {
    return sendError(res, error);
  }
});

const apiPort = Number(process.env.API_PORT ?? 8787);
const apiHost = process.env.API_HOST ?? '127.0.0.1';

(async () => {
  await loadPersistedLlmConfigs();

  server.listen(apiPort, apiHost, () => {
    console.log(`[vistral-api] listening on http://${apiHost}:${apiPort}`);
  });
})();
