import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';

const runtimeBootstrapTimeoutMs = (() => {
  const raw = Number.parseInt(process.env.VISTRAL_RUNTIME_BOOTSTRAP_TIMEOUT_MS ?? '180000', 10);
  if (!Number.isFinite(raw) || raw < 30_000) {
    return 180_000;
  }
  return Math.min(raw, 15 * 60_000);
})();

const parseEnabledFlag = (value: string | undefined, fallback: boolean): boolean => {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(normalized);
};

const isYoloAutoBootstrapEnabled = (): boolean =>
  parseEnabledFlag(process.env.VISTRAL_AUTO_BOOTSTRAP_YOLO_MODEL, true);
const isPaddleOcrAutoBootstrapEnabled = (): boolean =>
  parseEnabledFlag(process.env.VISTRAL_AUTO_BOOTSTRAP_PADDLEOCR_MODELS, true);
const isDoctrAutoBootstrapEnabled = (): boolean =>
  parseEnabledFlag(process.env.VISTRAL_AUTO_BOOTSTRAP_DOCTR_MODELS, true);
const isBlockingRuntimeBootstrapEnabled = (): boolean =>
  parseEnabledFlag(process.env.VISTRAL_RUNTIME_BOOTSTRAP_BLOCKING, false);

const runtimeModelsRoot = path.resolve(
  process.env.VISTRAL_RUNTIME_MODELS_ROOT?.trim() || path.join('.data', 'runtime-models')
);
const runtimeBootstrapMarkerRoot = path.join(runtimeModelsRoot, '.bootstrap-markers');
const bootstrapFrameworks = ['yolo', 'paddleocr', 'doctr'] as const;
type BootstrapFramework = (typeof bootstrapFrameworks)[number];

type BootstrapStatus = {
  ready_at: string | null;
  failure_at: string | null;
  failure_reason: string | null;
};

export type LocalRuntimeBootstrapStatus = Record<BootstrapFramework, BootstrapStatus>;

export type LocalRuntimeBootstrapExpectedAsset = {
  name: string;
  present: boolean;
  byte_size: number | null;
};

export type LocalRuntimeBootstrapAssetSnapshot = {
  framework: 'doctr';
  preseed_dir: string | null;
  expected_files: LocalRuntimeBootstrapExpectedAsset[];
  missing_files: string[];
};

const parseCsvList = (value: string | undefined): string[] => {
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const defaultDoctrPreseedExpectedFiles = ['db_resnet50-79bd7d70.pt', 'vgg16_bn_r-d108c19c.pt'];

const resolveDoctrPreseedDir = (): string =>
  path.resolve(
    process.env.VISTRAL_DOCTR_PRESEEDED_MODELS_DIR?.trim() || path.join(runtimeModelsRoot, 'doctr-preseed')
  );

const resolveDoctrPreseedExpectedFiles = (): string[] => {
  const configured = parseCsvList(process.env.VISTRAL_DOCTR_EXPECTED_MODEL_FILES);
  return configured.length > 0 ? configured : defaultDoctrPreseedExpectedFiles;
};

export const inspectDoctrPreseedAssets = (): LocalRuntimeBootstrapAssetSnapshot => {
  const preseedDir = resolveDoctrPreseedDir();
  const expectedFiles = resolveDoctrPreseedExpectedFiles().map((name) => {
    const filePath = path.join(preseedDir, name);
    if (!existsSync(filePath)) {
      return {
        name,
        present: false,
        byte_size: null
      };
    }

    try {
      const stats = statSync(filePath);
      const isUsable = stats.isFile() && stats.size > 1024;
      return {
        name,
        present: isUsable,
        byte_size: isUsable ? stats.size : null
      };
    } catch {
      return {
        name,
        present: false,
        byte_size: null
      };
    }
  });

  return {
    framework: 'doctr',
    preseed_dir: preseedDir,
    expected_files: expectedFiles,
    missing_files: expectedFiles
      .filter((item) => !item.present)
      .map((item) => item.name)
  };
};

const resolvePythonBin = (): string => {
  const candidates = [
    (process.env.VISTRAL_PYTHON_BIN ?? '').trim(),
    '/opt/vistral-venv/bin/python',
    '/opt/vistral-venv/bin/python3',
    'python3',
    'python'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (candidate.startsWith('/')) {
      if (existsSync(candidate)) {
        return candidate;
      }
      continue;
    }
    return candidate;
  }
  return 'python3';
};

const runPythonInline = async (pythonBin: string, args: string[]): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(pythonBin, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const logs: string[] = [];
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(
        new Error(
          `[runtime-bootstrap] python bootstrap timed out after ${runtimeBootstrapTimeoutMs}ms`
        )
      );
    }, runtimeBootstrapTimeoutMs);

    const collect = (chunk: Buffer | string, stream: 'stdout' | 'stderr') => {
      const lines = chunk
        .toString()
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-200)
        .map((line) => `[${stream}] ${line}`);
      logs.push(...lines);
      for (const line of lines) {
        if (stream === 'stdout') {
          console.log(line);
        } else {
          console.warn(line);
        }
      }
    };

    child.stdout.on('data', (chunk) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(chunk, 'stderr'));
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `[runtime-bootstrap] python spawn failed: ${(error as Error).message}`
        )
      );
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `[runtime-bootstrap] python exited with code ${code ?? 'unknown'}. logs=${logs.slice(-20).join(
            ' | '
          )}`
        )
      );
    });
  });

