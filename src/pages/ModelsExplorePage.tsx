import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import type { ModelRecord, ModelVersionRecord, TrainingJobRecord, User } from '../../shared/domain';
import ModelInventory from '../components/models/ModelInventory';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { FilterToolbar, InlineAlert, PageHeader, SectionCard } from '../components/ui/ConsolePage';
import { Input, Select } from '../components/ui/Field';
import { Card } from '../components/ui/Surface';
import {
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import { isCuratedFoundationModelName } from '../../shared/catalogFixtures';
import { buildModelVerificationCountsById } from '../features/modelAuthenticity';
import { deriveTrainingExecutionInsight, type TrainingExecutionInsight } from '../features/trainingExecutionInsight';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const readyStatusSet = new Set<ModelRecord['status']>(['approved', 'published']);
const terminalTrainingStatuses = new Set<TrainingJobRecord['status']>(['completed', 'failed', 'cancelled']);
const modelStatusOptions = ['draft', 'pending_approval', 'approved', 'rejected', 'published', 'deprecated'] as const;
const visibilityOptions = ['private', 'workspace', 'public'] as const;
type LoadMode = 'initial' | 'manual' | 'background';

type LaunchContext = {
  datasetId?: string | null;
  versionId?: string | null;
  taskType?: string | null;
  framework?: string | null;
  executionTarget?: string | null;
  workerId?: string | null;
  returnTo?: string | null;
};

const appendTrainingLaunchContext = (
  searchParams: URLSearchParams,
  context?: LaunchContext
) => {
  if (!context) {
    return;
  }
  if (context.datasetId?.trim() && !searchParams.has('dataset')) {
    searchParams.set('dataset', context.datasetId.trim());
  }
  if (context.versionId?.trim() && !searchParams.has('version')) {
    searchParams.set('version', context.versionId.trim());
  }
  if (context.taskType?.trim() && !searchParams.has('task_type')) {
    searchParams.set('task_type', context.taskType.trim());
  }
  if (context.framework?.trim() && !searchParams.has('framework')) {
    searchParams.set('framework', context.framework.trim());
  }
  if (
    context.executionTarget?.trim() &&
    context.executionTarget.trim() !== 'auto' &&
    !searchParams.has('execution_target')
  ) {
    searchParams.set('execution_target', context.executionTarget.trim());
  }
  if (context.workerId?.trim() && !searchParams.has('worker')) {
    searchParams.set('worker', context.workerId.trim());
  }
  const returnTo = context.returnTo?.trim() ?? '';
  if (
    returnTo &&
    returnTo.startsWith('/') &&
    !returnTo.startsWith('//') &&
    !returnTo.includes('://') &&
    !searchParams.has('return_to')
  ) {
    searchParams.set('return_to', returnTo);
  }
};

const sanitizeReturnToPath = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('://')) {
    return null;
  }
  return trimmed;
};

const buildInferenceValidationPath = (options?: {
  modelVersionId?: string | null;
  context?: LaunchContext;
  taskType?: string | null;
  framework?: string | null;
}): string => {
  const searchParams = new URLSearchParams();
  if (options?.modelVersionId?.trim()) {
    searchParams.set('modelVersion', options.modelVersionId.trim());
  }
  if (options?.taskType?.trim()) {
    searchParams.set('task_type', options.taskType.trim());
  }
  if (options?.framework?.trim()) {
    searchParams.set('framework', options.framework.trim());
  }
  appendTrainingLaunchContext(searchParams, options?.context);
  const query = searchParams.toString();
  return query ? `/inference/validate?${query}` : '/inference/validate';
};

const buildModelVersionsPath = (options?: {
  selectedVersionId?: string | null;
  context?: LaunchContext;
  focus?: string | null;
}): string => {
  const searchParams = new URLSearchParams();
  if (options?.selectedVersionId?.trim()) {
    searchParams.set('selectedVersion', options.selectedVersionId.trim());
  }
  if (options?.focus?.trim()) {
    searchParams.set('focus', options.focus.trim());
  }
  appendTrainingLaunchContext(searchParams, options?.context);
  const query = searchParams.toString();
  return query ? `/models/versions?${query}` : '/models/versions';
};

const buildCreateModelPath = (context?: LaunchContext): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, context);
  const query = searchParams.toString();
  return query ? `/models/create?${query}` : '/models/create';
};

