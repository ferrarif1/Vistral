import { Button } from '../ui/Button';
import { Select } from '../ui/Field';
import type { WorkshopCharacterId, WorkshopDataset } from '../../data/workshopDemoData';

interface DatasetSelectorProps {
  datasets: WorkshopDataset[];
  selectedDatasetId: string;
  validationDatasetId: string;
  characterId: WorkshopCharacterId;
  examMode: boolean;
  onSelectDataset: (datasetId: string) => void;
  onSelectValidationDataset: (datasetId: string) => void;
  onAutoSelectValidationDataset: () => void;
  onStartExam: () => void;
}

export default function DatasetSelector({
  datasets,
  selectedDatasetId,
  validationDatasetId,
  characterId,
  examMode,
  onSelectDataset,
  onSelectValidationDataset,
  onAutoSelectValidationDataset,
  onStartExam
}: DatasetSelectorProps) {
  return (
    <section className="workshop-selector-panel" aria-label="数据集选择">
      <div className="workshop-selector-panel__header">
        <strong>数据集选择</strong>
        <small>选择后角色会进入数据集仓库整理样本</small>
      </div>

      <div className="workshop-dataset-grid">
        {datasets.map((dataset) => (
          <button
            key={dataset.id}
            type="button"
            className={`workshop-dataset-card${selectedDatasetId === dataset.id ? ' active' : ''}`}
            onClick={() => onSelectDataset(dataset.id)}
          >
            <span>
              <strong>{dataset.name}</strong>
              <small>{dataset.taskType} · {dataset.samples.toLocaleString()} samples · {dataset.version}</small>
            </span>
            {dataset.recommendedFor.includes(characterId) ? <em>推荐</em> : null}
          </button>
        ))}
      </div>

      {examMode ? (
        <div className="workshop-exam-selector">
          <label>
            <span>验证数据集</span>
            <Select value={validationDatasetId} onChange={(event) => onSelectValidationDataset(event.target.value)}>
              {datasets.map((dataset) => (
                <option key={dataset.id} value={dataset.id}>
                  {dataset.name} · {dataset.version}
                </option>
              ))}
            </Select>
          </label>
          <div className="inline-actions">
            <Button type="button" variant="secondary" size="sm" onClick={onAutoSelectValidationDataset}>
              自动选择推荐数据集
            </Button>
            <Button type="button" variant="primary" size="sm" onClick={onStartExam}>
              开始考试
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
