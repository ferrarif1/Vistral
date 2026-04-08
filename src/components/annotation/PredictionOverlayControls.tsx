import { Badge } from '../ui/Badge';
import { Button, ButtonLink } from '../ui/Button';
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

interface PredictionOverlayControlsProps {
  t: TranslateFn;
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
  scopedInferenceValidationPath: string;
  onShowAnnotationOverlayChange: (value: boolean) => void;
  onShowPredictionOverlayChange: (value: boolean) => void;
  onOnlyLowConfidenceChange: (value: boolean) => void;
  onPredictionConfidenceThresholdChange: (value: string) => void;
  onUsePredictionCandidate: (candidate: PredictionCandidateView) => void;
  onFocusNextLowConfidence: () => void;
  onToggleLowConfidenceTag: () => void;
}

export default function PredictionOverlayControls({
  t,
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
  scopedInferenceValidationPath,
  onShowAnnotationOverlayChange,
  onShowPredictionOverlayChange,
  onOnlyLowConfidenceChange,
  onPredictionConfidenceThresholdChange,
  onUsePredictionCandidate,
  onFocusNextLowConfidence,
  onToggleLowConfidenceTag
}: PredictionOverlayControlsProps) {
  return (
    <Card as="section">
      <div className="row between gap wrap align-center">
        <h3>{t('Prediction Compare')}</h3>
        <Badge tone={hasPredictionOverlay ? 'info' : 'neutral'}>
          {hasPredictionOverlay ? t('pre_annotation source') : t('No prediction source')}
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
        <label className="row gap wrap align-center">
          <Checkbox
            checked={onlyLowConfidenceCandidates}
            onChange={(event) => onOnlyLowConfidenceChange(event.target.checked)}
          />
          <span>{t('Only low-confidence pre-annotation candidates')}</span>
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
        {selectedItemHasLowConfidenceTag ? <Badge tone="info">#low_confidence</Badge> : null}
      </div>
      {onlyLowConfidenceCandidates ? (
        <small className="muted">
          {t('Queue is narrowed to pre-annotation samples with confidence below threshold.')}
        </small>
      ) : null}
      {showPredictionOverlay && predictionCandidates.length > 0 ? (
        <ul className="workspace-record-list compact prediction-candidate-list">
          {predictionCandidates.slice(0, 6).map((candidate) => {
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
                  {candidate.extra}
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
      {showPredictionOverlay && predictionCandidates.length > 6 ? (
        <small className="muted">
          {t('Showing first {count} prediction candidates.', { count: 6 })}
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
          ? t('Current item has pre-annotation source and can be compared in this workbench.')
          : t('Run pre-annotation or open an item generated from prediction to enable richer comparison.')}
      </small>
      <ButtonLink to={scopedInferenceValidationPath} variant="ghost" size="sm">
        {t('Open Inference Validation')}
      </ButtonLink>
    </Card>
  );
}
