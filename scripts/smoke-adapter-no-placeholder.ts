import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const tmpRoot = path.resolve(rootDir, '.data', 'smoke-adapter-no-placeholder');
const trainingRoot = path.join(tmpRoot, 'training-jobs');
const exportRoot = path.join(tmpRoot, 'model-exports');
const jobId = 'tj-adapter-metrics';
const workspaceDir = path.join(trainingRoot, jobId);

const cleanup = async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
};

const writeJson = async (targetPath: string, payload: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, JSON.stringify(payload, null, 2), 'utf8');
};

const run = async () => {
  await cleanup();
  await fs.mkdir(workspaceDir, { recursive: true });

  process.env.TRAINING_WORKDIR_ROOT = trainingRoot;
  process.env.MODEL_EXPORT_ROOT = exportRoot;
  process.env.PADDLEOCR_RUNTIME_ENDPOINT = '';
  process.env.DOCTR_RUNTIME_ENDPOINT = '';
  process.env.YOLO_RUNTIME_ENDPOINT = '';
  process.env.VISTRAL_DISABLE_INFERENCE_FALLBACK = '0';
  process.env.PADDLEOCR_LOCAL_PREDICT_COMMAND = "python3 __missing_runner_for_smoke__.py";
  process.env.YOLO_LOCAL_PREDICT_COMMAND = "python3 __missing_runner_for_smoke__.py";

  const metricsPath = path.join(workspaceDir, 'metrics.json');
  await writeJson(metricsPath, {
    summary: {
      map: 0.8123,
      precision: 0.8741,
      recall: 0.7964
    },
    metric_series: [
      { step: 1, metrics: { map: 0.6, precision: 0.7, recall: 0.61 } },
      { step: 2, metrics: { map: 0.75, precision: 0.82, recall: 0.73 } },
      { step: 3, metrics: { map: 0.8123, precision: 0.8741, recall: 0.7964 } }
    ]
  });

  const modelFile = path.join(tmpRoot, 'models', 'yolo', 'weights.pt');
  await fs.mkdir(path.dirname(modelFile), { recursive: true });
  await fs.writeFile(modelFile, 'mock-model-bytes', 'utf8');
  const inputFile = path.join(tmpRoot, 'inputs', 'sample.txt');
  await fs.mkdir(path.dirname(inputFile), { recursive: true });
  await fs.writeFile(inputFile, 'SMOKE_OCR_SAMPLE_LINE', 'utf8');

  const { getTrainerByFramework } = await import('../backend/src/runtimeAdapters');
  const yoloTrainer = getTrainerByFramework('yolo');
  const ocrTrainer = getTrainerByFramework('paddleocr');

  const evaluated = await yoloTrainer.evaluate({ trainingJobId: jobId });
  assert.equal(typeof evaluated.metrics, 'object');
  assert.equal(evaluated.metrics.map, 0.8123);
  assert.equal(evaluated.metrics.precision, 0.8741);
  assert.equal(evaluated.metrics.recall, 0.7964);

  const emptyEval = await yoloTrainer.evaluate({ trainingJobId: 'tj-adapter-empty' });
  assert.deepEqual(emptyEval.metrics, {});

  const exported = await yoloTrainer.export({
    modelVersionId: 'mv-adapter-export',
    modelArtifactPath: modelFile
  });
  assert.ok(exported.artifactPath);
  assert.ok(!exported.artifactPath.includes('/mock-artifacts/'));
  const exportedStats = await fs.stat(exported.artifactPath);
  assert.ok(exportedStats.isFile());

  const loaded = await yoloTrainer.load_model({
    modelVersionId: 'mv-adapter-export',
    modelArtifactPath: modelFile
  });
  assert.ok(loaded.handle.startsWith('local_file:'));

  let missingLoadFailed = false;
  try {
    await yoloTrainer.load_model({
      modelVersionId: 'mv-adapter-missing',
      modelArtifactPath: path.join(tmpRoot, 'models', 'missing.pt')
    });
  } catch {
    missingLoadFailed = true;
  }
  assert.equal(missingLoadFailed, true);

  const yoloFallbackPredict = await yoloTrainer.predict({
    modelId: 'm-smoke',
    modelVersionId: 'mv-smoke-yolo',
    inputAttachmentId: 'f-smoke',
    filename: 'sample.jpg',
    taskType: 'detection',
    inputMimeType: 'image/jpeg',
    inputStoragePath: inputFile,
    modelArtifactPath: modelFile
  });
  assert.equal(
    yoloFallbackPredict.normalized_output.source,
    'explicit_fallback_local_command_failed'
  );
  assert.equal(
    Array.isArray(yoloFallbackPredict.boxes) && yoloFallbackPredict.boxes.length === 0,
    true
  );
  assert.equal(
    typeof yoloFallbackPredict.raw_output.local_command_fallback_reason === 'string',
    true
  );
  assert.equal(
    typeof yoloFallbackPredict.raw_output.attempted_command === 'string',
    true
  );

  const ocrFallbackPredict = await ocrTrainer.predict({
    modelId: 'm-smoke',
    modelVersionId: 'mv-smoke-ocr',
    inputAttachmentId: 'f-smoke-ocr',
    filename: 'sample.txt',
    taskType: 'ocr',
    inputMimeType: 'text/plain',
    inputStoragePath: inputFile,
    modelArtifactPath: modelFile
  });
  assert.equal(
    ocrFallbackPredict.normalized_output.source,
    'explicit_fallback_local_command_failed'
  );
  assert.deepEqual(ocrFallbackPredict.ocr.lines, []);
  assert.deepEqual(ocrFallbackPredict.ocr.words, []);
  const ocrSerialized = JSON.stringify(ocrFallbackPredict);
  assert.equal(ocrSerialized.includes('Invoice No.'), false);
  assert.equal(ocrSerialized.includes('Total: 458.30'), false);

  console.log('[smoke-adapter-no-placeholder] PASS');
  console.log(
    JSON.stringify(
      {
        evaluated_metrics: evaluated.metrics,
        export_path: exported.artifactPath,
        load_handle: loaded.handle,
        yolo_predict_source: yoloFallbackPredict.normalized_output.source,
        ocr_predict_source: ocrFallbackPredict.normalized_output.source
      },
      null,
      2
    )
  );
};

run()
  .catch((error) => {
    console.error(
      '[smoke-adapter-no-placeholder] failed:',
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });
