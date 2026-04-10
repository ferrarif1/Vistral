import { useState } from 'react';
import type { ModelRecord } from '../../../shared/domain';
import { isCuratedFoundationModelName } from '../../../shared/catalogFixtures';
import StateBlock from '../StateBlock';
import VirtualList from '../VirtualList';
import { Badge, StatusTag } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Overlay';
import { Card, Panel } from '../ui/Surface';
import { WorkspaceSectionHeader } from '../ui/WorkspacePage';
import { formatCompactTimestamp } from '../../utils/formatting';

const virtualizationThreshold = 14;
const rowHeight = 192;
const viewportHeight = 620;

interface TranslateVars {
  [key: string]: string | number;
}

interface ModelInventoryProps {
  title: string;
  description: string;
  ariaLabel: string;
  loadingDescription: string;
  emptyTitle: string;
  emptyDescription: string;
  models: ModelRecord[];
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  showRefreshAction?: boolean;
  canAdminDelete?: boolean;
  deletingModelId?: string | null;
  onDeleteModel?: (model: ModelRecord) => Promise<void> | void;
  modelAuthenticityById?: Record<string, { tone: 'neutral' | 'success' | 'warning'; label: string; hint?: string }>;
  t: (source: string, vars?: TranslateVars) => string;
}

function ModelInventoryRow({
  model,
  t,
  canAdminDelete,
  deletingModelId,
  onRequestDelete,
  authenticitySummary,
  className
}: {
  model: ModelRecord;
  t: (source: string, vars?: TranslateVars) => string;
  canAdminDelete?: boolean;
  deletingModelId?: string | null;
  onRequestDelete?: (model: ModelRecord) => void;
  authenticitySummary?: { tone: 'neutral' | 'success' | 'warning'; label: string; hint?: string };
  className?: string;
}) {
  const isProtectedFoundationModel = isCuratedFoundationModelName(model.name);
  const isDeleting = deletingModelId === model.id;

  return (
    <Panel as="li" className={className ?? 'workspace-record-item'} tone="soft">
      <div className="workspace-record-item-top">
        <div className="workspace-record-summary stack tight">
          <strong>{model.name}</strong>
          <small className="muted">
            {t(model.model_type)} · {t(model.visibility)} · {t('Last updated')}:{' '}
            {formatCompactTimestamp(model.updated_at)}
          </small>
        </div>
        <div className="workspace-record-actions">
          <StatusTag status={model.status}>{t(model.status)}</StatusTag>
          {canAdminDelete && isProtectedFoundationModel ? (
            <Badge tone="neutral">{t('Protected foundation model')}</Badge>
          ) : null}
          {canAdminDelete && !isProtectedFoundationModel && onRequestDelete ? (
            <Button
              type="button"
              variant="danger"
              size="sm"
              disabled={isDeleting}
              onClick={() => onRequestDelete(model)}
            >
              {isDeleting ? t('Deleting...') : t('Delete')}
            </Button>
          ) : null}
        </div>
      </div>
      <p className="line-clamp-2">{model.description || t('No description provided.')}</p>
      <div className="row gap wrap">
        <Badge tone="neutral">
          {t('Model Type')}: {t(model.model_type)}
        </Badge>
        <Badge tone="neutral">
          {t('Visibility')}: {t(model.visibility)}
        </Badge>
        <Badge tone="info">
          {t('Created')}: {formatCompactTimestamp(model.created_at)}
        </Badge>
        {canAdminDelete && isProtectedFoundationModel ? (
          <Badge tone="info">{t('This curated base model stays available as a training foundation.')}</Badge>
        ) : null}
        {authenticitySummary ? <Badge tone={authenticitySummary.tone}>{authenticitySummary.label}</Badge> : null}
      </div>
      {authenticitySummary?.hint ? <small className="muted">{authenticitySummary.hint}</small> : null}
    </Panel>
  );
}

export default function ModelInventory({
  title,
  description,
  ariaLabel,
  loadingDescription,
  emptyTitle,
  emptyDescription,
  models,
  loading,
  refreshing,
  onRefresh,
  showRefreshAction = true,
  canAdminDelete = false,
  deletingModelId = null,
  onDeleteModel,
  modelAuthenticityById,
  t
}: ModelInventoryProps) {
  const shouldVirtualize = models.length > virtualizationThreshold;
  const [deleteCandidate, setDeleteCandidate] = useState<ModelRecord | null>(null);

  const handleConfirmDelete = async () => {
    if (!deleteCandidate || !onDeleteModel) {
      return;
    }

    await onDeleteModel(deleteCandidate);
    setDeleteCandidate(null);
  };

  return (
    <>
      <Card as="article">
        <WorkspaceSectionHeader
          title={title}
          description={description}
          actions={showRefreshAction ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onRefresh}
              disabled={loading || refreshing}
            >
              {refreshing ? t('Refreshing...') : t('Refresh')}
            </Button>
          ) : undefined}
        />

        {loading ? (
          <StateBlock variant="loading" title={t('Loading Models')} description={loadingDescription} />
        ) : models.length === 0 ? (
          <StateBlock variant="empty" title={emptyTitle} description={emptyDescription} />
        ) : shouldVirtualize ? (
          <VirtualList
            items={models}
            itemHeight={rowHeight}
            height={viewportHeight}
            itemKey={(model) => model.id}
            listClassName="workspace-record-list"
            rowClassName="workspace-record-row"
            ariaLabel={ariaLabel}
            renderItem={(model) => (
              <ModelInventoryRow
                model={model}
                t={t}
                canAdminDelete={canAdminDelete}
                deletingModelId={deletingModelId}
                onRequestDelete={onDeleteModel ? (target) => setDeleteCandidate(target) : undefined}
                authenticitySummary={modelAuthenticityById?.[model.id]}
                className="workspace-record-item virtualized"
              />
            )}
          />
        ) : (
          <ul className="workspace-record-list">
            {models.map((model) => (
              <ModelInventoryRow
                key={model.id}
                model={model}
                t={t}
                canAdminDelete={canAdminDelete}
                deletingModelId={deletingModelId}
                onRequestDelete={onDeleteModel ? (target) => setDeleteCandidate(target) : undefined}
                authenticitySummary={modelAuthenticityById?.[model.id]}
              />
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={Boolean(deleteCandidate && onDeleteModel)}
        title={t('Delete model')}
        onClose={() => {
          if (!deletingModelId) {
            setDeleteCandidate(null);
          }
        }}
      >
        <div className="stack">
          <div className="stack tight">
            <h3>{t('Delete model {modelName}?', { modelName: deleteCandidate?.name ?? '' })}</h3>
            <p className="muted">
              {t('This permanently removes the model record, model-scoped files, and related approval requests.')}
            </p>
            <p className="muted">
              {t('Deletion is blocked if model versions or conversations still reference this model.')}
            </p>
          </div>
          <div className="workspace-record-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={Boolean(deletingModelId)}
              onClick={() => setDeleteCandidate(null)}
            >
              {t('Cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={Boolean(deletingModelId)}
              onClick={() => {
                handleConfirmDelete().catch(() => {
                  // parent page handles error state
                });
              }}
            >
              {deletingModelId === deleteCandidate?.id ? t('Deleting...') : t('Delete')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
