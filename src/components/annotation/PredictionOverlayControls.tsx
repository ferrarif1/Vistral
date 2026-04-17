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
      return t('Bound region {id}', { id: candidate.regionId.trim() });
    }
    return t('No linked region');
  }
  if (candidate.kind === 'box') {
    return rawExtra || t('Box');
  }
  if (candidate.kind === 'rotated_box') {
    if (rawExtra === 'obb') {
      return t('Rotated Boxes');
    }
    if (rawExtra.startsWith('angle ')) {
      return t('Angle {value}', { value: rawExtra.slice('angle '.length) });
    }
    return rawExtra || t('Rotated Boxes');
  }
  if (candidate.kind === 'polygon') {
    const pointsMatch = rawExtra.match(/^(\d+)\s+pts$/);
    if (pointsMatch) {
      return t('{count} points', { count: Number(pointsMatch[1]) });
    }
    return rawExtra || t('Polygons');
  }
  if (candidate.kind === 'label') {
    return t('Label');
  }
  return rawExtra || t('none');
};

interface PredictionOverlayControlsProps {
  t: TranslateFn;
  className?: string;
  busy: boolean;
  hasPredictionOverlay: boolean;
  showAnnotationOverlay: boolean;
  showPredictionOverlay: boolean;
  predictionConfidenceThreshold: string;
  predictionCandidateCount: number;
  lowConfidencePredictionCount: number;
  predictionCandidates: PredictionCandidateView[];
  numericPredictionConfidenceThreshold: number;
  canUsePredictionInOcrEditor: boolean;
  canAdoptPrediction: boolean;
  onShowAnnotationOverlayChange: (value: boolean) => void;
  onShowPredictionOverlayChange: (value: boolean) => void;
  onPredictionConfidenceThresholdChange: (value: string) => void;
  onUsePredictionCandidate: (candidate: PredictionCandidateView) => void;
  onAdoptPredictionResults: () => void;
}

export default function PredictionOverlayControls({
  t,
  className,
  busy,
  hasPredictionOverlay,
  showAnnotationOverlay,
  showPredictionOverlay,
  predictionConfidenceThreshold,
  predictionCandidateCount,
  lowConfidencePredictionCount,
  predictionCandidates,
  numericPredictionConfidenceThreshold,
  canUsePredictionInOcrEditor,
  canAdoptPrediction,
  onShowAnnotationOverlayChange,
  onShowPredictionOverlayChange,
  onPredictionConfidenceThresholdChange,
  onUsePredictionCandidate,
  onAdoptPredictionResults
}: PredictionOverlayControlsProps) {
  return (
    <Card as="section" className={className}>
      <div className="row between gap wrap align-center">
        <div className="stack tight">
          <h3>{t('Prediction Compare')}</h3>
        </div>
        <Badge tone={hasPredictionOverlay ? 'info' : 'neutral'}>
          {hasPredictionOverlay ? t('On') : t('Off')}
        </Badge>
      </div>
      <div className="stack tight">
        <label className="row gap wrap align-center">
          <Checkbox
            checked={showAnnotationOverlay}
            onChange={(event) => onShowAnnotationOverlayChange(event.target.checked)}
          />
          <span>{t('Show canvas')}</span>
        </label>
        <label className="row gap wrap align-center">
          <Checkbox
            checked={showPredictionOverlay}
            onChange={(event) => onShowPredictionOverlayChange(event.target.checked)}
            disabled={!hasPredictionOverlay}
          />
          <span>{t('Show prediction')}</span>
        </label>
      </div>
      <label>
        {t('Threshold')}
        <Input
          value={predictionConfidenceThreshold}
          onChange={(event) => onPredictionConfidenceThresholdChange(event.target.value)}
          placeholder="0.50"
        />
      </label>
      <div className="row gap wrap">
        <Badge tone="neutral">
          {t('Candidates')}: {predictionCandidateCount}
        </Badge>
        <Badge tone={lowConfidencePredictionCount > 0 ? 'warning' : 'neutral'}>
          {t('Low confidence')}: {lowConfidencePredictionCount}
        </Badge>
      </div>
      {showPredictionOverlay && predictionCandidates.length > 0 ? (
        <details className="workspace-disclosure" open={false}>
          <summary>
            <span>{t('Top candidates')}</span>
            <Badge tone="neutral">{predictionCandidates.length}</Badge>
          </summary>
          <div className="workspace-disclosure-content">
            <ul className="workspace-record-list compact prediction-candidate-list">
              {predictionCandidates.slice(0, 3).map((candidate) => {
                const isLowConfidence =
                  candidate.confidence !== null && candidate.confidence < numericPredictionConfidenceThreshold;

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
                        <Badge tone="neutral">{t('No confidence')}</Badge>
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
                        {t('Apply to OCR')}
                      </Button>
                    ) : null}
                  </Panel>
                );
              })}
            </ul>
          </div>
        </details>
      ) : null}
      <details className="workspace-disclosure">
        <summary>
          <span>{t('Actions')}</span>
        </summary>
        <div className="workspace-disclosure-content">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onAdoptPredictionResults}
            disabled={busy || !canAdoptPrediction}
          >
            {t('Use predictions')}
          </Button>
        </div>
      </details>
    </Card>
  );
}
