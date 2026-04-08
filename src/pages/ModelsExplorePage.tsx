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

export default function ModelsExplorePage() {
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
      const [user, result] = await Promise.all([api.me(), api.listModels()]);
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
      publicCount: models.filter((model) => model.visibility === 'public').length,
      workspaceCount: models.filter((model) => model.visibility === 'workspace').length,
      privateCount: models.filter((model) => model.visibility === 'private').length,
      sharedCount: models.filter((model) => model.visibility === 'workspace' || model.visibility === 'public').length
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
        eyebrow={t('Model Catalog')}
        title={t('Models Explore')}
        description={t('Scan shared and approved models before jumping into training or inference.')}
        stats={[
          { label: t('Visible catalog'), value: summary.total },
          { label: t('Ready for use'), value: summary.ready },
          { label: t('Shared access'), value: summary.sharedCount }
        ]}
      />

      {error ? <StateBlock variant="error" title={t('Load Failed')} description={error} /> : null}
      {result ? <StateBlock variant="success" title={t('Action Completed')} description={result} /> : null}

      <WorkspaceMetricGrid
        items={[
          {
            title: t('Visible catalog'),
            description: t('Models visible right now across public and workspace scopes.'),
            value: summary.total
          },
          {
            title: t('Ready for use'),
            description: t('Approved or published models that are ready for downstream use.'),
            value: summary.ready
          },
          {
            title: t('Pending review'),
            description: t('Models still waiting for governance review or publication.'),
            value: summary.pending,
            tone: summary.pending > 0 ? 'attention' : 'default'
          },
          {
            title: t('Public reach'),
            description: t('Models visible across broader workspace sharing settings.'),
            value: summary.publicCount
          }
        ]}
      />

      <WorkspaceSplit
        main={
          <ModelInventory
            title={t('Visible Model Inventory')}
            description={t(
              'Browse the currently visible catalog, then jump into your own models or version registration.'
            )}
            ariaLabel={t('Visible Model Inventory')}
            loadingDescription={t('Fetching model catalog.')}
            emptyTitle={t('No visible models yet.')}
            emptyDescription={t('Visible models will appear here after creation or approval.')}
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
          </>
        }
      />
    </WorkspacePage>
  );
}
