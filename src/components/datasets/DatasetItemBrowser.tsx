import type { ReactNode } from 'react';
import type { DatasetItemRecord } from '../../../shared/domain';
import AdvancedSection from '../AdvancedSection';
import VirtualList from '../VirtualList';
import { Badge, StatusTag } from '../ui/Badge';
import { Button, ButtonLink } from '../ui/Button';
import { Checkbox, Input, Select } from '../ui/Field';
import { Panel } from '../ui/Surface';
import StateBlock from '../StateBlock';

type TranslateFn = (source: string, vars?: Record<string, string | number>) => string;

export interface DatasetItemBrowserProps {
  t: TranslateFn;
  busy: boolean;
  filteredItems: DatasetItemRecord[];
  selectedItemIdSet: Set<string>;
  allFilteredItemsSelected: boolean;
  selectedCount: number;
  viewMode: 'list' | 'grid';
  searchText: string;
  splitFilter: 'all' | 'train' | 'val' | 'test' | 'unassigned';
  statusFilter: 'all' | 'uploading' | 'processing' | 'ready' | 'error';
  queueFilter: 'all' | 'needs_work' | 'in_review' | 'rejected' | 'approved';
  reviewReasonFilter:
    | 'all'
    | 'box_mismatch'
    | 'label_error'
    | 'text_error'
    | 'missing_object'
    | 'polygon_issue'
    | 'other';
  metadataFilter: string;
  savedViewNameDraft: string;
  selectedSavedViewId: string;
  savedViews: Array<{ id: string; name: string }>;
  openFilteredQueuePath: string;
  batchActionBar: ReactNode;
  onSearchTextChange: (value: string) => void;
  onSplitFilterChange: (value: 'all' | 'train' | 'val' | 'test' | 'unassigned') => void;
  onStatusFilterChange: (value: 'all' | 'uploading' | 'processing' | 'ready' | 'error') => void;
  onQueueFilterChange: (value: 'all' | 'needs_work' | 'in_review' | 'rejected' | 'approved') => void;
  onReviewReasonFilterChange: (
    value:
      | 'all'
      | 'box_mismatch'
      | 'label_error'
      | 'text_error'
      | 'missing_object'
      | 'polygon_issue'
      | 'other'
  ) => void;
  onMetadataFilterChange: (value: string) => void;
  onSavedViewNameDraftChange: (value: string) => void;
  onSelectedSavedViewChange: (value: string) => void;
  onSaveCurrentView: () => void;
  onDeleteSavedView: () => void;
  onSelectAllFiltered: () => void;
  onClearSelected: () => void;
  onClearFilters: () => void;
  onViewModeChange: (value: 'list' | 'grid') => void;
  onToggleSelection: (itemId: string) => void;
  onEditItem: (item: DatasetItemRecord) => void;
  resolveItemFilename: (item: DatasetItemRecord) => string;
  resolvePreviewUrl: (item: DatasetItemRecord) => string | null;
  resolveAnnotationStatus: (itemId: string) => string;
}

const datasetItemSplitOptions = ['unassigned', 'train', 'val', 'test'] as const;
const datasetItemStatusOptions = ['ready', 'processing', 'uploading', 'error'] as const;
const sampleViewModes = ['list', 'grid'] as const;

