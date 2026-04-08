import { useEffect, useMemo, useState } from 'react';
import type { ModelRecord, User } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import ModelInventory from '../components/models/ModelInventory';
import { Badge } from '../components/ui/Badge';
import { ButtonLink } from '../components/ui/Button';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceSplit
} from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const readyStatusSet = new Set<ModelRecord['status']>(['approved', 'published']);
type LoadMode = 'initial' | 'manual';

export default function MyModelsPage() {
  const { t } = useI18n();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deletingModelId, setDeletingModelId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');

  const load = async (mode: LoadMode = 'initial') => {
    if (mode === 'initial') {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    try {
      const [user, result] = await Promise.all([api.me(), api.listMyModels()]);
      setCurrentUser(user);
      setModels(result);
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
  };

  useEffect(() => {
    load('initial').catch(() => {
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

  const deleteModel = async (model: ModelRecord) => {
    setDeletingModelId(model.id);
    setError('');
    setResult('');

    try {
      await api.removeModelByAdmin(model.id);
      setResult(
        t('Deleted model {modelName}.', {
          modelName: model.name
        })
      );
      await load('manual');
    } catch (actionError) {
      setError((actionError as Error).message);
    } finally {
      setDeletingModelId(null);
    }
  };

  return (
    <WorkspacePage>
      <WorkspaceHero
        eyebrow={t('Ownership lane')}
        title={t('My Models')}
        description={t('Track your draft, pending, and ready models in one place.')}
        stats={[
          {
            label: t('Owned models'),
            value: summary.total
          },
          {
            label: t('Ready models'),
            value: summary.ready
          },
          {
            label: t('Pending reviews'),
            value: summary.pending
          }
        ]}
      />

      {error ? <StateBlock variant="error" title={t('Load Failed')} description={error} /> : null}
      {result ? <StateBlock variant="success" title={t('Action Completed')} description={result} /> : null}

      <WorkspaceMetricGrid
        items={[
          {
            title: t('Owned models'),
            description: t('Ownership-scoped model inventory.'),
            value: summary.total
          },
          {
            title: t('Ready models'),
            description: t('Models that are already approved or published for downstream usage.'),
            value: summary.ready
          },
          {
            title: t('Pending reviews'),
            description: t('Pending approvals in your lane.'),
            value: summary.pending,
            tone: summary.pending > 0 ? 'attention' : 'default'
          },
          {
            title: t('Drafts / rework'),
            description: t('Draft or rejected models that still need edits before they can move forward.'),
            value: summary.draftOrRework
          }
        ]}
      />

      <WorkspaceSplit
        main={
          <ModelInventory
            title={t('Owned Model Inventory')}
            description={t(
              'Follow the status of models you created, then move to versions or approval-related work.'
            )}
            ariaLabel={t('Owned Model Inventory')}
            loadingDescription={t('Checking ownership-scoped models.')}
            emptyTitle={t('No owned models yet.')}
            emptyDescription={t('Your created models will appear here once you start a draft.')}
            models={sortedModels}
            loading={loading}
            refreshing={refreshing}
            canAdminDelete={currentUser?.role === 'admin'}
            deletingModelId={deletingModelId}
            onRefresh={() => {
              load('manual').catch(() => {
                // no-op
              });
            }}
            onDeleteModel={deleteModel}
            t={t}
          />
        }
        side={
          <>
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
          </>
        }
      />
    </WorkspacePage>
  );
}
