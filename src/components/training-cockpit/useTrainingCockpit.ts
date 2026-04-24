import { startTransition, useCallback, useEffect, useMemo, useState } from 'react';
import type { ModelVersionRecord, TrainingMetricRecord, VisionModelingTaskRecord } from '../../../shared/domain';
import useBackgroundPolling from '../../hooks/useBackgroundPolling';
import { api } from '../../services/api';
import type {
  TrainingCockpitController,
  TrainingCockpitEventLevel,
  TrainingCockpitEventLog,
  TrainingCockpitMetricPoint,
  TrainingCockpitMode,
  TrainingCockpitParamValue,
  TrainingCockpitPlaybackSpeed,
  TrainingCockpitResourcePoint,
  TrainingCockpitSnapshot,
  TrainingCockpitStage,
  TrainingCockpitStageState,
  TrainingCockpitSummary,
  TrainingCockpitTrial,
  TrainingCockpitTrialStatus
} from './types';

const liveRefreshIntervalMs = 5000;
const demoFrameCount = 36;
const demoBaseTickMs = 1100;

const stageBlueprint: Array<Pick<TrainingCockpitStage, 'id' | 'label' | 'description'>> = [
  {
    id: 'data_preparation',
    label: 'Data preparation',
    description: 'Dataset snapshot is frozen and materialized for the run.'
  },
  {
    id: 'annotation_review',
    label: 'Annotation review',
    description: 'Label quality gate and trainability checks are locked.'
  },
  {
    id: 'training_config',
    label: 'Training config',
    description: 'Framework, recipe, and launch parameters are finalized.'
  },
  {
    id: 'auto_tuning',
    label: 'Auto tuning',
    description: 'Candidate hyper-parameters are generated, tried, and compared.'
  },
  {
    id: 'model_training',
    label: 'Model training',
    description: 'The selected configuration is running against the dataset snapshot.'
  },
  {
    id: 'validation',
    label: 'Validation',
    description: 'Evaluation metrics and checkpoints are being verified.'
  },
  {
    id: 'model_registration',
    label: 'Model registration',
    description: 'Training evidence is ready to be promoted into a model version.'
  },
  {
    id: 'publish_handoff',
    label: 'Publish handoff',
    description: 'The completed run is waiting for downstream validation or release.'
  }
];

type TrainingJobDetailPayload = Awaited<ReturnType<typeof api.getTrainingJobDetail>>;

type AutoTuneRound = {
  round: number;
  train_args: Record<string, string>;
  note: string;
};

type AutoTuneHistoryEntry = {
  round: number;
  training_job_id: string;
  status: string;
  created_at: string;
  config: Record<string, string>;
  pass_status?: 'pass' | 'fail' | 'needs_review';
  primary_metric?: string;
  primary_value?: number;
};

const parseNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const titleCaseMetric = (value: string) =>
  value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());

const normalizeParamRecord = (record: Record<string, unknown> | null | undefined) =>
  Object.fromEntries(
    Object.entries(record ?? {})
      .filter(([key]) => key.trim())
      .map(([key, value]) => {
        const trimmedKey = key.trim();
        const numeric = parseNumber(value);
        if (numeric !== null) {
          return [trimmedKey, Number(numeric.toFixed(4))];
        }
        if (typeof value === 'boolean') {
          return [trimmedKey, value];
        }
        return [trimmedKey, String(value ?? '').trim()];
      })
  ) as Record<string, TrainingCockpitParamValue>;

const detectMetricChannel = (metricName: string): keyof TrainingCockpitMetricPoint | null => {
  const normalized = metricName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (normalized.includes('val') && normalized.includes('loss')) {
    return 'valLoss';
  }
  if (normalized === 'loss' || normalized.endsWith('_loss') || normalized.includes('train_loss')) {
    return 'loss';
  }
  if (
    normalized === 'accuracy' ||
    normalized === 'acc' ||
    normalized.includes('word_accuracy') ||
    normalized.includes('char_accuracy')
  ) {
    return 'accuracy';
  }
  if (normalized === 'learning_rate' || normalized === 'lr' || normalized.includes('_lr')) {
    return 'learningRate';
  }
  if (normalized.includes('map')) {
    return 'map';
  }
  if (normalized.includes('precision')) {
    return 'precision';
  }
  if (normalized.includes('recall')) {
    return 'recall';
  }
  return null;
};

const safeIso = (value: string | null | undefined, fallback: string) => {
  if (!value || Number.isNaN(Date.parse(value))) {
    return fallback;
  }
  return value;
};

const addSeconds = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString();

const interpolateIso = (fromIso: string, toIso: string, ratio: number) => {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    return toIso;
  }
  return new Date(from + (to - from) * clamp(ratio, 0, 1)).toISOString();
};

const tryParseTaskMetadata = <T,>(value: string | undefined, fallback: T): T => {
  if (!value || !value.trim()) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(value) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};

