import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, StatusTag } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Panel } from '../ui/Surface';
import CockpitLineChart, { type CockpitLineChartSeries } from './CockpitLineChart';
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

const formatDuration = (seconds: number) => {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
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

const formatParamValue = (value: string | number | boolean) => {
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return String(value);
    }
    return value.toFixed(Math.abs(value) >= 1 ? 3 : 5);
  }
  if (typeof value === 'boolean') {
    return value ? 'On' : 'Off';
  }
  return value;
};

const availabilityTone = (value: TrainingCockpitSummary['availability']['resources']) =>
  value === 'real' ? 'success' : value === 'derived' ? 'warning' : 'neutral';

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
  return (
    <section className="training-cockpit-overview-grid">
      <OverviewCard label="Training task" value={summary.name} note={summary.modelType} accent status={summary.status} />
      <OverviewCard
        label="Dataset snapshot"
        value={summary.datasetVersion}
        note={`Model version · ${summary.modelVersion}`}
      />
      <OverviewCard
        label="Epoch progress"
        value={`${summary.currentEpoch}/${summary.totalEpoch || '—'}`}
        note={summary.currentStageLabel}
      />
      <OverviewCard
        label="Best metric"
        value={summary.bestMetricValue === null ? '—' : `${summary.bestMetricValue.toFixed(4)}`}
        note={summary.bestMetricLabel}
      />
      <OverviewCard label="Elapsed" value={formatDuration(summary.durationSeconds)} note={summary.tuningStrategy} />
      <OverviewCard label="Execution device" value={summary.deviceLabel} note="Live lane or demo GPU target" />
    </section>
  );
}