export default function ModelsExplorePage() {
  const { t } = useI18n();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const requestedReturnTo = sanitizeReturnToPath(searchParams.get('return_to'));
  const currentTaskPath = useMemo(
    () => `${location.pathname}${location.search || ''}`,
    [location.pathname, location.search]
  );
  const outboundReturnTo = requestedReturnTo ?? currentTaskPath;
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [modelVersions, setModelVersions] = useState<ModelVersionRecord[]>([]);
  const [trainingJobs, setTrainingJobs] = useState<TrainingJobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deletingModelId, setDeletingModelId] = useState<string | null>(null);
  const [jobExecutionInsights, setJobExecutionInsights] = useState<Record<string, TrainingExecutionInsight>>({});
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [searchText, setSearchText] = useState('');
  const deferredSearchText = useDeferredValue(searchText);
  const [statusFilter, setStatusFilter] = useState<'all' | ModelRecord['status']>('all');
  const [visibilityFilter, setVisibilityFilter] = useState<'all' | ModelRecord['visibility']>('all');
  const [modelTypeFilter, setModelTypeFilter] = useState('all');
  const deleteModelLockRef = useRef(false);
  const launchContext = useMemo<LaunchContext>(
    () => ({
      datasetId: (searchParams.get('dataset') ?? '').trim() || null,
      versionId: (searchParams.get('version') ?? '').trim() || null,
      taskType: (searchParams.get('task_type') ?? '').trim() || null,
      framework: (searchParams.get('framework') ?? searchParams.get('profile') ?? '').trim().toLowerCase() || null,
      executionTarget: (searchParams.get('execution_target') ?? '').trim().toLowerCase() || null,
      workerId: (searchParams.get('worker') ?? '').trim() || null,
      returnTo: outboundReturnTo
    }),
    [outboundReturnTo, searchParams]
  );
  const createModelDraftPath = useMemo(
    () => buildCreateModelPath(launchContext),
    [launchContext]
  );

  const backgroundSyncHint = t(
    'Background sync is unavailable right now. Deletion is already applied locally. Click Refresh to retry.'
  );

  const load = async (mode: LoadMode = 'initial'): Promise<boolean> => {
    if (mode === 'initial') {
      setLoading(true);
    } else if (mode === 'manual') {
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
      return true;
    } catch (loadError) {
      if (mode === 'background') {
        setResult((previous) => {
          if (previous?.includes(backgroundSyncHint)) {
            return previous;
          }
          return previous ? `${previous} ${backgroundSyncHint}` : backgroundSyncHint;
        });
        return false;
      }
      setError((loadError as Error).message);
      return false;
    } finally {
      if (mode === 'initial') {
        setLoading(false);
      } else if (mode === 'manual') {
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
  const latestRegisteredVersionByModelId = useMemo(() => {
    const map = new Map<string, ModelVersionRecord>();
    relevantVersions
      .filter((version) => version.status === 'registered')
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
      .forEach((version) => {
        if (!map.has(version.model_id)) {
          map.set(version.model_id, version);
        }
      });
    return map;
  }, [relevantVersions]);
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
      return;
    }

    let active = true;

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
  const statusEligibleCount = useMemo(
    () => (statusFilter === 'all' ? sortedModels.length : sortedModels.filter((model) => model.status === statusFilter).length),
    [sortedModels, statusFilter]
  );
  const visibilityEligibleCount = useMemo(
    () =>
      visibilityFilter === 'all'
        ? sortedModels.length
        : sortedModels.filter((model) => model.visibility === visibilityFilter).length,
    [sortedModels, visibilityFilter]
  );
  const modelTypeEligibleCount = useMemo(
    () => (modelTypeFilter === 'all' ? sortedModels.length : sortedModels.filter((model) => model.model_type === modelTypeFilter).length),
    [modelTypeFilter, sortedModels]
  );
  const searchEligibleCount = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();
    if (!keyword) {
      return sortedModels.length;
    }
    return sortedModels.filter((model) =>
      [model.name, model.description, model.model_type, model.visibility, model.status]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(keyword)
    ).length;
  }, [searchText, sortedModels]);
  const trainingJobsById = useMemo(() => new Map(trainingJobs.map((job) => [job.id, job])), [trainingJobs]);
  const modelVerificationCountsById = useMemo(
    () =>
      buildModelVerificationCountsById({
        models: filteredModels,
        versions: relevantVersions,
        jobsById: trainingJobsById,
        jobInsightsById: jobExecutionInsights
      }),
    [filteredModels, jobExecutionInsights, relevantVersions, trainingJobsById]
  );
  const modelVerificationSummaryById = useMemo(
    () =>
      Object.fromEntries(
        filteredModels.map((model) => {
          const counts = modelVerificationCountsById[model.id] ?? {
            totalVersions: 0,
            stableVersions: 0,
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
                    ? t('Includes unknown verification state. Review training and version details before production use.')
                    : t('Includes limited-output evidence. Review training and version details before production use.')
              }
            ];
          }

          return [
            model.id,
              {
                tone: 'success' as const,
                label: t('Stable versions: {stable}/{total}', {
                  stable: counts.stableVersions,
                  total: counts.totalVersions
                }),
                hint: t('Linked versions currently look verification-safe.')
              }
            ];
        })
      ),
    [filteredModels, modelVerificationCountsById, t]
  );
  const filteredRiskyModels = useMemo(
    () =>
      filteredModels.filter((model) => {
        const counts = modelVerificationCountsById[model.id];
        return Boolean(counts) && counts.riskyVersions > 0;
      }).length,
    [filteredModels, modelVerificationCountsById]
  );
  const readyToUsePublishedModels = useMemo(
    () =>
      sortedModels.filter(
        (model) => model.status === 'published' && isCuratedFoundationModelName(model.name)
      ),
    [sortedModels]
  );
  const hasActiveFilters =
    searchText.trim().length > 0 ||
    statusFilter !== 'all' ||
    visibilityFilter !== 'all' ||
    modelTypeFilter !== 'all';
  const filterBlockerHint = useMemo(() => {
    if (filteredModels.length > 0 || !hasActiveFilters) {
      return '';
    }
    if (searchText.trim() && searchEligibleCount === 0) {
      return t('Search keyword currently matches 0 models.');
    }
    if (statusFilter !== 'all' && statusEligibleCount === 0) {
      return t('Status filter currently has no matching models.');
    }
    if (visibilityFilter !== 'all' && visibilityEligibleCount === 0) {
      return t('Current filters are too strict. Clear one or more filters to recover models.');
    }
    if (modelTypeFilter !== 'all' && modelTypeEligibleCount === 0) {
      return t('Current filters are too strict. Clear one or more filters to recover models.');
    }
    return t('Current filters are too strict. Clear one or more filters to recover models.');
  }, [
    filteredModels.length,
    hasActiveFilters,
    modelTypeEligibleCount,
    modelTypeFilter,
    searchEligibleCount,
    searchText,
    statusEligibleCount,
    statusFilter,
    t,
    visibilityEligibleCount,
    visibilityFilter
  ]);

  const deleteModel = async (model: ModelRecord) => {
    if (deleteModelLockRef.current) {
      return;
    }
    deleteModelLockRef.current = true;
    setDeletingModelId(model.id);
    setError('');
    setResult('');

    try {
      await api.removeModelByAdmin(model.id);
      setModels((prev) => prev.filter((item) => item.id !== model.id));
      setModelVersions((prev) => prev.filter((version) => version.model_id !== model.id));
      setResult(
        t('Deleted model {modelName}.', {
          modelName: model.name
        })
      );
      load('background').catch(() => {
        // no-op
      });
    } catch (actionError) {
      setError((actionError as Error).message);
    } finally {
      setDeletingModelId(null);
      deleteModelLockRef.current = false;
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
      <PageHeader
        eyebrow={t('Model Catalog')}
        title={t('Models Explore')}
        description={t('Scan shared and approved models before jumping into training or inference.')}
        primaryAction={{
          label: loading ? t('Loading') : refreshing ? t('Refreshing...') : t('Refresh'),
          onClick: () => {
            load('manual').catch(() => {
              // no-op
            });
          },
          disabled: loading || refreshing
        }}
        secondaryActions={
          <div className="row gap wrap">
            {requestedReturnTo ? (
              <ButtonLink to={requestedReturnTo} variant="ghost" size="sm">
                {t('Return to current task')}
              </ButtonLink>
            ) : null}
            <ButtonLink to={createModelDraftPath} variant="secondary" size="sm">
              {t('Create model draft')}
            </ButtonLink>
          </div>
        }
      />

      {error ? <InlineAlert tone="danger" title={t('Load Failed')} description={error} /> : null}
      {result ? <InlineAlert tone="success" title={t('Action Completed')} description={result} /> : null}
      {filterBlockerHint ? (
        <InlineAlert
          tone="warning"
          title={t('Filters are hiding all models')}
          description={filterBlockerHint}
          actions={
            <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
              {t('Clear filters')}
            </Button>
          }
        />
      ) : null}

      <WorkspaceWorkbench
        toolbar={
          <FilterToolbar
            filters={
              <>
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
              </>
            }
            actions={
              hasActiveFilters ? (
                <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
                  {t('Clear filters')}
                </Button>
              ) : undefined
            }
          />
        }
        main={
          <div className="workspace-main-stack">
            {readyToUsePublishedModels.length > 0 ? (
              <SectionCard
                title={t('Ready for use')}
                description={t('Approved or published models that are ready for downstream use.')}
              >
                <div className="workspace-form-grid">
                  {readyToUsePublishedModels.map((model) => (
                    (() => {
                      const linkedVersion = latestRegisteredVersionByModelId.get(model.id) ?? null;
                      const inferredFramework =
                        typeof model.metadata.framework === 'string' && model.metadata.framework.trim()
                          ? model.metadata.framework.trim().toLowerCase()
                          : null;
                      const inferredTaskType = model.model_type?.trim() || null;
                      const validationPath = buildInferenceValidationPath({
                        modelVersionId: linkedVersion?.id ?? null,
                        taskType: inferredTaskType,
                        framework: inferredFramework,
                        context: launchContext
                      });
                      const versionsPath = buildModelVersionsPath({
                        selectedVersionId: linkedVersion?.id ?? null,
                        focus: linkedVersion ? 'device' : null,
                        context: launchContext
                      });

                      return (
                        <Card key={model.id} as="article" className="workspace-record-item stack tight" tone="soft">
                          <div className="row between gap wrap align-center">
                            <div className="stack tight">
                              <strong>{model.name}</strong>
                              <small className="muted">{model.description}</small>
                            </div>
                            <Badge tone="success">{t('published')}</Badge>
                          </div>
                          <div className="row gap wrap">
                            <Badge tone="info">{t(model.model_type)}</Badge>
                            <Badge tone="neutral">{t(model.metadata.framework ?? 'n/a')}</Badge>
                          </div>
                          <div className="row gap wrap">
                            <ButtonLink to={validationPath} variant="secondary" size="sm">
                              {t('Open Validation')}
                            </ButtonLink>
                            <ButtonLink to={versionsPath} variant="ghost" size="sm">
                              {t('Review versions')}
                            </ButtonLink>
                          </div>
                        </Card>
                      );
                    })()
                  ))}
                </div>
              </SectionCard>
            ) : null}

            <ModelInventory
              title={t('Visible Model Inventory')}
              description={t(
                'Browse the currently visible catalog, then jump into your own models or version registration.'
              )}
              ariaLabel={t('Visible Model Inventory')}
              loadingDescription={t('Fetching model catalog.')}
              emptyTitle={t('No visible models yet.')}
              emptyDescription={t('Visible models will appear here after creation or approval.')}
              emptyExtra={
                <div className="row gap wrap">
                  <ButtonLink to={createModelDraftPath} variant="secondary" size="sm">
                    {t('Create Model Draft')}
                  </ButtonLink>
                </div>
              }
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
              modelVerificationById={modelVerificationSummaryById}
              t={t}
            />
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <Card as="article" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Catalog snapshot')}
                description={t('Keep the active catalog context compact and always visible.')}
              />
              <small className="muted">
                {t('Search')}: {searchText.trim() || t('all')} · {t('Visibility')}: {visibilityFilter === 'all' ? t('all') : t(visibilityFilter)} · {t('Status')}: {statusFilter === 'all' ? t('all') : t(statusFilter)}
              </small>
              <div className="row gap wrap">
                <Badge tone="neutral">{t('Visible')}: {filteredSummary.total}</Badge>
                <Badge tone={filteredRiskyModels > 0 ? 'warning' : 'neutral'}>
                  {t('Risky')}: {filteredRiskyModels}
                </Badge>
              </div>
            </Card>
          </div>
        }
      />
    </WorkspacePage>
  );
}
