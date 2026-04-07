import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DatasetRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import VirtualList from '../components/VirtualList';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { Input, Select, Textarea } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceSplit
} from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const taskTypeOptions = ['ocr', 'detection', 'classification', 'segmentation', 'obb'] as const;
const datasetVirtualizationThreshold = 14;
const datasetVirtualRowHeight = 176;
const datasetVirtualViewportHeight = 620;
type LoadMode = 'initial' | 'manual';

const formatTimestamp = (iso: string): string => {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) {
    return iso;
  }

  return new Date(value).toLocaleString();
};

const getClassPreview = (classes: string[], limit = 2) => ({
  visible: classes.slice(0, limit),
  hiddenCount: Math.max(0, classes.length - limit)
});

const buildDatasetSignature = (items: DatasetRecord[]): string =>
  JSON.stringify(
    [...items]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => ({
        id: item.id,
        name: item.name,
        task_type: item.task_type,
        status: item.status,
        updated_at: item.updated_at,
        class_count: item.label_schema.classes.length
      }))
  );

export default function DatasetsPage() {
  const { t } = useI18n();
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [taskType, setTaskType] = useState<'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'>('ocr');
  const [classesText, setClassesText] = useState('text_line,table,stamp');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const datasetsSignatureRef = useRef('');

  const load = useCallback(async (mode: LoadMode = 'initial') => {
    if (mode === 'initial') {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    try {
      const result = await api.listDatasets();
      const nextSignature = buildDatasetSignature(result);
      if (datasetsSignatureRef.current !== nextSignature) {
        datasetsSignatureRef.current = nextSignature;
        setDatasets(result);
      }
      setError('');
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      if (mode === 'initial') {
        setLoading(false);
      } else {
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    load('initial').catch(() => {
      // no-op
    });
  }, [load]);

  const createDataset = async () => {
    if (!name.trim() || !description.trim()) {
      setError(t('Dataset name and description are required.'));
      return;
    }

    setSubmitting(true);
    setError('');
    setSuccess('');

    try {
      const classes = classesText
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

      const created = await api.createDataset({
        name: name.trim(),
        description: description.trim(),
        task_type: taskType,
        label_schema: {
          classes
        }
      });

      setSuccess(t('Dataset {datasetId} created.', { datasetId: created.id }));
      setName('');
      setDescription('');
      await load('manual');
    } catch (createError) {
      setError((createError as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const sortedDatasets = useMemo(
    () =>
      [...datasets].sort((left, right) => {
        const leftTime = Date.parse(left.updated_at);
        const rightTime = Date.parse(right.updated_at);
        return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
      }),
    [datasets]
  );

  const summary = useMemo(
    () => ({
      total: datasets.length,
      ready: datasets.filter((dataset) => dataset.status === 'ready').length,
      draft: datasets.filter((dataset) => dataset.status === 'draft').length,
      ocr: datasets.filter((dataset) => dataset.task_type === 'ocr').length,
      detection: datasets.filter((dataset) => dataset.task_type === 'detection').length
    }),
    [datasets]
  );

  const shouldVirtualizeDatasets = sortedDatasets.length > datasetVirtualizationThreshold;

  return (
    <WorkspacePage>
      <WorkspaceHero
        eyebrow={t('Dataset Hub')}
        title={t('Datasets')}
        description={t('Create and manage dataset assets for OCR and detection workflows.')}
        stats={[
          {
            label: t('Total'),
            value: summary.total
          },
          {
            label: t('Ready Datasets'),
            value: summary.ready
          },
          {
            label: t('Datasets by task'),
            value: `${summary.ocr} ${t('ocr')} / ${summary.detection} ${t('detection')}`
          }
        ]}
      />

      {error ? <StateBlock variant="error" title={t('Dataset Action Failed')} description={error} /> : null}
      {success ? <StateBlock variant="success" title={t('Completed')} description={success} /> : null}

      <WorkspaceMetricGrid
        items={[
          {
            title: t('Total'),
            description: t('All dataset shells currently visible to this account.'),
            value: summary.total
          },
          {
            title: t('Ready'),
            description: t('Datasets already prepared for downstream steps.'),
            value: summary.ready
          },
          {
            title: t('draft'),
            description: t('Draft dataset containers still waiting for more structure.'),
            value: summary.draft
          },
          {
            title: t('Task Type'),
            description: t('OCR and detection remain the main operational paths here.'),
            value: summary.ocr + summary.detection
          }
        ]}
      />

      <WorkspaceSplit
        main={
          <Card className="stack">
            <WorkspaceSectionHeader
              title={t('Dataset Inventory')}
              description={t('Open the dataset detail page to upload files, create splits, and version the asset.')}
              actions={
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    load('manual').catch(() => {
                      // no-op
                    });
                  }}
                  disabled={loading || refreshing}
                >
                  {loading ? t('Loading') : refreshing ? t('Refreshing...') : t('Refresh')}
                </Button>
              }
            />

            {loading ? (
              <StateBlock variant="loading" title={t('Loading Datasets')} description={t('Fetching dataset list.')} />
            ) : sortedDatasets.length === 0 ? (
              <StateBlock variant="empty" title={t('No Datasets')} description={t('Create your first dataset to begin.')} />
            ) : shouldVirtualizeDatasets ? (
              <VirtualList
                items={sortedDatasets}
                itemHeight={datasetVirtualRowHeight}
                height={datasetVirtualViewportHeight}
                itemKey={(dataset) => dataset.id}
                listClassName="workspace-record-list"
                rowClassName="workspace-record-row"
                ariaLabel={t('Dataset Inventory')}
                renderItem={(dataset) => {
                  const classPreview = getClassPreview(dataset.label_schema.classes);
                  return (
                    <div className="workspace-record-item virtualized">
                      <div className="workspace-record-item-top">
                        <div className="workspace-record-summary stack tight">
                          <strong>{dataset.name}</strong>
                          <small className="muted">
                            {t(dataset.task_type)} · {t(dataset.status)} · {t('Last updated')}:{' '}
                            {formatTimestamp(dataset.updated_at)}
                          </small>
                        </div>
                        <div className="workspace-record-actions">
                          <StatusTag status={dataset.status}>{t(dataset.status)}</StatusTag>
                          <ButtonLink variant="secondary" size="sm" to={`/datasets/${dataset.id}`}>
                            {t('Open Detail')}
                          </ButtonLink>
                        </div>
                      </div>
                      <p className="line-clamp-2">{dataset.description}</p>
                      <div className="row gap wrap">
                        <Badge tone="neutral">{t(dataset.task_type)}</Badge>
                        <Badge tone="info">
                          {t('Classes')}: {dataset.label_schema.classes.length}
                        </Badge>
                        {classPreview.visible.map((label) => (
                          <Badge key={`${dataset.id}-${label}`} tone="neutral">
                            {label}
                          </Badge>
                        ))}
                        {classPreview.hiddenCount > 0 ? (
                          <Badge tone="neutral">+{classPreview.hiddenCount}</Badge>
                        ) : null}
                      </div>
                    </div>
                  );
                }}
              />
            ) : (
              <ul className="workspace-record-list">
                {sortedDatasets.map((dataset) => {
                  const classPreview = getClassPreview(dataset.label_schema.classes);
                  return (
                    <li key={dataset.id} className="workspace-record-item">
                      <div className="workspace-record-item-top">
                        <div className="workspace-record-summary stack tight">
                          <strong>{dataset.name}</strong>
                          <small className="muted">
                            {t(dataset.task_type)} · {t(dataset.status)} · {t('Last updated')}:{' '}
                            {formatTimestamp(dataset.updated_at)}
                          </small>
                        </div>
                        <div className="workspace-record-actions">
                          <StatusTag status={dataset.status}>{t(dataset.status)}</StatusTag>
                          <ButtonLink variant="secondary" size="sm" to={`/datasets/${dataset.id}`}>
                            {t('Open Detail')}
                          </ButtonLink>
                        </div>
                      </div>
                      <p className="line-clamp-2">{dataset.description}</p>
                      <div className="row gap wrap">
                        <Badge tone="neutral">{t(dataset.task_type)}</Badge>
                        <Badge tone="info">
                          {t('Classes')}: {dataset.label_schema.classes.length}
                        </Badge>
                        {classPreview.visible.map((label) => (
                          <Badge key={`${dataset.id}-${label}`} tone="neutral">
                            {label}
                          </Badge>
                        ))}
                        {classPreview.hiddenCount > 0 ? (
                          <Badge tone="neutral">+{classPreview.hiddenCount}</Badge>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        }
        side={
          <Panel className="stack">
            <div className="stack tight">
              <h3>{t('Create Dataset')}</h3>
              <small className="muted">
                {t('Set the dataset intent first, then continue deeper in the detail workspace.')}
              </small>
            </div>

            <div className="workspace-form-grid">
              <label>
                {t('Name')}
                <Input value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label>
                {t('Task Type')}
                <Select
                  value={taskType}
                  onChange={(event) =>
                    setTaskType(
                      event.target.value as 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'
                    )
                  }
                >
                  {taskTypeOptions.map((option) => (
                    <option key={option} value={option}>
                      {t(option)}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="workspace-form-span-2">
                {t('Description')}
                <Textarea
                  value={description}
                  rows={4}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <label className="workspace-form-span-2">
                {t('Label Classes (comma separated)')}
                <Input
                  value={classesText}
                  onChange={(event) => setClassesText(event.target.value)}
                  placeholder="defect,scratch"
                />
              </label>
            </div>

            <Button onClick={createDataset} disabled={submitting} block>
              {submitting ? t('Creating...') : t('Create Dataset')}
            </Button>
          </Panel>
        }
      />
    </WorkspacePage>
  );
}
