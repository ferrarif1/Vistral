import { Badge } from '../ui/Badge';
import { Button, ButtonLink } from '../ui/Button';
import {
  workshopStages,
  type WorkshopCharacter,
  type WorkshopDataset,
  type WorkshopMetricSet,
  type WorkshopStageId
} from '../../data/workshopDemoData';

interface WorkshopStatusPanelProps {
  taskName: string;
  stage: WorkshopStageId;
  character: WorkshopCharacter;
  dataset: WorkshopDataset | null;
  validationDataset: WorkshopDataset | null;
  round: number;
  progress: number;
  metrics: WorkshopMetricSet;
  latestEvent: string;
  trainingJobsPath: string;
  onApprovePublish: () => void;
  onReturnTraining: () => void;
  onReselectDataset: () => void;
  onRetry: () => void;
}

const formatPercent = (value: number) => (value > 0 ? `${value.toFixed(1)}%` : '-');

export default function WorkshopStatusPanel({
  taskName,
  stage,
  character,
  dataset,
  validationDataset,
  round,
  progress,
  metrics,
  latestEvent,
  trainingJobsPath,
  onApprovePublish,
  onReturnTraining,
  onReselectDataset,
  onRetry
}: WorkshopStatusPanelProps) {
  const stageConfig = workshopStages[stage];
  const needsReview = stage === 'human_review_required';

  return (
    <aside className="workshop-status-panel" aria-label="训练工坊状态面板">
      <div className="workshop-status-panel__header">
        <small>当前任务</small>
        <h2>{taskName}</h2>
        <Badge tone={stage === 'failed' ? 'danger' : needsReview ? 'warning' : 'info'}>
          {stageConfig.label}
        </Badge>
      </div>

      <dl className="workshop-status-grid">
        <div>
          <dt>模型角色</dt>
          <dd>{character.name}</dd>
        </div>
        <div>
          <dt>训练数据集</dt>
          <dd>{dataset ? `${dataset.name} ${dataset.version}` : '-'}</dd>
        </div>
        <div>
          <dt>验证数据集</dt>
          <dd>{validationDataset ? `${validationDataset.name} ${validationDataset.version}` : '-'}</dd>
        </div>
        <div>
          <dt>训练轮次 / 进度</dt>
          <dd>第 {round} 轮 · {Math.round(progress)}%</dd>
        </div>
      </dl>

      <div className="workshop-metrics" aria-label="验证指标">
        <div>
          <span>准确率</span>
          <strong>{formatPercent(metrics.accuracy)}</strong>
        </div>
        <div>
          <span>召回率</span>
          <strong>{formatPercent(metrics.recall)}</strong>
        </div>
        <div>
          <span>mAP</span>
          <strong>{metrics.map > 0 ? metrics.map.toFixed(2) : '-'}</strong>
        </div>
        <div>
          <span>OCR 识别率</span>
          <strong>{formatPercent(metrics.ocrRate)}</strong>
        </div>
      </div>

      <div className="workshop-event">
        <span>最近事件</span>
        <strong>{latestEvent}</strong>
      </div>

      <div className="workshop-next-action">
        <span>下一步建议</span>
        <p>{stageConfig.nextSuggestion}</p>
      </div>

      {needsReview ? (
        <div className="workshop-review-actions">
          <Button type="button" variant="primary" size="sm" onClick={onApprovePublish}>
            通过并发布
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={onReturnTraining}>
            退回训练
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onReselectDataset}>
            重新选择数据集
          </Button>
        </div>
      ) : null}

      {stage === 'failed' ? (
        <div className="workshop-review-actions">
          <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
            重试训练
          </Button>
          <ButtonLink to={trainingJobsPath} variant="ghost" size="sm">
            查看训练任务
          </ButtonLink>
        </div>
      ) : null}
    </aside>
  );
}