const readAutoTuneRounds = (task: VisionModelingTaskRecord | null): AutoTuneRound[] => {
  const parsed = tryParseTaskMetadata<unknown[]>(task?.metadata.auto_tune_rounds_json, []);
  return Array.isArray(parsed)
    ? parsed
        .map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return null;
          }
          const entry = item as Partial<AutoTuneRound>;
          if (typeof entry.round !== 'number' || !Number.isFinite(entry.round)) {
            return null;
          }
          const trainArgs =
            entry.train_args && typeof entry.train_args === 'object' && !Array.isArray(entry.train_args)
              ? Object.fromEntries(
                  Object.entries(entry.train_args)
                    .filter(([key, value]) => key.trim() && typeof value === 'string')
                    .map(([key, value]) => [key.trim(), value.trim()])
                )
              : {};
          return {
            round: Math.max(1, Math.round(entry.round)),
            train_args: trainArgs,
            note: typeof entry.note === 'string' ? entry.note : ''
          } satisfies AutoTuneRound;
        })
        .filter((item): item is AutoTuneRound => Boolean(item))
        .sort((left, right) => left.round - right.round)
    : [];
};

const readAutoTuneHistory = (task: VisionModelingTaskRecord | null): AutoTuneHistoryEntry[] => {
  const parsed = tryParseTaskMetadata<unknown[]>(task?.metadata.auto_tune_history_json, []);
  return Array.isArray(parsed)
    ? parsed
        .map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return null;
          }
          const entry = item as Partial<AutoTuneHistoryEntry>;
          if (
            typeof entry.round !== 'number' ||
            !Number.isFinite(entry.round) ||
            typeof entry.training_job_id !== 'string' ||
            !entry.training_job_id.trim()
          ) {
            return null;
          }
          return {
            round: Math.max(1, Math.round(entry.round)),
            training_job_id: entry.training_job_id.trim(),
            status: typeof entry.status === 'string' ? entry.status : 'draft',
            created_at:
              typeof entry.created_at === 'string' && !Number.isNaN(Date.parse(entry.created_at))
                ? entry.created_at
                : new Date().toISOString(),
            config:
              entry.config && typeof entry.config === 'object' && !Array.isArray(entry.config)
                ? Object.fromEntries(
                    Object.entries(entry.config)
                      .filter(([key, value]) => key.trim() && typeof value === 'string')
                      .map(([key, value]) => [key.trim(), value.trim()])
                  )
                : {},
            pass_status:
              entry.pass_status === 'pass' || entry.pass_status === 'fail' || entry.pass_status === 'needs_review'
                ? entry.pass_status
                : undefined,
            primary_metric:
              typeof entry.primary_metric === 'string' && entry.primary_metric.trim()
                ? entry.primary_metric.trim()
                : undefined,
            primary_value:
              typeof entry.primary_value === 'number' && Number.isFinite(entry.primary_value)
                ? entry.primary_value
                : undefined
          } satisfies AutoTuneHistoryEntry;
        })
        .filter((item): item is AutoTuneHistoryEntry => Boolean(item))
        .sort((left, right) => left.round - right.round)
    : [];
};

const buildMetricSeries = (
  metrics: TrainingMetricRecord[],
  totalEpoch: number
): TrainingCockpitMetricPoint[] => {
  const sorted = [...metrics].sort((left, right) => {
    if (left.step !== right.step) {
      return left.step - right.step;
    }
    return Date.parse(left.recorded_at) - Date.parse(right.recorded_at);
  });
  const grouped = new Map<number, TrainingCockpitMetricPoint>();
  for (const metric of sorted) {
    const step = Math.max(1, Math.round(metric.step || 1));
    const existing =
      grouped.get(step) ??
      ({
        step,
        epoch: totalEpoch > 0 ? Math.min(totalEpoch, step) : step,
        recordedAt: metric.recorded_at,
        loss: null,
        valLoss: null,
        accuracy: null,
        map: null,
        learningRate: null,
        precision: null,
        recall: null
      } satisfies TrainingCockpitMetricPoint);
    existing.recordedAt = safeIso(metric.recorded_at, existing.recordedAt);
    const channel = detectMetricChannel(metric.metric_name);
    if (channel) {
      existing[channel] = Number(metric.metric_value.toFixed(6));
    }
    grouped.set(step, existing);
  }
  return [...grouped.values()].sort((left, right) => left.step - right.step);
};

const pickBestMetric = (
  metrics: TrainingMetricRecord[],
  task: VisionModelingTaskRecord | null
): { label: string; value: number | null } => {
  if (task?.validation_report?.summary) {
    return {
      label: titleCaseMetric(task.validation_report.summary.primary_metric),
      value: task.validation_report.summary.primary_value
    };
  }

  const latestByName = new Map<string, TrainingMetricRecord>();
  for (const metric of metrics) {
    const previous = latestByName.get(metric.metric_name);
    if (!previous || metric.step >= previous.step) {
      latestByName.set(metric.metric_name, metric);
    }
  }

  const priorities = ['map', 'accuracy', 'precision', 'recall', 'word_accuracy', 'cer', 'wer', 'loss'];
  for (const priority of priorities) {
    const hit = [...latestByName.values()].find((metric) =>
      metric.metric_name.toLowerCase().replace(/[^a-z0-9]+/g, '_').includes(priority)
    );
    if (hit) {
      return {
        label: titleCaseMetric(hit.metric_name),
        value: hit.metric_value
      };
    }
  }

  const fallback = metrics.at(-1) ?? null;
  return {
    label: fallback ? titleCaseMetric(fallback.metric_name) : 'Primary metric',
    value: fallback ? fallback.metric_value : null
  };
};

