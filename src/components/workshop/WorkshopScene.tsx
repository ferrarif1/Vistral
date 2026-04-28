import {
  workshopRoomPositions,
  workshopStages,
  type WorkshopCharacter,
  type WorkshopDataset,
  type WorkshopStageId
} from '../../data/workshopDemoData';
import ModelCharacter from './ModelCharacter';
import RoomLayer from './RoomLayer';

interface WorkshopSceneProps {
  stage: WorkshopStageId;
  character: WorkshopCharacter;
  dataset: WorkshopDataset | null;
  progress: number;
  round: number;
}

export default function WorkshopScene({ stage, character, dataset, progress, round }: WorkshopSceneProps) {
  const stageConfig = workshopStages[stage];
  const position = workshopRoomPositions[stageConfig.room];

  return (
    <section className="workshop-scene" aria-label="Vistral 像素训练工坊">
      <div className="workshop-scene__sky" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="workshop-house">
        <RoomLayer activeRoom={stageConfig.room} stage={stage} />
        <ModelCharacter
          character={character}
          action={stageConfig.action}
          x={position.x}
          y={position.y}
          bubble={stage === 'training' ? `训练第 ${round} 轮` : stageConfig.bubble}
        />
        {(stage === 'training' || stage === 'tuning') ? (
          <div className="workshop-training-progress" aria-label="训练进度">
            <span style={{ width: `${Math.max(4, Math.min(100, progress))}%` }} />
          </div>
        ) : null}
        {stage === 'inference_validating' ? (
          <div className="workshop-exam-ticket">
            <strong>Exam</strong>
            <small>{dataset?.name ?? '推荐验证集'}</small>
          </div>
        ) : null}
      </div>
    </section>
  );
}
