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
  /^real-(?:yolo|doctr)-model-\d+$/i,
  /^verify-model-[\w-]+$/i
];

const datasetFixtureNamePatterns = [
  /^conversation-smoke-dataset-\d+$/i,
  /^attachment-smoke-dataset$/i,
  /^real-det-\d+$/i,
  /^roundtrip-/i,
  /^persist-check-ds$/i,
  /^import-ref-test$/i,
  /^demo train dataset\b/i
];

const trainingJobFixtureNamePatterns = [
  /^conversation-smoke-job-\d+$/i,
  /^real-(?:yolo|doctr)-job-\d+$/i,
  /^local-command-yolo$/i,
  /^restart-resume-yolo$/i
];

const modelVersionFixtureNamePatterns = [/^real-(?:yolo|doctr)-v\d+$/i];

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