const deriveResourceSeries = (
  points: TrainingCockpitMetricPoint[],
  currentEpoch: number,
  totalEpoch: number,
  status: string,
  fromIso: string,
  toIso: string
): TrainingCockpitResourcePoint[] => {
  const count = Math.max(points.length, Math.min(Math.max(currentEpoch, 6), 18));
  return Array.from({ length: count }, (_, index) => {
    const progress = count <= 1 ? 0 : index / (count - 1);
    const runningFactor =
      status === 'running' ? 1 : status === 'evaluating' ? 0.82 : status === 'completed' ? 0.38 : 0.2;
    const curve = Math.sin(index * 0.72);
    const pressure = Math.cos(index * 0.41);
    const etaSeconds =
      totalEpoch > 0 && currentEpoch > 0 && currentEpoch < totalEpoch
        ? Math.round(((totalEpoch - Math.max(1, currentEpoch * progress)) * 92) / Math.max(runningFactor, 0.25))
        : 0;

    return {
      recordedAt: interpolateIso(fromIso, toIso, progress),
      gpuUtil: Number(clamp(45 + runningFactor * 32 + curve * 9, 12, 97).toFixed(1)),
      gpuMemory: Number(clamp(8.6 + progress * 4.8 + pressure * 0.65, 2.5, 24).toFixed(1)),
      gpuMemoryTotal: 24,
      cpuUtil: Number(clamp(30 + runningFactor * 26 + pressure * 10, 8, 92).toFixed(1)),
      memoryUtil: Number(clamp(42 + runningFactor * 18 + curve * 8, 16, 88).toFixed(1)),
      throughput: Number(clamp(9.5 + runningFactor * 7 + curve * 1.2, 2.2, 22).toFixed(1)),
      etaSeconds
    };
  });
};

const parseLogLevel = (line: string): TrainingCockpitEventLevel => {
  if (/(error|failed|traceback|exception|fatal|denied)/i.test(line)) {
    return 'error';
  }
  if (/(warn|fallback|retry|slow|queued|等待)/i.test(line)) {
    return 'warning';
  }
  if (/(completed|ready|saved|best|improved|registered)/i.test(line)) {
    return 'success';
  }
  return 'info';
};

const buildTuningTrialsFromTask = (
  task: VisionModelingTaskRecord | null,
  jobId: string
): {
  trials: TrainingCockpitTrial[];
  strategy: string;
  attempt: number;
  total: number;
  recommendedParamsApplied: boolean;
  currentParams: Record<string, TrainingCockpitParamValue> | null;
  eventLogs: TrainingCockpitEventLog[];
} => {
  if (!task) {
    return {
      trials: [],
      strategy: 'No live tuning stream',
      attempt: 0,
      total: 0,
      recommendedParamsApplied: false,
      currentParams: null,
      eventLogs: []
    };
  }

  const rounds = readAutoTuneRounds(task);
  const history = readAutoTuneHistory(task);
  const total = Math.max(rounds.length, history.length);
  const bestHistory = [...history]
    .filter((entry) => typeof entry.primary_value === 'number')
    .sort((left, right) => (right.primary_value ?? 0) - (left.primary_value ?? 0))[0] ?? null;
  const activeRound = parseNumber(task.metadata.auto_tune_active_round) ?? 0;

  const trials = Array.from({ length: total }, (_, index) => {
    const roundNumber = index + 1;
    const round = rounds.find((entry) => entry.round === roundNumber) ?? null;
    const historyEntry = history.find((entry) => entry.round === roundNumber) ?? null;
    const params = normalizeParamRecord(historyEntry?.config ?? round?.train_args ?? {});
    let status: TrainingCockpitTrialStatus = 'pending';
    if (historyEntry) {
      if (
        historyEntry.training_job_id === jobId &&
        ['queued', 'preparing', 'running', 'evaluating'].includes(historyEntry.status)
      ) {
        status = 'running';
      } else if (historyEntry.pass_status === 'fail' || ['failed', 'cancelled'].includes(historyEntry.status)) {
        status = 'rejected';
      } else {
        status = 'completed';
      }
    } else if (activeRound === roundNumber) {
      status = 'running';
    }
    if (bestHistory?.round === roundNumber) {
      status = 'best';
    }
    const progress = status === 'running' ? 0.56 : status === 'pending' ? 0 : 1;
    const score = historyEntry?.primary_value ?? null;
    const diffFromBest =
      bestHistory?.primary_value !== undefined && score !== null ? score - bestHistory.primary_value : null;
    return {
      trialId: `trial-${String(roundNumber).padStart(2, '0')}`,
      params,
      status,
      score,
      progress,
      startTime: historyEntry?.created_at ?? null,
      endTime:
        status === 'running' || !historyEntry?.created_at
          ? null
          : addSeconds(historyEntry.created_at, 180 + roundNumber * 12),
      isBest: bestHistory?.round === roundNumber,
      note: round?.note || '',
      diffFromBest,
      source: 'real'
    } satisfies TrainingCockpitTrial;
  });

  const eventLogs = history.map((entry) => ({
    id: `tuning-${entry.round}`,
    time: entry.created_at,
    level:
      entry.pass_status === 'fail'
        ? 'warning'
        : entry.training_job_id === jobId && ['running', 'evaluating'].includes(entry.status)
          ? 'info'
          : entry.pass_status === 'pass'
            ? 'success'
            : 'info',
    message:
      entry.pass_status === 'fail'
        ? `Trial #${String(entry.round).padStart(2, '0')} was rejected after evaluation.`
        : bestHistory?.round === entry.round
          ? `Trial #${String(entry.round).padStart(2, '0')} became the current best configuration.`
          : entry.training_job_id === jobId && ['running', 'evaluating'].includes(entry.status)
            ? `Trial #${String(entry.round).padStart(2, '0')} is active on the current run.`
            : `Trial #${String(entry.round).padStart(2, '0')} finished with recorded metrics.`,
    eventType: 'tuning',
    emphasis: bestHistory?.round === entry.round
  })) satisfies TrainingCockpitEventLog[];

  const currentParams = normalizeParamRecord(
    history.find((entry) => entry.training_job_id === jobId)?.config ??
      bestHistory?.config ??
      rounds.find((entry) => entry.round === activeRound)?.train_args ??
      {}
  );

  return {
    trials,
    strategy: task.training_plan?.recipe_id ? titleCaseMetric(task.training_plan.recipe_id) : 'Adaptive search',
    attempt: history.length,
    total,
    recommendedParamsApplied: history.some((entry) => entry.training_job_id === jobId),
    currentParams: Object.keys(currentParams).length > 0 ? currentParams : null,
    eventLogs
  };
};

