import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ModelRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const readyStatusSet = new Set<ModelRecord['status']>(['approved', 'published']);

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

  return (
    <div className="workspace-overview-page stack">
      <section className="card workspace-overview-hero">
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
      </section>

      {error ? <StateBlock variant="error" title={t('Load Failed')} description={error} /> : null}

      <section className="workspace-overview-signal-grid">
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Owned models')}</h3>
            <small className="muted">{t('Ownership-scoped model inventory.')}</small>
          </div>
          <strong className="metric">{summary.total}</strong>
        </article>
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Ready models')}</h3>
            <small className="muted">
              {t('Models that are already approved or published for downstream usage.')}
            </small>
          </div>
          <strong className="metric">{summary.ready}</strong>
        </article>
        <article className={`card stack workspace-signal-card${summary.pending > 0 ? ' attention' : ''}`}>
          <div className="workspace-signal-top">
            <h3>{t('Pending reviews')}</h3>
            <small className="muted">{t('Pending approvals in your lane.')}</small>
          </div>
          <strong className="metric">{summary.pending}</strong>
        </article>
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Drafts / rework')}</h3>
            <small className="muted">
              {t('Draft or rejected models that still need edits before they can move forward.')}
            </small>
          </div>
          <strong className="metric">{summary.draftOrRework}</strong>
        </article>
      </section>

      <section className="workspace-overview-panel-grid">
        <article className="card stack workspace-overview-main">
          <div className="workspace-section-header">
            <div className="stack tight">
              <h3>{t('Owned Model Inventory')}</h3>
              <small className="muted">
                {t('Follow the status of models you created, then move to versions or approval-related work.')}
              </small>
            </div>
            <button
              type="button"
              className="workspace-inline-button"
              onClick={() => {
                load().catch(() => {
                  // no-op
                });
              }}
              disabled={loading}
            >
              {loading ? t('Loading') : t('Refresh')}
            </button>
          </div>

          {loading ? (
            <StateBlock variant="loading" title={t('Loading Models')} description={t('Checking ownership-scoped models.')} />
          ) : sortedModels.length === 0 ? (
            <StateBlock
              variant="empty"
              title={t('No owned models yet.')}
              description={t('Your created models will appear here once you start a draft.')}
            />
          ) : (
            <ul className="workspace-record-list">
              {sortedModels.map((model) => (
                <li key={model.id} className="workspace-record-item">
                  <div className="workspace-record-item-top">
                    <div className="workspace-record-summary stack tight">
                      <strong>{model.name}</strong>
                      <small className="muted">
                        {t(model.model_type)} · {t(model.visibility)} · {t('Last updated')}: {formatTimestamp(model.updated_at)}
                      </small>
                    </div>
                    <div className="workspace-record-actions">
                      <span className={`workspace-status-pill ${model.status}`}>{t(model.status)}</span>
                    </div>
                  </div>
                  <p>{model.description || t('No description provided.')}</p>
                  <div className="row gap wrap">
                    <span className="chip">
                      {t('Visibility')}: {t(model.visibility)}
                    </span>
                    <span className="chip">
                      {t('Model Type')}: {t(model.model_type)}
                    </span>
                    <span className="chip">
                      {t('owner')}: {model.owner_user_id}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>

        <div className="workspace-overview-side">
          <article className="card stack">
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
            <Link to="/models/create" className="workspace-inline-link">
              {t('Create New Model')}
            </Link>
          </article>

          <article className="card stack">
            <div className="stack tight">
              <h3>{t('Approval follow-up')}</h3>
              <small className="muted">
                {t('Keep the next operational jump close: register versions, explore shared catalog, or continue authoring.')}
              </small>
            </div>
            <ul className="workspace-record-list compact">
              <li className="workspace-record-item compact">
                <div className="row between gap wrap">
                  <strong>{t('Ready models')}</strong>
                  <span className="chip">{summary.ready}</span>
                </div>
                <small className="muted">{t('Ready models in your lane.')}</small>
              </li>
              <li className="workspace-record-item compact">
                <div className="row between gap wrap">
                  <strong>{t('Pending reviews')}</strong>
                  <span className="chip">{summary.pending}</span>
                </div>
                <small className="muted">{t('Pending approvals in your lane.')}</small>
              </li>
            </ul>
            <div className="stack tight">
              <Link to="/models/versions" className="workspace-inline-link">
                {t('Open Model Versions')}
              </Link>
              <Link to="/models/explore" className="workspace-inline-link">
                {t('Explore Model Catalog')}
              </Link>
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}
