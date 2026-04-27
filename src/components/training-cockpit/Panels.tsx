import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { Badge, StatusTag } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Panel } from '../ui/Surface';
import CockpitLineChart, { type CockpitLineChartSeries } from './CockpitLineChart';
import TrainingFluxScene from './TrainingFluxScene';
import type {
  TrainingCockpitEventLog,
  TrainingCockpitResourcePoint,
  TrainingCockpitSnapshot,
  TrainingCockpitSummary,
  TrainingCockpitTrial
} from './types';

const chartPalette = {
  blue: '#59b3ff',
  cyan: '#7ef2ff',
  green: '#7ddca1',
  amber: '#ffbf69',
  violet: '#a58bff',
  coral: '#ff8f79'
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const availabilityTone = (value: TrainingCockpitSummary['availability']['resources']) =>
  value === 'real' ? 'success' : value === 'derived' ? 'warning' : 'neutral';

export { TrainingFluxScene };

const stageStateTone = (value: 'complete' | 'active' | 'upcoming' | 'failed') =>
  value === 'complete' ? 'success' : value === 'active' ? 'info' : value === 'failed' ? 'danger' : 'neutral';

const trialStatusTone = (value: TrainingCockpitTrial['status']) =>
  value === 'best'
    ? 'success'
    : value === 'running'
      ? 'info'
      : value === 'rejected'
        ? 'danger'
        : value === 'completed'
          ? 'neutral'
          : 'warning';

const formatDuration = (
  seconds: number,
  t: (source: string, vars?: Record<string, string | number>) => string
) => {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  if (hours > 0) {
    return t('{hours}h {minutes}m', { hours, minutes });
  }
  if (minutes > 0) {
    return t('{minutes}m {seconds}s', { minutes, seconds: secs });
  }
  return t('{seconds}s', { seconds: secs });
};

const formatPercent = (value: number | null) => (value === null ? '—' : `${value.toFixed(1)}%`);

const formatMemory = (value: number | null, total: number | null) => {
  if (value === null) {
    return '—';
  }
  if (!total) {
    return `${value.toFixed(1)} GB`;
  }
  return `${value.toFixed(1)} / ${total.toFixed(0)} GB`;
};

const formatScore = (value: number | null) => (value === null ? '—' : value.toFixed(4));

const formatParamValue = (
  value: string | number | boolean,
  t: (source: string, vars?: Record<string, string | number>) => string
) => {
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return String(value);
    }
    return value.toFixed(Math.abs(value) >= 1 ? 3 : 5);
  }
  if (typeof value === 'boolean') {
    return value ? t('On') : t('Off');
  }
  return value;
};

const availabilityLabel = (
  value: TrainingCockpitSummary['availability']['resources'],
  t: (source: string, vars?: Record<string, string | number>) => string
) =>
  value === 'real' ? t('Real') : value === 'derived' ? t('Derived') : t('Unavailable');

const availabilityDescription = (
  value: TrainingCockpitSummary['availability']['resources'],
  t: (source: string, vars?: Record<string, string | number>) => string
) =>
  value === 'real'
    ? t('This panel is backed by the current live run.')
    : value === 'derived'
      ? t('This panel is currently derived from adjacent telemetry and run progress.')
      : t('No stream is available for this panel on the current run.');

const stageStateLabel = (
  value: 'complete' | 'active' | 'upcoming' | 'failed',
  t: (source: string, vars?: Record<string, string | number>) => string
) =>
  value === 'complete'
    ? t('Completed')
    : value === 'active'
      ? t('In progress')
      : value === 'failed'
        ? t('Failed')
        : t('Upcoming');

const trialStatusLabel = (
  value: TrainingCockpitTrial['status'],
  t: (source: string, vars?: Record<string, string | number>) => string
) =>
  value === 'best'
    ? t('Best')
    : value === 'running'
      ? t('Running')
      : value === 'rejected'
        ? t('Rejected')
        : value === 'completed'
          ? t('Completed')
          : t('Pending');