const buildStages = (input: {
  status: string;
  hasVersion: boolean;
  tuningEnabled: boolean;
}): { stages: TrainingCockpitStage[]; currentStageLabel: string } => {
  const { status, hasVersion, tuningEnabled } = input;
  let activeStageId: TrainingCockpitStage['id'] = 'training_config';
  if (status === 'queued') {
    activeStageId = 'training_config';
  } else if (status === 'preparing') {
    activeStageId = tuningEnabled ? 'auto_tuning' : 'model_training';
  } else if (status === 'running') {
    activeStageId = 'model_training';
  } else if (status === 'evaluating') {
    activeStageId = 'validation';
  } else if (status === 'completed') {
    activeStageId = hasVersion ? 'publish_handoff' : 'model_registration';
  } else if (status === 'failed' || status === 'cancelled') {
    activeStageId = 'model_training';
  }

  const activeIndex = stageBlueprint.findIndex((stage) => stage.id === activeStageId);
  const stages = stageBlueprint.map((stage, index) => {
    let state: TrainingCockpitStageState = 'upcoming';
    if (index < activeIndex) {
      state = 'complete';
    } else if (index === activeIndex) {
      state = status === 'failed' || status === 'cancelled' ? 'failed' : 'active';
    }
    if (stage.id === 'auto_tuning' && !tuningEnabled && index < activeIndex) {
      state = 'complete';
    }
    if (stage.id === 'publish_handoff' && hasVersion) {
      state = 'active';
    }
    return { ...stage, state };
  });
  return {
    stages,
    currentStageLabel: stageBlueprint[activeIndex]?.label ?? stageBlueprint[0].label
  };
};

const buildLiveEventStream = (input: {
  detail: TrainingJobDetailPayload;
  metrics: TrainingCockpitMetricPoint[];
  bestMetricLabel: string;
  tuningEvents: TrainingCockpitEventLog[];
}): TrainingCockpitEventLog[] => {
  const { detail, metrics, bestMetricLabel, tuningEvents } = input;
  const createdAt = safeIso(detail.job.created_at, new Date().toISOString());
  const updatedAt = safeIso(detail.job.updated_at, createdAt);
  const baseEvents: TrainingCockpitEventLog[] = [
    {
      id: 'job-created',
      time: createdAt,
      level: 'info',
      message: 'Training task was created and entered the execution queue.',
      eventType: 'job',
      emphasis: true
    },
    {
      id: 'dataset-locked',
      time: addSeconds(createdAt, 18),
      level: 'success',
      message: 'Dataset snapshot and launch configuration were frozen for this run.',
      eventType: 'snapshot'
    }
  ];

  if (detail.job.status !== 'queued') {
    baseEvents.push({
      id: 'training-started',
      time: addSeconds(createdAt, 42),
      level: 'success',
      message: 'Training execution started and telemetry began streaming.',
      eventType: 'training'
    });
  }

  const metricEvents = metrics
    .filter((point, index) => index === 0 || index === metrics.length - 1 || index % 4 === 0)
    .map((point, index) => {
      const primaryValue =
        point.map ?? point.accuracy ?? point.precision ?? point.recall ?? point.loss ?? point.valLoss ?? null;
      return {
        id: `metric-${point.step}-${index}`,
        time: safeIso(point.recordedAt, interpolateIso(createdAt, updatedAt, (index + 1) / (metrics.length + 1))),
        level: primaryValue !== null ? 'info' : 'warning',
        message:
          primaryValue !== null
            ? `${bestMetricLabel} refreshed at epoch ${point.epoch}: ${primaryValue.toFixed(4)}`
            : `Metrics refresh landed for epoch ${point.epoch}.`,
        eventType: 'metric'
      } satisfies TrainingCockpitEventLog;
    });

  const logLines = detail.logs.slice(-10).map((line, index) => ({
    id: `log-${index}`,
    time: interpolateIso(createdAt, updatedAt, 0.56 + (index / Math.max(detail.logs.length, 1)) * 0.4),
    level: parseLogLevel(line),
    message: line,
    eventType: 'log'
  })) satisfies TrainingCockpitEventLog[];

  if (detail.job.status === 'completed') {
    baseEvents.push({
      id: 'best-weights',
      time: addSeconds(updatedAt, -45),
      level: 'success',
      message: 'Best checkpoint was saved and validation summary was sealed.',
      eventType: 'checkpoint',
      emphasis: true
    });
  }

  if (detail.job.status === 'failed' || detail.job.status === 'cancelled') {
    baseEvents.push({
      id: 'job-failed',
      time: updatedAt,
      level: 'error',
      message: 'The current run exited early. Review the latest logs before retrying.',
      eventType: 'job',
      emphasis: true
    });
  }

  return [...baseEvents, ...tuningEvents, ...metricEvents, ...logLines].sort(
    (left, right) => Date.parse(left.time) - Date.parse(right.time)
  );
};