const bootstrapYoloModelFromModelScope = async (): Promise<void> => {
  const targetPath = path.resolve(
    process.env.YOLO_LOCAL_MODEL_PATH?.trim() || path.join(runtimeModelsRoot, 'yolo11n.pt')
  );
  if (existsSync(targetPath)) {
    console.log(`[runtime-bootstrap] YOLO model already exists: ${targetPath}`);
    writeBootstrapMarker('yolo', {
      python_bin: 'existing_local_model',
      source: 'runtime_bootstrap',
      model_path: targetPath,
      reused_existing: true
    });
    return;
  }

  const pythonBin = resolvePythonBin();
  const cacheDir = path.resolve(path.join(runtimeModelsRoot, '.modelscope-cache'));
  const script = [
    'import os, shutil, sys',
    'target = sys.argv[1]',
    'cache_dir = sys.argv[2]',
    'os.makedirs(os.path.dirname(target), exist_ok=True)',
    'if os.path.exists(target) and os.path.getsize(target) > 1024:',
    '    print(f"target_exists:{target}")',
    '    raise SystemExit(0)',
    'from modelscope.hub.file_download import model_file_download',
    'downloaded = model_file_download("ultralytics/YOLO11", "yolo11n.pt", cache_dir=cache_dir)',
    'if not downloaded or not os.path.exists(downloaded):',
    '    raise RuntimeError("modelscope_download_failed")',
    'shutil.copy2(downloaded, target)',
    'print(f"target_ready:{target}:{os.path.getsize(target)}")'
  ].join('\n');
  await runPythonInline(pythonBin, ['-c', script, targetPath, cacheDir]);
  writeBootstrapMarker('yolo', {
    python_bin: pythonBin,
    source: 'runtime_bootstrap',
    model_path: targetPath,
    reused_existing: false
  });
};

const resolveBootstrapMarkerPath = (name: BootstrapFramework): string =>
  path.resolve(path.join(runtimeBootstrapMarkerRoot, `${name}.ready.json`));

const resolveBootstrapFailureMarkerPath = (name: BootstrapFramework): string =>
  path.resolve(path.join(runtimeBootstrapMarkerRoot, `${name}.last-failure.json`));

const hasBootstrapMarker = (name: BootstrapFramework): boolean => existsSync(resolveBootstrapMarkerPath(name));

const trimFailureReason = (value: string): string => {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length <= 1600) {
    return normalized;
  }
  return `${normalized.slice(0, 1600)}...(truncated)`;
};

const writeBootstrapMarker = (
  name: BootstrapFramework,
  details: Record<string, string | number | boolean>
) => {
  mkdirSync(runtimeBootstrapMarkerRoot, { recursive: true });
  const payload = {
    name,
    ready_at: new Date().toISOString(),
    ...details
  };
  writeFileSync(resolveBootstrapMarkerPath(name), JSON.stringify(payload, null, 2), 'utf8');
};

