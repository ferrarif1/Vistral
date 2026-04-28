import type { WorkshopRoomId, WorkshopStageId } from '../../data/workshopDemoData';

interface RoomLayerProps {
  activeRoom: WorkshopRoomId;
  stage: WorkshopStageId;
}

const rooms: Array<{
  id: Exclude<WorkshopRoomId, 'center'>;
  title: string;
  asset: string;
}> = [
  {
    id: 'dataset',
    title: '数据集仓库',
    asset: '/assets/vistral-workshop/dataset.png'
  },
  {
    id: 'training',
    title: '训练实验室',
    asset: '/assets/vistral-workshop/training.png'
  },
  {
    id: 'exam',
    title: '推理验证室',
    asset: '/assets/vistral-workshop/exam.png'
  }
];

export default function RoomLayer({ activeRoom, stage }: RoomLayerProps) {
  return (
    <div className="workshop-room-layer" aria-label="训练工坊房间">
      {rooms.map((room) => (
        <section
          key={room.id}
          className={`workshop-room workshop-room--${room.id}${activeRoom === room.id ? ' active' : ''}`}
          aria-label={room.title}
        >
          <img
            src={room.asset}
            alt=""
            draggable={false}
            className="workshop-room__asset"
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
          />
          <div className="workshop-room__header">
            <strong>{room.title}</strong>
          </div>
          <div className="workshop-room__icons" aria-hidden="true">
            {room.id === 'dataset' ? (
              <>
                <span className="workshop-icon workshop-icon--album" />
                <span className="workshop-icon workshop-icon--tape" />
                <span className="workshop-icon workshop-icon--box" />
                <span className="workshop-icon workshop-icon--tag">v</span>
              </>
            ) : null}
            {room.id === 'training' ? (
              <>
                <span className="workshop-icon workshop-icon--screen" />
                <span className="workshop-icon workshop-icon--panel" />
                <span className="workshop-icon workshop-icon--bar" />
                <span className={`workshop-icon workshop-icon--pulse ${stage === 'training' || stage === 'tuning' ? 'active' : ''}`} />
              </>
            ) : null}
            {room.id === 'exam' ? (
              <>
                <span className="workshop-icon workshop-icon--paper" />
                <span className="workshop-icon workshop-icon--target" />
                <span className="workshop-icon workshop-icon--score">92</span>
                <span className="workshop-icon workshop-icon--pass">OK</span>
              </>
            ) : null}
          </div>
        </section>
      ))}
      <div className="workshop-center-pad" aria-label="工坊中央休息点">
        <span />
      </div>
    </div>
  );
}
