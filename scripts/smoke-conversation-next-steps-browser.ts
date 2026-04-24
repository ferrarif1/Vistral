import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiPort = 8787;
const webPort = 5173;
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
const webBaseUrl = `http://127.0.0.1:${webPort}`;
const reportDir = resolve(rootDir, process.env.SMOKE_BROWSER_REPORT_DIR ?? '.data/verify-reports');
const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const mockWorkerId = 'tw-browser-next-steps';
const mockWorkerToken = `browser-worker-token-${timestamp}`;

type ManagedProcess = {
  name: string;
  process: ReturnType<typeof spawn>;
  logs: string[];
  exitCode: number | null;
};

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type CdpEventHandler = (params: unknown) => void;

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

interface RuntimeEvaluateResult {
  result?: {
    type?: string;
    value?: unknown;
    description?: string;
    unserializableValue?: string;
  };
  exceptionDetails?: {
    text?: string;
    exception?: {
      description?: string;
      value?: unknown;
    };
  };
}

interface LayoutProbe {
  ok: boolean;
  reason: string;
  card?: {
    width: number;
    height: number;
  };
  buttons: Array<{
    text: string;
    width: number;
    height: number;
  }>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const truncate = (value: string, max = 1400): string =>
  value.length > max ? `${value.slice(0, max)}...` : value;

const isPortFree = (port: number): Promise<boolean> =>
  new Promise((resolvePort) => {
    const server = createNetServer();
    server.once('error', () => resolvePort(false));
    server.once('listening', () => {
      server.close(() => resolvePort(true));
    });
    server.listen(port, '127.0.0.1');
  });

const findFreePort = async (start: number, end = start + 2000): Promise<number> => {
  for (let port = start; port <= end; port += 1) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(`No free port found in range ${start}-${end}.`);
};

const requireFreePort = async (port: number, label: string) => {
  const free = await isPortFree(port);
  assert.ok(
    free,
    `${label} port ${port} is already in use. Stop the existing process before running this browser smoke.`
  );
};

const findExecutableOnPath = (name: string): string => {
  const result = spawnSync('which', [name], { encoding: 'utf8' });
  if (result.status === 0) {
    return result.stdout.trim();
  }
  return '';
};

const findChrome = (): string => {
  const candidates = [
    process.env.CHROME_BIN?.trim() ?? '',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    findExecutableOnPath('google-chrome'),
    findExecutableOnPath('chromium'),
    findExecutableOnPath('chromium-browser'),
    findExecutableOnPath('chrome'),
    findExecutableOnPath('microsoft-edge')
  ].filter(Boolean);

  const chrome = candidates.find((candidate) => existsSync(candidate));
  assert.ok(
    chrome,
    'Chrome/Chromium executable not found. Set CHROME_BIN=/path/to/chrome to run this browser smoke.'
  );
  return chrome;
};

const spawnManaged = (
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): ManagedProcess => {
  const child = spawn(command, args, {
    cwd: rootDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const managed: ManagedProcess = {
    name,
    process: child,
    logs: [],
    exitCode: null
  };

  const collect = (streamName: 'stdout' | 'stderr', chunk: Buffer) => {
    const text = chunk.toString('utf8');
    managed.logs.push(`[${streamName}] ${text}`);
    if (managed.logs.length > 120) {
      managed.logs.splice(0, managed.logs.length - 120);
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk));
  child.on('exit', (code) => {
    managed.exitCode = code;
  });
  return managed;
};

const assertProcessAlive = (managed: ManagedProcess) => {
  assert.equal(
    managed.exitCode,
    null,
    `${managed.name} exited early with code ${managed.exitCode}\n${truncate(managed.logs.join(''))}`
  );
};

const stopManaged = async (managed: ManagedProcess | null) => {
  if (!managed || managed.process.exitCode !== null || managed.process.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => {
      managed.process.kill('SIGKILL');
      resolveStop();
    }, 3000);
    managed.process.once('exit', () => {
      clearTimeout(timeout);
      resolveStop();
    });
    managed.process.kill('SIGTERM');
  });
};

const readRequestJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
};

const writeJsonResponse = (
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>
) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
};