const writeBootstrapFailureMarker = (name: BootstrapFramework, reason: string) => {
  mkdirSync(runtimeBootstrapMarkerRoot, { recursive: true });
  const payload = {
    name,
    failed_at: new Date().toISOString(),
    reason: trimFailureReason(reason)
  };
  writeFileSync(resolveBootstrapFailureMarkerPath(name), JSON.stringify(payload, null, 2), 'utf8');
};

const clearBootstrapFailureMarker = (name: BootstrapFramework) => {
  const markerPath = resolveBootstrapFailureMarkerPath(name);
  if (!existsSync(markerPath)) {
    return;
  }
  try {
    unlinkSync(markerPath);
  } catch {
    // ignore marker cleanup failure
  }
};

const readJsonObjectFile = (filePath: string): Record<string, unknown> | null => {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const content = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed marker file
  }
  return null;
};

export const readLocalRuntimeBootstrapStatus = (): LocalRuntimeBootstrapStatus => {
  const status = Object.fromEntries(
    bootstrapFrameworks.map((name) => [
      name,
      {
        ready_at: null,
        failure_at: null,
        failure_reason: null
      } satisfies BootstrapStatus
    ])
  ) as LocalRuntimeBootstrapStatus;

  for (const name of bootstrapFrameworks) {
    const readyMarker = readJsonObjectFile(resolveBootstrapMarkerPath(name));
    const failureMarker = readJsonObjectFile(resolveBootstrapFailureMarkerPath(name));
    status[name] = {
      ready_at: typeof readyMarker?.ready_at === 'string' ? readyMarker.ready_at : null,
      failure_at: typeof failureMarker?.failed_at === 'string' ? failureMarker.failed_at : null,
      failure_reason: typeof failureMarker?.reason === 'string' ? failureMarker.reason : null
    };
  }
  return status;
};

const bootstrapPaddleOcrModels = async (): Promise<void> => {
  if (hasBootstrapMarker('paddleocr')) {
    console.log('[runtime-bootstrap] PaddleOCR bootstrap marker exists, skip warmup.');
    return;
  }

  const pythonBin = resolvePythonBin();
  const script = [
    'import os',
    'lang = (os.getenv("VISTRAL_PADDLEOCR_LANG", "ch") or "ch").strip() or "ch"',
    'use_gpu = (os.getenv("VISTRAL_PADDLEOCR_USE_GPU", "0") or "0").strip() == "1"',
    'from paddleocr import PaddleOCR',
    'attempts = [',
    '  {"use_textline_orientation": True, "lang": lang, "device": "gpu" if use_gpu else "cpu", "show_log": False},',
    '  {"use_angle_cls": True, "lang": lang, "device": "gpu" if use_gpu else "cpu", "show_log": False},',
    '  {"lang": lang, "device": "gpu" if use_gpu else "cpu", "show_log": False},',
    '  {"use_textline_orientation": True, "lang": lang, "use_gpu": use_gpu, "show_log": False},',
    '  {"use_angle_cls": True, "lang": lang, "use_gpu": use_gpu, "show_log": False},',
    '  {"use_angle_cls": True, "lang": lang, "use_gpu": use_gpu},',
    '  {"use_angle_cls": True, "lang": lang, "show_log": False},',
    '  {"lang": lang, "show_log": False},',
    '  {"use_angle_cls": True, "lang": lang},',
    '  {"lang": lang, "use_gpu": use_gpu},',
    '  {"lang": lang}',
    ']',
    'last_error = None',
    'for kwargs in attempts:',
    '  try:',
    '    PaddleOCR(**kwargs)',
    '    print(f"paddleocr_ready:{lang}:gpu={int(use_gpu)}")',
    '    raise SystemExit(0)',
    '  except Exception as exc:',
    '    last_error = exc',
    'if last_error is None:',
    '  raise RuntimeError("paddleocr_warmup_failed_without_error")',
    'raise last_error',
  ].join('\n');
  await runPythonInline(pythonBin, ['-c', script]);
  writeBootstrapMarker('paddleocr', {
    python_bin: pythonBin,
    source: 'runtime_bootstrap'
  });
};

