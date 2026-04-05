import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { URL } from 'node:url';
import { UPLOAD_SOFT_LIMIT_BYTES, UPLOAD_SOFT_LIMIT_LABEL } from '../../shared/uploadLimits';
import { normalizeApiError } from './apiError';
import * as handlers from './handlers';
import { loadPersistedAppState, loadPersistedLlmConfigs, persistAppState } from './store';

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

      const body = (await readBody(req)) as {
        current_password: string;
        new_password: string;
      };

      return withUserMutation(req, res, () => handlers.changeMyPassword(body));
    }

    if (path === '/api/admin/users') {
      if (req.method === 'GET') {
        return withUser(req, res, () => handlers.listUsers());
      }

      if (req.method === 'POST') {
        const body = (await readBody(req)) as {
          username: string;
          password: string;
          role: 'user' | 'admin';
        };

        return withUserMutation(req, res, () => handlers.createUserByAdmin(body));
      }

      return methodNotAllowed(res);
    }

    const adminUserPasswordResetMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/password-reset$/);
    if (adminUserPasswordResetMatch) {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const userId = decodeURIComponent(adminUserPasswordResetMatch[1] ?? '');
      const body = (await readBody(req)) as {
        new_password: string;
      };

      return withUserMutation(req, res, () => handlers.resetUserPasswordByAdmin(userId, body));
    }

    const adminUserStatusMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/status$/);
    if (adminUserStatusMatch) {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const userId = decodeURIComponent(adminUserStatusMatch[1] ?? '');
      const body = (await readBody(req)) as {
        status: 'active' | 'disabled';
      };
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
          handlers.updateUserStatusByAdmin(userId, body)
        );
        if (updated.status === 'disabled') {
          invalidateSessionsForUser(updated.id);
        }
        return sendJson(res, 200, json(updated));
      } catch (error) {
        return sendError(res, error);
      }
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
      if (req.method === 'GET') {
        return withUser(req, res, () => handlers.listDatasetItems(datasetId));
      }

      if (req.method === 'POST') {
        const body = (await readBody(req)) as {
          attachment_id?: string;
          filename?: string;
          split?: 'train' | 'val' | 'test' | 'unassigned';
          status?: 'uploading' | 'processing' | 'ready' | 'error';
          metadata?: Record<string, string>;
        };
        return withUserMutation(req, res, () => handlers.createDatasetItem(datasetId, body));
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

      const body = (await readBody(req)) as {
        split?: 'train' | 'val' | 'test' | 'unassigned';
        status?: 'uploading' | 'processing' | 'ready' | 'error';
        metadata?: Record<string, string>;
      };
      return withUserMutation(req, res, () => handlers.updateDatasetItem(datasetId, itemId, body));
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

      const contentType = readContentType(req);

      if (contentType.toLowerCase().includes('multipart/form-data')) {
        return withUserMutation(req, res, async () => {
          assertUploadPayloadWithinLimit(req);
          const fileUpload = await readMultipartFileUpload(req);
          return handlers.uploadConversationAttachment(fileUpload);
        });
      }

      const body = (await readBody(req)) as { filename: string };
      return withUserMutation(req, res, () => handlers.uploadConversationAttachment(body.filename));
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

      const body = (await readBody(req)) as { filename: string };
      return withUserMutation(req, res, () => handlers.uploadInferenceInputAttachment(body.filename));
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

    if (path === '/api/task-drafts/from-requirement') {
      if (req.method !== 'POST') {
        return methodNotAllowed(res);
      }

      const body = (await readBody(req)) as { description: string };
      return withUserMutation(req, res, () =>
        handlers.draftTaskFromRequirement({
          description: body.description
        })
      );
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
        dataset_version_id: string;
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
        use_stored_api_key?: boolean;
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