const startMockWorker = async (port: number): Promise<Server> => {
  const pendingTrainResponses = new Map<string, ServerResponse>();
  const server = createHttpServer((req, res) => {
    void (async () => {
      const path = req.url?.split('?')[0] ?? '';
      if (req.method === 'GET' && (path === '/api/worker/healthz' || path === '/healthz')) {
        writeJsonResponse(res, 200, {
          ok: true,
          worker: {
            runtime_profile: 'yolo',
            worker_version: 'browser-smoke',
            contract_version: 'training-worker-healthz.v1',
            capabilities: ['framework:yolo', 'task:detection']
          }
        });
        return;
      }

      const token = req.headers['x-training-worker-token'];
      const normalizedToken = Array.isArray(token) ? token[0] : token;
      if (normalizedToken !== mockWorkerToken) {
        writeJsonResponse(res, 401, { accepted: false, error: 'invalid training worker token' });
        return;
      }

      if (req.method === 'POST' && path === '/api/worker/train') {
        const body = await readRequestJson(req);
        const jobId = typeof body.job_id === 'string' ? body.job_id : '';
        if (!jobId) {
          writeJsonResponse(res, 400, { accepted: false, error: 'job_id is required' });
          return;
        }
        pendingTrainResponses.set(jobId, res);
        res.on('close', () => {
          pendingTrainResponses.delete(jobId);
        });
        return;
      }

      if (req.method === 'POST' && path === '/api/worker/cancel') {
        const body = await readRequestJson(req);
        const jobId = typeof body.job_id === 'string' ? body.job_id : '';
        const pendingTrain = pendingTrainResponses.get(jobId);
        const hadRunningProcess = Boolean(pendingTrain);
        if (pendingTrain && !pendingTrain.writableEnded) {
          pendingTrain.destroy();
          pendingTrainResponses.delete(jobId);
        }
        writeJsonResponse(res, 200, {
          cancelled: true,
          job_id: jobId,
          had_running_process: hadRunningProcess,
          message: 'cancelled by browser smoke mock worker'
        });
        return;
      }

      writeJsonResponse(res, 404, { ok: false, error: 'not_found' });
    })().catch((error) => {
      writeJsonResponse(res, 500, { ok: false, error: (error as Error).message });
    });
  });

  await new Promise<void>((resolveListen) => {
    server.listen(port, '127.0.0.1', resolveListen);
  });
  return server;
};

const stopHttpServer = async (server: Server | null) => {
  if (!server) {
    return;
  }
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  });
};

const registerMockWorker = async (port: number) => {
  const response = await fetch(`${apiBaseUrl}/api/runtime/training-workers/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Training-Worker-Token': mockWorkerToken
    },
    body: JSON.stringify({
      worker_id: mockWorkerId,
      name: 'browser-next-steps-worker',
      endpoint: `http://127.0.0.1:${port}`,
      status: 'online',
      enabled: true,
      max_concurrency: 2,
      reported_load: 0,
      capabilities: ['framework:yolo', 'task:detection'],
      metadata: {
        source: 'browser_next_steps_smoke'
      }
    })
  });
  const body = (await response.json().catch((error) => ({
    success: false,
    error: { message: String(error) }
  }))) as {
    success?: boolean;
    error?: { message?: string };
  };
  assert.ok(
    response.ok && body.success === true,
    `failed to register mock training worker: ${JSON.stringify(body)}`
  );
};

const fetchJson = async <T>(url: string, timeoutMs = 5000): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
};

const waitForHttp = async (
  url: string,
  label: string,
  processes: ManagedProcess[],
  timeoutMs = 45000
) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    processes.forEach(assertProcessAlive);
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await sleep(350);
  }
  throw new Error(`${label} did not become ready at ${url}: ${lastError}`);
};

