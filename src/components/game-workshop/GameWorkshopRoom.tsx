import type { CSSProperties } from 'react';
import { Badge } from '../ui/Badge';
import { ButtonLink } from '../ui/Button';
import type { GameWorkshopRoleStatus, GameWorkshopRoomSnapshot } from '../../features/gameWorkshopSnapshot';
import {
  getPixelWorkshopRoleAsset,
  getPixelWorkshopRoomAsset,
  getPixelWorkshopRoomFurnitureAsset,
  getPixelWorkshopScenePersonaAsset,
  pixelWorkshopFurnitureAssets,
  pixelWorkshopUiAssets
} from '../../features/pixelWorkshopAssets';

interface GameWorkshopRoomProps {
  room: GameWorkshopRoomSnapshot;
  active: boolean;
  modelRoles?: GameWorkshopRoleStatus[];
  onFocusRoom: () => void;
  onOpenDetails: () => void;
}

export default function GameWorkshopRoom({
  room,
  active,
  modelRoles = [],
  onFocusRoom,
  onOpenDetails
}: GameWorkshopRoomProps) {
  const roomAsset = getPixelWorkshopRoomAsset(room.id);
  const roomStyle = roomAsset
    ? ({ '--game-room-bg-image': `url("${roomAsset}")` } as CSSProperties & Record<'--game-room-bg-image', string>)
    : undefined;
  const furnitureAsset = getPixelWorkshopRoomFurnitureAsset(room.id);
  const scenePersonaAsset = getPixelWorkshopScenePersonaAsset(room.scene.persona);

  return (
    <article
      className={`game-room game-room--${room.accent} game-room--${room.id}${roomAsset ? ' has-room-bg' : ''}${active ? ' is-active' : ''}`}
      data-room-id={room.id}
      style={roomStyle}
    >
      <div className="game-room__header">
        <span className="game-room__number" aria-hidden="true">
          {room.number}
        </span>
        <div className="game-room__title">
          <strong>{room.title}</strong>
          <small>{room.subtitle}</small>
        </div>
        <button type="button" className="game-room__focus" onClick={onOpenDetails} aria-label={`查看 ${room.title}`}>
          详情
        </button>
      </div>
      <div
        className={`game-room__scene${roomAsset ? ' has-room-asset' : ''} persona-${room.scene.persona} device-${room.scene.device}`}
        aria-hidden="true"
      >
        {active ? (
          <img
            className="game-room__active-frame"
            src={pixelWorkshopUiAssets.activeRoomFrame}
            alt=""
            loading="lazy"
            decoding="async"
          />
        ) : null}
        <img
          className="game-room__furniture-asset"
          src={furnitureAsset}
          alt=""
          loading="lazy"
          decoding="async"
        />
        <img
          className="game-room__persona-asset"
          src={scenePersonaAsset}
          alt=""
          loading="lazy"
          decoding="async"
        />
        {room.id === 'training' ? (
          <img
            className="game-room__extra-asset game-room__extra-asset--monitor"
            src={pixelWorkshopFurnitureAssets.trainingMonitor}
            alt=""
            loading="lazy"
            decoding="async"
          />
        ) : null}
        {room.id === 'runtime' ? (
          <img
            className="game-room__extra-asset game-room__extra-asset--server"
            src={pixelWorkshopFurnitureAssets.workerNode}
            alt=""
            loading="lazy"
            decoding="async"
          />
        ) : null}
        {room.id === 'datasets' ? (
          <img
            className="game-room__extra-asset game-room__extra-asset--crates"
            src={pixelWorkshopFurnitureAssets.dataCrates}
            alt=""
            loading="lazy"
            decoding="async"
          />
        ) : null}
        <img
          className="game-room__lamp-asset"
          src={pixelWorkshopFurnitureAssets.lamp}
          alt=""
          loading="lazy"
          decoding="async"
        />
        <div className="game-room__wall-sign">
          <span />
          <span />
          <span />
        </div>
        <div className="game-room__device">
          <span />
          <span />
          <span />
        </div>
        <div className="game-room__prop game-room__prop--left" />
        <div className="game-room__prop game-room__prop--right" />
        <div className="game-room__model-roles" aria-hidden="true">
          {modelRoles.slice(0, 3).map((role) => (
            <span key={role.id} className={`game-room__model-role persona-${role.persona}`}>
              <i>
                <img src={getPixelWorkshopRoleAsset(role.persona)} alt="" loading="lazy" decoding="async" />
              </i>
              <b>{role.statusLabel}</b>
            </span>
          ))}
        </div>
        <div className="game-room__npc">
          <span className="game-room__npc-head" />
          <span className="game-room__npc-body" />
          <span className="game-room__npc-shadow" />
        </div>
        <div className="game-room__meter">
          <span>{room.scene.meterLabel}</span>
          <strong>{room.scene.meterPercent}%</strong>
          <em style={{ width: `${room.scene.meterPercent}%` }} />
        </div>
      </div>
      <p className="game-room__summary">{room.summary}</p>
      <div className="game-room__badges">
        {room.badges.map((badge) => (
          <Badge key={`${room.id}-${badge.label}`} tone={badge.tone ?? 'neutral'}>
            {badge.label}: {badge.value}
          </Badge>
        ))}
      </div>
      <ul className="game-room__details">
        {room.details.map((detail) => (
          <li key={detail}>{detail}</li>
        ))}
      </ul>
      <div className="game-room__actions">
        <button type="button" className="game-room__focus game-room__focus--secondary" onClick={onFocusRoom}>
          聚焦
        </button>
        <ButtonLink to={room.href} variant="secondary" size="sm">
          {room.primaryActionLabel}
        </ButtonLink>
      </div>
    </article>
  );
}