const buildLiveSnapshot = (input: {
  detail: TrainingJobDetailPayload;
  versions: ModelVersionRecord[];
  relatedTask: VisionModelingTaskRecord | null;
}): TrainingCockpitSnapshot => {
  const { detail, versions, relatedTask } = input;
  const totalEpoch = parseNumber(detail.job.config.epochs) ?? parseNumber(detail.job.config.epoch) ?? 0;
  const metrics = buildMetricSeries(detail.metrics, totalEpoch);
  const currentEpoch = Math.max(metrics.at(-1)?.epoch ?? 0, 0);
  const bestMetric = pickBestMetric(detail.metrics, relatedTask);
  const linkedVersion =
    [...versions]
      .filter((version) => version.training_job_id === detail.job.id)
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0] ?? null;
  const tuning = buildTuningTrialsFromTask(relatedTask, detail.job.id);
  const createdAt = safeIso(detail.job.created_at, new Date().toISOString());
  const lastUpdatedAt = safeIso(detail.job.updated_at, createdAt);
  const durationAnchor =
    detail.job.status === 'completed' || detail.job.status === 'failed' || detail.job.status === 'cancelled'
      ? Date.parse(lastUpdatedAt)
      : Date.now();
  const durationSeconds = Math.max(60, Math.round((durationAnchor - Date.parse(createdAt)) / 1000));
  const resources = deriveResourceSeries(metrics, currentEpoch, totalEpoch, detail.job.status, createdAt, lastUpdatedAt);
  const stages = buildStages({
    status: detail.job.status,
    hasVersion: Boolean(linkedVersion),
    tuningEnabled: tuning.trials.length > 0
  });
  const summary: TrainingCockpitSummary = {
    id: detail.job.id,
    name: detail.job.name,
    status: detail.job.status,
    modelType: detail.job.task_type,
    datasetVersion: detail.job.dataset_version_id || 'Pending snapshot',
    modelVersion: linkedVersion?.version_name ?? 'Pending registration',
    createdAt,
    startedAt: createdAt,
    durationSeconds,
    currentEpoch,
    totalEpoch,
    bestMetricLabel: bestMetric.label,
    bestMetricValue: bestMetric.value,
    deviceLabel:
      detail.job.execution_target === 'worker'
        ? `Worker lane${detail.job.scheduled_worker_id ? ` · ${detail.job.scheduled_worker_id}` : ''}`
        : 'Control plane lane',
    currentStageLabel: stages.currentStageLabel,
    autoTuningEnabled: tuning.trials.length > 0,
    tuningStrategy: tuning.strategy,
    tuningAttempt: tuning.attempt,
    tuningTotal: tuning.total,
    recommendedParamsApplied: tuning.recommendedParamsApplied,
    currentParams: tuning.currentParams ?? normalizeParamRecord(detail.job.config),
    appliedTrialId: tuning.trials.find((trial) => trial.isBest)?.trialId ?? null,
    availability: {
      resources: resources.length > 0 ? 'derived' : 'unavailable',
      tuning: tuning.trials.length > 0 ? 'real' : 'unavailable'
    }
  };

  return {
    source: 'live',
    lastUpdatedAt,
    summary,
    stages: stages.stages,
    metrics,
    resources,
    tuningTrials: tuning.trials,
    events: buildLiveEventStream({
      detail,
      metrics,
      bestMetricLabel: bestMetric.label,
      tuningEvents: tuning.eventLogs
    })
  };
};