class CdpClient {
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
    }
  >();
  private handlers = new Map<string, CdpEventHandler[]>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => this.onMessage(event.data));
    socket.addEventListener('close', () => {
      for (const [, callback] of this.pending) {
        callback.reject(new Error('CDP websocket closed.'));
      }
      this.pending.clear();
    });
  }

  static async connect(webSocketUrl: string): Promise<CdpClient> {
    const socket = new WebSocket(webSocketUrl);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timeout = setTimeout(() => rejectOpen(new Error('Timed out opening CDP websocket.')), 10000);
      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolveOpen();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        rejectOpen(new Error('Failed to open CDP websocket.'));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  private onMessage(raw: unknown) {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8');
    const message = JSON.parse(text) as CdpMessage;
    if (typeof message.id === 'number') {
      const callback = this.pending.get(message.id);
      if (!callback) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        callback.reject(new Error(message.error.message ?? `CDP command failed: ${message.error.code}`));
      } else {
        callback.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      const eventHandlers = this.handlers.get(message.method) ?? [];
      eventHandlers.forEach((handler) => handler(message.params));
    }
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    const result = new Promise<T>((resolveCommand, rejectCommand) => {
      this.pending.set(id, {
        resolve: (value) => resolveCommand(value as T),
        reject: rejectCommand
      });
    });
    this.socket.send(payload);
    return result;
  }

  waitForEvent(method: string, timeoutMs = 15000): Promise<unknown> {
    return new Promise((resolveEvent, rejectEvent) => {
      const timeout = setTimeout(() => {
        rejectEvent(new Error(`Timed out waiting for CDP event ${method}.`));
      }, timeoutMs);
      const handler = (params: unknown) => {
        clearTimeout(timeout);
        const existing = this.handlers.get(method) ?? [];
        this.handlers.set(
          method,
          existing.filter((item) => item !== handler)
        );
        resolveEvent(params);
      };
      this.handlers.set(method, [...(this.handlers.get(method) ?? []), handler]);
    });
  }

  close() {
    this.socket.close();
  }
}

const connectToChromePage = async (debugPort: number): Promise<CdpClient> => {
  type ChromeTarget = {
    type?: string;
    url?: string;
    webSocketDebuggerUrl?: string;
  };

  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, 'Chrome debug endpoint', [], 15000);
  let targets = await fetchJson<ChromeTarget[]>(`http://127.0.0.1:${debugPort}/json/list`);
  let page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  if (!page) {
    await fetch(`http://127.0.0.1:${debugPort}/json/new`, { method: 'PUT' });
    targets = await fetchJson<ChromeTarget[]>(`http://127.0.0.1:${debugPort}/json/list`);
    page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  }

  assert.ok(page?.webSocketDebuggerUrl, 'Chrome did not expose a page target for CDP.');
  const client = await CdpClient.connect(page.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('DOM.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  });
  return client;
};

const evaluate = async <T>(client: CdpClient, expression: string): Promise<T> => {
  const result = await client.send<RuntimeEvaluateResult>('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'Runtime.evaluate failed.'
    );
  }
  return result.result?.value as T;
};

const navigate = async (client: CdpClient, url: string) => {
  const load = client.waitForEvent('Page.loadEventFired', 25000).catch(() => null);
  await client.send('Page.navigate', { url });
  await load;
};

const waitForValue = async <T>(
  client: CdpClient,
  label: string,
  expression: string,
  timeoutMs = 20000
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let lastValue: unknown = null;
  while (Date.now() < deadline) {
    lastValue = await evaluate<unknown>(
      client,
      `(() => { try { return (${expression}); } catch (error) { return { __error: String(error) }; } })()`
    );
    if (
      lastValue &&
      !(typeof lastValue === 'object' && lastValue !== null && '__error' in lastValue)
    ) {
      return lastValue as T;
    }
    await sleep(220);
  }
  const pageText = await evaluate<string>(
    client,
    `(() => (document.body?.innerText || '').slice(-5000))()`
  ).catch(() => '');
  throw new Error(
    `${label} timed out. Last value: ${truncate(JSON.stringify(lastValue))}\nPage text:\n${truncate(pageText, 5000)}`
  );
};

const clickSelector = async (client: CdpClient, selector: string) => {
  const clicked = await evaluate<boolean>(
    client,
    `(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target) return false;
      target.scrollIntoView({ block: 'center', inline: 'center' });
      if (target instanceof HTMLElement) {
        target.click();
        return true;
      }
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    })()`
  );
  assert.ok(clicked, `expected to click selector ${selector}`);
};

const clickButtonContaining = async (client: CdpClient, text: string, rootSelector = 'body') => {
  const clicked = await evaluate<boolean>(
    client,
    `(() => {
      const root = document.querySelector(${JSON.stringify(rootSelector)}) || document.body;
      const target = Array.from(root.querySelectorAll('button, a'))
        .find((element) => {
          const haystack = [
            element.textContent || '',
            element.getAttribute('title') || '',
            element.getAttribute('aria-label') || ''
          ].join('\\n');
          return haystack.includes(${JSON.stringify(text)});
        });
      if (!target) return false;
      target.scrollIntoView({ block: 'center', inline: 'center' });
      if (target instanceof HTMLElement) {
        target.click();
        return true;
      }
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    })()`
  );
  assert.ok(clicked, `expected a button/link containing "${text}"`);
};

