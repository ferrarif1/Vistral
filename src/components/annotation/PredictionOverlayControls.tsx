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
      return t('绑定区域 {id}', { id: candidate.regionId.trim() });
    }
    return t('未绑定区域');
  }
  if (candidate.kind === 'box') {
    return rawExtra || t('框');
  }
  if (candidate.kind === 'rotated_box') {
    if (rawExtra === 'obb') {
      return t('旋转框');
    }
    if (rawExtra.startsWith('angle ')) {
      return t('角度 {value}', { value: rawExtra.slice('angle '.length) });
    }
    return rawExtra || t('旋转框');
  }
  if (candidate.kind === 'polygon') {
    const pointsMatch = rawExtra.match(/^(\d+)\s+pts$/);
    if (pointsMatch) {
      return t('{count} 个点', { count: Number(pointsMatch[1]) });
    }
    return rawExtra || t('多边形');
  }
  if (candidate.kind === 'label') {
    return t('分类标签');
  }
  return rawExtra || t('无');
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
          <h3>{t('预测对比')}</h3>
          <small className="muted">
            {hasPredictionOverlay
              ? t('对比预标注结果和当前标注。')
              : t('当前样本还没有可对比的预测结果。')}
          </small>
        </div>
        <Badge tone={hasPredictionOverlay ? 'info' : 'neutral'}>
          {hasPredictionOverlay ? t('预测已就绪') : t('暂无预测')}
        </Badge>
      </div>
      <div className="stack tight">
        <label className="row gap wrap align-center">
          <Checkbox
            checked={showAnnotationOverlay}
            onChange={(event) => onShowAnnotationOverlayChange(event.target.checked)}
          />
          <span>{t('显示标注层')}</span>
        </label>
        <label className="row gap wrap align-center">
          <Checkbox
            checked={showPredictionOverlay}
            onChange={(event) => onShowPredictionOverlayChange(event.target.checked)}
            disabled={!hasPredictionOverlay}
          />
          <span>{t('显示预测层')}</span>
        </label>
      </div>
      <label>
        {t('置信度阈值')}
        <Input
          value={predictionConfidenceThreshold}
          onChange={(event) => onPredictionConfidenceThresholdChange(event.target.value)}
          placeholder="0.50"
        />
      </label>
      <div className="row gap wrap">
        <Badge tone="neutral">
          {t('可见候选')}: {predictionCandidateCount}
        </Badge>
        <Badge tone={lowConfidencePredictionCount > 0 ? 'warning' : 'neutral'}>
          {t('低置信候选')}: {lowConfidencePredictionCount}
        </Badge>
        {selectedItemHasLowConfidenceTag ? <Badge tone="info">{t('低置信标记')}</Badge> : null}
      </div>
      {onlyLowConfidenceCandidates ? (
        <small className="muted">
          {t('当前队列仅保留低置信样本。')}
        </small>
      ) : null}
      {showPredictionOverlay && predictionCandidates.length > 0 ? (
        <ul className="workspace-record-list compact prediction-candidate-list">
          {predictionCandidates.slice(0, 4).map((candidate) => {
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
                    <Badge tone="neutral">{t('无')}</Badge>
                  )}
                </div>
                <small className="muted">
                  {formatPredictionExtra(candidate, t)}
                  {isLowConfidence ? ` · ${t('低于阈值')}` : ''}
                </small>
                {canUsePredictionInOcrEditor && candidate.kind === 'ocr_line' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => onUsePredictionCandidate(candidate)}
                    disabled={busy}
                  >
                    {t('应用到 OCR')}
                  </Button>
                ) : null}
              </Panel>
            );
          })}
        </ul>
      ) : null}
      {showPredictionOverlay && predictionCandidates.length > 4 ? (
        <small className="muted">
          {t('仅显示前 {count} 个候选。', { count: 4 })}
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
          {t('跳到下一个低置信样本')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onToggleLowConfidenceTag}
          disabled={busy || !hasSelectedItem}
        >
          {selectedItemHasLowConfidenceTag
            ? t('移除低置信标记')
            : t('标记为低置信')}
        </Button>
      </div>
      <small className="muted">
        {hasPredictionOverlay
          ? t('当前样本已带有预标注结果，可在这里对比。')
          : t('先运行预标注，再在这里查看预测对比。')}
      </small>
    </Card>
  );
}