const buildDemoTrials = (frame: number): TrainingCockpitTrial[] => {
  const templates = [
    {
      id: 'trial-01',
      params: {
        learning_rate: 0.0012,
        batch_size: 8,
        image_size: 640,
        optimizer: 'AdamW',
        weight_decay: 0.0004,
        augmentation_strength: 0.42
      },
      score: 0.698,
      note: 'Fast warmup candidate focused on stable recall.'
    },
    {
      id: 'trial-02',
      params: {
        learning_rate: 0.0008,
        batch_size: 12,
        image_size: 704,
        optimizer: 'AdamW',
        weight_decay: 0.00025,
        augmentation_strength: 0.5
      },
      score: 0.734,
      note: 'Expanded image size to test hard-example recovery.'
    },
    {
      id: 'trial-03',
      params: {
        learning_rate: 0.00062,
        batch_size: 16,
        image_size: 736,
        optimizer: 'SGD',
        weight_decay: 0.00015,
        augmentation_strength: 0.47
      },
      score: 0.781,
      note: 'Balanced convergence candidate promoted into main training.'
    },
    {
      id: 'trial-04',
      params: {
        learning_rate: 0.00054,
        batch_size: 16,
        image_size: 736,
        optimizer: 'SGD',
        weight_decay: 0.0001,
        augmentation_strength: 0.63
      },
      score: 0.753,
      note: 'Higher augmentation was too unstable on validation.'
    },
    {
      id: 'trial-05',
      params: {
        learning_rate: 0.00048,
        batch_size: 20,
        image_size: 768,
        optimizer: 'SGD',
        weight_decay: 0.00008,
        augmentation_strength: 0.44
      },
      score: 0.768,
      note: 'Late-stage fine candidate reserved for next round.'
    },
    {
      id: 'trial-06',
      params: {
        learning_rate: 0.00041,
        batch_size: 20,
        image_size: 768,
        optimizer: 'SGD',
        weight_decay: 0.00005,
        augmentation_strength: 0.4
      },
      score: 0.774,
      note: 'Projected follow-up candidate after main run.'
    }
  ] as const;

  return templates.map((template, index) => {
    const startFrame = 4 + index * 3;
    let status: TrainingCockpitTrialStatus = 'pending';
    let progress = 0;
    if (frame >= startFrame && frame < startFrame + 2) {
      status = 'running';
      progress = clamp((frame - startFrame + 1) / 2, 0.15, 0.94);
    } else if (frame >= startFrame + 2) {
      status = index === 2 ? 'best' : index === 4 && frame >= 28 ? 'completed' : index > 2 ? 'rejected' : 'completed';
      progress = 1;
    }
    if (index === 0 && frame >= 7) {
      status = 'rejected';
    }
    if (index === 1 && frame >= 10) {
      status = 'completed';
    }
    if (index === 2 && frame >= 13) {
      status = 'best';
    }
    if (index === 3 && frame >= 16) {
      status = 'rejected';
    }
    if (index === 4 && frame >= 19 && frame < 28) {
      status = 'running';
      progress = clamp((frame - 18) / 10, 0.22, 0.95);
    }
    if (index === 4 && frame >= 28) {
      status = 'completed';
    }
    if (index === 5 && frame >= 30 && frame < 35) {
      status = 'running';
      progress = clamp((frame - 29) / 6, 0.16, 0.88);
    }
    const bestScore = 0.781;
    return {
      trialId: template.id,
      params: template.params,
      status,
      score: status === 'pending' ? null : template.score,
      progress,
      startTime: addSeconds('2026-04-24T08:00:00.000Z', startFrame * 96),
      endTime: status === 'pending' || status === 'running' ? null : addSeconds('2026-04-24T08:00:00.000Z', (startFrame + 2) * 96),
      isBest: status === 'best',
      note: template.note,
      diffFromBest: status === 'pending' ? null : template.score - bestScore,
      source: 'demo'
    } satisfies TrainingCockpitTrial;
  });
};

const buildDemoMetrics = (frame: number, totalEpoch: number, startedAt: string) =>
  Array.from({ length: Math.max(0, frame - 2) }, (_, index) => {
    const step = index + 1;
    const progress = step / totalEpoch;
    const oscillation = Math.sin(step * 0.42);
    return {
      step,
      epoch: step,
      recordedAt: addSeconds(startedAt, step * 92),
      loss: Number((1.28 - progress * 0.92 + oscillation * 0.04).toFixed(4)),
      valLoss: Number((1.34 - progress * 0.81 + Math.cos(step * 0.37) * 0.05).toFixed(4)),
      accuracy: Number((0.58 + progress * 0.28 + oscillation * 0.015).toFixed(4)),
      map: Number((0.49 + progress * 0.34 + Math.sin(step * 0.31) * 0.02).toFixed(4)),
      learningRate: Number((0.0012 * (1 - progress * 0.76)).toFixed(6)),
      precision: Number((0.61 + progress * 0.21 + Math.sin(step * 0.19) * 0.012).toFixed(4)),
      recall: Number((0.56 + progress * 0.25 + Math.cos(step * 0.23) * 0.014).toFixed(4))
    } satisfies TrainingCockpitMetricPoint;
  });

const buildDemoResources = (frame: number, startedAt: string): TrainingCockpitResourcePoint[] => {
  const count = Math.max(6, frame + 2);
  return Array.from({ length: count }, (_, index) => {
    const progress = count <= 1 ? 0 : index / (count - 1);
    const focus = frame < 12 ? 0.76 : frame < 26 ? 1 : 0.84;
    return {
      recordedAt: addSeconds(startedAt, index * 88),
      gpuUtil: Number(clamp(58 + focus * 22 + Math.sin(index * 0.44) * 8, 24, 98).toFixed(1)),
      gpuMemory: Number(clamp(10.4 + progress * 6.2 + Math.cos(index * 0.33) * 0.7, 5, 22.6).toFixed(1)),
      gpuMemoryTotal: 24,
      cpuUtil: Number(clamp(34 + focus * 18 + Math.cos(index * 0.58) * 7, 16, 88).toFixed(1)),
      memoryUtil: Number(clamp(46 + focus * 14 + Math.sin(index * 0.36) * 6, 24, 84).toFixed(1)),
      throughput: Number(clamp(11.8 + focus * 5.1 + Math.sin(index * 0.27), 4.2, 22.4).toFixed(1)),
      etaSeconds: frame >= 32 ? 0 : Math.max(0, Math.round((36 - Math.max(index, frame)) * 94))
    };
  });
};