const fillTextarea = async (client: CdpClient, selector: string, value: string) => {
  const filled = await evaluate<boolean>(
    client,
    `(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!(target instanceof HTMLTextAreaElement)) return false;
      target.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) {
        setter.call(target, ${JSON.stringify(value)});
      } else {
        target.value = ${JSON.stringify(value)};
      }
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`
  );
  assert.ok(filled, `expected to fill textarea ${selector}`);
};

const captureScreenshot = async (client: CdpClient, filename: string): Promise<string> => {
  const response = await client.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true
  });
  const outputPath = join(reportDir, filename);
  writeFileSync(outputPath, Buffer.from(response.data, 'base64'));
  return outputPath;
};

const loginAsAlice = async (client: CdpClient) => {
  const result = await evaluate<{
    ok: boolean;
    status: number;
    body: {
      success?: boolean;
      error?: { message?: string };
    };
  }>(
    client,
    `fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'mock-pass' })
    }).then(async (response) => ({
      ok: response.ok,
      status: response.status,
      body: await response.json().catch((error) => ({ error: { message: String(error) } }))
    }))`
  );
  assert.ok(result.ok && result.body.success === true, `login failed: ${JSON.stringify(result)}`);
};

const createCancelableTrainingJob = async (client: CdpClient, workerId: string): Promise<string> => {
  const result = await evaluate<{
    ok: boolean;
    status: number;
    body: {
      success?: boolean;
      data?: { id?: string; status?: string };
      error?: { message?: string };
    };
  }>(
    client,
    `(async () => {
      const csrfResponse = await fetch('/api/auth/csrf', { credentials: 'include' });
      const csrfBody = await csrfResponse.json();
      const token = csrfBody?.data?.csrf_token || '';
      const response = await fetch('/api/training/jobs', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': token
        },
        body: JSON.stringify({
          name: 'browser-next-steps-cancel-${timestamp}',
          task_type: 'detection',
          framework: 'yolo',
          dataset_id: 'd-2',
          dataset_version_id: 'dv-2',
          base_model: 'yolo11n',
          execution_target: 'worker',
          worker_id: ${JSON.stringify(workerId)},
          config: {
            epochs: '80',
            batch_size: '1',
            learning_rate: '0.0003'
          }
        })
      });
      return {
        ok: response.ok,
        status: response.status,
        body: await response.json().catch((error) => ({ error: { message: String(error) } }))
      };
    })()`
  );
  const jobId = result.body.data?.id ?? '';
  assert.ok(
    result.ok && result.body.success === true && jobId,
    `failed to create cancelable training job: ${JSON.stringify(result)}`
  );
  return jobId;
};

const probeConversationLayout = async (client: CdpClient): Promise<LayoutProbe> =>
  evaluate<LayoutProbe>(
    client,
    `(() => {
      const cards = Array.from(document.querySelectorAll('.chat-message-action-card'));
      const card = cards.find((item) =>
        (item.textContent || '').includes('Suggested next steps') &&
        (item.textContent || '').includes('Retry on control-plane lane') &&
        (item.textContent || '').includes('Open training logs')
      );
      if (!card) {
        return { ok: false, reason: 'suggested next-step card not found', buttons: [] };
      }
      const rect = card.getBoundingClientRect();
      const buttons = Array.from(card.querySelectorAll('.chat-action-btn')).map((button) => {
        const buttonRect = button.getBoundingClientRect();
        return {
          text: (button.textContent || '').trim(),
          width: Math.round(buttonRect.width),
          height: Math.round(buttonRect.height)
        };
      });
      const badButtons = buttons.filter((button) => button.width < 36 || button.height < 24);
      return {
        ok: rect.width >= 280 && rect.height >= 80 && badButtons.length === 0,
        reason: badButtons.length > 0 ? 'button geometry too small' : '',
        card: { width: Math.round(rect.width), height: Math.round(rect.height) },
        buttons
      };
    })()`
  );

