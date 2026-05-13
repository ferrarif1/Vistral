import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import type { ModelRecord, ModelVersionRecord, TrainingJobRecord, User } from '../../shared/domain';
import ModelInventory from '../components/models/ModelInventory';
import TrainingLaunchContextPills from '../components/onboarding/TrainingLaunchContextPills';
import WorkspaceNextStepCard from '../components/onboarding/WorkspaceNextStepCard';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { DetailList, FilterToolbar, InlineAlert, PageHeader, SectionCard } from '../components/ui/ConsolePage';
import { Input, Select } from '../components/ui/Field';
import { WorkspacePage, WorkspaceWorkbench } from '../components/ui/WorkspacePage';
import { buildModelVerificationCountsById } from '../features/modelAuthenticity';
import { deriveTrainingExecutionInsight, type TrainingExecutionInsight } from '../features/trainingExecutionInsight';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const readyStatusSet = new Set<ModelRecord['status']>(['approved', 'published']);
const terminalTrainingStatuses = new Set<TrainingJobRecord['status']>(['completed', 'failed', 'cancelled']);
const modelStatusOptions = ['draft', 'pending_approval', 'approved', 'rejected', 'published', 'deprecated'] as const;
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

const toTime = (value: string | null | undefined): number => {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const appendTrainingLaunchContext = (searchParams: URLSearchParams, context?: LaunchContext) => {
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

const buildCreateModelContinuationPath = (modelId: string, launchContext?: LaunchContext): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('model', modelId);
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/models/create?${searchParams.toString()}`;
};

const buildAdminApprovalQueuePath = (model: ModelRecord, launchContext?: LaunchContext): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('model', model.id);
  searchParams.set('q', model.name);
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/admin/models/pending?${searchParams.toString()}`;
};

const buildAdminApprovalQueueLandingPath = (launchContext?: LaunchContext): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
  const query = searchParams.toString();
  return query ? `/admin/models/pending?${query}` : '/admin/models/pending';
};

