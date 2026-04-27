import type { CSSProperties } from 'react';
import { useMemo } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { Badge } from '../ui/Badge';
import type {
  TrainingCockpitDatasetPreview,
  TrainingCockpitMetricPoint,
  TrainingCockpitSnapshot,
  TrainingCockpitSummary
} from './types';

const sceneCurveWidth = 248;
const sceneCurveHeight = 84;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type ScenePreviewVariant = 'ocr' | 'detection' | 'classification' | 'segmentation';

interface SceneThumbnail {
  id: string;
  title: string;
  tag: string;
  note: string;
  variant: ScenePreviewVariant;
  isActive: boolean;
  previewUrl: string | null;
}

const parseNumericParam = (
  summary: TrainingCockpitSummary,
  key: string,
  fallback: number
): number => {
  const value = summary.currentParams[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

const formatCount = (value: number) => new Intl.NumberFormat().format(value);

const buildFallbackMetricPoints = (
  summary: TrainingCockpitSummary,
  sourceMetrics: TrainingCockpitMetricPoint[]
): TrainingCockpitMetricPoint[] => {
  if (sourceMetrics.length > 0) {
    return sourceMetrics.slice(-18);
  }

  const total = Math.max(summary.totalEpoch, 12);
  const current = Math.max(summary.currentEpoch, 1);
  return Array.from({ length: Math.min(total, 16) }, (_, index) => {
    const step = index + 1;
    const progress = step / Math.max(current, 6);
    return {
      step,
      epoch: step,
      recordedAt: summary.createdAt,
      loss: Number((1.24 - progress * 0.64 + Math.sin(step * 0.42) * 0.04).toFixed(4)),
      valLoss: Number((1.3 - progress * 0.54 + Math.cos(step * 0.37) * 0.05).toFixed(4)),
      accuracy: Number((0.54 + progress * 0.22 + Math.sin(step * 0.26) * 0.02).toFixed(4)),
      map: Number((0.48 + progress * 0.28 + Math.cos(step * 0.29) * 0.015).toFixed(4)),
      learningRate: Number((parseNumericParam(summary, 'learning_rate', 0.001) * (1 - progress * 0.72)).toFixed(6)),
      precision: Number((0.58 + progress * 0.18).toFixed(4)),
      recall: Number((0.52 + progress * 0.2).toFixed(4))
    };
  });
};

const buildLinePath = (values: number[]) => {
  if (values.length === 0) {
    return null;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values
    .map((value, index) => {
      const x = values.length <= 1 ? sceneCurveWidth / 2 : (sceneCurveWidth / (values.length - 1)) * index;
      const y = sceneCurveHeight - ((value - min) / range) * (sceneCurveHeight - 16) - 8;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
};

const pickLatestValue = (
  points: TrainingCockpitMetricPoint[],
  accessor: (point: TrainingCockpitMetricPoint) => number | null
) => {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = accessor(points[index]);
    if (value !== null) {
      return value;
    }
  }
  return null;
};

const derivePreviewVariant = (modelType: string): ScenePreviewVariant => {
  const normalized = modelType.toLowerCase();
  if (normalized.includes('ocr')) {
    return 'ocr';
  }
  if (normalized.includes('segment')) {
    return 'segmentation';
  }
  if (normalized.includes('class')) {
    return 'classification';
  }
  return 'detection';
};

const thumbSkeleton = [
  { id: 'sample-01', title: 'S-01', tag: 'hard' },
  { id: 'sample-02', title: 'S-02', tag: 'edge' },
  { id: 'sample-03', title: 'S-03', tag: 'clean' },
  { id: 'sample-04', title: 'S-04', tag: 'occl' },
  { id: 'sample-05', title: 'S-05', tag: 'rare' },
  { id: 'sample-06', title: 'S-06', tag: 'bright' },
  { id: 'sample-07', title: 'S-07', tag: 'dark' },
  { id: 'sample-08', title: 'S-08', tag: 'mix' }
] as const;

const corridorStops = ['9%', '50%', '91%'] as const;

const modelNodeBlueprint = [
  { id: 'n1', x: 42, y: 34, delay: '0s' },
  { id: 'n2', x: 88, y: 48, delay: '0.2s' },
  { id: 'n3', x: 128, y: 26, delay: '0.4s' },
  { id: 'n4', x: 190, y: 44, delay: '0.6s' },
  { id: 'n5', x: 236, y: 82, delay: '0.8s' },
  { id: 'n6', x: 242, y: 138, delay: '1s' },
  { id: 'n7', x: 190, y: 176, delay: '1.2s' },
  { id: 'n8', x: 130, y: 192, delay: '1.4s' },
  { id: 'n9', x: 72, y: 170, delay: '1.6s' },
  { id: 'n10', x: 36, y: 118, delay: '1.8s' }
] as const;

const modelLinkBlueprint = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [8, 9],
  [9, 0],
  [0, 3],
  [2, 5],
  [4, 7],
  [6, 9],
  [1, 8]
] as const;

function FluxMiniCurve({
  label,
  accent,
  values,
  latestValue,
  formatter,
  note
}: {
  label: string;
  accent: string;
  values: number[];
  latestValue: number | null;
  formatter: (value: number | null) => string;
  note: string;
}) {
  const path = useMemo(() => buildLinePath(values), [values]);
  const gradientId = `scene-gradient-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <article className="training-flux-scene__curve-card">
      <div className="training-flux-scene__curve-card-head">
        <small>{label}</small>
        <strong>{formatter(latestValue)}</strong>
      </div>
      <svg
        viewBox={`0 0 ${sceneCurveWidth} ${sceneCurveHeight}`}
        className="training-flux-scene__curve"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="1">
            <stop offset="0%" stopColor={accent} stopOpacity="0.2" />
            <stop offset="100%" stopColor={accent} stopOpacity="0.95" />
          </linearGradient>
        </defs>
        {Array.from({ length: 4 }, (_, index) => {
          const y = 10 + ((sceneCurveHeight - 20) / 3) * index;
          return (
            <line
              key={`grid-${index}`}
              x1="0"
              y1={y}
              x2={sceneCurveWidth}
              y2={y}
              stroke="rgba(218, 237, 255, 0.08)"
              strokeWidth="1"
            />
          );
        })}
        {path ? (
          <path
            d={path}
            fill="none"
            stroke={`url(#${gradientId})`}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </svg>
      <small>{note}</small>
    </article>
  );
}

function ThumbnailPreview({
  previewUrl,
  variant,
  emphasis = false
}: {
  previewUrl: string | null;
  variant: ScenePreviewVariant;
  emphasis?: boolean;
}) {
  return (
    <div className={`training-flux-scene__thumb-preview ${variant}${emphasis ? ' emphasis' : ''}`} aria-hidden="true">
      <span className="training-flux-scene__thumb-preview-bg" />
      {previewUrl ? (
        <span
          className="training-flux-scene__thumb-image"
          style={{ backgroundImage: `url("${previewUrl}")` } as CSSProperties}
        />
      ) : null}
      {variant === 'ocr' ? (
        <>
          <span className="training-flux-scene__thumb-plate" />
          <span className="training-flux-scene__thumb-text training-flux-scene__thumb-text--short" />
          <span className="training-flux-scene__thumb-text training-flux-scene__thumb-text--long" />
        </>
      ) : null}
      {variant === 'detection' ? (
        <>
          <span className="training-flux-scene__thumb-box training-flux-scene__thumb-box--a" />
          <span className="training-flux-scene__thumb-box training-flux-scene__thumb-box--b" />
        </>
      ) : null}
      {variant === 'classification' ? (
        <>
          <span className="training-flux-scene__thumb-subject" />
          <span className="training-flux-scene__thumb-label-dot" />
        </>
      ) : null}
      {variant === 'segmentation' ? (
        <>
          <span className="training-flux-scene__thumb-mask training-flux-scene__thumb-mask--a" />
          <span className="training-flux-scene__thumb-mask training-flux-scene__thumb-mask--b" />
        </>
      ) : null}
    </div>
  );
}

export default function TrainingFluxScene({ snapshot }: { snapshot: TrainingCockpitSnapshot }) {
  const { t } = useI18n();
  const metrics = useMemo(
    () => buildFallbackMetricPoints(snapshot.summary, snapshot.metrics),
    [snapshot.metrics, snapshot.summary]
  );

  const completion =
    snapshot.summary.totalEpoch > 0
      ? clamp(snapshot.summary.currentEpoch / snapshot.summary.totalEpoch, 0, 1)
      : snapshot.summary.status === 'completed'
        ? 1
        : 0.12;
  const batchSize = parseNumericParam(snapshot.summary, 'batch_size', 16);
  const imageSize = parseNumericParam(snapshot.summary, 'image_size', 736);
  const learningRate = parseNumericParam(snapshot.summary, 'learning_rate', 0.001);
  const baseFileCount = Math.max(
    720,
    Math.round(batchSize * Math.max(snapshot.summary.totalEpoch, 12) * 10 + imageSize * 1.2)
  );
  const remainingFiles =
    snapshot.summary.status === 'completed' ? 0 : Math.max(0, Math.round(baseFileCount * (1 - completion)));
  const streamedFiles = Math.max(0, baseFileCount - remainingFiles);
  const batchWindow = clamp(Math.round(batchSize / 8), 3, 4);
  const gallerySourceLength = Math.max(snapshot.datasetPreviews.length, thumbSkeleton.length, 1);
  const activeStart = (snapshot.summary.currentEpoch + snapshot.summary.tuningAttempt) % gallerySourceLength;
  const activeIndices = Array.from({ length: batchWindow }, (_, offset) =>
    (activeStart + offset) % gallerySourceLength
  );
  const activeIndexSet = new Set(activeIndices);
  const currentBatchNumber = Math.max(1, Math.ceil(Math.max(streamedFiles, batchSize) / Math.max(batchSize, 1)));
  const activeTrial =
    snapshot.tuningTrials.find((trial) => trial.status === 'running') ??
    snapshot.tuningTrials.find((trial) => trial.isBest) ??
    snapshot.tuningTrials[0] ??
    null;
  const activeModelNodeCount = clamp(
    Math.round(4 + completion * 4 + snapshot.summary.tuningAttempt * 0.4),
    4,
    modelNodeBlueprint.length
  );
  const fileFlowLabel =
    snapshot.datasetPreviewAvailability === 'real'
      ? t('Real')
      : snapshot.datasetPreviewAvailability === 'derived'
        ? t('Derived')
        : t('Unavailable');
  const taskVariant = derivePreviewVariant(snapshot.summary.modelType);
  const realThumbnailTitle = (preview: TrainingCockpitDatasetPreview, index: number) => {
    const filename = preview.filename.trim();
    if (!filename) {
      return `S-${String(index + 1).padStart(2, '0')}`;
    }
    return filename.length > 16 ? `${filename.slice(0, 13)}...` : filename;
  };
  const thumbnails: SceneThumbnail[] =
    snapshot.datasetPreviews.length > 0
      ? snapshot.datasetPreviews.map((preview, index) => ({
          id: preview.id,
          title: realThumbnailTitle(preview, index),
          tag: preview.split === 'unassigned' ? t('Pool') : preview.split.toUpperCase(),
          note: preview.source === 'real' ? t('Real sample') : t('Derived sample'),
          variant: taskVariant,
          isActive: activeIndexSet.has(index),
          previewUrl: preview.previewUrl
        }))
      : thumbSkeleton.map((item, index) => ({
          ...item,
          note:
            index % 3 === 0
              ? t('Augment')
              : index % 3 === 1
                ? t('Batch')
                : t('Focus'),
          variant: taskVariant,
          isActive: activeIndexSet.has(index),
          previewUrl: null
        }));
  const batchThumbs = thumbnails.filter((thumb) => thumb.isActive).slice(0, 3);
  const qualityAccessor = snapshot.metrics.some((point) => point.map !== null)
    ? (point: TrainingCockpitMetricPoint) => point.map
    : (point: TrainingCockpitMetricPoint) => point.accuracy;
  const qualityLabel = snapshot.metrics.some((point) => point.map !== null) ? 'mAP' : t('Accuracy');
  const recentLossValues = metrics
    .map((point) => point.loss)
    .filter((value): value is number => value !== null)
    .slice(-14);
  const recentQualityValues = metrics
    .map((point) => qualityAccessor(point))
    .filter((value): value is number => value !== null)
    .slice(-14);
  const recentLrValues = metrics
    .map((point) => point.learningRate)
    .filter((value): value is number => value !== null)
    .slice(-14);
  const latestLoss = pickLatestValue(metrics, (point) => point.loss);
  const latestQuality = pickLatestValue(metrics, qualityAccessor);
  const latestLearningRate = pickLatestValue(metrics, (point) => point.learningRate);
  const interactionSteps = [t('Batch sampled'), t('Augment + normalize'), t('Forward pass')];
  const telemetryCells = [
    { label: t('Current mini-batch'), value: String(currentBatchNumber).padStart(3, '0') },
    { label: t('Image size'), value: `${imageSize}px` },
    { label: t('Learning rate'), value: learningRate.toFixed(5) },
    { label: t('Active trial'), value: activeTrial ? activeTrial.trialId.toUpperCase() : t('Main run') }
  ];

  return (
    <section className="training-flux-scene" data-testid="training-cockpit-scene">
      <div className="training-flux-scene__header">
        <div className="stack tight">
          <h3>{t('Training flux theater')}</h3>
          <small className="muted">
            {t('A restrained cinematic control lane keeps only the active training path in motion.')}
          </small>
        </div>
        <div className="row gap wrap align-center">
          <Badge tone={snapshot.source === 'live' ? 'success' : 'warning'}>
            {snapshot.source === 'live' ? t('Live driven') : t('Demo driven')}
          </Badge>
          <Badge tone={snapshot.summary.availability.resources === 'unavailable' ? 'neutral' : 'info'}>
            {t('File flow')}: {fileFlowLabel}
          </Badge>
          <Badge tone={snapshot.summary.availability.tuning === 'unavailable' ? 'neutral' : 'success'}>
            {t('Vector field')}: {snapshot.summary.autoTuningEnabled ? t('Active') : t('Standby')}
          </Badge>
        </div>
      </div>

      <div className="training-flux-scene__theater">
        <article className="training-flux-scene__dataset-card">
          <div className="training-flux-scene__panel-head">
            <small>{snapshot.datasetLabel || t('Dataset gallery')}</small>
            <Badge tone="info">{snapshot.summary.datasetVersion}</Badge>
          </div>
          <strong>{t('Thumbnail album')}</strong>
          <div className="training-flux-scene__dataset-stats">
            <div>
              <span>{t('Remaining files')}</span>
              <strong>{formatCount(remainingFiles)}</strong>
            </div>
            <div>
              <span>{t('Current mini-batch')}</span>
              <strong>{currentBatchNumber}</strong>
            </div>
          </div>
          <div className="training-flux-scene__album" aria-hidden="true">
            {thumbnails.map((thumb) => (
              <article key={thumb.id} className={`training-flux-scene__thumb${thumb.isActive ? ' active' : ''}`}>
                <ThumbnailPreview previewUrl={thumb.previewUrl} variant={thumb.variant} emphasis={thumb.isActive} />
                <div className="training-flux-scene__thumb-meta">
                  <strong>{thumb.title}</strong>
                  <span>{thumb.tag}</span>
                </div>
                <small>{thumb.note}</small>
              </article>
            ))}
          </div>
          <div className="training-flux-scene__dataset-progress" aria-hidden="true">
            <span style={{ width: `${Math.max(8, completion * 100)}%` }} />
          </div>
          <small className="training-flux-scene__dataset-footnote">
            {snapshot.datasetPreviewAvailability === 'real'
              ? t('Real sample gallery loaded from dataset attachments; highlighted thumbnails represent the currently sampled batch.')
              : t('Thumbnail sampling and depletion are derived from run progress, but still follow batch selection -> transform -> forward-pass logic.')}
          </small>
        </article>

        <div className="training-flux-scene__stream">
          <div className="training-flux-scene__transfer-board" aria-hidden="true">
            <div className="training-flux-scene__board-head">
              <div className="stack tight">
                <small>{snapshot.summary.currentStageLabel}</small>
                <strong>{t('Sample-to-model interaction')}</strong>
              </div>
              <span className="training-flux-scene__hud-code">
                {activeTrial ? activeTrial.trialId.toUpperCase() : t('Main run')}
              </span>
            </div>

            <div className="training-flux-scene__batch-rack">
              {batchThumbs.map((thumb) => (
                <article key={`batch-${thumb.id}`} className="training-flux-scene__batch-card">
                  <ThumbnailPreview previewUrl={thumb.previewUrl} variant={thumb.variant} emphasis />
                  <div className="training-flux-scene__batch-card-meta">
                    <strong>{thumb.title}</strong>
                    <span>{t('batch slice')}</span>
                  </div>
                </article>
              ))}
            </div>

            <div className="training-flux-scene__telemetry-strip">
              {telemetryCells.map((cell) => (
                <article key={cell.label} className="training-flux-scene__telemetry-cell">
                  <small>{cell.label}</small>
                  <strong>{cell.value}</strong>
                </article>
              ))}
            </div>

            <div className="training-flux-scene__corridor">
              <span className="training-flux-scene__corridor-backdrop" />
              <span className="training-flux-scene__corridor-line" />
              <span className="training-flux-scene__corridor-sweep" />
              {interactionSteps.map((step, index) => (
                <span
                  key={step}
                  className={`training-flux-scene__corridor-node step-${index + 1}`}
                  style={{ '--node-position': corridorStops[index] } as CSSProperties}
                >
                  <b />
                  <small>{step}</small>
                </span>
              ))}
            </div>
          </div>

          <div className="training-flux-scene__stream-label">
            <span>{t('Single transfer corridor')}</span>
            <strong>{t('Sample-to-model interaction')}</strong>
            <small>
              {activeTrial
                ? t('{trialId} is guiding how the sampled gallery batch is transformed before it reaches the model core.', {
                    trialId: activeTrial.trialId.toUpperCase()
                  })
                : t('The highlighted gallery batch is being normalized and forwarded into the active model lane.')}
            </small>
          </div>
        </div>

        <article className="training-flux-scene__model-card">
          <div className="training-flux-scene__panel-head">
            <small>{t('Model core')}</small>
            <Badge tone="success">{snapshot.summary.modelVersion}</Badge>
          </div>
          <div className="training-flux-scene__model-shell" aria-hidden="true">
            <span className="training-flux-scene__model-ring training-flux-scene__model-ring--outer" />
            <span className="training-flux-scene__model-ring training-flux-scene__model-ring--inner" />
            <span className="training-flux-scene__model-pulse" />
            <svg viewBox="0 0 280 220" className="training-flux-scene__model-graph">
              {modelLinkBlueprint.map(([fromIndex, toIndex], index) => {
                const from = modelNodeBlueprint[fromIndex];
                const to = modelNodeBlueprint[toIndex];
                return (
                  <line
                    key={`link-${index + 1}`}
                    className="training-flux-scene__model-link"
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                  />
                );
              })}
              {modelNodeBlueprint.map((node, index) => (
                <circle
                  key={node.id}
                  className={`training-flux-scene__model-node${index < activeModelNodeCount ? ' active' : ''}`}
                  cx={node.x}
                  cy={node.y}
                  r={index < activeModelNodeCount ? 4.6 : 3.2}
                  style={{ '--node-delay': node.delay } as CSSProperties}
                />
              ))}
            </svg>
            <span className="training-flux-scene__model-core" />
            <span className="training-flux-scene__model-scan" />
          </div>
          <strong>{t('Optimizer response field')}</strong>
          <div className="training-flux-scene__model-stats">
            <div>
              <span>{t('Best metric')}</span>
              <strong>
                {snapshot.summary.bestMetricValue === null
                  ? '—'
                  : `${snapshot.summary.bestMetricLabel} ${snapshot.summary.bestMetricValue.toFixed(4)}`}
              </strong>
            </div>
            <div>
              <span>{t('Active params')}</span>
              <strong>{Object.keys(snapshot.summary.currentParams).length}</strong>
            </div>
          </div>
          <div className="training-flux-scene__param-pills">
            {[
              ['lr', learningRate.toFixed(5)],
              ['batch', String(batchSize)],
              ['size', String(imageSize)],
              ['trial', activeTrial ? activeTrial.trialId.toUpperCase() : '—']
            ].map(([label, value]) => (
              <span key={label} className="training-flux-scene__param-pill">
                <small>{label}</small>
                <strong>{value}</strong>
              </span>
            ))}
          </div>
          <small className="training-flux-scene__dataset-footnote">
            {t('Parameter nodes brighten as the optimizer settles; the scene should feel like a calm control room, not decorative noise.')}
          </small>
        </article>
      </div>

      <div className="training-flux-scene__curve-band">
        <FluxMiniCurve
          label={t('Loss drift')}
          accent="#ff8f79"
          values={recentLossValues}
          latestValue={latestLoss}
          formatter={(value) => (value === null ? '—' : value.toFixed(4))}
          note={t('Descending loss confirms that sampled thumbnails are still refining the weights.')}
        />
        <FluxMiniCurve
          label={qualityLabel}
          accent="#7ef2ff"
          values={recentQualityValues}
          latestValue={latestQuality}
          formatter={(value) => (value === null ? '—' : value.toFixed(4))}
          note={t('Quality uplift follows the brighter interaction between the active batch and the model core.')}
        />
        <FluxMiniCurve
          label={t('Learning rate')}
          accent="#a58bff"
          values={recentLrValues}
          latestValue={latestLearningRate}
          formatter={(value) => (value === null ? '—' : value.toFixed(6))}
          note={t('Scheduler decay and tuning changes remain readable without leaving the scene.')}
        />
      </div>
    </section>
  );
}
