import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { DatasetRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import VirtualList from '../components/VirtualList';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { PageHeader } from '../components/ui/ConsolePage';
import { Input, Select, Textarea } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';

const taskTypeOptions = ['ocr', 'detection', 'classification', 'segmentation', 'obb'] as const;
const datasetStatusOptions = ['draft', 'ready', 'archived'] as const;
const datasetVirtualizationThreshold = 14;
const datasetVirtualRowHeight = 176;
const datasetVirtualViewportHeight = 620;
type LoadMode = 'initial' | 'manual';

const formatTimestamp = (iso: string): string => formatCompactTimestamp(iso);

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
  const [searchText, setSearchText] = useState('');
  const [taskFilter, setTaskFilter] = useState<'all' | 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'draft' | 'ready' | 'archived'>('all');
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [selectedDatasetId, setSelectedDatasetId] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const datasetsSignatureRef = useRef('');
  const createPanelRef = useRef<HTMLDetailsElement | null>(null);
  const datasetNameInputRef = useRef<HTMLInputElement | null>(null);
  const deferredSearchText = useDeferredValue(searchText);

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

  const sortedDatasets = useMemo(
    () =>
      [...datasets].sort((left, right) => {
        const leftTime = Date.parse(left.updated_at);
        const rightTime = Date.parse(right.updated_at);
        return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
      }),
    [datasets]
  );

  const filteredDatasets = useMemo(() => {
    const query = deferredSearchText.trim().toLowerCase();
    return sortedDatasets.filter((dataset) => {
      if (taskFilter !== 'all' && dataset.task_type !== taskFilter) {
        return false;
      }
      if (statusFilter !== 'all' && dataset.status !== statusFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      const classNames = dataset.label_schema.classes.join(' ').toLowerCase();
      return (
        dataset.name.toLowerCase().includes(query) ||
        dataset.description.toLowerCase().includes(query) ||
        classNames.includes(query)
      );
    });
  }, [deferredSearchText, sortedDatasets, statusFilter, taskFilter]);

  useEffect(() => {
    if (!filteredDatasets.length) {
      setSelectedDatasetId('');
      return;
    }
    if (!selectedDatasetId || !filteredDatasets.some((dataset) => dataset.id === selectedDatasetId)) {
      setSelectedDatasetId(filteredDatasets[0].id);
    }
  }, [filteredDatasets, selectedDatasetId]);

  const selectedDataset = useMemo(
    () => filteredDatasets.find((dataset) => dataset.id === selectedDatasetId) ?? null,
    [filteredDatasets, selectedDatasetId]
  );

  const shouldVirtualizeDatasets =
    viewMode === 'list' && filteredDatasets.length > datasetVirtualizationThreshold;
  const hasActiveFilters =
    deferredSearchText.trim().length > 0 || taskFilter !== 'all' || statusFilter !== 'all';

  const resetFilters = () => {
    setSearchText('');
    setTaskFilter('all');
    setStatusFilter('all');
  };

  const focusCreatePanel = () => {
    createPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => {
      datasetNameInputRef.current?.focus();
    }, 180);
  };

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

      setSuccess(t('Dataset created. Open it from the inventory to continue upload and annotation setup.'));
      setName('');
      setDescription('');
      await load('manual');
      setSelectedDatasetId(created.id);
    } catch (createError) {
      setError((createError as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const renderDatasetRecord = (dataset: DatasetRecord, as: 'div' | 'li' = 'li') => {
    const classPreview = getClassPreview(dataset.label_schema.classes);
    const selected = selectedDatasetId === dataset.id;

    return (
      <Panel
        as={as}
        key={dataset.id}
        className={`workspace-record-item dataset-inventory-record${as === 'div' ? ' virtualized' : ''}${
          selected ? ' selected' : ''
        }`}
        tone={selected ? 'accent' : 'soft'}
      >
        <button
          type="button"
          className="dataset-inventory-record-btn"
          onClick={() => setSelectedDatasetId(dataset.id)}
        >
          <div className="workspace-record-item-top">
            <div className="workspace-record-summary stack tight">
              <strong>{dataset.name}</strong>
              <small className="muted">
                {t(dataset.task_type)} · {t('Last updated')}: {formatTimestamp(dataset.updated_at)}
              </small>
            </div>
            <div className="workspace-record-actions">
              <StatusTag status={dataset.status}>{t(dataset.status)}</StatusTag>
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
            {classPreview.hiddenCount > 0 ? <Badge tone="neutral">+{classPreview.hiddenCount}</Badge> : null}
          </div>
        </button>
      </Panel>
    );
  };

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Dataset Workbench')}
        title={t('Datasets')}
        description={t('Browse dataset inventory and open one dataset at a time.')}
        primaryAction={{
          label: t('Create Dataset'),
          onClick: focusCreatePanel
        }}
        secondaryActions={
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

      {error ? <StateBlock variant="error" title={t('Dataset Action Failed')} description={error} /> : null}
      {success ? <StateBlock variant="success" title={t('Completed')} description={success} /> : null}

      <WorkspaceWorkbench
        toolbar={
          <Card as="section" className="workspace-toolbar-card">
            <div className="workspace-toolbar-head">
              <div className="workspace-toolbar-copy">
                <h3>{t('Dataset Controls')}</h3>
                <small className="muted">
                  {t('Search, segment, and refresh the dataset inventory from one stable control strip.')}
                </small>
              </div>
              <div className="workspace-toolbar-actions">
                <Button
                  type="button"
                  variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setViewMode('list')}
                >
                  {t('List')}
                </Button>
                <Button
                  type="button"
                  variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setViewMode('grid')}
                >
                  {t('Grid')}
                </Button>
                {hasActiveFilters ? (
                  <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
                    {t('Clear filters')}
                  </Button>
                ) : null}
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
              </div>
            </div>

            <div className="workspace-filter-grid">
              <label className="stack tight">
                <small className="muted">{t('Search')}</small>
                <Input
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                  placeholder={t('Search by name, description, or class')}
                />
              </label>
              <label className="stack tight">
                <small className="muted">{t('Task')}</small>
                <Select
                  value={taskFilter}
                  onChange={(event) =>
                    setTaskFilter(
                      event.target.value as
                        | 'all'
                        | 'ocr'
                        | 'detection'
                        | 'classification'
                        | 'segmentation'
                        | 'obb'
                    )
                  }
                >
                  <option value="all">{t('all')}</option>
                  {taskTypeOptions.map((option) => (
                    <option key={option} value={option}>
                      {t(option)}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="stack tight">
                <small className="muted">{t('Status')}</small>
                <Select
                  value={statusFilter}
                  onChange={(event) =>
                    setStatusFilter(event.target.value as 'all' | 'draft' | 'ready' | 'archived')
                  }
                >
                  <option value="all">{t('all')}</option>
                  {datasetStatusOptions.map((option) => (
                    <option key={option} value={option}>
                      {t(option)}
                    </option>
                  ))}
                </Select>
              </label>
            </div>

            <small className="muted">
              {t('Showing {count} datasets in inventory.', { count: filteredDatasets.length })}
            </small>
          </Card>
        }
        main={
          <div className="workspace-main-stack">
            <Card as="article">
              <WorkspaceSectionHeader
                title={t('Dataset Inventory')}
                description={t('Select one dataset to inspect details in the right inspector.')}
              />

              {loading ? (
                <StateBlock variant="loading" title={t('Loading Datasets')} description={t('Fetching dataset inventory.')} />
              ) : filteredDatasets.length === 0 ? (
                <StateBlock
                  variant="empty"
                  title={t('No Datasets')}
                  description={
                    hasActiveFilters
                      ? t('No datasets match current filters. Try adjusting search or filter conditions.')
                      : t('Create your first dataset here to start upload, split, and version preparation.')
                  }
                  extra={
                    hasActiveFilters ? (
                      <small className="muted">
                        {t('Clear search or filter chips to reveal the full dataset inventory again.')}
                      </small>
                    ) : (
                      <small className="muted">
                        {t('Use the create panel on the right to start the first dataset.')}
                      </small>
                    )
                  }
                />
              ) : viewMode === 'grid' ? (
                <div className="dataset-catalog-grid">
                  {filteredDatasets.map((dataset) => renderDatasetRecord(dataset, 'div'))}
                </div>
              ) : shouldVirtualizeDatasets ? (
                <VirtualList
                  items={filteredDatasets}
                  itemHeight={datasetVirtualRowHeight}
                  height={datasetVirtualViewportHeight}
                  itemKey={(dataset) => dataset.id}
                  listClassName="workspace-record-list"
                  rowClassName="workspace-record-row"
                  ariaLabel={t('Dataset Inventory')}
                  renderItem={(dataset) => renderDatasetRecord(dataset, 'div')}
                />
              ) : (
                <ul className="workspace-record-list">
                  {filteredDatasets.map((dataset) => renderDatasetRecord(dataset))}
                </ul>
              )}
            </Card>
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <Card as="article" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Selected Dataset')}
                description={t('Inspector panel for the current dataset selection.')}
              />

              {!selectedDataset ? (
                <StateBlock
                  variant="empty"
                  title={t('No selection')}
                  description={t('Select one dataset from the inventory to inspect and continue.')}
                />
              ) : (
                <>
                  <Panel as="section" tone="soft" className="stack tight">
                    <div className="row between gap wrap align-center">
                      <strong>{selectedDataset.name}</strong>
                      <StatusTag status={selectedDataset.status}>{t(selectedDataset.status)}</StatusTag>
                    </div>
                    <small className="muted">{selectedDataset.description}</small>
                    <div className="row gap wrap">
                      <Badge tone="neutral">{t(selectedDataset.task_type)}</Badge>
                      <Badge tone="info">
                        {t('Classes')}: {selectedDataset.label_schema.classes.length}
                      </Badge>
                    </div>
                    <small className="muted">
                      {t('Last updated')}: {formatTimestamp(selectedDataset.updated_at)}
                    </small>
                  </Panel>
                  <div className="workspace-action-cluster">
                    <ButtonLink to={`/datasets/${selectedDataset.id}`} variant="secondary" size="sm" block>
                      {t('Open Dataset Detail')}
                    </ButtonLink>
                  </div>
                </>
              )}
            </Card>

            <details ref={createPanelRef} className="workspace-disclosure workspace-inspector-card">
              <summary className="row between gap wrap align-center">
                <span>{t('Create Dataset')}</span>
              </summary>
              <div className="workspace-disclosure-content">
                <WorkspaceSectionHeader
                  title={t('Create Dataset')}
                  description={t('Create a new dataset in the side panel when you need one.')}
                />

                <div className="workspace-form-grid">
                  <label>
                    {t('Name')}
                    <Input ref={datasetNameInputRef} value={name} onChange={(event) => setName(event.target.value)} />
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
                    <Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} />
                  </label>
                  <label className="workspace-form-span-2">
                    {t('Classes')}
                    <Input
                      value={classesText}
                      onChange={(event) => setClassesText(event.target.value)}
                      placeholder={t('Comma-separated label classes')}
                    />
                  </label>
                </div>

                <Button onClick={createDataset} disabled={submitting} block>
                  {submitting ? t('Creating...') : t('Create Dataset')}
                </Button>
              </div>
            </details>
          </div>
        }
      />
    </WorkspacePage>
  );
}