const buildVersionRegistryPath = (
  model: ModelRecord,
  version?: ModelVersionRecord | null,
  launchContext?: LaunchContext
): string => {
  const searchParams = new URLSearchParams();
  if (version?.id) {
    searchParams.set('selectedVersion', version.id);
  } else {
    searchParams.set('model', model.id);
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/models/versions?${searchParams.toString()}`;
};

const buildVersionRegistryLandingPath = (launchContext?: LaunchContext): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('focus', 'register');
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/models/versions?${searchParams.toString()}`;
};

const buildInferenceValidationPath = (
  versionId: string,
  options?: {
    datasetId?: string | null;
    versionId?: string | null;
    launchContext?: LaunchContext;
  }
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('modelVersion', versionId);
  if (options?.datasetId?.trim()) {
    searchParams.set('dataset', options.datasetId.trim());
  }
  if (options?.versionId?.trim()) {
    searchParams.set('version', options.versionId.trim());
  }
  appendTrainingLaunchContext(searchParams, options?.launchContext);
  return `/inference/validate?${searchParams.toString()}`;
};

export default function MyModelsPage() {
  const { t } = useI18n();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const requestedReturnTo = sanitizeReturnToPath(searchParams.get('return_to'));
  const currentTaskPath = useMemo(
    () => `${location.pathname}${location.search || ''}`,
    [location.pathname, location.search]
  );
  const outboundReturnTo = requestedReturnTo ?? currentTaskPath;
  const preferredDatasetId = (searchParams.get('dataset') ?? '').trim();
  const preferredVersionId = (searchParams.get('version') ?? '').trim();
  const preferredTaskType = (searchParams.get('task_type') ?? '').trim();
  const preferredFramework = (searchParams.get('framework') ?? searchParams.get('profile') ?? '').trim().toLowerCase();
  const preferredExecutionTarget = (searchParams.get('execution_target') ?? '').trim().toLowerCase();
  const preferredWorkerId = (searchParams.get('worker') ?? '').trim();
  const preferredModelId = (searchParams.get('model') ?? searchParams.get('model_id') ?? '').trim();
  const launchContext: LaunchContext = {
    datasetId: preferredDatasetId || null,
    versionId: preferredVersionId || null,
    taskType: preferredTaskType || null,
    framework: preferredFramework || null,
    executionTarget: preferredExecutionTarget || null,
    workerId: preferredWorkerId || null,
    returnTo: outboundReturnTo
  };
  const versionRegistryLandingPath = useMemo(
    () => buildVersionRegistryLandingPath(launchContext),
    [launchContext]
  );
  const adminApprovalQueueLandingPath = useMemo(
    () => buildAdminApprovalQueueLandingPath(launchContext),
    [launchContext]
  );
  const createModelPath = useMemo(() => {
    const searchParams = new URLSearchParams();
    appendTrainingLaunchContext(searchParams, launchContext);
    const query = searchParams.toString();
    return query ? `/models/create?${query}` : '/models/create';
  }, [launchContext]);
  const initialLaneFilter = (() => {
    const value = (searchParams.get('lane') ?? '').trim();
    return value === 'ready' || value === 'pending' || value === 'draft_rework' ? value : 'all';
  })();
  const initialStatusFilter = (() => {
    const value = (searchParams.get('status') ?? '').trim();
    return value === 'draft' ||
      value === 'pending_approval' ||
      value === 'approved' ||
      value === 'rejected' ||
      value === 'published' ||
      value === 'deprecated'
      ? value
      : 'all';
  })();
  const initialSearchText = (searchParams.get('q') ?? '').trim();
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
  const [searchText, setSearchText] = useState(initialSearchText);
  const deferredSearchText = useDeferredValue(searchText);
  const [statusFilter, setStatusFilter] = useState<'all' | ModelRecord['status']>(initialStatusFilter);
  const [laneFilter, setLaneFilter] = useState<'all' | 'ready' | 'pending' | 'draft_rework'>(initialLaneFilter);
  const [preferredModelFilterHint, setPreferredModelFilterHint] = useState('');
  const preferredModelFilterRecoveryAppliedRef = useRef(false);
  const deleteModelLockRef = useRef(false);

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
        api.listMyModels(),
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
  const latestVersionByModelId = useMemo(() => {
    const next = new Map<string, ModelVersionRecord>();

    [...relevantVersions]
      .sort((left, right) => toTime(right.created_at) - toTime(left.created_at))
      .forEach((version) => {
        if (!next.has(version.model_id)) {
          next.set(version.model_id, version);
        }
      });

    return next;
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
  const preferredModelRecord = useMemo(
    () => (preferredModelId ? sortedModels.find((model) => model.id === preferredModelId) ?? null : null),
    [preferredModelId, sortedModels]
  );
  const preferredModelMissing = useMemo(
    () => Boolean(preferredModelId && !loading && sortedModels.length > 0 && !preferredModelRecord),
    [loading, preferredModelId, preferredModelRecord, sortedModels.length]
  );
  const clearPreferredModelContextPath = useMemo(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('model');
    next.delete('model_id');
    const query = next.toString();
    return query ? `${location.pathname}?${query}` : location.pathname;
  }, [location.pathname, searchParams]);
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
  const hasActiveFilters =
    searchText.trim().length > 0 ||
    statusFilter !== 'all' ||
    laneFilter !== 'all';
  const laneEligibleCount = useMemo(
    () =>
      sortedModels.filter((model) => {
        if (laneFilter === 'ready') {
          return readyStatusSet.has(model.status);
        }
        if (laneFilter === 'pending') {
          return model.status === 'pending_approval';
        }
        if (laneFilter === 'draft_rework') {
          return model.status === 'draft' || model.status === 'rejected';
        }
        return true;
      }).length,
    [laneFilter, sortedModels]
  );
  const statusEligibleCount = useMemo(
    () => (statusFilter === 'all' ? sortedModels.length : sortedModels.filter((model) => model.status === statusFilter).length),
    [sortedModels, statusFilter]
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
  const filterBlockerHint = useMemo(() => {
    if (filteredModels.length > 0 || !hasActiveFilters) {
      return '';
    }
    if (searchText.trim() && searchEligibleCount === 0) {
      return t('Search keyword currently matches 0 models.');
    }
    if (laneFilter !== 'all' && laneEligibleCount === 0) {
      return t('Lane filter currently has no matching models.');
    }
    if (statusFilter !== 'all' && statusEligibleCount === 0) {
      return t('Status filter currently has no matching models.');
    }
    return t('Current filters are too strict. Clear one or more filters to recover models.');
  }, [
    filteredModels.length,
    hasActiveFilters,
    laneEligibleCount,
    laneFilter,
    searchEligibleCount,
    searchText,
    statusEligibleCount,
    statusFilter,
    t
  ]);
  const overallSummary = useMemo(
    () => ({
      total: models.length,
      ready: models.filter((model) => readyStatusSet.has(model.status)).length,
      pending: models.filter((model) => model.status === 'pending_approval').length,
      draftOrRework: models.filter((model) => model.status === 'draft' || model.status === 'rejected').length
    }),
    [models]
  );
  useEffect(() => {
    preferredModelFilterRecoveryAppliedRef.current = false;
    setPreferredModelFilterHint('');
  }, [preferredModelId]);

  useEffect(() => {
    if (preferredModelFilterRecoveryAppliedRef.current || !preferredModelId || !preferredModelRecord) {
      return;
    }
    if (filteredModels.some((model) => model.id === preferredModelId)) {
      return;
    }

    preferredModelFilterRecoveryAppliedRef.current = true;
    if (laneFilter !== 'all') {
      setLaneFilter('all');
    }
    if (statusFilter !== 'all') {
      setStatusFilter('all');
    }
    if (!searchText.trim().toLowerCase().includes(preferredModelRecord.name.toLowerCase())) {
      setSearchText(preferredModelRecord.name);
    }
    setPreferredModelFilterHint(
      t('Adjusted filters to show the requested model {modelId}.', { modelId: preferredModelRecord.id })
    );
  }, [
    filteredModels,
    laneFilter,
    preferredModelId,
    preferredModelRecord,
    searchText,
    statusFilter,
    t
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
    setLaneFilter('all');
  };

  type GuidanceAction = {
    label: string;
    to?: string;
    onClick?: () => void;
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  };
  type OwnerNextStepState = {
    current: number;
    total: number;
    title: string;
    detail: string;
    badgeTone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
    badgeLabel: string;
    actions: GuidanceAction[];
  };

  const ownerNextStep = useMemo<OwnerNextStepState>(() => {
    if (models.length === 0) {
      return {
        current: 1,
        total: 4,
        title: t('Create the first model draft'),
        detail: t('Start with a model shell so completed training runs have a governance target for version registration and approval.'),
        badgeTone: 'warning',
        badgeLabel: t('No models'),
        actions: [{ label: t('Create model draft'), to: createModelPath }]
      };
    }

    if (overallSummary.draftOrRework > 0) {
      return {
        current: 2,
        total: 4,
        title: t('Finish draft or rework governance'),
        detail: t('{count} models are still in draft or rejected state. Clean these up first so version delivery does not lose its governance anchor.', {
          count: overallSummary.draftOrRework
        }),
        badgeTone: 'warning',
        badgeLabel: t('Drafts / rework'),
        actions: [
          {
            label: t('Focus drafts / rework'),
            onClick: () => {
              setLaneFilter('draft_rework');
              setStatusFilter('all');
            }
          },
          { label: t('Open version registry'), to: versionRegistryLandingPath, variant: 'ghost' }
        ]
      };
    }

    if (overallSummary.pending > 0) {
      return {
        current: 3,
        total: 4,
        title: t('Track pending approval results'),
        detail: t('{count} models are waiting in pending approval. Watch these before you broaden rollout or device delivery.', {
          count: overallSummary.pending
        }),
        badgeTone: 'info',
        badgeLabel: t('Pending approval'),
        actions: [
          {
            label: t('Focus pending models'),
            onClick: () => {
              setLaneFilter('pending');
              setStatusFilter('all');
            }
          },
          currentUser?.role === 'admin'
            ? { label: t('Open admin queue'), to: adminApprovalQueueLandingPath, variant: 'ghost' }
            : { label: t('Open version registry'), to: versionRegistryLandingPath, variant: 'ghost' }
        ]
      };
    }

    return {
      current: 4,
      total: 4,
      title: t('Ready models can move into versions and delivery'),
      detail: t('Your governed model shells are in good shape. Continue in the version registry for validation, comparison, and device-facing delivery.'),
      badgeTone: 'success',
      badgeLabel: t('Governance ready'),
      actions: [
        { label: t('Open version registry'), to: versionRegistryLandingPath },
        { label: t('Create another model'), to: createModelPath, variant: 'ghost' }
      ]
    };
  }, [
    createModelPath,
    adminApprovalQueueLandingPath,
    currentUser?.role,
    models.length,
    overallSummary.draftOrRework,
    overallSummary.pending,
    t,
    versionRegistryLandingPath
  ]);

  const focusPendingModel = useCallback(
    (model: ModelRecord) => {
      setLaneFilter('pending');
      setStatusFilter('pending_approval');
      setSearchText(model.name);
    },
    []
  );

  const renderOwnedModelActions = useCallback(
    (model: ModelRecord) => {
      const latestVersion = latestVersionByModelId.get(model.id) ?? null;

      if (model.status === 'draft') {
        return (
          <>
            <ButtonLink to={buildCreateModelContinuationPath(model.id, launchContext)} variant="secondary" size="sm">
              {t('Continue draft package')}
            </ButtonLink>
          </>
        );
      }

      if (model.status === 'rejected') {
        return (
          <>
            <ButtonLink to={buildCreateModelContinuationPath(model.id, launchContext)} variant="secondary" size="sm">
              {t('Continue rework')}
            </ButtonLink>
          </>
        );
      }

      if (model.status === 'pending_approval') {
        return (
          <>
            <Button type="button" variant="secondary" size="sm" onClick={() => focusPendingModel(model)}>
              {t('Track approval')}
            </Button>
            {currentUser?.role === 'admin' ? (
              <ButtonLink to={buildAdminApprovalQueuePath(model, launchContext)} variant="ghost" size="sm">
                {t('Open admin queue')}
              </ButtonLink>
            ) : (
              <Button type="button" variant="ghost" size="sm" onClick={() => focusPendingModel(model)}>
                {t('Open pending lane')}
              </Button>
            )}
          </>
        );
      }

      return (
        <>
          <ButtonLink to={buildVersionRegistryPath(model, latestVersion, launchContext)} variant="secondary" size="sm">
            {latestVersion ? t('Open model versions') : t('Register first version')}
          </ButtonLink>
          {latestVersion?.status === 'registered' ? (
            <ButtonLink
              to={buildInferenceValidationPath(latestVersion.id, {
                launchContext,
                datasetId:
                  latestVersion.training_job_id && trainingJobsById.get(latestVersion.training_job_id)?.dataset_id
                    ? trainingJobsById.get(latestVersion.training_job_id)?.dataset_id ?? null
                    : null,
                versionId:
                  latestVersion.training_job_id && trainingJobsById.get(latestVersion.training_job_id)?.dataset_version_id
                    ? trainingJobsById.get(latestVersion.training_job_id)?.dataset_version_id ?? null
                    : null
              })}
              variant="ghost"
              size="sm"
            >
              {t('Validate inference')}
            </ButtonLink>
          ) : null}
        </>
      );
    },
    [currentUser?.role, focusPendingModel, launchContext, latestVersionByModelId, t, trainingJobsById]
  );

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Ownership lane')}
        title={t('My Models')}
        description={t('Track your draft, pending, and ready models in one place.')}
        meta={
          <TrainingLaunchContextPills
            taskType={launchContext.taskType}
            framework={launchContext.framework}
            executionTarget={launchContext.executionTarget}
            workerId={launchContext.workerId}
            t={t}
          />
        }
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
            <ButtonLink to={createModelPath} variant="secondary" size="sm">
              {t('Create New Model')}
            </ButtonLink>
          </div>
        }
      />

      {error ? <InlineAlert tone="danger" title={t('Load Failed')} description={error} /> : null}
      {result ? <InlineAlert tone="success" title={t('Action Completed')} description={result} /> : null}
      {preferredModelFilterHint ? (
        <InlineAlert tone="info" title={t('Focused on requested model')} description={preferredModelFilterHint} />
      ) : null}
      {preferredModelMissing ? (
        <InlineAlert
          tone="warning"
          title={t('Requested model not found')}
          description={t('The model from the incoming link is unavailable. Showing available owned models instead.')}
          actions={
            <ButtonLink to={clearPreferredModelContextPath} variant="ghost" size="sm">
              {t('Clear context')}
            </ButtonLink>
          }
        />
      ) : null}
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
          />
        }
        main={
          <div className="workspace-main-stack">
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
                <ButtonLink to={createModelPath} variant="secondary" size="sm">
                  {t('Create Model Draft')}
                </ButtonLink>
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
              renderModelActions={renderOwnedModelActions}
              t={t}
            />
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <WorkspaceNextStepCard
              title={t('Next step')}
              description={t('Keep ownership governance and version work connected from this lane.')}
              stepLabel={ownerNextStep.title}
              stepDetail={ownerNextStep.detail}
              current={ownerNextStep.current}
              total={ownerNextStep.total}
              badgeLabel={ownerNextStep.badgeLabel}
              badgeTone={ownerNextStep.badgeTone}
              actions={ownerNextStep.actions.map((action) =>
                action.to ? (
                  <ButtonLink key={action.label} to={action.to} variant={action.variant ?? 'primary'} size="sm">
                    {action.label}
                  </ButtonLink>
                ) : (
                  <Button key={action.label} type="button" variant={action.variant ?? 'primary'} size="sm" onClick={action.onClick}>
                    {action.label}
                  </Button>
                )
              )}
            />

            <SectionCard
              title={t('Owner snapshot')}
              description={t('Keep model governance counts and current filters visible from the side rail.')}
            >
              <DetailList
                items={[
                  { label: t('Owner'), value: currentUser?.username ?? t('guest') },
                  { label: t('Visible models'), value: filteredSummary.total },
                  { label: t('Ready'), value: overallSummary.ready },
                  { label: t('Pending approval'), value: overallSummary.pending },
                  { label: t('Drafts / rework'), value: overallSummary.draftOrRework },
                  { label: t('Risky models'), value: filteredRiskyModels }
                ]}
              />
              <small className="muted">
                {t('Search')}: {searchText.trim() || t('all')} · {t('Lane')}:{' '}
                {laneFilter === 'all'
                  ? t('all')
                  : laneFilter === 'ready'
                    ? t('Ready')
                    : laneFilter === 'pending'
                      ? t('Pending review')
                      : t('Drafts / rework')}
              </small>
              <div className="row gap wrap">
                <ButtonLink to={versionRegistryLandingPath} variant="ghost" size="sm">
                  {t('Open version registry')}
                </ButtonLink>
                <ButtonLink to={createModelPath} variant="ghost" size="sm">
                  {t('Create model draft')}
                </ButtonLink>
              </div>
            </SectionCard>
          </div>
        }
      />
    </WorkspacePage>
  );
}
