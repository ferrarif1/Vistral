import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { ModelRecord, ModelVersionRecord, TrainingJobRecord, User } from '../../shared/domain';
import WorkspaceOnboardingCard from '../components/onboarding/WorkspaceOnboardingCard';
import ModelInventory from '../components/models/ModelInventory';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { FilterToolbar, InlineAlert, KPIStatRow, PageHeader } from '../components/ui/ConsolePage';
import WorkspaceActionPanel from '../components/ui/WorkspaceActionPanel';
import { Input, Select } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import {
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
const myModelsOnboardingDismissedStorageKey = 'vistral-my-models-onboarding-dismissed';
type LoadMode = 'initial' | 'manual';

export default function MyModelsPage() {
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
  const [laneFilter, setLaneFilter] = useState<'all' | 'ready' | 'pending' | 'draft_rework'>('all');

  const load = async (mode: LoadMode = 'initial') => {
    if (mode === 'initial') {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    try {
      const [user, result, versionsResult, jobsResult] = await Promise.all([
        api.me(),
        api.listMyModels(),
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
  const filteredModels = useMemo(() => {
    const keyword = deferredSearchText.trim().toLowerCase();

    return sortedModels.filter((model) => {
      if (statusFilter !== 'all' && model.status !== statusFilter) {
        return false;
      }

      if (laneFilter === 'ready' && !readyStatusSet.has(model.status)) {
        return false;
      }

      if (laneFilter === 'pending' && model.status !== 'pending_approval') {
        return false;
      }

      if (laneFilter === 'draft_rework' && model.status !== 'draft' && model.status !== 'rejected') {
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
  }, [deferredSearchText, laneFilter, sortedModels, statusFilter]);
  const filteredSummary = useMemo(
    () => ({
      total: filteredModels.length,
      ready: filteredModels.filter((model) => readyStatusSet.has(model.status)).length,
      pending: filteredModels.filter((model) => model.status === 'pending_approval').length,
      draftOrRework: filteredModels.filter((model) => model.status === 'draft' || model.status === 'rejected').length
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
                    : t('Includes degraded or non-real evidence. Review training and version details before production use.')
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
    laneFilter !== 'all';
  const onboardingSteps = useMemo(
    () => [
      {
        key: 'drafts',
        label: t('Create or restore your draft lane'),
        detail: t('Your ownership lane starts with at least one draft so model status and review history have a stable home.'),
        done: models.length > 0,
        to: '/models/create',
        cta: t('Create Model Draft')
      },
      {
        key: 'statuses',
        label: t('Track readiness and review state'),
        detail: t('Use the lane and status filters to separate drafts, pending approvals, and ready models before taking action.'),
        done:
          filteredSummary.ready > 0 ||
          filteredSummary.pending > 0 ||
          filteredSummary.draftOrRework > 0,
        to: '/models/my-models',
        cta: t('Review ownership lane')
      },
      {
        key: 'versions',
        label: t('Continue into version registration'),
        detail: t('Once a model has completed training evidence, move into the version lane for registration and deployment follow-up.'),
        done: modelVersions.length > 0,
        to: '/models/versions',
        cta: t('Open Model Versions')
      }
    ],
    [filteredSummary.draftOrRework, filteredSummary.pending, filteredSummary.ready, modelVersions.length, models.length, t]
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
  const resetFilters = () => {
    setSearchText('');
    setStatusFilter('all');
    setLaneFilter('all');
  };

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Ownership lane')}
        title={t('My Models')}
        description={t('Track your draft, pending, and ready models in one place.')}
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
          <ButtonLink to="/models/create" variant="secondary" size="sm">
            {t('Create New Model')}
          </ButtonLink>
        }
      />

      <KPIStatRow
        items={[
          {
            label: t('Owned models'),
            value: summary.total,
            tone: 'info',
            hint: t('Ownership-scoped model inventory.')
          },
          {
            label: t('Ready models'),
            value: summary.ready,
            tone: summary.ready > 0 ? 'success' : 'neutral',
            hint: t('Models that are already approved or published for downstream usage.')
          },
          {
            label: t('Pending reviews'),
            value: summary.pending,
            tone: summary.pending > 0 ? 'warning' : 'neutral',
            hint: t('Pending approvals in your lane.')
          },
          {
            label: t('Drafts / rework'),
            value: summary.draftOrRework,
            tone: 'neutral',
            hint: t('Draft or rejected models that still need edits before they can move forward.')
          },
          {
            label: t('Authenticity risk'),
            value: filteredRiskyModels,
            tone: filteredRiskyModels > 0 ? 'warning' : 'neutral',
            hint: t('Models in current view linked to non-real/unknown version evidence.')
          }
        ]}
      />

      {error ? <InlineAlert tone="danger" title={t('Load Failed')} description={error} /> : null}
      {result ? <InlineAlert tone="success" title={t('Action Completed')} description={result} /> : null}

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
                  <small className="muted">{t('Lane')}</small>
                  <Select
                    value={laneFilter}
                    onChange={(event) =>
                      setLaneFilter(event.target.value as 'all' | 'ready' | 'pending' | 'draft_rework')
                    }
                  >
                    <option value="all">{t('all')}</option>
                    <option value="ready">{t('Ready')}</option>
                    <option value="pending">{t('Pending review')}</option>
                    <option value="draft_rework">{t('Drafts / rework')}</option>
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
                <div className="stack tight">
                  <small className="muted">{t('Owner view')}</small>
                  <div className="row gap wrap">
                    <Badge tone="neutral">{currentUser?.username ?? t('guest')}</Badge>
                  </div>
                </div>
              </>
            }
            actions={
              hasActiveFilters ? (
                <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
                  {t('Clear filters')}
                </Button>
              ) : undefined
            }
            summary={
              <div className="row gap wrap">
                <Badge tone="info">{t('Matched')}: {filteredSummary.total}</Badge>
                <Badge tone="neutral">{t('Ready models')}: {filteredSummary.ready}</Badge>
                <Badge tone={filteredSummary.pending > 0 ? 'warning' : 'neutral'}>
                  {t('Pending reviews')}: {filteredSummary.pending}
                </Badge>
                <Badge tone="neutral">{t('Drafts / rework')}: {filteredSummary.draftOrRework}</Badge>
                <Badge tone={filteredRiskyModels > 0 ? 'warning' : 'neutral'}>
                  {t('Authenticity risk')}: {filteredRiskyModels}
                </Badge>
                {jobInsightsLoading ? <Badge tone="neutral">{t('Checking authenticity...')}</Badge> : null}
              </div>
            }
          />
        }
        main={
          <div className="workspace-main-stack">
            <WorkspaceOnboardingCard
              title={t('My models first-run guide')}
              description={t('Use this page to track the models you own from draft through approval and version follow-up.')}
              summary={t('Guide status is computed from owned model records, lane signals, and version availability.')}
              storageKey={myModelsOnboardingDismissedStorageKey}
              steps={onboardingSteps.map((stepItem) => ({
                key: stepItem.key,
                label: stepItem.label,
                detail: stepItem.detail,
                done: stepItem.done,
                primaryAction: {
                  to: stepItem.to,
                  label: stepItem.cta
                }
              }))}
            />

            <ModelInventory
              title={t('Owned Model Inventory')}
              description={t(
                'Follow the status of models you created, then move to versions or approval-related work.'
              )}
              ariaLabel={t('Owned Model Inventory')}
              loadingDescription={t('Checking ownership-scoped models.')}
              emptyTitle={t('No owned models yet.')}
              emptyDescription={t('Your created models will appear here once you start a draft.')}
              emptyExtra={
                <div className="row gap wrap">
                  <ButtonLink to="/models/create" variant="secondary" size="sm">
                    {t('Create Model Draft')}
                  </ButtonLink>
                  <ButtonLink to="/models/versions" variant="ghost" size="sm">
                    {t('Open Model Versions')}
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
              modelAuthenticityById={modelAuthenticitySummaryById}
              t={t}
            />
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <Card as="article" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Current lane')}
                description={t('Keep your ownership-focused filter scope visible while reviewing model progress.')}
              />
              <div className="workspace-keyline-list">
                <div className="workspace-keyline-item">
                  <span>{t('Search')}</span>
                  <strong>{searchText.trim() || t('all')}</strong>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Lane')}</span>
                  <strong>
                    {laneFilter === 'all'
                      ? t('all')
                      : laneFilter === 'ready'
                        ? t('Ready')
                        : laneFilter === 'pending'
                          ? t('Pending review')
                          : t('Drafts / rework')}
                  </strong>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Status')}</span>
                  <strong>{statusFilter === 'all' ? t('all') : t(statusFilter)}</strong>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Owner')}</span>
                  <strong>{currentUser?.username ?? t('guest')}</strong>
                </div>
              </div>
              <div className="row gap wrap">
                <Badge tone="info">{t('Matched')}: {filteredSummary.total}</Badge>
                <Badge tone="neutral">{t('Ready models')}: {filteredSummary.ready}</Badge>
                <Badge tone={filteredRiskyModels > 0 ? 'warning' : 'neutral'}>
                  {t('Authenticity risk')}: {filteredRiskyModels}
                </Badge>
              </div>
            </Card>

            <WorkspaceActionPanel
              title={t('Create next draft')}
              description={t('Start a new model draft when you are ready to upload artifacts or prepare approval.')}
              actions={
                <ButtonLink to="/models/create" variant="secondary">
                  {t('Create New Model')}
                </ButtonLink>
              }
            >
              <strong className="workspace-side-metric">{summary.draftOrRework}</strong>
              <small className="muted">
                {t('Drafts / rework')}: {summary.draftOrRework}
              </small>
            </WorkspaceActionPanel>

            <WorkspaceActionPanel
              title={t('Approval follow-up')}
              description={t('Keep the next operational jump close: register versions, explore shared catalog, or continue authoring.')}
              actions={
                <>
                  <ButtonLink to="/models/versions" variant="secondary" size="sm">
                    {t('Open Model Versions')}
                  </ButtonLink>
                  <ButtonLink to="/models/explore" variant="secondary" size="sm">
                    {t('Explore Model Catalog')}
                  </ButtonLink>
                </>
              }
            >
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
                <Panel as="li" className="workspace-record-item compact" tone="soft">
                  <div className="row between gap wrap">
                    <strong>{t('Authenticity risk')}</strong>
                    <Badge tone={filteredRiskyModels > 0 ? 'warning' : 'neutral'}>{filteredRiskyModels}</Badge>
                  </div>
                  <small className="muted">
                    {jobInsightsLoading
                      ? t('Checking linked training authenticity...')
                      : t('Models linked to non-real or unknown version evidence in current view.')}
                  </small>
                </Panel>
              </ul>
            </WorkspaceActionPanel>
          </div>
        }
      />
    </WorkspacePage>
  );
}