const bootstrapDoctrModels = async (): Promise<void> => {
  if (hasBootstrapMarker('doctr')) {
    console.log('[runtime-bootstrap] docTR bootstrap marker exists, skip warmup.');
    return;
  }

  const doctrCacheModelsDir = path.resolve(
    path.join(process.env.DOCTR_CACHE_DIR?.trim() || path.join(runtimeModelsRoot, 'doctr-cache'), 'models')
  );
  const cleanupDoctrPartialCacheArtifacts = () => {
    if (!existsSync(doctrCacheModelsDir)) {
      return;
    }
    for (const entry of readdirSync(doctrCacheModelsDir)) {
      const filePath = path.join(doctrCacheModelsDir, entry);
      try {
        const fileStats = statSync(filePath);
        if (!fileStats.isFile()) {
          continue;
        }
        if (fileStats.size > 1024) {
          continue;
        }
        if (!entry.endsWith('.pt') && !entry.endsWith('.zip') && !entry.endsWith('.bin')) {
          continue;
        }
        unlinkSync(filePath);
        console.warn(`[runtime-bootstrap] Removed partial docTR cache artifact: ${filePath}`);
      } catch {
        // ignore corrupted file metadata and continue bootstrap
      }
    }
  };

  const preseedDoctrModelArtifactsFromDir = () => {
    const sourceDir = resolveDoctrPreseedDir();
    if (!existsSync(sourceDir)) {
      return;
    }
    mkdirSync(doctrCacheModelsDir, { recursive: true });
    const copiedFiles: string[] = [];
    for (const entry of readdirSync(sourceDir)) {
      const sourcePath = path.join(sourceDir, entry);
      try {
        const sourceStats = statSync(sourcePath);
        if (!sourceStats.isFile()) {
          continue;
        }
        if (sourceStats.size <= 1024) {
          continue;
        }
        if (!entry.endsWith('.pt') && !entry.endsWith('.zip') && !entry.endsWith('.bin')) {
          continue;
        }
        const targetPath = path.join(doctrCacheModelsDir, entry);
        let shouldCopy = true;
        if (existsSync(targetPath)) {
          const targetStats = statSync(targetPath);
          if (targetStats.isFile() && targetStats.size > 1024) {
            shouldCopy = false;
          }
        }
        if (shouldCopy) {
          copyFileSync(sourcePath, targetPath);
          copiedFiles.push(entry);
        }
      } catch {
        // ignore preseed source read/copy failure and continue.
      }
    }
    if (copiedFiles.length > 0) {
      console.log(
        `[runtime-bootstrap] docTR preseed copied ${copiedFiles.length} model artifact(s) from ${sourceDir}.`
      );
    }
  };

  const pythonBin = resolvePythonBin();
  cleanupDoctrPartialCacheArtifacts();
  preseedDoctrModelArtifactsFromDir();

  const preseedUrls = parseCsvList(process.env.VISTRAL_DOCTR_PRESEEDED_MODELS_URLS);
  if (preseedUrls.length > 0) {
    mkdirSync(doctrCacheModelsDir, { recursive: true });
    const preseedScript = [
      'import os, sys, urllib.parse, urllib.request',
      'target_dir = sys.argv[1]',
      'urls = sys.argv[2:]',
      'os.makedirs(target_dir, exist_ok=True)',
      'copied = 0',
      'for raw_url in urls:',
      '  url = (raw_url or "").strip()',
      '  if not url:',
      '    continue',
      '  parsed = urllib.parse.urlparse(url)',
      '  name = os.path.basename(parsed.path or "")',
      '  if not name:',
      '    continue',
      '  if not (name.endswith(".pt") or name.endswith(".zip") or name.endswith(".bin")):',
      '    continue',
      '  target_path = os.path.join(target_dir, name)',
      '  if os.path.exists(target_path) and os.path.getsize(target_path) > 1024:',
      '    continue',
      '  tmp_path = target_path + ".part"',
      '  try:',
      '    with urllib.request.urlopen(url, timeout=120) as response:',
      '      with open(tmp_path, "wb") as fp:',
      '        fp.write(response.read())',
      '    if os.path.getsize(tmp_path) <= 1024:',
      '      raise RuntimeError(f"download_too_small:{url}")',
      '    os.replace(tmp_path, target_path)',
      '    copied += 1',
      '    print(f"doctr_preseed_downloaded:{name}:{os.path.getsize(target_path)}")',
      '  finally:',
      '    if os.path.exists(tmp_path):',
      '      try:',
      '        os.remove(tmp_path)',
      '      except Exception:',
      '        pass',
      'print(f"doctr_preseed_download_count:{copied}")'
    ].join('\n');
    try {
      await runPythonInline(pythonBin, ['-c', preseedScript, doctrCacheModelsDir, ...preseedUrls]);
    } catch (error) {
      console.warn(
        `[runtime-bootstrap] docTR preseed URL download skipped: ${(error as Error).message}`
      );
    }
    cleanupDoctrPartialCacheArtifacts();
  }

  const script = [
    'import os',
    'detector = (os.getenv("VISTRAL_DOCTR_DET_ARCH", "db_resnet50") or "db_resnet50").strip() or "db_resnet50"',
    'recognizer = (os.getenv("VISTRAL_DOCTR_RECO_ARCH", "crnn_vgg16_bn") or "crnn_vgg16_bn").strip() or "crnn_vgg16_bn"',
    'from doctr.models import ocr_predictor',
    'ocr_predictor(det_arch=detector, reco_arch=recognizer, pretrained=True)',
    'print(f"doctr_ready:{detector}:{recognizer}")',
  ].join('\n');
  try {
    await runPythonInline(pythonBin, ['-c', script]);
  } catch (error) {
    cleanupDoctrPartialCacheArtifacts();
    throw error;
  }
  writeBootstrapMarker('doctr', {
    python_bin: pythonBin,
    source: 'runtime_bootstrap'
  });
};

