import { useEffect, useMemo, useState } from 'react';
import type { ModelRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import VirtualList from '../components/VirtualList';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { Card, Panel } from '../components/ui/Surface';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const readyStatusSet = new Set<ModelRecord['status']>(['approved', 'published']);
const modelsVirtualizationThreshold = 14;
const modelsVirtualRowHeight = 168;
const modelsVirtualViewportHeight = 620;

const formatTimestamp = (iso: string): string => {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) {
    return iso;
  }

  return new Date(value).toLocaleString();
};

export default function ModelsExplorePage() {
  const { t } = useI18n();
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const result = await api.listModels();
      setModels(result);
      setError('');
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load().catch(() => {
      // no-op
    });
  }, []);

  const sortedModels = useMemo(
    () =>
      [...models].sort((left, right) => {
        const leftTime = Date.parse(left.updated_at);
        const rightTime = Date.parse(right.updated_at);
        return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
      }),
    [models]
  );

  const summary = useMemo(
    () => ({
      total: models.length,
      ready: models.filter((model) => readyStatusSet.has(model.status)).length,
      pending: models.filter((model) => model.status === 'pending_approval').length,
      publicCount: models.filter((model) => model.visibility === 'public').length,
      workspaceCount: models.filter((model) => model.visibility === 'workspace').length,
      privateCount: models.filter((model) => model.visibility === 'private').length,
      sharedCount: models.filter((model) => model.visibility === 'workspace' || model.visibility === 'public').length
    }),
    [models]
  );

  const shouldVirtualizeModels = sortedModels.length > modelsVirtualizationThreshold;

  return (
    <div className="workspace-overview-page stack">
      <Card className="workspace-overview-hero">
        <div className="workspace-overview-hero-grid">
          <div className="workspace-overview-copy stack">
            <small className="workspace-eyebrow">{t('Model Catalog')}</small>
            <h1>{t('Models Explore')}</h1>
            <p className="muted">
              {t('Scan shared and approved models before jumping into training or inference.')}
            </p>
          </div>
          <div className="workspace-overview-badges">
            <div className="workspace-overview-badge">
              <span>{t('Visible catalog')}</span>
              <strong>{summary.total}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Ready for use')}</span>
              <strong>{summary.ready}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Shared access')}</span>
              <strong>{summary.sharedCount}</strong>
            </div>
          </div>
        </div>
      </Card>

      {error ? <StateBlock variant="error" title={t('Load Failed')} description={error} /> : null}

      <section className="workspace-overview-signal-grid">
        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Visible catalog')}</h3>
            <small className="muted">
              {t('Models visible right now across public and workspace scopes.')}
            </small>
          </div>
          <strong className="metric">{summary.total}</strong>
        </Card>
        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Ready for use')}</h3>
            <small className="muted">
              {t('Approved or published models that are ready for downstream use.')}
            </small>
          </div>
          <strong className="metric">{summary.ready}</strong>
        </Card>
        <Card as="article" className={`workspace-signal-card${summary.pending > 0 ? ' attention' : ''}`}>
          <div className="workspace-signal-top">
            <h3>{t('Pending review')}</h3>
            <small className="muted">
              {t('Models still waiting for governance review or publication.')}
            </small>
          </div>
          <strong className="metric">{summary.pending}</strong>
        </Card>
        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Public reach')}</h3>
            <small className="muted">
              {t('Models visible across broader workspace sharing settings.')}
            </small>
          </div>
          <strong className="metric">{summary.publicCount}</strong>
        </Card>
      </section>

      <section className="workspace-overview-panel-grid">
        <Card as="article" className="workspace-overview-main">
          <div className="workspace-section-header">
            <div className="stack tight">
              <h3>{t('Visible Model Inventory')}</h3>
              <small className="muted">
                {t('Browse the currently visible catalog, then jump into your own models or version registration.')}
              </small>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                load().catch(() => {
                  // no-op
                });
              }}
              disabled={loading}
            >
              {loading ? t('Loading') : t('Refresh')}
            </Button>
          </div>

          {loading ? (
            <StateBlock variant="loading" title={t('Loading Models')} description={t('Fetching model catalog.')} />
          ) : sortedModels.length === 0 ? (
            <StateBlock
              variant="empty"
              title={t('No visible models yet.')}
              description={t('Visible models will appear here after creation or approval.')}
            />
          ) : shouldVirtualizeModels ? (
            <VirtualList
              items={sortedModels}
              itemHeight={modelsVirtualRowHeight}
              height={modelsVirtualViewportHeight}
              itemKey={(model) => model.id}
              listClassName="workspace-record-list"
              rowClassName="workspace-record-row"
              ariaLabel={t('Visible Model Inventory')}
              renderItem={(model) => (
                <Panel className="workspace-record-item virtualized" tone="soft">
                  <div className="workspace-record-item-top">
                    <div className="workspace-record-summary stack tight">
                      <strong>{model.name}</strong>
                      <small className="muted">
                        {t(model.model_type)} · {t(model.visibility)} · {t('Last updated')}: {formatTimestamp(model.updated_at)}
                      </small>
                    </div>
                    <div className="workspace-record-actions">
                      <StatusTag status={model.status}>{t(model.status)}</StatusTag>
                    </div>
                  </div>
                  <p className="line-clamp-2">{model.description || t('No description provided.')}</p>
                  <div className="row gap wrap">
                    <Badge tone="info">
                      {t('owner')}: {model.owner_user_id}
                    </Badge>
                    <Badge tone="neutral">
                      {t('Visibility')}: {t(model.visibility)}
                    </Badge>
                    <Badge tone="neutral">
                      {t('Model Type')}: {t(model.model_type)}
                    </Badge>
                  </div>
                </Panel>
              )}
            />
          ) : (
            <ul className="workspace-record-list">
              {sortedModels.map((model) => (
                <Panel key={model.id} as="li" className="workspace-record-item" tone="soft">
                  <div className="workspace-record-item-top">
                    <div className="workspace-record-summary stack tight">
                      <strong>{model.name}</strong>
                      <small className="muted">
                        {t(model.model_type)} · {t(model.visibility)} · {t('Last updated')}: {formatTimestamp(model.updated_at)}
                      </small>
                    </div>
                    <div className="workspace-record-actions">
                      <StatusTag status={model.status}>{t(model.status)}</StatusTag>
                    </div>
                  </div>
                  <p className="line-clamp-2">{model.description || t('No description provided.')}</p>
                  <div className="row gap wrap">
                    <Badge tone="info">
                      {t('owner')}: {model.owner_user_id}
                    </Badge>
                    <Badge tone="neutral">
                      {t('Visibility')}: {t(model.visibility)}
                    </Badge>
                    <Badge tone="neutral">
                      {t('Model Type')}: {t(model.model_type)}
                    </Badge>
                  </div>
                </Panel>
              ))}
            </ul>
          )}
        </Card>

        <div className="workspace-overview-side">
          <Card as="article">
            <div className="stack tight">
              <h3>{t('Next actions')}</h3>
              <small className="muted">
                {t('Move from exploration to ownership, creation, or version follow-up without losing context.')}
              </small>
            </div>
            <div className="workspace-button-stack">
              <ButtonLink to="/models/create" variant="secondary" size="sm">
                {t('Create model draft')}
              </ButtonLink>
              <ButtonLink to="/models/my-models" variant="secondary" size="sm">
                {t('Inspect my models')}
              </ButtonLink>
              <ButtonLink to="/models/versions" variant="secondary" size="sm">
                {t('Review versions')}
              </ButtonLink>
            </div>
          </Card>

          <Card as="article">
            <div className="stack tight">
              <h3>{t('Catalog mix')}</h3>
              <small className="muted">
                {t('Visibility and governance split for the models currently shown here.')}
              </small>
            </div>
            <ul className="workspace-record-list compact">
              <Panel as="li" className="workspace-record-item compact" tone="soft">
                <div className="row between gap wrap">
                  <strong>{t('Public reach')}</strong>
                  <Badge tone="neutral">{summary.publicCount}</Badge>
                </div>
                <small className="muted">{t('Shared across the broadest audience scope.')}</small>
              </Panel>
              <Panel as="li" className="workspace-record-item compact" tone="soft">
                <div className="row between gap wrap">
                  <strong>{t('Workspace shared')}</strong>
                  <Badge tone="info">{summary.workspaceCount}</Badge>
                </div>
                <small className="muted">{t('Shared inside the current workspace boundary.')}</small>
              </Panel>
              <Panel as="li" className="workspace-record-item compact" tone="soft">
                <div className="row between gap wrap">
                  <strong>{t('Private to owner')}</strong>
                  <Badge tone="warning">{summary.privateCount}</Badge>
                </div>
                <small className="muted">
                  {t('Visible only to the owner or explicitly authorized collaborators.')}
                </small>
              </Panel>
            </ul>
          </Card>
        </div>
      </section>
    </div>
  );
}
