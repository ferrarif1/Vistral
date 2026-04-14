import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Checkbox, Input } from '../ui/Field';
import { Card, Panel } from '../ui/Surface';

type TranslateFn = (source: string, vars?: Record<string, string | number>) => string;

export interface PredictionCandidateView {
  id: string;
  kind: 'ocr_line' | 'box' | 'rotated_box' | 'polygon' | 'label';
  title: string;
  confidence: number | null;
  extra: string;
  text?: string;
  regionId?: string | null;
}

const formatPredictionExtra = (candidate: PredictionCandidateView, t: TranslateFn): string => {
  const rawExtra = candidate.extra.trim();
  if (candidate.kind === 'ocr_line') {
    if (candidate.regionId && candidate.regionId.trim()) {
      return t('Linked region {id}', { id: candidate.regionId.trim() });
    }
    return t('No linked region');
  }
  if (candidate.kind === 'box') {
    return rawExtra || t('Bounding box');
  }
  if (candidate.kind === 'rotated_box') {
    if (rawExtra === 'obb') {
      return t('Rotated box');
    }
    if (rawExtra.startsWith('angle ')) {
      return t('Angle {value}', { value: rawExtra.slice('angle '.length) });
    }
    return rawExtra || t('Rotated box');
  }
  if (candidate.kind === 'polygon') {
    const pointsMatch = rawExtra.match(/^(\d+)\s+pts$/);
    if (pointsMatch) {
      return t('{count} points', { count: Number(pointsMatch[1]) });
    }
    return rawExtra || t('Polygon');
  }
  if (candidate.kind === 'label') {
    return t('Classification label');
  }
  return rawExtra || t('n/a');
};

interface PredictionOverlayControlsProps {
  t: TranslateFn;
  className?: string;
  busy: boolean;
  hasPredictionOverlay: boolean;
  showAnnotationOverlay: boolean;
  showPredictionOverlay: boolean;
  onlyLowConfidenceCandidates: boolean;
  predictionConfidenceThreshold: string;
  predictionCandidateCount: number;
  lowConfidencePredictionCount: number;
  selectedItemHasLowConfidenceTag: boolean;
  predictionCandidates: PredictionCandidateView[];
  numericPredictionConfidenceThreshold: number;
  canUsePredictionInOcrEditor: boolean;
  nextLowConfidenceQueueItemId: string;
  hasSelectedItem: boolean;
  onShowAnnotationOverlayChange: (value: boolean) => void;
  onShowPredictionOverlayChange: (value: boolean) => void;
  onPredictionConfidenceThresholdChange: (value: string) => void;
  onUsePredictionCandidate: (candidate: PredictionCandidateView) => void;
  onFocusNextLowConfidence: () => void;
  onToggleLowConfidenceTag: () => void;
}

