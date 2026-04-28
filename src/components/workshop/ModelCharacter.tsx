import { useState } from 'react';
import type { WorkshopCharacter, WorkshopCharacterAction } from '../../data/workshopDemoData';

interface ModelCharacterProps {
  character: WorkshopCharacter;
  action: WorkshopCharacterAction;
  x: number;
  y: number;
  bubble: string;
}

export default function ModelCharacter({ character, action, x, y, bubble }: ModelCharacterProps) {
  const [assetFailed, setAssetFailed] = useState(false);

  return (
    <div
      className={`workshop-character workshop-character--${character.id} workshop-character--${action}`}
      style={{ left: `${x}%`, top: `${y}%` }}
      aria-label={`${character.name}: ${bubble}`}
    >
      <div className="workshop-character__bubble">{bubble}</div>
      <div className="workshop-character__sprite">
        {!assetFailed ? (
          <img src={character.asset} alt="" onError={() => setAssetFailed(true)} draggable={false} />
        ) : (
          <span className="workshop-character__fallback" aria-hidden="true">
            <span />
          </span>
        )}
      </div>
      {action === 'celebrate' ? (
        <span className="workshop-character__badge" aria-hidden="true">
          OK
        </span>
      ) : null}
      {action === 'failed' ? (
        <span className="workshop-character__warning" aria-hidden="true">
          !
        </span>
      ) : null}
    </div>
  );
}