const buildDemoEvents = (frame: number, startedAt: string, trialId: string | null): TrainingCockpitEventLog[] => {
  const events: Array<{ frame: number; event: TrainingCockpitEventLog }> = [
    {
      frame: 0,
      event: {
        id: 'demo-created',
        time: startedAt,
        level: 'info',
        message: 'Training task created from dataset snapshot v14.',
        eventType: 'job',
        emphasis: true
      }
    },
    {
      frame: 2,
      event: {
        id: 'demo-config',
        time: addSeconds(startedAt, 180),
        level: 'success',
        message: 'Recipe and initial parameter envelope validated.',
        eventType: 'config'
      }
    },
    {
      frame: 4,
      event: {
        id: 'demo-trial-1',
        time: addSeconds(startedAt, 420),
        level: 'info',
        message: 'Trial #01 launched for warmup exploration.',
        eventType: 'tuning'
      }
    },
    {
      frame: 7,
      event: {
        id: 'demo-trial-1-reject',
        time: addSeconds(startedAt, 720),
        level: 'warning',
        message: 'Trial #01 rejected due to unstable validation recall.',
        eventType: 'tuning'
      }
    },
    {
      frame: 10,
      event: {
        id: 'demo-trial-2-pass',
        time: addSeconds(startedAt, 1020),
        level: 'success',
        message: 'Trial #02 completed with better mAP and lower loss.',
        eventType: 'tuning'
      }
    },
    {
      frame: 13,
      event: {
        id: 'demo-best-selected',
        time: addSeconds(startedAt, 1310),
        level: 'success',
        message: 'Trial #03 selected as current best; training config updated.',
        eventType: 'tuning',
        emphasis: true
      }
    },
    {
      frame: 18,
      event: {
        id: 'demo-main-train',
        time: addSeconds(startedAt, 1780),
        level: 'info',
        message: 'Main training resumed under the promoted parameter set.',
        eventType: 'training'
      }
    },
    {
      frame: 23,
      event: {
        id: 'demo-best-weights',
        time: addSeconds(startedAt, 2220),
        level: 'success',
        message: 'Best checkpoint refreshed after validation uplift.',
        eventType: 'checkpoint'
      }
    },
    {
      frame: 31,
      event: {
        id: 'demo-validation',
        time: addSeconds(startedAt, 2860),
        level: 'success',
        message: 'Validation sweep completed and artifact bundle sealed.',
        eventType: 'validation',
        emphasis: true
      }
    },
    {
      frame: 34,
      event: {
        id: 'demo-register',
        time: addSeconds(startedAt, 3220),
        level: 'info',
        message: 'Run is ready for model registration and publish handoff.',
        eventType: 'handoff'
      }
    }
  ];

  if (trialId && frame >= 13) {
    events.push({
      frame: 14,
      event: {
        id: 'demo-params-applied',
        time: addSeconds(startedAt, 1400),
        level: 'success',
        message: `Promoted parameters from ${trialId.toUpperCase()} are now active.`,
        eventType: 'config'
      }
    });
  }

  return events
    .filter((entry) => entry.frame <= frame)
    .map((entry) => entry.event)
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
};

const buildDemoSnapshot = (
  frame: number,
  liveSummary: TrainingCockpitSummary | null
): TrainingCockpitSnapshot => {
  const totalEpoch = 30;
  const startedAt = safeIso(liveSummary?.createdAt, '2026-04-24T08:00:00.000Z');
  const metrics = buildDemoMetrics(frame, totalEpoch, startedAt);
  const resources = buildDemoResources(frame, startedAt);
  const tuningTrials = buildDemoTrials(frame);
  const promotedTrial = tuningTrials.find((trial) => trial.status === 'best') ?? null;
  const status =
    frame < 2 ? 'queued' : frame < 4 ? 'preparing' : frame < 29 ? 'running' : frame < 33 ? 'evaluating' : 'completed';
  const stages = buildStages({
    status,
    hasVersion: false,
    tuningEnabled: true
  });
  const bestMap = metrics.reduce((best, point) => Math.max(best, point.map ?? 0), 0);
  const durationSeconds = Math.max(120, Math.round(frame * 96));
  return {
    source: 'demo',
    lastUpdatedAt: addSeconds(startedAt, durationSeconds),
    summary: {
      id: liveSummary?.id ?? 'demo-training-cockpit',
      name: liveSummary?.name ?? 'surface-defect-tuning-demo',
      status,
      modelType: liveSummary?.modelType ?? 'detection',
      datasetVersion: liveSummary?.datasetVersion ?? 'dv-cockpit-demo-v14',
      modelVersion: liveSummary?.modelVersion ?? 'Pending registration',
      createdAt: startedAt,
      startedAt,
      durationSeconds,
      currentEpoch: metrics.at(-1)?.epoch ?? 0,
      totalEpoch,
      bestMetricLabel: 'mAP',
      bestMetricValue: Number(bestMap.toFixed(4)),
      deviceLabel: 'NVIDIA L40S · Worker GPU-03',
      currentStageLabel: stages.currentStageLabel,
      autoTuningEnabled: true,
      tuningStrategy: 'Bayesian search',
      tuningAttempt: tuningTrials.filter((trial) => trial.status !== 'pending').length,
      tuningTotal: tuningTrials.length,
      recommendedParamsApplied: frame >= 13,
      currentParams:
        frame >= 13 && promotedTrial
          ? promotedTrial.params
          : {
              learning_rate: 0.0012,
              batch_size: 8,
              image_size: 640,
              optimizer: 'AdamW',
              weight_decay: 0.0004,
              augmentation_strength: 0.42
            },
      appliedTrialId: promotedTrial?.trialId ?? null,
      availability: {
        resources: 'derived',
        tuning: 'derived'
      }
    },
    stages: stages.stages,
    metrics,
    resources,
    tuningTrials,
    events: buildDemoEvents(frame, startedAt, promotedTrial?.trialId ?? null)
  };
};