export default function PredictionOverlayControls({
  t,
  className,
  busy,
  hasPredictionOverlay,
  showAnnotationOverlay,
  showPredictionOverlay,
  onlyLowConfidenceCandidates,
  predictionConfidenceThreshold,
  predictionCandidateCount,
  lowConfidencePredictionCount,
  selectedItemHasLowConfidenceTag,
  predictionCandidates,
  numericPredictionConfidenceThreshold,
  canUsePredictionInOcrEditor,
  nextLowConfidenceQueueItemId,
  hasSelectedItem,
  onShowAnnotationOverlayChange,
  onShowPredictionOverlayChange,
  onPredictionConfidenceThresholdChange,
  onUsePredictionCandidate,
  onFocusNextLowConfidence,
  onToggleLowConfidenceTag
}: PredictionOverlayControlsProps) {
  return (
    <Card as="section" className={className}>
      <div className="row between gap wrap align-center">
        <div className="stack tight">
          <h3>{t('Prediction Compare')}</h3>
          <small className="muted">
            {hasPredictionOverlay
              ? t('Use this panel to compare pre-annotation output with your current annotation.')
              : t('Prediction compare becomes available after pre-annotation or prediction feedback is attached to this sample.')}
          </small>
        </div>
        <Badge tone={hasPredictionOverlay ? 'info' : 'neutral'}>
          {hasPredictionOverlay ? t('Prediction source ready') : t('No prediction source')}
        </Badge>
      </div>
      <div className="stack tight">
        <label className="row gap wrap align-center">
          <Checkbox
            checked={showAnnotationOverlay}
            onChange={(event) => onShowAnnotationOverlayChange(event.target.checked)}
          />
          <span>{t('Show annotation overlay')}</span>
        </label>
        <label className="row gap wrap align-center">
          <Checkbox
            checked={showPredictionOverlay}
            onChange={(event) => onShowPredictionOverlayChange(event.target.checked)}
            disabled={!hasPredictionOverlay}
          />
          <span>{t('Show prediction overlay')}</span>
        </label>
      </div>
      <label>
        {t('Prediction confidence threshold')}
        <Input
          value={predictionConfidenceThreshold}
          onChange={(event) => onPredictionConfidenceThresholdChange(event.target.value)}
          placeholder="0.50"
        />
      </label>
      <div className="row gap wrap">
        <Badge tone="neutral">
          {t('Visible prediction candidates')}: {predictionCandidateCount}
        </Badge>
        <Badge tone={lowConfidencePredictionCount > 0 ? 'warning' : 'neutral'}>
          {t('Low-confidence candidates')}: {lowConfidencePredictionCount}
        </Badge>
        {selectedItemHasLowConfidenceTag ? <Badge tone="info">{t('Low-confidence tag')}</Badge> : null}
      </div>
      {onlyLowConfidenceCandidates ? (
        <small className="muted">
          {t('Queue is currently filtered to low-confidence samples only.')}
        </small>
      ) : null}
      {showPredictionOverlay && predictionCandidates.length > 0 ? (
        <ul className="workspace-record-list compact prediction-candidate-list">
          {predictionCandidates.slice(0, 4).map((candidate) => {
            const isLowConfidence =
              candidate.confidence !== null &&
              candidate.confidence < numericPredictionConfidenceThreshold;
            return (
              <Panel
                key={candidate.id}
                as="li"
                className={`workspace-record-item compact prediction-candidate-item${isLowConfidence ? ' low-confidence' : ''}`}
                tone="soft"
              >
                <div className="row between gap wrap align-center">
                  <strong className="line-clamp-1">{candidate.title}</strong>
                  {candidate.confidence !== null ? (
                    <Badge tone={isLowConfidence ? 'warning' : 'info'}>
                      {candidate.confidence.toFixed(2)}
                    </Badge>
                  ) : (
                    <Badge tone="neutral">{t('n/a')}</Badge>
                  )}
                </div>
                <small className="muted">
                  {formatPredictionExtra(candidate, t)}
                  {isLowConfidence ? ` · ${t('below threshold')}` : ''}
                </small>
                {canUsePredictionInOcrEditor && candidate.kind === 'ocr_line' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => onUsePredictionCandidate(candidate)}
                    disabled={busy}
                  >
                    {t('Use in OCR editor')}
                  </Button>
                ) : null}
              </Panel>
            );
          })}
        </ul>
      ) : null}
      {showPredictionOverlay && predictionCandidates.length > 4 ? (
        <small className="muted">
          {t('Showing first {count} prediction candidates.', { count: 4 })}
        </small>
      ) : null}
      <div className="workspace-button-stack">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onFocusNextLowConfidence}
          disabled={busy || !nextLowConfidenceQueueItemId}
        >
          {t('Focus Next Low-confidence Item')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onToggleLowConfidenceTag}
          disabled={busy || !hasSelectedItem}
        >
          {selectedItemHasLowConfidenceTag
            ? t('Remove Low-confidence Tag')
            : t('Tag Sample as Low-confidence')}
        </Button>
      </div>
      <small className="muted">
        {hasPredictionOverlay
          ? t('Current sample already carries pre-annotation output and can be reviewed here.')
          : t('Run pre-annotation first if you want prediction overlay and low-confidence triage here.')}
      </small>
    </Card>
  );
}
