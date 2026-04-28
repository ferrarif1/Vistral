import {
  workshopStages,
  workshopTimeline,
  type WorkshopStageId
} from '../../data/workshopDemoData';

interface StageTimelineProps {
  stage: WorkshopStageId;
}

export default function StageTimeline({ stage }: StageTimelineProps) {
  const currentIndex = workshopStages[stage].timelineIndex;
  const failed = stage === 'failed';

  return (
    <section className="workshop-timeline" aria-label="Vistral 训练流程时间线">
      {workshopTimeline.map((item, index) => {
        const done = !failed && index < currentIndex;
        const active = !failed && index === currentIndex;
        const retry = failed && index === workshopStages.failed.timelineIndex;
        return (
          <div
            key={item.id}
            className={[
              'workshop-timeline__item',
              done ? 'done' : '',
              active ? 'active' : '',
              retry ? 'retry' : ''
            ].filter(Boolean).join(' ')}
          >
            <span>{done ? '✓' : retry ? '↻' : index + 1}</span>
            <strong>{item.label}</strong>
          </div>
        );
      })}
    </section>
  );
}
