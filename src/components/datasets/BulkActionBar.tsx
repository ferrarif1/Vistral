import { Select, Input } from '../ui/Field';
import { Button } from '../ui/Button';

type TranslateFn = (source: string, vars?: Record<string, string | number>) => string;

interface BulkActionBarProps {
  t: TranslateFn;
  busy: boolean;
  selectedCount: number;
  batchSplit: 'keep' | 'train' | 'val' | 'test' | 'unassigned';
  batchStatus: 'keep' | 'uploading' | 'processing' | 'ready' | 'error';
  batchTagsText: string;
  onBatchSplitChange: (value: 'keep' | 'train' | 'val' | 'test' | 'unassigned') => void;
  onBatchStatusChange: (value: 'keep' | 'uploading' | 'processing' | 'ready' | 'error') => void;
  onBatchTagsTextChange: (value: string) => void;
  onApplyBatchUpdates: () => void;
}

const datasetItemSplitOptions = ['unassigned', 'train', 'val', 'test'] as const;
const datasetItemStatusOptions = ['ready', 'processing', 'uploading', 'error'] as const;

export default function BulkActionBar({
  t,
  busy,
  selectedCount,
  batchSplit,
  batchStatus,
  batchTagsText,
  onBatchSplitChange,
  onBatchStatusChange,
  onBatchTagsTextChange,
  onApplyBatchUpdates
}: BulkActionBarProps) {
  return (
    <div className="dataset-item-browser-batch">
      <div className="dataset-item-browser-toolbar compact">
        <Select
          value={batchSplit}
          onChange={(event) =>
            onBatchSplitChange(event.target.value as 'keep' | 'train' | 'val' | 'test' | 'unassigned')
          }
        >
          <option value="keep">{t('Keep current split')}</option>
          {datasetItemSplitOptions.map((option) => (
            <option key={`batch-split-${option}`} value={option}>
              {t('Set split')} · {t(option)}
            </option>
          ))}
        </Select>
        <Select
          value={batchStatus}
          onChange={(event) =>
            onBatchStatusChange(event.target.value as 'keep' | 'uploading' | 'processing' | 'ready' | 'error')
          }
        >
          <option value="keep">{t('Keep current status')}</option>
          {datasetItemStatusOptions.map((option) => (
            <option key={`batch-status-${option}`} value={option}>
              {t('Set status')} · {t(option)}
            </option>
          ))}
        </Select>
        <Input
          value={batchTagsText}
          onChange={(event) => onBatchTagsTextChange(event.target.value)}
          placeholder={t('Append tags, e.g. low_light,hard_case')}
        />
      </div>
      <div className="row between gap wrap">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={onApplyBatchUpdates}
          disabled={busy || selectedCount === 0}
        >
          {t('Apply to selected')}
        </Button>
      </div>
    </div>
  );
}
