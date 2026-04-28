import type { WorkshopCharacter, WorkshopCharacterId } from '../../data/workshopDemoData';

interface ModelSelectorProps {
  characters: WorkshopCharacter[];
  selectedId: WorkshopCharacterId;
  onSelect: (characterId: WorkshopCharacterId) => void;
}

export default function ModelSelector({ characters, selectedId, onSelect }: ModelSelectorProps) {
  return (
    <section className="workshop-selector-panel" aria-label="模型角色选择">
      <div className="workshop-selector-panel__header">
        <strong>模型角色选择</strong>
        <small>场景中只会渲染当前选中的一个角色</small>
      </div>
      <div className="workshop-model-selector">
        {characters.map((character) => (
          <button
            key={character.id}
            type="button"
            className={`workshop-model-card${selectedId === character.id ? ' active' : ''}`}
            onClick={() => onSelect(character.id)}
          >
            <span className={`workshop-model-card__avatar workshop-model-card__avatar--${character.id}`} />
            <span>
              <strong>{character.name}</strong>
              <small>{character.type}</small>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
