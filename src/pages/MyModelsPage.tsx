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
const myModelsVirtualizationThreshold = 14;
const myModelsVirtualRowHeight = 168;
const myModelsVirtualViewportHeight = 620;

const formatTimestamp = (iso: string): string => {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) {
    return iso;
  }

  return new Date(value).toLocaleString();
};

export default function MyModelsPage() {
  const { t } = useI18n();
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const result = await api.listMyModels();
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
      draftOrRework: models.filter((model) => model.status === 'draft' || model.status === 'rejected').length
    }),
    [models]
  );

  const shouldVirtualizeModels = sortedModels.length > myModelsVirtualizationThreshold;

  return (
    <div className="workspace-overview-page stack">
      <Card className="workspace-overview-hero">
        <div className="workspace-overview-hero-grid">
          <div className="workspace-overview-copy stack">
            <small className="workspace-eyebrow">{t('Ownership lane')}</small>
            <h1>{t('My Models')}</h1>
            <p className="muted">{t('Track your draft, pending, and ready models in one place.')}</p>
          </div>
          <div className="workspace-overview-badges">
            <div className="workspace-overview-badge">
              <span>{t('Owned models')}</span>
              <strong>{summary.total}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Ready models')}</span>
              <strong>{summary.ready}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Pending reviews')}</span>
              <strong>{summary.pending}</strong>
            </div>
          </div>
        </div>
      </Card>

      {error ? <StateBlock variant="error" title={t('Load Failed')} description={error} /> : null}

      <section className="workspace-overview-signal-grid">
        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Owned models')}</h3>
            <small className="muted">{t('Ownership-scoped model inventory.')}</small>
          </div>
          <strong className="metric">{summary.total}</strong>
        </Card>
        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Ready models')}</h3>
            <small className="muted">
              {t('Models that are already approved or published for downstream usage.')}
            </small>
          </div>
          <strong className="metric">{summary.ready}</strong>
        </Card>
        <Card as="article" className={`workspace-signal-card${summary.pending > 0 ? ' attention' : ''}`}>
          <div className="workspace-signal-top">
            <h3>{t('Pending reviews')}</h3>
            <small className="muted">{t('Pending approvals in your lane.')}</small>
          </div>
          <strong className="metric">{summary.pending}</strong>
        </Card>
        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Drafts / rework')}</h3>
            <small className="muted">
              {t('Draft or rejected models that still need edits before they can move forward.')}
            </small>
          </div>
          <strong className="metric">{summary.draftOrRework}</strong>
        </Card>
      </section>

      <section className="workspace-overview-panel-grid">
        <Card as="article" className="workspace-overview-main">
          <div className="workspace-section-header">
            <div className="stack tight">
              <h3>{t('Owned Model Inventory')}</h3>
              <small className="muted">
                {t('Follow the status of models you created, then move to versions or approval-related work.')}
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
            <StateBlock variant="loading" title={t('Loading Models')} description={t('Checking ownership-scoped models.')} />
          ) : sortedModels.length === 0 ? (
            <StateBlock
              variant="empty"
              title={t('No owned models yet.')}
              description={t('Your created models will appear here once you start a draft.')}
            />
          ) : shouldVirtualizeModels ? (
            <VirtualList
              items={sortedModels}
              itemHeight={myModelsVirtualRowHeight}
              height={myModelsVirtualViewportHeight}
              itemKey={(model) => model.id}
              listClassName="workspace-record-list"
              rowClassName="workspace-record-row"
              ariaLabel={t('Owned Model Inventory')}
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
                    <Badge tone="neutral">
                      {t('Visibility')}: {t(model.visibility)}
                    </Badge>
                    <Badge tone="neutral">
                      {t('Model Type')}: {t(model.model_type)}
                    </Badge>
                    <Badge tone="info">
                      {t('owner')}: {model.owner_user_id}
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
                    <Badge tone="neutral">
                      {t('Visibility')}: {t(model.visibility)}
                    </Badge>
                    <Badge tone="neutral">
                      {t('Model Type')}: {t(model.model_type)}
                    </Badge>
                    <Badge tone="info">
                      {t('owner')}: {model.owner_user_id}
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
              <h3>{t('Create next draft')}</h3>
              <small className="muted">
                {t('Start a new model draft when you are ready to upload artifacts or prepare approval.')}
              </small>
            </div>
            <strong className="workspace-side-metric">{summary.draftOrRework}</strong>
            <small className="muted">
              {t('Drafts / rework')}: {summary.draftOrRework}
            </small>
            <div className="workspace-button-stack">
              <ButtonLink to="/models/create" variant="secondary">
                {t('Create New Model')}
              </ButtonLink>
            </div>
          </Card>

          <Card as="article">
            <div className="stack tight">
              <h3>{t('Approval follow-up')}</h3>
              <small className="muted">
                {t('Keep the next operational jump close: register versions, explore shared catalog, or continue authoring.')}
              </small>
            </div>
            <ul className="workspace-record-list compact">
              <Panel as="li" className="workspace-record-item compact" tone="soft">
                <div className="row between gap wrap">
                  <strong>{t('Ready models')}</strong>
                  <Badge tone="success">{summary.ready}</Badge>
                </div>
                <small className="muted">{t('Ready models in your lane.')}</small>
              </Panel>
              <Panel as="li" className="workspace-record-item compact" tone="soft">
                <div className="row between gap wrap">
                  <strong>{t('Pending reviews')}</strong>
                  <Badge tone={summary.pending > 0 ? 'warning' : 'neutral'}>{summary.pending}</Badge>
                </div>
                <small className="muted">{t('Pending approvals in your lane.')}</small>
              </Panel>
            </ul>
            <div className="workspace-button-stack">
              <ButtonLink to="/models/versions" variant="secondary" size="sm">
                {t('Open Model Versions')}
              </ButtonLink>
              <ButtonLink to="/models/explore" variant="secondary" size="sm">
                {t('Explore Model Catalog')}
              </ButtonLink>
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}