function OverviewCard({
  label,
  value,
  note,
  accent,
  status
}: {
  label: string;
  value: string;
  note: string;
  accent?: boolean;
  status?: string;
}) {
  return (
    <article className={`training-cockpit-overview-card${accent ? ' accent' : ''}`}>
      <div className="training-cockpit-overview-card__head">
        <small>{label}</small>
        {status ? (
          <div className="training-cockpit-status-indicator">
            <span className="training-cockpit-status-indicator__dot" />
            <StatusTag status={status}>{status}</StatusTag>
          </div>
        ) : null}
      </div>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

export function TrainingCockpitOverview({ summary }: { summary: TrainingCockpitSummary }) {
  const { t } = useI18n();

  return (
    <section className="training-cockpit-overview-grid" data-testid="training-cockpit-overview">
      <OverviewCard
        label={t('Training task')}
        value={summary.name}
        note={t(summary.modelType)}
        accent
        status={t(summary.status)}
      />
      <OverviewCard
        label={t('Dataset snapshot')}
        value={summary.datasetVersion}
        note={t('Model version · {version}', { version: summary.modelVersion })}
      />
      <OverviewCard
        label={t('Epoch progress')}
        value={`${summary.currentEpoch}/${summary.totalEpoch || '—'}`}
        note={summary.currentStageLabel}
      />
      <OverviewCard
        label={t('Best metric')}
        value={summary.bestMetricValue === null ? '—' : `${summary.bestMetricValue.toFixed(4)}`}
        note={summary.bestMetricLabel}
      />
      <OverviewCard
        label={t('Elapsed')}
        value={formatDuration(summary.durationSeconds, t)}
        note={summary.tuningStrategy}
      />
      <OverviewCard
        label={t('Execution device')}
        value={summary.deviceLabel}
        note={t('Live lane or demo GPU target')}
      />
    </section>
  );
}

export function TrainingStageRail({ snapshot }: { snapshot: TrainingCockpitSnapshot }) {
  const { t } = useI18n();

  return (
    <div className="training-cockpit-panel training-cockpit-stage-rail" data-testid="training-cockpit-stage-rail">
      <div className="training-cockpit-panel__header">
        <div className="stack tight">
          <h3>{t('Execution flow')}</h3>
          <small className="muted">{t('The current run advances through one readable phase rail.')}</small>
        </div>
      </div>
      <div className="training-cockpit-stage-list">
        {snapshot.stages.map((stage, index) => (
          <div key={stage.id} className={`training-cockpit-stage ${stage.state}`}>
            <div className="training-cockpit-stage__rail">
              <span className="training-cockpit-stage__node">{index + 1}</span>
              {index < snapshot.stages.length - 1 ? <span className="training-cockpit-stage__connector" /> : null}
            </div>
            <div className="training-cockpit-stage__copy">
              <div className="row gap wrap align-center">
                <strong>{stage.label}</strong>
                <Badge tone={stageStateTone(stage.state)}>{stageStateLabel(stage.state, t)}</Badge>
              </div>
              <small className="muted">{stage.description}</small>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TrainingMetricPanel({ snapshot }: { snapshot: TrainingCockpitSnapshot }) {
  const { t } = useI18n();
  const [family, setFamily] = useState<'quality' | 'loss' | 'optimizer' | 'validation'>('quality');

  const seriesByFamily = useMemo<Record<typeof family, CockpitLineChartSeries[]>>(
    () => ({
      quality: [
        {
          key: 'map',
          label: 'mAP',
          color: chartPalette.cyan,
          valueAccessor: (point) => point.map
        },
        {
          key: 'accuracy',
          label: t('Accuracy'),
          color: chartPalette.green,
          valueAccessor: (point) => point.accuracy
        },
        {
          key: 'precision',
          label: t('Precision'),
          color: chartPalette.blue,
          valueAccessor: (point) => point.precision
        },
        {
          key: 'recall',
          label: t('Recall'),
          color: chartPalette.amber,
          valueAccessor: (point) => point.recall
        }
      ],
      loss: [
        {
          key: 'loss',
          label: t('Loss'),
          color: chartPalette.coral,
          valueAccessor: (point) => point.loss
        },
        {
          key: 'valLoss',
          label: t('Val loss'),
          color: chartPalette.amber,
          valueAccessor: (point) => point.valLoss
        }
      ],
      optimizer: [
        {
          key: 'learningRate',
          label: t('Learning rate'),
          color: chartPalette.violet,
          valueAccessor: (point) => point.learningRate
        }
      ],
      validation: [
        {
          key: 'valLoss',
          label: t('Val loss'),
          color: chartPalette.amber,
          valueAccessor: (point) => point.valLoss
        },
        {
          key: 'map',
          label: 'mAP',
          color: chartPalette.cyan,
          valueAccessor: (point) => point.map
        },
        {
          key: 'accuracy',
          label: t('Accuracy'),
          color: chartPalette.green,
          valueAccessor: (point) => point.accuracy
        }
      ]
    }),
    [t]
  );

  return (
    <div className="stack" data-testid="training-cockpit-metrics">
      <div className="training-cockpit-subnav">
        {(['quality', 'loss', 'optimizer', 'validation'] as const).map((item) => (
          <Button
            key={item}
            type="button"
            variant={family === item ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setFamily(item)}
            aria-pressed={family === item}
          >
            {item === 'quality'
              ? t('Quality')
              : item === 'loss'
                ? t('Loss')
                : item === 'optimizer'
                  ? t('Optimizer')
                  : t('Validation')}
          </Button>
        ))}
        <Badge tone="info">{t('{count} points', { count: snapshot.metrics.length })}</Badge>
      </div>
      <CockpitLineChart
        title={
          family === 'quality'
            ? t('Quality trends')
            : family === 'loss'
              ? t('Loss trends')
              : family === 'optimizer'
                ? t('Optimizer schedule')
                : t('Validation signals')
        }
        description={t('The chart refreshes as telemetry arrives or as demo playback advances.')}
        points={snapshot.metrics}
        series={seriesByFamily[family]}
        emptyTitle={t('No metric series yet')}
        emptyDescription={t('Switch to demo mode or wait for the first live telemetry points.')}
      />
    </div>
  );
}

function Sparkline({
  points,
  accessor,
  maxValue = 100
}: {
  points: TrainingCockpitResourcePoint[];
  accessor: (point: TrainingCockpitResourcePoint) => number | null;
  maxValue?: number;
}) {
  const values = points.map(accessor).filter((value): value is number => value !== null);
  if (values.length === 0) {
    return <div className="training-cockpit-sparkline-empty" />;
  }
  const width = 120;
  const height = 44;
  const min = 0;
  const max = Math.max(maxValue, ...values);
  const range = max - min || 1;
  const step = values.length <= 1 ? width : width / (values.length - 1);
  const polyline = values
    .map((value, index) => {
      const x = index * step;
      const y = height - ((value - min) / range) * (height - 4) - 2;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="training-cockpit-sparkline" aria-hidden="true">
      <polyline points={polyline} fill="none" stroke="rgba(126, 242, 255, 0.95)" strokeWidth="2" />
    </svg>
  );
}

function ResourceCard({
  label,
  value,
  note,
  percent,
  points,
  accessor,
  maxValue
}: {
  label: string;
  value: string;
  note: string;
  percent: number | null;
  points: TrainingCockpitResourcePoint[];
  accessor: (point: TrainingCockpitResourcePoint) => number | null;
  maxValue?: number;
}) {
  const progress = percent === null ? 0 : clamp(percent, 0, 100);
  const circumference = 2 * Math.PI * 30;
  const dashOffset = circumference - (progress / 100) * circumference;
  return (
    <article className="training-cockpit-resource-card" aria-label={label}>
      <div className="training-cockpit-resource-card__top">
        <div className="stack tight">
          <small>{label}</small>
          <strong>{value}</strong>
          <small>{note}</small>
        </div>
        <svg viewBox="0 0 80 80" className="training-cockpit-resource-card__gauge" aria-hidden="true">
          <circle cx="40" cy="40" r="30" className="training-cockpit-resource-card__track" />
          <circle
            cx="40"
            cy="40"
            r="30"
            className="training-cockpit-resource-card__progress"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
          />
          <text x="40" y="44" textAnchor="middle">
            {percent === null ? '—' : `${Math.round(progress)}%`}
          </text>
        </svg>
      </div>
      <Sparkline points={points} accessor={accessor} maxValue={maxValue} />
    </article>
  );
}

export function TrainingResourcePanel({ snapshot }: { snapshot: TrainingCockpitSnapshot }) {
  const { t } = useI18n();
  const latest = snapshot.resources.at(-1) ?? null;
  const throughput = latest?.throughput ?? null;
  const etaSeconds = latest?.etaSeconds ?? null;

  return (
    <div className="training-cockpit-panel stack" data-testid="training-cockpit-resources">
      <div className="training-cockpit-panel__header">
        <div className="stack tight">
          <h3>{t('Resource telemetry')}</h3>
          <small className="muted">
            {t('GPU, CPU, memory, throughput, and ETA stay in one compact monitoring lane.')}
          </small>
        </div>
        <Badge tone={availabilityTone(snapshot.summary.availability.resources)}>
          {availabilityLabel(snapshot.summary.availability.resources, t)}
        </Badge>
      </div>
      {snapshot.resources.length === 0 ? (
        <Panel tone="soft" className="stack tight">
          <strong>{t('No resource telemetry yet')}</strong>
          <small className="muted">{availabilityDescription(snapshot.summary.availability.resources, t)}</small>
        </Panel>
      ) : (
        <>
          <small className="muted training-cockpit-panel__note">
            {availabilityDescription(snapshot.summary.availability.resources, t)}
          </small>
          <div className="training-cockpit-resource-grid">
            <ResourceCard
              label={t('GPU util')}
              value={formatPercent(latest?.gpuUtil ?? null)}
              note={t('Compute occupancy')}
              percent={latest?.gpuUtil ?? null}
              points={snapshot.resources}
              accessor={(point) => point.gpuUtil}
            />
            <ResourceCard
              label={t('GPU memory')}
              value={formatMemory(latest?.gpuMemory ?? null, latest?.gpuMemoryTotal ?? null)}
              note={t('Reserved VRAM')}
              percent={latest?.gpuMemory !== null && latest?.gpuMemoryTotal ? (latest.gpuMemory / latest.gpuMemoryTotal) * 100 : null}
              points={snapshot.resources}
              accessor={(point) => point.gpuMemory}
              maxValue={latest?.gpuMemoryTotal ?? 24}
            />
            <ResourceCard
              label={t('CPU util')}
              value={formatPercent(latest?.cpuUtil ?? null)}
              note={t('Loader + orchestration')}
              percent={latest?.cpuUtil ?? null}
              points={snapshot.resources}
              accessor={(point) => point.cpuUtil}
            />
            <ResourceCard
              label={t('Memory util')}
              value={formatPercent(latest?.memoryUtil ?? null)}
              note={t('System memory pressure')}
              percent={latest?.memoryUtil ?? null}
              points={snapshot.resources}
              accessor={(point) => point.memoryUtil}
            />
            <ResourceCard
              label={t('Throughput')}
              value={throughput === null ? '—' : t('{value} step/s', { value: throughput.toFixed(1) })}
              note={t('Steady-state speed')}
              percent={throughput !== null ? (throughput / 22) * 100 : null}
              points={snapshot.resources}
              accessor={(point) => point.throughput}
              maxValue={22}
            />
            <ResourceCard
              label={t('ETA')}
              value={etaSeconds && etaSeconds > 0 ? formatDuration(etaSeconds, t) : t('Ready')}
              note={t('Estimated time left')}
              percent={
                etaSeconds !== null && etaSeconds > 0
                  ? clamp(100 - etaSeconds / 40, 0, 100)
                  : 100
              }
              points={snapshot.resources}
              accessor={(point) =>
                point.etaSeconds !== null ? clamp(100 - point.etaSeconds / 40, 0, 100) : null
              }
            />
          </div>
        </>
      )}
    </div>
  );
}

function TrialScoreBar({ trial, bestScore }: { trial: TrainingCockpitTrial; bestScore: number | null }) {
  const ratio =
    trial.score === null || bestScore === null || bestScore <= 0
      ? 0
      : clamp((trial.score / bestScore) * 100, 0, 100);
  return (
    <div className="training-cockpit-trial-score">
      <div className="training-cockpit-trial-score__bar">
        <span style={{ width: `${ratio}%` }} />
      </div>
      <strong>{formatScore(trial.score)}</strong>
    </div>
  );
}

function TuningConvergence({ trials }: { trials: TrainingCockpitTrial[] }) {
  const { t } = useI18n();
  const resolvedTrials = trials.filter((trial) => trial.score !== null);
  const maxScore = resolvedTrials.reduce((best, trial) => Math.max(best, trial.score ?? 0), 0);
  return (
    <div className="training-cockpit-convergence">
      <div className="training-cockpit-convergence__header">
        <strong>{t('Search convergence')}</strong>
        <small className="muted">{t('The candidate band narrows as the score frontier stabilizes.')}</small>
      </div>
      <div className="training-cockpit-convergence__rows">
        {trials.map((trial, index) => {
          const width = 78 - index * 9;
          const offset = 10 + index * 3;
          const scoreRatio = trial.score !== null && maxScore > 0 ? (trial.score / maxScore) * 100 : 0;
          return (
            <div key={trial.trialId} className={`training-cockpit-convergence__row ${trial.status}`}>
              <span className="training-cockpit-convergence__label">{trial.trialId.toUpperCase()}</span>
              <div className="training-cockpit-convergence__lane">
                <div className="training-cockpit-convergence__focus" style={{ width: `${width}%`, left: `${offset}%` }} />
                <div className="training-cockpit-convergence__score" style={{ width: `${scoreRatio}%` }} />
              </div>
              <strong>{formatScore(trial.score)}</strong>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AutoTuningPanel({ snapshot }: { snapshot: TrainingCockpitSnapshot }) {
  const { t } = useI18n();
  const [selectedTrialId, setSelectedTrialId] = useState<string | null>(
    snapshot.tuningTrials.find((trial) => trial.isBest)?.trialId ?? snapshot.tuningTrials[0]?.trialId ?? null
  );
  const [paramPulse, setParamPulse] = useState(false);

  useEffect(() => {
    if (!snapshot.summary.appliedTrialId) {
      return;
    }
    setSelectedTrialId((previous) => previous ?? snapshot.summary.appliedTrialId);
    setParamPulse(true);
    const timer = window.setTimeout(() => setParamPulse(false), 1200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [snapshot.summary.appliedTrialId]);

  useEffect(() => {
    if (snapshot.tuningTrials.length === 0) {
      setSelectedTrialId(null);
      return;
    }
    if (!selectedTrialId || !snapshot.tuningTrials.some((trial) => trial.trialId === selectedTrialId)) {
      setSelectedTrialId(
        snapshot.tuningTrials.find((trial) => trial.isBest)?.trialId ?? snapshot.tuningTrials[0].trialId
      );
    }
  }, [selectedTrialId, snapshot.tuningTrials]);

  const selectedTrial =
    snapshot.tuningTrials.find((trial) => trial.trialId === selectedTrialId) ??
    snapshot.tuningTrials.find((trial) => trial.isBest) ??
    snapshot.tuningTrials[0] ??
    null;
  const bestScore = snapshot.tuningTrials.reduce<number | null>((best, trial) => {
    if (trial.score === null) {
      return best;
    }
    return best === null ? trial.score : Math.max(best, trial.score);
  }, null);

  return (
    <div className="training-cockpit-panel stack" data-testid="training-cockpit-tuning">
      <div className="training-cockpit-panel__header">
        <div className="stack tight">
          <h3>{t('Auto tuning')}</h3>
          <small className="muted">
            {t('Generated candidates, trial outcomes, and promoted parameters stay visible here.')}
          </small>
        </div>
        <Badge tone={availabilityTone(snapshot.summary.availability.tuning)}>
          {availabilityLabel(snapshot.summary.availability.tuning, t)}
        </Badge>
      </div>

      <Panel tone="soft" className={`training-cockpit-current-params${paramPulse ? ' pulsing' : ''}`}>
        <div className="row between gap wrap align-center">
          <div className="stack tight">
            <strong>{t('Current active parameters')}</strong>
            <small className="muted">
              {snapshot.summary.autoTuningEnabled
                ? t('{strategy} · {attempt}/{total} attempts', {
                    strategy: snapshot.summary.tuningStrategy,
                    attempt: snapshot.summary.tuningAttempt,
                    total: snapshot.summary.tuningTotal
                  })
                : t('Auto tuning is currently not streaming from the backend.')}
            </small>
          </div>
          <div className="row gap wrap">
            <Badge tone={snapshot.summary.autoTuningEnabled ? 'info' : 'neutral'}>
              {snapshot.summary.autoTuningEnabled ? t('Enabled') : t('Unavailable')}
            </Badge>
            <Badge tone={snapshot.summary.recommendedParamsApplied ? 'success' : 'warning'}>
              {snapshot.summary.recommendedParamsApplied ? t('Applied') : t('Pending apply')}
            </Badge>
          </div>
        </div>
        <div className="training-cockpit-param-grid">
          {Object.entries(snapshot.summary.currentParams).map(([key, value]) => (
            <div key={key} className="training-cockpit-param-pill">
              <span>{key}</span>
              <strong>{formatParamValue(value, t)}</strong>
            </div>
          ))}
        </div>
      </Panel>

      <small className="muted training-cockpit-panel__note">
        {availabilityDescription(snapshot.summary.availability.tuning, t)}
      </small>

      {snapshot.tuningTrials.length === 0 ? (
        <Panel tone="soft" className="stack tight">
          <strong>{t('No live tuning stream yet')}</strong>
          <small className="muted">
            {t(
              'Switch to demo mode to see the full optimization animation, or wait until a related Vision Task exposes tuning history.'
            )}
          </small>
        </Panel>
      ) : (
        <>
          <div className="training-cockpit-trial-list">
            {snapshot.tuningTrials.map((trial) => (
              <button
                key={trial.trialId}
                type="button"
                className={`training-cockpit-trial-card ${trial.status}${selectedTrialId === trial.trialId ? ' selected' : ''}`}
                onClick={() => setSelectedTrialId(trial.trialId)}
                aria-pressed={selectedTrialId === trial.trialId}
                data-testid={`training-cockpit-trial-${trial.trialId}`}
              >
                <div className="row between gap wrap align-center">
                  <strong>{trial.trialId.toUpperCase()}</strong>
                  <div className="row gap wrap">
                    {trial.isBest ? <Badge tone="success">{t('Best')}</Badge> : null}
                    <Badge tone={trialStatusTone(trial.status)}>{trialStatusLabel(trial.status, t)}</Badge>
                  </div>
                </div>
                <small className="muted">{trial.note || t('Candidate parameter sweep.')}</small>
                <TrialScoreBar trial={trial} bestScore={bestScore} />
                <div className="training-cockpit-trial-delta">
                  {trial.diffFromBest === null
                    ? t('Awaiting score')
                    : trial.diffFromBest === 0
                      ? t('Current frontier')
                      : t('{delta} vs best', {
                          delta: `${trial.diffFromBest > 0 ? '+' : ''}${trial.diffFromBest.toFixed(4)}`
                        })}
                </div>
                {trial.status === 'running' ? (
                  <div className="training-cockpit-trial-progress">
                    <span style={{ width: `${Math.round(trial.progress * 100)}%` }} />
                  </div>
                ) : null}
              </button>
            ))}
          </div>

          <TuningConvergence trials={snapshot.tuningTrials} />

          {selectedTrial ? (
            <Panel tone="soft" className="stack tight">
              <div className="row between gap wrap align-center">
                <div className="stack tight">
                  <strong>{t('{trialId} details', { trialId: selectedTrial.trialId.toUpperCase() })}</strong>
                  <small className="muted">{selectedTrial.note || t('No note recorded for this trial.')}</small>
                </div>
                <Badge
                  tone={
                    selectedTrial.isBest
                      ? 'success'
                      : selectedTrial.status === 'rejected'
                        ? 'danger'
                        : selectedTrial.status === 'running'
                          ? 'info'
                          : 'neutral'
                  }
                >
                  {selectedTrial.isBest ? t('Best') : trialStatusLabel(selectedTrial.status, t)}
                </Badge>
              </div>
              <div className="row gap wrap">
                <Badge tone="info">{t('Score {score}', { score: formatScore(selectedTrial.score) })}</Badge>
                <Badge tone="neutral">
                  {selectedTrial.startTime
                    ? new Date(selectedTrial.startTime).toLocaleTimeString()
                    : t('Start pending')}
                </Badge>
                <Badge tone="neutral">
                  {selectedTrial.endTime
                    ? new Date(selectedTrial.endTime).toLocaleTimeString()
                    : t('Still active')}
                </Badge>
              </div>
              <div className="training-cockpit-param-grid">
                {Object.entries(selectedTrial.params).map(([key, value]) => (
                  <div key={`${selectedTrial.trialId}-${key}`} className="training-cockpit-param-pill compact">
                    <span>{key}</span>
                    <strong>{formatParamValue(value, t)}</strong>
                  </div>
                ))}
              </div>
            </Panel>
          ) : null}
        </>
      )}
    </div>
  );
}

export function TrainingEventStream({ events }: { events: TrainingCockpitEventLog[] }) {
  const { t } = useI18n();
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!autoScroll || !containerRef.current) {
      return;
    }
    containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [autoScroll, events]);

  return (
    <div className="training-cockpit-panel stack" data-testid="training-cockpit-events">
      <div className="training-cockpit-panel__header">
        <div className="stack tight">
          <h3>{t('Event stream')}</h3>
          <small className="muted">
            {t('Structured lifecycle events and log continuity stay together in one terminal-like lane.')}
          </small>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setAutoScroll((previous) => !previous)}
          aria-pressed={!autoScroll}
        >
          {autoScroll ? t('Pause auto-scroll') : t('Resume auto-scroll')}
        </Button>
      </div>
      <div ref={containerRef} className="training-cockpit-event-stream">
        {events.length === 0 ? (
          <div className="training-cockpit-event-row">
            <small className="muted">{t('No events yet. Switch to demo mode or wait for the first live updates.')}</small>
          </div>
        ) : (
          events.map((event) => (
            <div key={event.id} className={`training-cockpit-event-row ${event.level}${event.emphasis ? ' emphasis' : ''}`}>
              <small className="training-cockpit-event-row__time">{new Date(event.time).toLocaleTimeString()}</small>
              <Badge
                tone={
                  event.level === 'success'
                    ? 'success'
                    : event.level === 'warning'
                      ? 'warning'
                      : event.level === 'error'
                        ? 'danger'
                        : 'info'
                }
              >
                {t(event.eventType)}
              </Badge>
              <div className="training-cockpit-event-row__message">{event.message}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
