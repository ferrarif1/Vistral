import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import StateBlock from '../components/StateBlock';
import {
  AutoTuningPanel,
  TrainingCockpitOverview,
  TrainingEventStream,
  TrainingFluxScene,
  TrainingMetricPanel,
  TrainingResourcePanel,
  TrainingStageRail
} from '../components/training-cockpit/Panels';
import useTrainingCockpit from '../components/training-cockpit/useTrainingCockpit';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { InlineAlert, PageHeader } from '../components/ui/ConsolePage';
import { Panel } from '../components/ui/Surface';
import { WorkspaceContextBar, WorkspacePage, WorkspaceWorkbench } from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';

const availabilityTone = (value: 'real' | 'derived' | 'unavailable') =>
  value === 'real' ? 'success' : value === 'derived' ? 'warning' : 'neutral';

const sanitizeReturnToPath = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('://')) {
    return null;
  }
  return trimmed;
};

export default function TrainingCockpitPage() {
  const { t } = useI18n();
  const { jobId } = useParams<{ jobId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedMode = searchParams.get('mode') === 'demo' ? 'demo' : 'live';
  const controller = useTrainingCockpit(jobId, requestedMode);

  useEffect(() => {
    if (controller.mode !== requestedMode) {
      controller.setMode(requestedMode);
    }
  }, [controller, requestedMode]);

  const updateMode = (mode: 'live' | 'demo') => {
    const next = new URLSearchParams(searchParams);
    next.set('mode', mode);
    setSearchParams(next, { replace: true });
    controller.setMode(mode);
  };

  const cleanDetailParams = new URLSearchParams(searchParams);
  cleanDetailParams.delete('mode');
  const detailQuery = cleanDetailParams.toString();
  const detailPath = jobId
    ? detailQuery
      ? `/training/jobs/${encodeURIComponent(jobId)}?${detailQuery}`
      : `/training/jobs/${encodeURIComponent(jobId)}`
    : '/training/jobs';
  const requestedReturnTo = sanitizeReturnToPath(searchParams.get('return_to'));
  const backPath = requestedReturnTo ?? detailPath;
  const availabilityLabel = (value: 'real' | 'derived' | 'unavailable') =>
    value === 'real' ? t('Real') : value === 'derived' ? t('Derived') : t('Unavailable');

  if (!jobId) {
    return (
      <WorkspacePage>
        <PageHeader
          eyebrow={t('Training cockpit')}
          title={t('Training Cockpit')}
          description={t('Open this page from a training job so telemetry can be visualized.')}
          secondaryActions={
            <ButtonLink to="/training/jobs" variant="ghost" size="sm">
              {t('Open Training Jobs')}
            </ButtonLink>
          }
        />
        <StateBlock variant="error" title={t('Missing Job ID')} description={t('Open from training jobs list.')} />
      </WorkspacePage>
    );
  }

  if (controller.status === 'loading' && !controller.snapshot) {
    return (
      <WorkspacePage>
        <PageHeader
          eyebrow={t('Training cockpit')}
          title={t('Training Cockpit')}
          description={t('Preparing the visualization workspace for this run.')}
          secondaryActions={
            <ButtonLink to={backPath} variant="ghost" size="sm">
              {t('Back to job detail')}
            </ButtonLink>
          }
        />
        <StateBlock variant="loading" title={t('Loading')} description={t('Fetching training telemetry.')} />
      </WorkspacePage>
    );
  }

  if (controller.status === 'error' && !controller.snapshot) {
    return (
      <WorkspacePage>
        <PageHeader
          eyebrow={t('Training cockpit')}
          title={t('Training Cockpit')}
          description={t('Live telemetry could not be loaded for this run.')}
          secondaryActions={
            <div className="row gap wrap">
              <ButtonLink to={backPath} variant="ghost" size="sm">
                {t('Back to job detail')}
              </ButtonLink>
              <Button type="button" variant="secondary" size="sm" onClick={() => updateMode('demo')}>
                {t('Open Demo Mode')}
              </Button>
            </div>
          }
        />
        <StateBlock variant="error" title={t('Load Failed')} description={controller.error} />
      </WorkspacePage>
    );
  }

  const snapshot = controller.snapshot;
  if (!snapshot) {
    return null;
  }

  return (
    <WorkspacePage className="training-cockpit-route" data-testid="training-cockpit-page">
      <PageHeader
        eyebrow={t('Training cockpit')}
        title={snapshot.summary.name}
        description={t('A visual execution surface for training progress, telemetry, tuning, and event flow.')}
        meta={
          <div className="row gap wrap align-center">
            <Badge tone="info">{snapshot.summary.modelType}</Badge>
            <Badge tone={snapshot.source === 'live' ? 'success' : 'warning'}>
              {snapshot.source === 'live' ? t('Live mode') : t('Demo mode')}
            </Badge>
            <Badge tone="neutral">{snapshot.summary.datasetVersion}</Badge>
            <Badge tone="neutral">
              {t('Last updated')}: {new Date(snapshot.lastUpdatedAt).toLocaleTimeString()}
            </Badge>
          </div>
        }
        primaryAction={{
          label:
            controller.mode === 'live'
              ? controller.status === 'loading'
                ? t('Refreshing...')
                : t('Refresh')
              : t('Replay'),
          onClick: () => {
            if (controller.mode === 'live') {
              void controller.refreshLive();
            } else {
              controller.replay();
            }
          },
          loading: controller.mode === 'live' && controller.status === 'loading'
        }}
        secondaryActions={
          <div className="row gap wrap">
            <ButtonLink to={detailPath} variant="secondary" size="sm">
              {t('Job detail')}
            </ButtonLink>
            <ButtonLink to={backPath} variant="ghost" size="sm">
              {t('Back')}
            </ButtonLink>
          </div>
        }
      />

      {controller.mode === 'live' && controller.error ? (
        <InlineAlert
          tone="warning"
          title={t('Live lane is degraded')}
          description={controller.error}
          actions={
            <Button type="button" variant="ghost" size="sm" onClick={() => updateMode('demo')}>
              {t('Fallback to demo mode')}
            </Button>
          }
        />
      ) : null}

      <div className="training-cockpit-shell">
        <WorkspaceWorkbench
          className="training-cockpit-workbench"
          toolbar={
            <WorkspaceContextBar
              leading={
                <div className="row gap wrap align-center">
                  <Button
                    type="button"
                    variant={controller.mode === 'live' ? 'secondary' : 'ghost'}
                    size="sm"
                    onClick={() => updateMode('live')}
                    aria-pressed={controller.mode === 'live'}
                    data-testid="training-cockpit-mode-live"
                  >
                    {t('Live mode')}
                  </Button>
                  <Button
                    type="button"
                    variant={controller.mode === 'demo' ? 'secondary' : 'ghost'}
                    size="sm"
                    onClick={() => updateMode('demo')}
                    aria-pressed={controller.mode === 'demo'}
                    data-testid="training-cockpit-mode-demo"
                  >
                    {t('Demo mode')}
                  </Button>
                  {controller.mode === 'demo' ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={controller.isPlaying ? controller.pause : controller.play}
                        data-testid="training-cockpit-demo-play-toggle"
                      >
                        {controller.isPlaying ? t('Pause') : t('Play')}
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={controller.replay} data-testid="training-cockpit-demo-replay">
                        {t('Replay')}
                      </Button>
                      {[1, 2, 4].map((speed) => (
                        <Button
                          key={`speed-${speed}`}
                          type="button"
                          variant={controller.speed === speed ? 'secondary' : 'ghost'}
                          size="sm"
                          onClick={() => controller.setSpeed(speed as 1 | 2 | 4)}
                          aria-pressed={controller.speed === speed}
                          data-testid={`training-cockpit-demo-speed-${speed}`}
                        >
                          {speed}x
                        </Button>
                      ))}
                    </>
                  ) : null}
                </div>
              }
              trailing={
                <div className="row gap wrap align-center">
                  <Badge
                    tone={availabilityTone(snapshot.summary.availability.resources)}
                    data-testid="training-cockpit-availability-resources"
                  >
                    {t('Resources')}: {availabilityLabel(snapshot.summary.availability.resources)}
                  </Badge>
                  <Badge
                    tone={availabilityTone(snapshot.summary.availability.tuning)}
                    data-testid="training-cockpit-availability-tuning"
                  >
                    {t('Tuning')}: {availabilityLabel(snapshot.summary.availability.tuning)}
                  </Badge>
                  {controller.mode === 'demo' ? (
                    <Badge tone={controller.isPlaying ? 'info' : snapshot.summary.status === 'completed' ? 'success' : 'neutral'}>
                      {controller.isPlaying
                        ? t('Demo playing')
                        : snapshot.summary.status === 'completed'
                          ? t('Demo finished')
                          : t('Demo paused')}
                    </Badge>
                  ) : null}
                </div>
              }
              summary={
                <Panel tone="soft" className="training-cockpit-context-summary">
                  <div className="row between gap wrap align-center">
                    <div className="stack tight">
                      <strong>
                        {snapshot.summary.currentStageLabel} · {snapshot.summary.currentEpoch}/{snapshot.summary.totalEpoch || '—'} {t('epochs')}
                      </strong>
                      <small className="muted">
                        {snapshot.summary.bestMetricLabel}: {snapshot.summary.bestMetricValue === null ? '—' : snapshot.summary.bestMetricValue.toFixed(4)} · {snapshot.summary.deviceLabel}
                      </small>
                    </div>
                    <div className="row gap wrap">
                      <Badge tone="info">{snapshot.summary.tuningStrategy}</Badge>
                      <Badge tone={snapshot.summary.recommendedParamsApplied ? 'success' : 'warning'}>
                        {snapshot.summary.recommendedParamsApplied ? t('Promoted config active') : t('Searching next config')}
                      </Badge>
                    </div>
                  </div>
                </Panel>
              }
            />
          }
          main={
            <div className="training-cockpit-main stack">
              <TrainingFluxScene snapshot={snapshot} />
              <TrainingCockpitOverview summary={snapshot.summary} />
              <div className="training-cockpit-core-grid">
                <TrainingStageRail snapshot={snapshot} />
                <div className="training-cockpit-core-stack">
                  <TrainingMetricPanel snapshot={snapshot} />
                  <TrainingResourcePanel snapshot={snapshot} />
                </div>
              </div>
            </div>
          }
          side={<AutoTuningPanel snapshot={snapshot} />}
        />
        <TrainingEventStream events={snapshot.events} />
      </div>
    </WorkspacePage>
  );
}
