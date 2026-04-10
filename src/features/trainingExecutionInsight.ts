import type {
  TrainingArtifactSummary,
  TrainingExecutionMode,
  TrainingJobStatus
} from '../../shared/domain';

export type TrainingExecutionReality = 'real' | 'template' | 'simulated' | 'unknown';

export interface TrainingExecutionInsight {
  reality: TrainingExecutionReality;
  fallbackReason: string | null;
  runnerMode: string | null;
  showWarning: boolean;
}

const terminalStatuses = new Set<TrainingJobStatus>(['completed', 'failed', 'cancelled']);

const toNormalizedMode = (value: string | null | undefined): string | null => {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || null;
};

export const deriveTrainingExecutionInsight = (input: {
  status: TrainingJobStatus;
  executionMode: TrainingExecutionMode;
  artifactSummary?: TrainingArtifactSummary | null;
}): TrainingExecutionInsight => {
  const artifactSummary = input.artifactSummary ?? null;
  const runnerMode = toNormalizedMode(artifactSummary?.mode);
  const fallbackReason =
    typeof artifactSummary?.fallback_reason === 'string' && artifactSummary.fallback_reason.trim()
      ? artifactSummary.fallback_reason.trim()
      : null;
  const trainingPerformed = artifactSummary?.training_performed ?? null;
  const terminal = terminalStatuses.has(input.status);

  if (input.executionMode === 'simulated') {
    return {
      reality: 'simulated',
      fallbackReason,
      runnerMode,
      showWarning: terminal
    };
  }

  if (input.executionMode === 'unknown') {
    return {
      reality: 'unknown',
      fallbackReason,
      runnerMode,
      showWarning: terminal
    };
  }

  if (runnerMode === 'real' && trainingPerformed === true) {
    return {
      reality: 'real',
      fallbackReason,
      runnerMode,
      showWarning: false
    };
  }

  if (runnerMode === 'template' || trainingPerformed === false || Boolean(fallbackReason)) {
    return {
      reality: 'template',
      fallbackReason,
      runnerMode,
      showWarning: terminal
    };
  }

  if (terminal && !artifactSummary) {
    return {
      reality: 'unknown',
      fallbackReason,
      runnerMode,
      showWarning: true
    };
  }

  return {
    reality: 'real',
    fallbackReason,
    runnerMode,
    showWarning: false
  };
};

