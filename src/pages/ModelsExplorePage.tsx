import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { ModelRecord, ModelVersionRecord, TrainingJobRecord, User } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import ModelInventory from '../components/models/ModelInventory';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { Input, Select } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import { buildModelAuthenticityCountsById } from '../features/modelAuthenticity';
import { deriveTrainingExecutionInsight, type TrainingExecutionInsight } from '../features/trainingExecutionInsight';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const readyStatusSet = new Set<ModelRecord['status']>(['approved', 'published']);
const terminalTrainingStatuses = new Set<TrainingJobRecord['status']>(['completed', 'failed', 'cancelled']);
const modelStatusOptions = ['draft', 'pending_approval', 'approved', 'rejected', 'published', 'deprecated'] as const;
const visibilityOptions = ['private', 'workspace', 'public'] as const;
type LoadMode = 'initial' | 'manual';

export default function ModelsExplorePage() {
  const { t } = useI18n();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [modelVersions, setModelVersions] = useState<ModelVersionRecord[]>([]);
  const [trainingJobs, setTrainingJobs] = useState<TrainingJobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deletingModelId, setDeletingModelId] = useState<string | null>(null);
  const [jobExecutionInsights, setJobExecutionInsights] = useState<Record<string, TrainingExecutionInsight>>({});
  const [jobInsightsLoading, setJobInsightsLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [searchText, setSearchText] = useState('');
  const deferredSearchText = useDeferredValue(searchText);
  const [statusFilter, setStatusFilter] = useState<'all' | ModelRecord['status']>('all');
  const [visibilityFilter, setVisibilityFilter] = useState<'all' | ModelRecord['visibility']>('all');
  const [modelTypeFilter, setModelTypeFilter] = useState('all');

  const load = async (mode: LoadMode = 'initial') => {
    if (mode === 'initial') {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    try {
      const [user, result, versionsResult, jobsResult] = await Promise.all([
        api.me(),
        api.listModels(),
        api.listModelVersions(),
        api.listTrainingJobs()
      ]);
      setCurrentUser(user);
      setModels(result);
      setModelVersions(versionsResult);
      setTrainingJobs(jobsResult);
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

  const relevantModelIdSet = useMemo(() => new Set(models.map((model) => model.id)), [models]);
  const relevantVersions = useMemo(
    () => modelVersions.filter((version) => relevantModelIdSet.has(version.model_id)),
    [modelVersions, relevantModelIdSet]
  );
  const relevantTrainingJobIdSet = useMemo(
    () =>
      new Set(
        relevantVersions
          .map((version) => version.training_job_id)
          .filter((jobId): jobId is string => typeof jobId === 'string' && jobId.trim().length > 0)
      ),
    [relevantVersions]
  );
  const relevantLocalCommandJobs = useMemo(
    () =>
      trainingJobs
        .filter(
          (job) =>
            relevantTrainingJobIdSet.has(job.id) &&
            terminalTrainingStatuses.has(job.status) &&
            job.execution_mode === 'local_command'
        )
        .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
        .slice(0, 48),
    [relevantTrainingJobIdSet, trainingJobs]
  );
  const relevantLocalCommandSignature = useMemo(
    () =>
      relevantLocalCommandJobs
        .map((job) => `${job.id}:${job.updated_at}`)
        .sort((left, right) => left.localeCompare(right))
        .join('|'),
    [relevantLocalCommandJobs]
  );

  useEffect(() => {
    if (!relevantLocalCommandJobs.length) {
      setJobExecutionInsights({});
      setJobInsightsLoading(false);
      return;
    }

    let active = true;
    setJobInsightsLoading(true);

    Promise.all(
      relevantLocalCommandJobs.map(async (job) => {
        try {
          const detail = await api.getTrainingJobDetail(job.id);
          return [
            job.id,
            deriveTrainingExecutionInsight({
              status: detail.job.status,
              executionMode: detail.job.execution_mode,
              artifactSummary: detail.artifact_summary
            })
          ] as const;
        } catch {
          return [
            job.id,
            deriveTrainingExecutionInsight({
              status: job.status,
              executionMode: job.execution_mode,
              artifactSummary: null
            })
          ] as const;
        }
      })
    )
      .then((entries) => {
        if (!active) {
          return;
        }
        const next: Record<string, TrainingExecutionInsight> = {};
        entries.forEach(([id, insight]) => {
          next[id] = insight;
        });
        setJobExecutionInsights(next);
      })
      .finally(() => {
        if (!active) {
          return;
        }
        setJobInsightsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [relevantLocalCommandSignature, relevantLocalCommandJobs]);

  const sortedModels = useMemo(
    () =>
      [...models].sort((left, right) => {
        const leftTime = Date.parse(left.updated_at);
        const rightTime = Date.parse(right.updated_at);
        return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
      }),
    [models]
  );
  const modelTypeOptions = useMemo(
    () => Array.from(new Set(models.map((model) => model.model_type).filter(Boolean))).sort((left, right) => left.localeCompare(right)),
    [models]
  );
  const filteredModels = useMemo(() => {
    const keyword = deferredSearchText.trim().toLowerCase();

    return sortedModels.filter((model) => {
      if (statusFilter !== 'all' && model.status !== statusFilter) {
        return false;
      }

      if (visibilityFilter !== 'all' && model.visibility !== visibilityFilter) {
        return false;
      }

      if (modelTypeFilter !== 'all' && model.model_type !== modelTypeFilter) {
        return false;
      }

      if (!keyword) {
        return true;
      }

      return [model.name, model.description, model.model_type, model.visibility, model.status]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(keyword);
    });
  }, [deferredSearchText, modelTypeFilter, sortedModels, statusFilter, visibilityFilter]);
  const filteredSummary = useMemo(
    () => ({
      total: filteredModels.length,
      ready: filteredModels.filter((model) => readyStatusSet.has(model.status)).length,
      pending: filteredModels.filter((model) => model.status === 'pending_approval').length,
      shared: filteredModels.filter((model) => model.visibility === 'workspace' || model.visibility === 'public').length
    }),
    [filteredModels]
  );
  const trainingJobsById = useMemo(() => new Map(trainingJobs.map((job) => [job.id, job])), [trainingJobs]);
  const modelAuthenticityCountsById = useMemo(
    () =>
      buildModelAuthenticityCountsById({
        models: filteredModels,
        versions: relevantVersions,
        jobsById: trainingJobsById,
        jobInsightsById: jobExecutionInsights
      }),
    [filteredModels, jobExecutionInsights, relevantVersions, trainingJobsById]
  );
  const modelAuthenticitySummaryById = useMemo(
    () =>
      Object.fromEntries(
        filteredModels.map((model) => {
          const counts = modelAuthenticityCountsById[model.id] ?? {
            totalVersions: 0,
            realVersions: 0,
            riskyVersions: 0,
            unknownVersions: 0
          };

          if (counts.totalVersions === 0) {
            return [
              model.id,
              {
                tone: 'neutral' as const,
                label: t('No versions yet'),
                hint: t('No registered model versions are linked to this model.')
              }
            ];
          }

          if (counts.riskyVersions > 0) {
            return [
              model.id,
              {
                tone: 'warning' as const,
                label: t('Risky versions: {risky}/{total}', {
                  risky: counts.riskyVersions,
                  total: counts.totalVersions
                }),
                hint:
                  counts.unknownVersions > 0
                    ? t('Includes unknown authenticity evidence. Review training and version details before production use.')
                    : t('Includes template/simulated/non-real evidence. Review training and version details before production use.')
              }
            ];
          }

          return [
            model.id,
            {
              tone: 'success' as const,
              label: t('Real versions: {real}/{total}', {
                real: counts.realVersions,
                total: counts.totalVersions
              }),
              hint: t('Linked versions currently look authenticity-safe.')
            }
          ];
        })
      ),
    [filteredModels, modelAuthenticityCountsById, t]
  );
  const filteredRiskyModels = useMemo(
    () =>
      filteredModels.filter((model) => {
        const counts = modelAuthenticityCountsById[model.id];
        return Boolean(counts) && counts.riskyVersions > 0;
      }).length,
    [filteredModels, modelAuthenticityCountsById]
  );
  const hasActiveFilters =
    searchText.trim().length > 0 ||
    statusFilter !== 'all' ||
    visibilityFilter !== 'all' ||
    modelTypeFilter !== 'all';

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
  const resetFilters = () => {
    setSearchText('');
    setStatusFilter('all');
    setVisibilityFilter('all');
    setModelTypeFilter('all');
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
          },
          {
            title: t('Authenticity risk'),
            description: t('Models in current view linked to non-real/unknown version evidence.'),
            value: filteredRiskyModels,
            tone: filteredRiskyModels > 0 ? 'attention' : 'default'
          }
        ]}
      />

      <WorkspaceWorkbench
        toolbar={
          <Card as="section" className="workspace-toolbar-card">
            <div className="workspace-toolbar-head">
              <div className="workspace-toolbar-copy">
                <h3>{t('Catalog Controls')}</h3>
                <small className="muted">
                  {t('Filter the shared model catalog before jumping into ownership or version actions.')}
                </small>
              </div>
              <div className="workspace-toolbar-actions">
                <ButtonLink to="/models/create" size="sm">
                  {t('Create model draft')}
                </ButtonLink>
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
                  placeholder={t('Search by name, description, or model type')}
                />
              </label>
              <label className="stack tight">
                <small className="muted">{t('Visibility')}</small>
                <Select
                  value={visibilityFilter}
                  onChange={(event) =>
                    setVisibilityFilter(event.target.value as 'all' | ModelRecord['visibility'])
                  }
                >
                  <option value="all">{t('all')}</option>
                  {visibilityOptions.map((option) => (
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
                  onChange={(event) => setStatusFilter(event.target.value as 'all' | ModelRecord['status'])}
                >
                  <option value="all">{t('all')}</option>
                  {modelStatusOptions.map((option) => (
                    <option key={option} value={option}>
                      {t(option)}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="stack tight">
                <small className="muted">{t('Model Type')}</small>
                <Select value={modelTypeFilter} onChange={(event) => setModelTypeFilter(event.target.value)}>
                  <option value="all">{t('all')}</option>
                  {modelTypeOptions.map((option) => (
                    <option key={option} value={option}>
                      {t(option)}
                    </option>
                  ))}
                </Select>
              </label>
            </div>

            <div className="workspace-toolbar-meta">
              <div className="workspace-segmented-actions">
                <Badge tone="info">{t('Matched')}: {filteredSummary.total}</Badge>
                <Badge tone="neutral">{t('Ready for use')}: {filteredSummary.ready}</Badge>
                <Badge tone={filteredSummary.pending > 0 ? 'warning' : 'neutral'}>
                  {t('Pending review')}: {filteredSummary.pending}
                </Badge>
                <Badge tone="neutral">{t('Shared access')}: {filteredSummary.shared}</Badge>
                <Badge tone={filteredRiskyModels > 0 ? 'warning' : 'neutral'}>
                  {t('Authenticity risk')}: {filteredRiskyModels}
                </Badge>
                {jobInsightsLoading ? <Badge tone="neutral">{t('Checking authenticity...')}</Badge> : null}
              </div>
            </div>
          </Card>
        }
        main={
          <div className="workspace-main-stack">
            <ModelInventory
              title={t('Visible Model Inventory')}
              description={t(
                'Browse the currently visible catalog, then jump into your own models or version registration.'
              )}
              ariaLabel={t('Visible Model Inventory')}
              loadingDescription={t('Fetching model catalog.')}
              emptyTitle={t('No visible models yet.')}
              emptyDescription={t('Visible models will appear here after creation or approval.')}
              models={filteredModels}
              loading={loading}
              refreshing={refreshing}
              onRefresh={() => {
                load('manual').catch(() => {
                  // no-op
                });
              }}
              showRefreshAction={false}
              canAdminDelete={currentUser?.role === 'admin'}
              deletingModelId={deletingModelId}
              onDeleteModel={deleteModel}
              modelAuthenticityById={modelAuthenticitySummaryById}
              t={t}
            />
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <Card as="article" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Current catalog lens')}
                description={t('Keep the active filter context visible while scanning the shared inventory.')}
              />
              <div className="workspace-keyline-list">
                <div className="workspace-keyline-item">
                  <span>{t('Search')}</span>
                  <strong>{searchText.trim() || t('all')}</strong>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Visibility')}</span>
                  <strong>{visibilityFilter === 'all' ? t('all') : t(visibilityFilter)}</strong>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Status')}</span>
                  <strong>{statusFilter === 'all' ? t('all') : t(statusFilter)}</strong>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Model Type')}</span>
                  <small>{modelTypeFilter === 'all' ? t('all') : t(modelTypeFilter)}</small>
                </div>
              </div>
              <div className="row gap wrap">
                <Badge tone="info">{t('Matched')}: {filteredSummary.total}</Badge>
                <Badge tone="neutral">{t('Ready for use')}: {filteredSummary.ready}</Badge>
                <Badge tone={filteredRiskyModels > 0 ? 'warning' : 'neutral'}>
                  {t('Authenticity risk')}: {filteredRiskyModels}
                </Badge>
              </div>
            </Card>

            <Card as="article" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Next actions')}
                description={t('Move from exploration to ownership, creation, or version follow-up without losing context.')}
              />
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

            <Card as="article" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Catalog mix')}
                description={t('Visibility and governance split for the models currently shown here.')}
              />
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
        }
      />
    </WorkspacePage>
  );
}
