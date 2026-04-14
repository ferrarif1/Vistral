import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ModelFramework, RuntimeFrameworkConfig } from '../../shared/domain';

export const bundledLocalRunnerCommands: Record<
  ModelFramework,
  {
    train: string;
    predict: string;
  }
> = {
  paddleocr: {
    train:
      '{{python_bin}} {{repo_root}}/scripts/local-runners/paddleocr_train_runner.py --job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} --base-model {{base_model}} --workspace-dir {{workspace_dir}} --config-path {{config_path}} --summary-path {{summary_path}} --metrics-path {{metrics_path}} --artifact-path {{artifact_path}}',
    predict:
      '{{python_bin}} {{repo_root}}/scripts/local-runners/paddleocr_predict_runner.py --model-id {{model_id}} --model-version-id {{model_version_id}} --task-type {{task_type}} --input-path {{input_path}} --filename {{filename}} --model-path {{model_path}} --output-path {{output_path}}'
  },
  doctr: {
    train:
      '{{python_bin}} {{repo_root}}/scripts/local-runners/doctr_train_runner.py --job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} --base-model {{base_model}} --workspace-dir {{workspace_dir}} --config-path {{config_path}} --summary-path {{summary_path}} --metrics-path {{metrics_path}} --artifact-path {{artifact_path}}',
    predict:
      '{{python_bin}} {{repo_root}}/scripts/local-runners/doctr_predict_runner.py --model-id {{model_id}} --model-version-id {{model_version_id}} --task-type {{task_type}} --input-path {{input_path}} --filename {{filename}} --model-path {{model_path}} --output-path {{output_path}}'
  },
  yolo: {
    train:
      '{{python_bin}} {{repo_root}}/scripts/local-runners/yolo_train_runner.py --job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} --base-model {{base_model}} --workspace-dir {{workspace_dir}} --config-path {{config_path}} --summary-path {{summary_path}} --metrics-path {{metrics_path}} --artifact-path {{artifact_path}}',
    predict:
      '{{python_bin}} {{repo_root}}/scripts/local-runners/yolo_predict_runner.py --model-id {{model_id}} --model-version-id {{model_version_id}} --task-type {{task_type}} --input-path {{input_path}} --filename {{filename}} --model-path {{model_path}} --output-path {{output_path}}'
  }
};

const frameworkLocalModelEnvKeys: Record<ModelFramework, string[]> = {
  paddleocr: ['PADDLEOCR_LOCAL_MODEL_PATH'],
  doctr: ['DOCTR_LOCAL_MODEL_PATH'],
  yolo: ['YOLO_LOCAL_MODEL_PATH', 'VISTRAL_YOLO_MODEL_PATH', 'REAL_YOLO_MODEL_PATH']
};

const bundledLocalModelCandidatePaths = (framework: ModelFramework): string[] => {
  if (framework !== 'yolo') {
    return [];
  }

  return [
    path.resolve(process.cwd(), '.data', 'runtime-models', 'yolo11n.pt'),
    path.resolve(process.cwd(), '.data', 'runtime-models', 'yolov8n.pt')
  ];
};

export const resolveBundledLocalModelPath = (framework: ModelFramework): string => {
  const envKeys = frameworkLocalModelEnvKeys[framework] ?? [];
  for (const envKey of envKeys) {
    const value = (process.env[envKey] ?? '').trim();
    if (value) {
      return value;
    }
  }

  const fileCandidate = bundledLocalModelCandidatePaths(framework).find((candidate) => existsSync(candidate));
  return fileCandidate ?? '';
};

const parseRuntimeBoolean = (value: string | undefined, fallback = false): boolean => {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};

export const isRuntimeAutoPopulateLocalCommandsEnabled = (): boolean =>
  parseRuntimeBoolean(process.env.VISTRAL_RUNTIME_AUTO_POPULATE_LOCAL_COMMANDS, true);

export const applyBundledLocalCommandDefaults = (
  framework: ModelFramework,
  config: RuntimeFrameworkConfig
): RuntimeFrameworkConfig => {
  if (!isRuntimeAutoPopulateLocalCommandsEnabled()) {
    return config;
  }

  const templates = bundledLocalRunnerCommands[framework];
  return {
    ...config,
    local_model_path: config.local_model_path.trim() || resolveBundledLocalModelPath(framework),
    local_train_command: config.local_train_command.trim() || templates.train,
    local_predict_command: config.local_predict_command.trim() || templates.predict
  };
};