const probeDockLayout = async (client: CdpClient): Promise<LayoutProbe> =>
  evaluate<LayoutProbe>(
    client,
    `(() => {
      const container = document.querySelector('.app-chat-dock-action-next-steps');
      if (!container) {
        return { ok: false, reason: 'dock next-step container not found', buttons: [] };
      }
      const rect = container.getBoundingClientRect();
      const buttons = Array.from(container.querySelectorAll('.app-chat-dock-inline-action')).map((button) => {
        const buttonRect = button.getBoundingClientRect();
        return {
          text: (button.textContent || '').trim(),
          width: Math.round(buttonRect.width),
          height: Math.round(buttonRect.height)
        };
      });
      const badButtons = buttons.filter((button) => button.width < 32 || button.height < 24);
      return {
        ok:
          (container.textContent || '').includes('Suggested next steps') &&
          rect.width >= 220 &&
          rect.height >= 50 &&
          buttons.length > 0 &&
          badButtons.length === 0,
        reason: badButtons.length > 0 ? 'dock button geometry too small' : '',
        card: { width: Math.round(rect.width), height: Math.round(rect.height) },
        buttons
      };
    })()`
  );

const main = async () => {
  mkdirSync(reportDir, { recursive: true });
  await requireFreePort(apiPort, 'API');
  await requireFreePort(webPort, 'Vite');

  const stateDir = mkdtempSync(join(tmpdir(), 'vistral-browser-state-'));
  const chromeProfileDir = mkdtempSync(join(tmpdir(), 'vistral-browser-profile-'));
  const runtimeModelsDir = mkdtempSync(join(tmpdir(), 'vistral-runtime-models-'));
  const chromeDebugPort = await findFreePort(9222, 11000);
  const mockWorkerPort = await findFreePort(19090, 22000);
  const appStatePath = join(stateDir, 'app-state.json');

  let api: ManagedProcess | null = null;
  let vite: ManagedProcess | null = null;
  let chrome: ManagedProcess | null = null;
  let mockWorker: Server | null = null;
  let client: CdpClient | null = null;

  try {
    const smokeEnv = {
      ...process.env,
      API_HOST: '127.0.0.1',
      API_PORT: String(apiPort),
      APP_STATE_STORE_PATH: appStatePath,
      APP_STATE_BOOTSTRAP_MODE: 'full',
      APP_STATE_PERSIST_INTERVAL_MS: '400',
      DEFAULT_USER_PASSWORD: 'mock-pass',
      DEFAULT_ADMIN_PASSWORD: 'mock-pass-admin',
      LLM_CONFIG_SECRET: `browser-smoke-${timestamp}`,
      VISTRAL_RUNTIME_MODELS_ROOT: runtimeModelsDir,
      VISTRAL_RUNTIME_AUTO_POPULATE_LOCAL_COMMANDS: '0',
      VISTRAL_DISABLE_SIMULATED_TRAIN_FALLBACK: '0',
      VISTRAL_DISABLE_INFERENCE_FALLBACK: '0',
      VISTRAL_RUNNER_ENABLE_REAL: '0',
      VISTRAL_AUTO_BOOTSTRAP_YOLO_MODEL: '0',
      VISTRAL_AUTO_BOOTSTRAP_PADDLEOCR_MODELS: '0',
      VISTRAL_AUTO_BOOTSTRAP_DOCTR_MODELS: '0',
      VISTRAL_RUNTIME_BOOTSTRAP_BLOCKING: '0',
      TRAINING_WORKER_SHARED_TOKEN: mockWorkerToken,
      TRAINING_WORKER_DISPATCH_FALLBACK_LOCAL: '0',
      TRAINING_WORKER_DISPATCH_MAX_ATTEMPTS: '1',
      TRAINING_WORKER_DISPATCH_TIMEOUT_MS: '60000'
    };

    api = spawnManaged('api', 'npx', ['tsx', 'backend/src/server.ts'], smokeEnv);
    await waitForHttp(`${apiBaseUrl}/api/health`, 'API', [api], 60000);
    mockWorker = await startMockWorker(mockWorkerPort);
    await registerMockWorker(mockWorkerPort);

    vite = spawnManaged(
      'vite',
      'npx',
      ['vite', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
      {
        ...process.env,
        BROWSER: 'none'
      }
    );
    await waitForHttp(webBaseUrl, 'Vite', [api, vite], 60000);

    const chromeBin = findChrome();
    chrome = spawnManaged('chrome', chromeBin, [
      `--remote-debugging-port=${chromeDebugPort}`,
      `--user-data-dir=${chromeProfileDir}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1440,1000',
      'about:blank'
    ]);
    client = await connectToChromePage(chromeDebugPort);

    await navigate(client, `${webBaseUrl}/workspace/chat`);
    await waitForValue<boolean>(
      client,
      'origin storage access',
      `location.origin === ${JSON.stringify(webBaseUrl)}`,
      10000
    );
    await evaluate<JsonValue>(
      client,
      `(() => {
        localStorage.setItem('vistral-language', 'en-US');
        localStorage.setItem('vistral-app-chat-dock-collapsed', 'false');
        localStorage.setItem('vistral-chat-sidebar-collapsed', 'false');
        return true;
      })()`
    );
    await loginAsAlice(client);

    await navigate(client, `${webBaseUrl}/workspace/chat`);
    await waitForValue<boolean>(
      client,
      'conversation composer',
      `Boolean(document.querySelector('.chat-simple-input:not([disabled])'))`,
      30000
    );

    const jobId = await createCancelableTrainingJob(client, mockWorkerId);
    await fillTextarea(
      client,
      '.chat-simple-input',
      `/ops ${JSON.stringify({ api: 'cancel_training_job', params: { job_id: jobId } })}`
    );
    await waitForValue<boolean>(
      client,
      'enabled conversation send button',
      `Boolean(document.querySelector('.chat-simple-send-btn:not([disabled])'))`,
      10000
    );
    await clickSelector(client, '.chat-simple-send-btn:not([disabled])');

    await waitForValue<boolean>(
      client,
      'cancel confirmation action card',
      `document.body.innerText.includes('High-risk console API call queued (cancel_training_job)') &&
        document.body.innerText.includes('Confirm now')`,
      30000
    );
    await clickButtonContaining(client, 'Confirm now', '.chat-workspace-page');

    await waitForValue<boolean>(
      client,
      'completed cancel card suggested next steps',
      `document.body.innerText.includes('Console API cancel_training_job executed') &&
        document.body.innerText.includes('Suggested next steps') &&
        document.body.innerText.includes('Retry on control-plane lane') &&
        document.body.innerText.includes('Open training logs')`,
      30000
    );

    const conversationLayout = await probeConversationLayout(client);
    assert.ok(
      conversationLayout.ok,
      `conversation next-step layout failed: ${JSON.stringify(conversationLayout)}`
    );
    const chatScreenshot = await captureScreenshot(
      client,
      `conversation-next-steps-browser-chat-${timestamp}.png`
    );

    await clickButtonContaining(client, 'Retry on control-plane lane', '.chat-workspace-page');
    await waitForValue<boolean>(
      client,
      'retry suggested next step stays guarded',
      `document.body.innerText.includes('Suggested next step sent. Confirm if prompted.') ||
        (document.body.innerText.includes('High-risk console API call queued (retry_training_job)') &&
          document.body.innerText.includes('Confirm now'))`,
      30000
    );

    await navigate(client, `${webBaseUrl}/workspace/console`);
    await waitForValue<boolean>(
      client,
      'workbench chat dock loaded',
      `Boolean(document.querySelector('.app-chat-dock:not(.collapsed) .app-chat-dock-body'))`,
      30000
    );
    await waitForValue<boolean>(
      client,
      'dock suggested next steps',
      `Boolean(document.querySelector('.app-chat-dock-action-next-steps')) &&
        document.body.innerText.includes('Suggested next steps')`,
      30000
    );

    const dockLayout = await probeDockLayout(client);
    assert.ok(dockLayout.ok, `dock next-step layout failed: ${JSON.stringify(dockLayout)}`);
    const dockScreenshot = await captureScreenshot(
      client,
      `conversation-next-steps-browser-dock-${timestamp}.png`
    );

    console.log('[smoke-conversation-next-steps-browser] PASS');
    console.log(`[smoke-conversation-next-steps-browser] job_id=${jobId}`);
    console.log(`[smoke-conversation-next-steps-browser] screenshots=${chatScreenshot},${dockScreenshot}`);
  } finally {
    client?.close();
    await stopHttpServer(mockWorker);
    await stopManaged(chrome);
    await stopManaged(vite);
    await stopManaged(api);
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(chromeProfileDir, { recursive: true, force: true });
    rmSync(runtimeModelsDir, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error('[smoke-conversation-next-steps-browser] FAIL');
  console.error((error as Error).stack ?? (error as Error).message);
  process.exitCode = 1;
});