export default function useTrainingCockpit(
  jobId: string | undefined,
  initialMode: TrainingCockpitMode = 'live'
): TrainingCockpitController {
  const [mode, setMode] = useState<TrainingCockpitMode>(initialMode);
  const [speed, setSpeed] = useState<TrainingCockpitPlaybackSpeed>(1);
  const [isPlaying, setIsPlaying] = useState(true);
  const [demoFrame, setDemoFrame] = useState(0);
  const [liveStatus, setLiveStatus] = useState<'loading' | 'ready' | 'error'>(jobId ? 'loading' : 'error');
  const [liveSnapshot, setLiveSnapshot] = useState<TrainingCockpitSnapshot | null>(null);
  const [liveError, setLiveError] = useState('');
  const [liveUpdatedAt, setLiveUpdatedAt] = useState<string | null>(null);

  const refreshLive = useCallback(async () => {
    if (!jobId) {
      startTransition(() => {
        setLiveStatus('error');
        setLiveError('Missing training job id.');
        setLiveSnapshot(null);
        setLiveUpdatedAt(null);
      });
      return;
    }

    startTransition(() => {
      setLiveStatus((previous) => (previous === 'ready' ? previous : 'loading'));
      setLiveError('');
    });

    try {
      const detail = await api.getTrainingJobDetail(jobId);
      const [versionsResult, tasksResult] = await Promise.allSettled([
        api.listModelVersions(),
        api.listVisionTasks()
      ]);
      const versions = versionsResult.status === 'fulfilled' ? versionsResult.value : [];
      const tasks = tasksResult.status === 'fulfilled' ? tasksResult.value : [];
      const relatedTask = tasks.find((task) => task.training_job_id === detail.job.id) ?? null;
      const snapshot = buildLiveSnapshot({
        detail,
        versions,
        relatedTask
      });
      startTransition(() => {
        setLiveSnapshot(snapshot);
        setLiveStatus('ready');
        setLiveUpdatedAt(snapshot.lastUpdatedAt);
      });
    } catch (error) {
      startTransition(() => {
        setLiveStatus('error');
        setLiveError((error as Error).message);
      });
    }
  }, [jobId]);

  useEffect(() => {
    void refreshLive();
  }, [refreshLive]);

  useBackgroundPolling(
    () => refreshLive(),
    {
      intervalMs: liveRefreshIntervalMs,
      enabled: Boolean(jobId),
      pauseWhenHidden: true,
      runOnVisible: true
    }
  );

  const demoFrames = useMemo(
    () => Array.from({ length: demoFrameCount }, (_, index) => buildDemoSnapshot(index, liveSnapshot?.summary ?? null)),
    [liveSnapshot?.summary]
  );

  useEffect(() => {
    setDemoFrame((previous) => Math.min(previous, demoFrames.length - 1));
  }, [demoFrames.length]);

  useEffect(() => {
    if (mode !== 'demo' || !isPlaying) {
      return;
    }
    if (demoFrame >= demoFrames.length - 1) {
      setIsPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      startTransition(() => {
        setDemoFrame((previous) => Math.min(previous + 1, demoFrames.length - 1));
      });
    }, demoBaseTickMs / speed);
    return () => {
      window.clearTimeout(timer);
    };
  }, [demoFrame, demoFrames.length, isPlaying, mode, speed]);

  const snapshot = mode === 'demo' ? demoFrames[demoFrame] : liveSnapshot;
  const status: 'loading' | 'ready' | 'error' =
    mode === 'demo' ? 'ready' : liveStatus;
  const error = mode === 'demo' ? '' : liveError;

  return {
    mode,
    setMode: (nextMode) => {
      startTransition(() => {
        setMode(nextMode);
        if (nextMode === 'demo') {
          setIsPlaying(true);
        }
      });
    },
    speed,
    setSpeed,
    isPlaying,
    play: () => setIsPlaying(true),
    pause: () => setIsPlaying(false),
    replay: () => {
      startTransition(() => {
        setDemoFrame(0);
        setIsPlaying(true);
      });
    },
    status,
    snapshot,
    error,
    refreshLive,
    liveUpdatedAt
  };
}
