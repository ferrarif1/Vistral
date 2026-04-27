import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

type ManagedProcess = {
  name: string;
  process: ReturnType<typeof spawn>;
  logs: string[];
  exitCode: number | null;
};

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

type CdpEventHandler = (params: unknown) => void;

const sleep = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const truncate = (value: string, max = 1600): string =>
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
    if (managed.logs.length > 160) {
      managed.logs.splice(0, managed.logs.length - 160);
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
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timeout);
          resolveOpen();
        },
        { once: true }
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timeout);
          rejectOpen(new Error('Failed to open CDP websocket.'));
        },
        { once: true }
      );
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
    webSocketDebuggerUrl?: string;
  };

  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, 'Chrome debug endpoint', [], 15000);
  let targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as ChromeTarget[];
  let page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  if (!page) {
    await fetch(`http://127.0.0.1:${debugPort}/json/new`, { method: 'PUT' });
    targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as ChromeTarget[];
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
      const target = Array.from(root.querySelectorAll('button, a')).find((element) => {
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

const createTrainingJob = async (client: CdpClient): Promise<string> => {
  const result = await evaluate<{
    ok: boolean;
    status: number;
    body: {
      success?: boolean;
      data?: { id?: string };
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
          name: 'browser-training-cockpit-${timestamp}',
          task_type: 'detection',
          framework: 'yolo',
          dataset_id: 'd-2',
          dataset_version_id: 'dv-2',
          base_model: 'yolo11n',
          execution_target: 'local',
          config: {
            epochs: '40',
            batch_size: '4',
            learning_rate: '0.0004'
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
  assert.ok(result.ok && result.body.success === true && jobId, `failed to create training job: ${JSON.stringify(result)}`);
  return jobId;
};

const assertCockpitSections = async (client: CdpClient) => {
  const sections = await evaluate<Record<string, boolean>>(
    client,
    `(() => ({
      page: Boolean(document.querySelector('[data-testid="training-cockpit-page"]')),
      overview: Boolean(document.querySelector('[data-testid="training-cockpit-overview"]')),
      stages: Boolean(document.querySelector('[data-testid="training-cockpit-stage-rail"]')),
      metrics: Boolean(document.querySelector('[data-testid="training-cockpit-metrics"]')),
      resources: Boolean(document.querySelector('[data-testid="training-cockpit-resources"]')),
      tuning: Boolean(document.querySelector('[data-testid="training-cockpit-tuning"]')),
      events: Boolean(document.querySelector('[data-testid="training-cockpit-events"]'))
    }))()`
  );
  assert.deepEqual(sections, {
    page: true,
    overview: true,
    stages: true,
    metrics: true,
    resources: true,
    tuning: true,
    events: true
  });
};

const assertDemoControls = async (client: CdpClient) => {
  const controls = await evaluate<Record<string, boolean | string>>(
    client,
    `(() => ({
      live: Boolean(document.querySelector('[data-testid="training-cockpit-mode-live"]')),
      demo: Boolean(document.querySelector('[data-testid="training-cockpit-mode-demo"]')),
      toggle: Boolean(document.querySelector('[data-testid="training-cockpit-demo-play-toggle"]')),
      replay: Boolean(document.querySelector('[data-testid="training-cockpit-demo-replay"]')),
      speed1: Boolean(document.querySelector('[data-testid="training-cockpit-demo-speed-1"]')),
      speed2: Boolean(document.querySelector('[data-testid="training-cockpit-demo-speed-2"]')),
      speed4: Boolean(document.querySelector('[data-testid="training-cockpit-demo-speed-4"]')),
      body: document.body?.innerText || ''
    }))()`
  );
  assert.equal(controls.live, true);
  assert.equal(controls.demo, true);
  assert.equal(controls.toggle, true);
  assert.equal(controls.replay, true);
  assert.equal(controls.speed1, true);
  assert.equal(controls.speed2, true);
  assert.equal(controls.speed4, true);
  assert.ok(
    String(controls.body).includes('Demo playing') ||
      String(controls.body).includes('Demo paused') ||
      String(controls.body).includes('Demo finished'),
    'demo playback state badge not found'
  );
};

const assertNoHorizontalOverflow = async (client: CdpClient) => {
  const probe = await evaluate<{ ok: boolean; scrollWidth: number; innerWidth: number }>(
    client,
    `(() => ({
      ok: document.documentElement.scrollWidth <= window.innerWidth + 4,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth
    }))()`
  );
  assert.ok(
    probe.ok,
    `expected no horizontal overflow in mobile cockpit view: ${JSON.stringify(probe)}`
  );
};

const main = async () => {
  mkdirSync(reportDir, { recursive: true });
  await requireFreePort(apiPort, 'API');
  await requireFreePort(webPort, 'Vite');

  const stateDir = mkdtempSync(join(tmpdir(), 'vistral-browser-state-'));
  const chromeProfileDir = mkdtempSync(join(tmpdir(), 'vistral-browser-profile-'));
  const runtimeModelsDir = mkdtempSync(join(tmpdir(), 'vistral-runtime-models-'));
  const appStatePath = join(stateDir, 'app-state.json');
  const chromeDebugPort = await findFreePort(9223, 11223);

  let api: ManagedProcess | null = null;
  let vite: ManagedProcess | null = null;
  let chrome: ManagedProcess | null = null;
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
      LLM_CONFIG_SECRET: `browser-cockpit-${timestamp}`,
      VISTRAL_RUNTIME_MODELS_ROOT: runtimeModelsDir,
      VISTRAL_RUNTIME_AUTO_POPULATE_LOCAL_COMMANDS: '0',
      VISTRAL_DISABLE_SIMULATED_TRAIN_FALLBACK: '0',
      VISTRAL_DISABLE_INFERENCE_FALLBACK: '0',
      VISTRAL_RUNNER_ENABLE_REAL: '0',
      VISTRAL_AUTO_BOOTSTRAP_YOLO_MODEL: '0',
      VISTRAL_AUTO_BOOTSTRAP_PADDLEOCR_MODELS: '0',
      VISTRAL_AUTO_BOOTSTRAP_DOCTR_MODELS: '0',
      VISTRAL_RUNTIME_BOOTSTRAP_BLOCKING: '0'
    };

    api = spawnManaged('api', 'npx', ['tsx', 'backend/src/server.ts'], smokeEnv);
    await waitForHttp(`${apiBaseUrl}/api/health`, 'API', [api], 60000);

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
    await evaluate<boolean>(
      client,
      `(() => {
        localStorage.setItem('vistral-language', 'en-US');
        return true;
      })()`
    );
    await loginAsAlice(client);

    const jobId = await createTrainingJob(client);

    await navigate(client, `${webBaseUrl}/training/jobs`);
    await waitForValue<boolean>(
      client,
      'training jobs list with cockpit action',
      `document.body.innerText.includes(${JSON.stringify(jobId)}) &&
        document.body.innerText.includes('Open cockpit')`,
      30000
    );
    await clickButtonContaining(client, 'Open cockpit', 'body');

    await waitForValue<boolean>(
      client,
      'cockpit page',
      `Boolean(document.querySelector('[data-testid="training-cockpit-page"]'))`,
      30000
    );
    await assertCockpitSections(client);
    await waitForValue<boolean>(
      client,
      'live empty-state copy',
      `document.body.innerText.includes('No resource telemetry yet') &&
        document.body.innerText.includes('No live tuning stream yet')`,
      15000
    );
    const liveScreenshot = await captureScreenshot(
      client,
      `training-cockpit-browser-live-${timestamp}.png`
    );

    await clickButtonContaining(client, 'Job detail', 'body');
    await waitForValue<boolean>(
      client,
      'training job detail',
      `document.body.innerText.includes('Open cockpit') &&
        document.body.innerText.includes(${JSON.stringify(jobId)})`,
      30000
    );
    await clickButtonContaining(client, 'Open cockpit', 'body');

    await waitForValue<boolean>(
      client,
      'cockpit page from detail',
      `Boolean(document.querySelector('[data-testid="training-cockpit-page"]')) &&
        document.body.innerText.includes('Demo mode')`,
      30000
    );
    await clickSelector(client, '[data-testid="training-cockpit-mode-demo"]');
    await waitForValue<boolean>(
      client,
      'demo controls',
      `Boolean(document.querySelector('[data-testid="training-cockpit-demo-play-toggle"]'))`,
      15000
    );
    await assertDemoControls(client);
    await clickSelector(client, '[data-testid="training-cockpit-demo-speed-4"]');
    await clickSelector(client, '[data-testid="training-cockpit-demo-play-toggle"]');
    await waitForValue<boolean>(
      client,
      'demo paused state',
      `document.body.innerText.includes('Demo paused') || document.body.innerText.includes('Play')`,
      8000
    );
    await clickSelector(client, '[data-testid="training-cockpit-demo-replay"]');
    await waitForValue<boolean>(
      client,
      'demo replay running',
      `document.body.innerText.includes('Demo playing')`,
      10000
    );
    const demoScreenshot = await captureScreenshot(
      client,
      `training-cockpit-browser-demo-${timestamp}.png`
    );

    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });
    await sleep(600);
    await assertNoHorizontalOverflow(client);

    console.log('[smoke-training-cockpit-browser] PASS');
    console.log(`[smoke-training-cockpit-browser] job_id=${jobId}`);
    console.log(`[smoke-training-cockpit-browser] screenshots=${liveScreenshot},${demoScreenshot}`);
  } finally {
    client?.close();
    await stopManaged(chrome);
    await stopManaged(vite);
    await stopManaged(api);
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(chromeProfileDir, { recursive: true, force: true });
    rmSync(runtimeModelsDir, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error('[smoke-training-cockpit-browser] FAIL');
  console.error((error as Error).stack ?? (error as Error).message);
  process.exitCode = 1;
});
