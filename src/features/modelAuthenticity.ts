import type { ModelRecord, ModelVersionRecord, TrainingJobRecord } from '../../shared/domain';
import { deriveTrainingExecutionInsight, type TrainingExecutionInsight } from './trainingExecutionInsight';

export interface ModelVerificationCounts {
  totalVersions: number;
  stableVersions: number;
  riskyVersions: number;
  unknownVersions: number;
}

export const buildModelVerificationCountsById = (input: {
  models: ModelRecord[];
  versions: ModelVersionRecord[];
  jobsById: Map<string, TrainingJobRecord>;
  jobInsightsById: Record<string, TrainingExecutionInsight>;
}): Record<string, ModelVerificationCounts> => {
  const countsById: Record<string, ModelVerificationCounts> = {};
  input.models.forEach((model) => {
    countsById[model.id] = {
      totalVersions: 0,
      stableVersions: 0,
      riskyVersions: 0,
      unknownVersions: 0
    };
  });

  input.versions.forEach((version) => {
    const current = countsById[version.model_id];
    if (!current) {
      return;
    }
    current.totalVersions += 1;

    if (!version.training_job_id) {
      current.unknownVersions += 1;
      current.riskyVersions += 1;
      return;
    }

    const linkedJob = input.jobsById.get(version.training_job_id);
    if (!linkedJob) {
      current.unknownVersions += 1;
      current.riskyVersions += 1;
      return;
    }

    const insight =
      input.jobInsightsById[linkedJob.id] ??
      deriveTrainingExecutionInsight({
        status: linkedJob.status,
        executionMode: linkedJob.execution_mode,
        artifactSummary: null
      });

    if (insight.reality === 'standard') {
      current.stableVersions += 1;
      return;
    }

    current.riskyVersions += 1;
    if (insight.reality === 'unknown') {
      current.unknownVersions += 1;
    }
  });

  return countsById;
};

export type { ModelVerificationCounts as ModelAuthenticityCounts };
export const buildModelAuthenticityCountsById = buildModelVerificationCountsById;