export default function DatasetItemBrowser({
  t,
  busy,
  filteredItems,
  selectedItemIdSet,
  allFilteredItemsSelected,
  selectedCount,
  viewMode,
  searchText,
  splitFilter,
  statusFilter,
  queueFilter,
  reviewReasonFilter,
  metadataFilter,
  savedViewNameDraft,
  selectedSavedViewId,
  savedViews,
  openFilteredQueuePath,
  batchActionBar,
  onSearchTextChange,
  onSplitFilterChange,
  onStatusFilterChange,
  onQueueFilterChange,
  onReviewReasonFilterChange,
  onMetadataFilterChange,
  onSavedViewNameDraftChange,
  onSelectedSavedViewChange,
  onSaveCurrentView,
  onDeleteSavedView,
  onSelectAllFiltered,
  onClearSelected,
  onClearFilters,
  onViewModeChange,
  onToggleSelection,
  onEditItem,
  resolveItemFilename,
  resolvePreviewUrl,
  resolveAnnotationStatus
}: DatasetItemBrowserProps) {
  const shouldVirtualizeItemList = viewMode === 'list' && filteredItems.length > 10;
  const activeFilters = [
    searchText.trim() ? `${t('Search')}: ${searchText.trim()}` : '',
    splitFilter !== 'all' ? `${t('Split')}: ${t(splitFilter)}` : '',
    statusFilter !== 'all' ? `${t('Status')}: ${t(statusFilter)}` : '',
    queueFilter !== 'all' ? `${t('Queue')}: ${queueFilter === 'needs_work' ? t('Needs Work') : t(queueFilter)}` : '',
    reviewReasonFilter !== 'all' ? `${t('Review')}: ${t(reviewReasonFilter)}` : '',
    metadataFilter.trim() ? `${t('Metadata')}: ${metadataFilter.trim()}` : ''
  ].filter(Boolean);
  const hasActiveFilters = activeFilters.length > 0;

  return (
    <div className="stack">
      <Panel as="section" className="stack tight" tone="soft">
        <div className="dataset-item-browser-toolbar">
          <Input
            value={searchText}
            onChange={(event) => onSearchTextChange(event.target.value)}
            placeholder={t('Search by filename')}
          />
          <Select
            value={splitFilter}
            onChange={(event) =>
              onSplitFilterChange(event.target.value as 'all' | 'train' | 'val' | 'test' | 'unassigned')
            }
          >
            <option value="all">{t('All splits')}</option>
            {datasetItemSplitOptions.map((option) => (
              <option key={`split-filter-${option}`} value={option}>
                {t(option)}
              </option>
            ))}
          </Select>
          <Select
            value={statusFilter}
            onChange={(event) =>
              onStatusFilterChange(event.target.value as 'all' | 'uploading' | 'processing' | 'ready' | 'error')
            }
          >
            <option value="all">{t('All statuses')}</option>
            {datasetItemStatusOptions.map((option) => (
              <option key={`status-filter-${option}`} value={option}>
                {t(option)}
              </option>
            ))}
          </Select>
        </div>
        <div className="dataset-item-browser-actions">
          <div className="dataset-item-browser-active-filters">
            {hasActiveFilters ? (
              <>
                <small className="muted">{t('Active filters')}:</small>
                <div className="row gap wrap">
                  {activeFilters.map((label) => (
                    <Badge key={`active-filter-${label}`} tone="neutral">
                      {label}
                    </Badge>
                  ))}
                </div>
              </>
            ) : (
              <small className="muted">{t('No active filters')}</small>
            )}
          </div>
          <div className="row gap wrap">
            {selectedCount > 0 ? <Badge tone="info">{t('Selected')}: {selectedCount}</Badge> : null}
            <ButtonLink to={openFilteredQueuePath} variant="secondary" size="sm">
              {t('Open focused queue')}
            </ButtonLink>
            {sampleViewModes.map((mode) => (
              <Button
                key={`sample-view-${mode}`}
                type="button"
                variant={viewMode === mode ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => onViewModeChange(mode)}
                disabled={busy}
              >
                {mode === 'grid' ? t('Grid view') : t('List view')}
              </Button>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClearFilters}
              disabled={busy || !hasActiveFilters}
            >
              {t('Clear filters')}
            </Button>
          </div>
        </div>
      </Panel>

      <AdvancedSection
        title={t('Refine and curate')}
        description={t('Queue filters, metadata hints, saved views, and batch updates stay collapsed until needed.')}
      >
        <Panel as="section" className="stack tight" tone="soft">
          <div className="dataset-item-browser-toolbar compact">
            <Select
              value={queueFilter}
              onChange={(event) =>
                onQueueFilterChange(event.target.value as 'all' | 'needs_work' | 'in_review' | 'rejected' | 'approved')
              }
            >
              <option value="all">{t('All queues')}</option>
              <option value="needs_work">{t('Needs Work')}</option>
              <option value="in_review">{t('in_review')}</option>
              <option value="rejected">{t('rejected')}</option>
              <option value="approved">{t('approved')}</option>
            </Select>
            <Select
              value={reviewReasonFilter}
              onChange={(event) =>
                onReviewReasonFilterChange(
                  event.target.value as
                    | 'all'
                    | 'box_mismatch'
                    | 'label_error'
                    | 'text_error'
                    | 'missing_object'
                    | 'polygon_issue'
                    | 'other'
                )
              }
            >
              <option value="all">{t('All review reasons')}</option>
              <option value="box_mismatch">{t('box_mismatch')}</option>
              <option value="label_error">{t('label_error')}</option>
              <option value="text_error">{t('text_error')}</option>
              <option value="missing_object">{t('missing_object')}</option>
              <option value="polygon_issue">{t('polygon_issue')}</option>
              <option value="other">{t('other')}</option>
            </Select>
            <Input
              value={metadataFilter}
              onChange={(event) => onMetadataFilterChange(event.target.value)}
              placeholder={t('Metadata / tag filter')}
            />
          </div>
          <div className="row between gap wrap">
            <small className="muted">
              {selectedCount > 0
                ? t('Selected samples: {count}', { count: selectedCount })
                : t('No samples selected')}
            </small>
            <div className="row gap wrap">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={onSelectAllFiltered}
                disabled={busy || filteredItems.length === 0 || allFilteredItemsSelected}
              >
                {t('Select all filtered')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClearSelected}
                disabled={busy || selectedCount === 0}
              >
                {t('Clear selection')}
              </Button>
            </div>
          </div>
        </Panel>
        <Panel as="section" className="stack tight" tone="soft">
          {batchActionBar}
        </Panel>
        <Panel as="section" className="stack tight" tone="soft">
          <div className="dataset-item-browser-toolbar">
            <Select
              value={selectedSavedViewId}
              onChange={(event) => onSelectedSavedViewChange(event.target.value)}
            >
              <option value="">{t('Saved views')}</option>
              {savedViews.map((view) => (
                <option key={`saved-view-${view.id}`} value={view.id}>
                  {view.name}
                </option>
              ))}
            </Select>
            <Input
              value={savedViewNameDraft}
              onChange={(event) => onSavedViewNameDraftChange(event.target.value)}
              placeholder={t('Current view name')}
            />
          </div>
          <div className="row gap wrap">
            <Button type="button" variant="secondary" size="sm" onClick={onSaveCurrentView} disabled={busy}>
              {t('Save view')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDeleteSavedView}
              disabled={busy || !selectedSavedViewId}
            >
              {t('Delete view')}
            </Button>
          </div>
        </Panel>
      </AdvancedSection>

      {filteredItems.length === 0 ? (
        <StateBlock
          variant="empty"
          title={t('No samples matched')}
          description={t('Adjust search/filter criteria or clear metadata/tag filters.')}
        />
      ) : viewMode === 'grid' ? (
        <div className="dataset-item-grid">
          {filteredItems.map((item) => {
            const annotationStatus = resolveAnnotationStatus(item.id);
            const previewUrl = resolvePreviewUrl(item);
            const isSelected = selectedItemIdSet.has(item.id);

            return (
              <Panel
                key={item.id}
                as="article"
                className={`dataset-item-grid-card${isSelected ? ' selected' : ''}`}
                tone="soft"
              >
                <label className="dataset-item-grid-checkbox">
                  <Checkbox
                    checked={isSelected}
                    onChange={() => onToggleSelection(item.id)}
                    disabled={busy}
                  />
                  <span>{t('Select')}</span>
                </label>
                <Button
                  type="button"
                  className="dataset-item-grid-preview"
                  variant="ghost"
                  size="sm"
                  onClick={() => onEditItem(item)}
                >
                  {previewUrl ? (
                    <img src={previewUrl} alt={resolveItemFilename(item)} loading="lazy" />
                  ) : (
                    <span className="dataset-item-grid-placeholder">{t('Preview unavailable')}</span>
                  )}
                </Button>
                <div className="stack tight">
                  <strong className="line-clamp-1">{resolveItemFilename(item)}</strong>
                  <div className="row gap wrap">
                    <Badge tone="neutral">{t(item.split)}</Badge>
                    <StatusTag status={item.status}>{t(item.status)}</StatusTag>
                    <Badge tone="info">{t(annotationStatus)}</Badge>
                  </div>
                  <small className="muted">
                    {Object.keys(item.metadata).length > 0
                      ? t('Metadata keys: {count}', { count: Object.keys(item.metadata).length })
                      : t('No metadata')}
                  </small>
                </div>
              </Panel>
            );
          })}
        </div>
      ) : shouldVirtualizeItemList ? (
        <VirtualList
          items={filteredItems}
          itemHeight={96}
          height={420}
          ariaLabel={t('Dataset Items')}
          listClassName="workspace-record-list"
          itemKey={(item) => item.id}
          renderItem={(item) => (
            <div className="workspace-record-item virtualized">
              <div className="stack tight">
                <div className="row between gap wrap">
                  <div className="row gap align-center wrap">
                    <Checkbox
                      checked={selectedItemIdSet.has(item.id)}
                      onChange={() => onToggleSelection(item.id)}
                      disabled={busy}
                    />
                    <strong>{resolveItemFilename(item)}</strong>
                  </div>
                  <div className="row gap wrap">
                    <Badge tone="neutral">{t(item.split)}</Badge>
                    <StatusTag status={item.status}>{t(item.status)}</StatusTag>
                    <Badge tone="info">{t(resolveAnnotationStatus(item.id))}</Badge>
                  </div>
                </div>
                <div className="row between gap wrap">
                  <small className="muted">
                    {Object.keys(item.metadata).length > 0
                      ? t('Metadata keys: {count}', { count: Object.keys(item.metadata).length })
                      : t('No metadata')}
                  </small>
                  <Button size="sm" variant="ghost" onClick={() => onEditItem(item)} disabled={busy}>
                    {t('Edit Item')}
                  </Button>
                </div>
              </div>
            </div>
          )}
        />
      ) : (
        <ul className="workspace-record-list">
          {filteredItems.map((item) => (
            <Panel key={item.id} as="li" className="workspace-record-item" tone="soft">
              <div className="stack tight">
                <div className="row between gap wrap">
                  <div className="row gap align-center wrap">
                    <Checkbox
                      checked={selectedItemIdSet.has(item.id)}
                      onChange={() => onToggleSelection(item.id)}
                      disabled={busy}
                    />
                    <strong>{resolveItemFilename(item)}</strong>
                  </div>
                  <div className="row gap wrap">
                    <Badge tone="neutral">{t(item.split)}</Badge>
                    <StatusTag status={item.status}>{t(item.status)}</StatusTag>
                    <Badge tone="info">{t(resolveAnnotationStatus(item.id))}</Badge>
                  </div>
                </div>
                <div className="row between gap wrap">
                  <small className="muted">
                    {Object.keys(item.metadata).length > 0
                      ? t('Metadata keys: {count}', { count: Object.keys(item.metadata).length })
                      : t('No metadata')}
                  </small>
                  <div className="row gap wrap">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => onToggleSelection(item.id)}
                      disabled={busy}
                    >
                      {selectedItemIdSet.has(item.id) ? t('Unselect') : t('Select')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onEditItem(item)} disabled={busy}>
                      {t('Edit Item')}
                    </Button>
                  </div>
                </div>
              </div>
            </Panel>
          ))}
        </ul>
      )}
    </div>
  );
}
