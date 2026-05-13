import { ButtonLink } from '../ui/Button';
import type { GameWorkshopTimelineEvent } from '../../features/gameWorkshopSnapshot';

interface GameWorkshopTimelineProps {
  events: GameWorkshopTimelineEvent[];
}

export default function GameWorkshopTimeline({ events }: GameWorkshopTimelineProps) {
  return (
    <>
      {events.length === 0 ? (
        <p className="game-workshop-empty">当前还没有可展示的事件。</p>
      ) : (
        <ol className="game-workshop-timeline">
          {events.map((event) => (
            <li key={event.id} className={`game-workshop-timeline__item tone-${event.tone}`}>
              <div className="game-workshop-timeline__time">{event.at}</div>
              <div className="game-workshop-timeline__body">
                <strong>{event.title}</strong>
                <span>{event.detail}</span>
              </div>
              <ButtonLink to={event.href} variant="ghost" size="sm">
                查看
              </ButtonLink>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
