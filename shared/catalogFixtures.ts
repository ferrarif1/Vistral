import type {
  DatasetRecord,
  ModelRecord,
  ModelVersionRecord,
  TrainingJobRecord
} from './domain';

const curatedFoundationModelNames = new Set(['Road Damage Detector', 'Invoice OCR Assistant']);
const retiredSeedModelNames = new Set(['Factory PPE Checker']);

const modelFixtureNamePatterns = [
  /^conversation-smoke-model-\d+$/i,
  /^analyze further:\s*模型草稿已创建：.+$/i,
  /^testmodels?\s*类型：ocr$/i,
  /^对话烟测模型$/i,
  /^doctr-phase2-smoke-model$/i,
  /^doctr-runtime-success-model$/i,
  /^ocr-closure-(?:doctr|paddle)-model$/i,
  /^real-(?:yolo|doctr)-model-\d+$/i,
  /^verify-model-[\w-]+$/i
];

const datasetFixtureNamePatterns = [
  /^conversation-smoke-dataset-\d+$/i,
  /^attachment-smoke-dataset$/i,
  /^conversation-training-target-\d+$/i,
  /^coverage gate smoke$/i,
  /^feedback-(?:ocr|detection)-target-\d+$/i,
  /^ocr-closure-\d+$/i,
  /^verify-feedback-reuse-\d{14}$/i,
  /^version mismatch smoke$/i,
  /^segmentation smoke$/i,
  /^对话烟测数据集$/i,
  /^real-det-\d+$/i,
  /^roundtrip-/i,
  /^persist-check-ds$/i,
  /^import-ref-test$/i,
  /^demo train dataset\b/i
];

const trainingJobFixtureNamePatterns = [
  /^conversation-smoke-job-\d+$/i,
  /^doctr-smoke-job$/i,
  /^doctr-runtime-success$/i,
  /^ocr-closure-(?:doctr|paddle)$/i,
  /^real-(?:yolo|doctr)-job-\d+$/i,
  /^local-command-yolo$/i,
  /^restart-resume-yolo$/i
];

const modelVersionFixtureNamePatterns = [
  /^doctr-smoke-v\d+$/i,
  /^doctr-runtime-v\d+$/i,
  /^ocr-closure-(?:doctr|paddle)-v\d+$/i,
  /^real-(?:yolo|doctr)-v\d+$/i
];

const attachmentFixtureNamePatterns = [
  /^conversation-smoke\./i,
  /^roundtrip-/i,
  /^demo-train-/i,
  /^verify-/i,
  /^import-ref-/i,
  /^ocr-sample\.txt$/i,
  /^vistral-ocr-sample\.png$/i,
  /^6200_104_0_jpg\.rf\.[a-z0-9]+\.(?:jpg|jpeg)$/i
];

const matchesAnyPattern = (value: string, patterns: RegExp[]): boolean => {
  const normalized = value.trim();
  return normalized.length > 0 && patterns.some((pattern) => pattern.test(normalized));
};

export const isCuratedFoundationModelName = (name: string): boolean =>
  curatedFoundationModelNames.has(name.trim());

export const isFixtureModelRecord = (model: Pick<ModelRecord, 'name'>): boolean =>
  retiredSeedModelNames.has(model.name.trim()) || matchesAnyPattern(model.name, modelFixtureNamePatterns);

export const isFixtureDatasetRecord = (dataset: Pick<DatasetRecord, 'name'>): boolean =>
  matchesAnyPattern(dataset.name, datasetFixtureNamePatterns);

export const isFixtureTrainingJobRecord = (job: Pick<TrainingJobRecord, 'name'>): boolean =>
  matchesAnyPattern(job.name, trainingJobFixtureNamePatterns);

export const isFixtureModelVersionRecord = (
  version: Pick<ModelVersionRecord, 'version_name'>
): boolean => matchesAnyPattern(version.version_name, modelVersionFixtureNamePatterns);

export const isFixtureAttachmentFilename = (filename: string): boolean =>
  matchesAnyPattern(filename, attachmentFixtureNamePatterns);

export const filterVisibleModels = <T extends Pick<ModelRecord, 'name'>>(models: T[]): T[] =>
  models.filter((model) => !isFixtureModelRecord(model));

export const filterVisibleDatasets = <T extends Pick<DatasetRecord, 'name'>>(datasets: T[]): T[] =>
  datasets.filter((dataset) => !isFixtureDatasetRecord(dataset));

export const filterVisibleTrainingJobs = <T extends Pick<TrainingJobRecord, 'name'>>(
  jobs: T[]
): T[] => jobs.filter((job) => !isFixtureTrainingJobRecord(job));

export const filterVisibleModelVersions = <T extends Pick<ModelVersionRecord, 'version_name'>>(
  versions: T[]
): T[] => versions.filter((version) => !isFixtureModelVersionRecord(version));

export const filterVisibleAttachments = <T extends { filename: string }>(attachments: T[]): T[] =>
  attachments.filter((attachment) => !isFixtureAttachmentFilename(attachment.filename));