export const bootstrapLocalRuntimeAssets = async (): Promise<void> => {
  mkdirSync(runtimeModelsRoot, { recursive: true });
  mkdirSync(runtimeBootstrapMarkerRoot, { recursive: true });

  const tasks: Array<{ id: BootstrapFramework; name: string; run: () => Promise<void> }> = [];
  if (isYoloAutoBootstrapEnabled()) {
    tasks.push({ id: 'yolo', name: 'YOLO', run: bootstrapYoloModelFromModelScope });
  } else {
    console.log('[runtime-bootstrap] YOLO auto bootstrap disabled.');
  }

  if (isPaddleOcrAutoBootstrapEnabled()) {
    tasks.push({ id: 'paddleocr', name: 'PaddleOCR', run: bootstrapPaddleOcrModels });
  } else {
    console.log('[runtime-bootstrap] PaddleOCR auto bootstrap disabled.');
  }

  if (isDoctrAutoBootstrapEnabled()) {
    tasks.push({ id: 'doctr', name: 'docTR', run: bootstrapDoctrModels });
  } else {
    console.log('[runtime-bootstrap] docTR auto bootstrap disabled.');
  }

  const runBootstrapTasks = async () => {
    for (const task of tasks) {
      try {
        await task.run();
        clearBootstrapFailureMarker(task.id);
      } catch (error) {
        const reason =
          error instanceof Error && error.message.trim()
            ? error.message
            : String(error ?? 'unknown runtime bootstrap error');
        writeBootstrapFailureMarker(task.id, reason);
        console.warn(
          `[runtime-bootstrap] ${task.name} auto bootstrap skipped: ${reason}`
        );
      }
    }
  };

  if (isBlockingRuntimeBootstrapEnabled()) {
    await runBootstrapTasks();
    return;
  }

  if (tasks.length > 0) {
    console.log('[runtime-bootstrap] non-blocking bootstrap enabled; runtime warmup runs in background.');
    setTimeout(() => {
      void runBootstrapTasks();
    }, 0);
  }
};