export function TrainingStageRail({ snapshot }: { snapshot: TrainingCockpitSnapshot }) {
  return (
    <div className="training-cockpit-panel training-cockpit-stage-rail">
      <div className="training-cockpit-panel__header">
        <div className="stack tight">
          <h3>Execution flow</h3>
          <small className="muted">The current run advances through one readable phase rail.</small>
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
                <Badge tone={stage.state === 'complete' ? 'success' : stage.state === 'active' ? 'info' : stage.state === 'failed' ? 'danger' : 'neutral'}>
                  {stage.state}
                </Badge>
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
          label: 'Accuracy',
          color: chartPalette.green,
          valueAccessor: (point) => point.accuracy
        },
        {
          key: 'precision',
          label: 'Precision',
          color: chartPalette.blue,
          valueAccessor: (point) => point.precision
        },
        {
          key: 'recall',
          label: 'Recall',
          color: chartPalette.amber,
          valueAccessor: (point) => point.recall
        }
      ],
      loss: [
        {
          key: 'loss',
          label: 'Loss',
          color: chartPalette.coral,
          valueAccessor: (point) => point.loss
        },
        {
          key: 'valLoss',
          label: 'Val loss',
          color: chartPalette.amber,
          valueAccessor: (point) => point.valLoss
        }
      ],
      optimizer: [
        {
          key: 'learningRate',
          label: 'Learning rate',
          color: chartPalette.violet,
          valueAccessor: (point) => point.learningRate
        }
      ],
      validation: [
        {
          key: 'valLoss',
          label: 'Val loss',
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
          label: 'Accuracy',
          color: chartPalette.green,
          valueAccessor: (point) => point.accuracy
        }
      ]
    }),
    []
  );

  return (
    <div className="stack">
      <div className="training-cockpit-subnav">
        {(['quality', 'loss', 'optimizer', 'validation'] as const).map((item) => (
          <Button
            key={item}
            type="button"
            variant={family === item ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setFamily(item)}
          >
            {item === 'quality'
              ? 'Quality'
              : item === 'loss'
                ? 'Loss'
                : item === 'optimizer'
                  ? 'Optimizer'
                  : 'Validation'}
          </Button>
        ))}
        <Badge tone="info">{snapshot.metrics.length} points</Badge>
      </div>
      <CockpitLineChart
        title={
          family === 'quality'
            ? 'Quality trends'
            : family === 'loss'
              ? 'Loss trends'
              : family === 'optimizer'
                ? 'Optimizer schedule'
                : 'Validation signals'
        }
        description="The chart refreshes as telemetry arrives or as demo playback advances."
        points={snapshot.metrics}
        series={seriesByFamily[family]}
        emptyTitle="No metric series yet"
        emptyDescription="Switch to demo mode or wait for the first live telemetry points."
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
    <article className="training-cockpit-resource-card">
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
  const latest = snapshot.resources.at(-1) ?? null;
  return (
    <div className="training-cockpit-panel stack">
      <div className="training-cockpit-panel__header">
        <div className="stack tight">
          <h3>Resource telemetry</h3>
          <small className="muted">GPU, CPU, memory, throughput, and ETA stay in one compact monitoring lane.</small>
        </div>
        <Badge tone={availabilityTone(snapshot.summary.availability.resources)}>
          {snapshot.summary.availability.resources}
        </Badge>
      </div>
      <div className="training-cockpit-resource-grid">
        <ResourceCard
          label="GPU util"
          value={formatPercent(latest?.gpuUtil ?? null)}
          note="Compute occupancy"
          percent={latest?.gpuUtil ?? null}
          points={snapshot.resources}
          accessor={(point) => point.gpuUtil}
        />
        <ResourceCard
          label="GPU memory"
          value={formatMemory(latest?.gpuMemory ?? null, latest?.gpuMemoryTotal ?? null)}
          note="Reserved VRAM"
          percent={latest?.gpuMemory !== null && latest?.gpuMemoryTotal ? (latest.gpuMemory / latest.gpuMemoryTotal) * 100 : null}
          points={snapshot.resources}
          accessor={(point) => point.gpuMemory}
          maxValue={latest?.gpuMemoryTotal ?? 24}
        />
        <ResourceCard
          label="CPU util"
          value={formatPercent(latest?.cpuUtil ?? null)}
          note="Loader + orchestration"
          percent={latest?.cpuUtil ?? null}
          points={snapshot.resources}
          accessor={(point) => point.cpuUtil}
        />
        <ResourceCard
          label="Memory util"
          value={formatPercent(latest?.memoryUtil ?? null)}
          note="System memory pressure"
          percent={latest?.memoryUtil ?? null}
          points={snapshot.resources}
          accessor={(point) => point.memoryUtil}
        />
        <ResourceCard
          label="Throughput"
          value={latest?.throughput === null ? '—' : `${latest.throughput.toFixed(1)} step/s`}
          note="Steady-state speed"
          percent={latest?.throughput !== null ? (latest.throughput / 22) * 100 : null}
          points={snapshot.resources}
          accessor={(point) => point.throughput}
          maxValue={22}
        />
        <ResourceCard
          label="ETA"
          value={latest?.etaSeconds ? formatDuration(latest.etaSeconds) : 'Ready'}
          note="Estimated time left"
          percent={
            latest?.etaSeconds !== null && latest.etaSeconds > 0
              ? clamp(100 - latest.etaSeconds / 40, 0, 100)
              : 100
          }
          points={snapshot.resources}
          accessor={(point) => (point.etaSeconds !== null ? clamp(100 - point.etaSeconds / 40, 0, 100) : null)}
        />
      </div>
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
  const resolvedTrials = trials.filter((trial) => trial.score !== null);
  const maxScore = resolvedTrials.reduce((best, trial) => Math.max(best, trial.score ?? 0), 0);
  return (
    <div className="training-cockpit-convergence">
      <div className="training-cockpit-convergence__header">
        <strong>Search convergence</strong>
        <small className="muted">The candidate band narrows as the score frontier stabilizes.</small>
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
  const [selectedTrialId, setSelectedTrialId] = useState<string | null>(snapshot.tuningTrials.find((trial) => trial.isBest)?.trialId ?? snapshot.tuningTrials[0]?.trialId ?? null);
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
      setSelectedTrialId(snapshot.tuningTrials.find((trial) => trial.isBest)?.trialId ?? snapshot.tuningTrials[0].trialId);
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
    <div className="training-cockpit-panel stack">
      <div className="training-cockpit-panel__header">
        <div className="stack tight">
          <h3>Auto tuning</h3>
          <small className="muted">Generated candidates, trial outcomes, and promoted parameters stay visible here.</small>
        </div>
        <Badge tone={availabilityTone(snapshot.summary.availability.tuning)}>{snapshot.summary.availability.tuning}</Badge>
      </div>

      <Panel tone="soft" className={`training-cockpit-current-params${paramPulse ? ' pulsing' : ''}`}>
        <div className="row between gap wrap align-center">
          <div className="stack tight">
            <strong>Current active parameters</strong>
            <small className="muted">
              {snapshot.summary.autoTuningEnabled
                ? `${snapshot.summary.tuningStrategy} · ${snapshot.summary.tuningAttempt}/${snapshot.summary.tuningTotal} attempts`
                : 'Auto tuning is currently not streaming from the backend.'}
            </small>
          </div>
          <div className="row gap wrap">
            <Badge tone={snapshot.summary.autoTuningEnabled ? 'info' : 'neutral'}>
              {snapshot.summary.autoTuningEnabled ? 'Enabled' : 'Unavailable'}
            </Badge>
            <Badge tone={snapshot.summary.recommendedParamsApplied ? 'success' : 'warning'}>
              {snapshot.summary.recommendedParamsApplied ? 'Applied' : 'Pending apply'}
            </Badge>
          </div>
        </div>
        <div className="training-cockpit-param-grid">
          {Object.entries(snapshot.summary.currentParams).map(([key, value]) => (
            <div key={key} className="training-cockpit-param-pill">
              <span>{key}</span>
              <strong>{formatParamValue(value)}</strong>
            </div>
          ))}
        </div>
      </Panel>

      {snapshot.tuningTrials.length === 0 ? (
        <Panel tone="soft" className="stack tight">
          <strong>No live tuning stream yet</strong>
          <small className="muted">
            Switch to demo mode to see the full optimization animation, or wait until a related Vision Task exposes tuning history.
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
              >
                <div className="row between gap wrap align-center">
                  <strong>{trial.trialId.toUpperCase()}</strong>
                  <div className="row gap wrap">
                    {trial.isBest ? <Badge tone="success">Best</Badge> : null}
                    <Badge tone={trial.status === 'running' ? 'info' : trial.status === 'rejected' ? 'danger' : trial.status === 'best' ? 'success' : trial.status === 'completed' ? 'neutral' : 'warning'}>
                      {trial.status}
                    </Badge>
                  </div>
                </div>
                <small className="muted">{trial.note || 'Candidate parameter sweep.'}</small>
                <TrialScoreBar trial={trial} bestScore={bestScore} />
                <div className="training-cockpit-trial-delta">
                  {trial.diffFromBest === null
                    ? 'Awaiting score'
                    : trial.diffFromBest === 0
                      ? 'Current frontier'
                      : `${trial.diffFromBest > 0 ? '+' : ''}${trial.diffFromBest.toFixed(4)} vs best`}
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
                  <strong>{selectedTrial.trialId.toUpperCase()} details</strong>
                  <small className="muted">{selectedTrial.note || 'No note recorded for this trial.'}</small>
                </div>
                <Badge tone={selectedTrial.isBest ? 'success' : selectedTrial.status === 'rejected' ? 'danger' : selectedTrial.status === 'running' ? 'info' : 'neutral'}>
                  {selectedTrial.isBest ? 'Best' : selectedTrial.status}
                </Badge>
              </div>
              <div className="row gap wrap">
                <Badge tone="info">Score {formatScore(selectedTrial.score)}</Badge>
                <Badge tone="neutral">{selectedTrial.startTime ? new Date(selectedTrial.startTime).toLocaleTimeString() : 'Start pending'}</Badge>
                <Badge tone="neutral">{selectedTrial.endTime ? new Date(selectedTrial.endTime).toLocaleTimeString() : 'Still active'}</Badge>
              </div>
              <div className="training-cockpit-param-grid">
                {Object.entries(selectedTrial.params).map(([key, value]) => (
                  <div key={`${selectedTrial.trialId}-${key}`} className="training-cockpit-param-pill compact">
                    <span>{key}</span>
                    <strong>{formatParamValue(value)}</strong>
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
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!autoScroll || !containerRef.current) {
      return;
    }
    containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [autoScroll, events]);

  return (
    <div className="training-cockpit-panel stack">
      <div className="training-cockpit-panel__header">
        <div className="stack tight">
          <h3>Event stream</h3>
          <small className="muted">Structured lifecycle events and log continuity stay together in one terminal-like lane.</small>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setAutoScroll((previous) => !previous)}>
          {autoScroll ? 'Pause auto-scroll' : 'Resume auto-scroll'}
        </Button>
      </div>
      <div ref={containerRef} className="training-cockpit-event-stream">
        {events.length === 0 ? (
          <div className="training-cockpit-event-row">
            <small className="muted">No events yet. Switch to demo mode or wait for the first live updates.</small>
          </div>
        ) : (
          events.map((event) => (
            <div key={event.id} className={`training-cockpit-event-row ${event.level}${event.emphasis ? ' emphasis' : ''}`}>
              <small className="training-cockpit-event-row__time">
                {new Date(event.time).toLocaleTimeString()}
              </small>
              <Badge tone={event.level === 'success' ? 'success' : event.level === 'warning' ? 'warning' : event.level === 'error' ? 'danger' : 'info'}>
                {event.eventType}
              </Badge>
              <div className="training-cockpit-event-row__message">{event.message}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
