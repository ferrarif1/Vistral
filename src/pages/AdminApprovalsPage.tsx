import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import type { ApprovalRequest, ModelRecord, ModelVersionRecord, User } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import TrainingLaunchContextPills from '../components/onboarding/TrainingLaunchContextPills';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import {
  DetailDrawer,
  FilterToolbar,
  InlineAlert,
  PageHeader,
  SectionCard,
  StatusTable,
  type StatusTableColumn
} from '../components/ui/ConsolePage';
import { Input } from '../components/ui/Field';
import { Panel } from '../components/ui/Surface';
import { WorkspacePage } from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';

const approvalsBatchSize = 30;

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

const buildOwnerPendingPath = (model: ModelRecord, launchContext?: LaunchContext): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('lane', 'pending');
  searchParams.set('status', 'pending_approval');
  searchParams.set('q', model.name);
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/models/my-models?${searchParams.toString()}`;
};

const buildCreateModelContinuationPath = (modelId: string, launchContext?: LaunchContext): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('model', modelId);
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/models/create?${searchParams.toString()}`;
};

const buildVersionRegistryPath = (
  modelId: string,
  version?: ModelVersionRecord | null,
  launchContext?: LaunchContext
): string => {
  const searchParams = new URLSearchParams();
  if (version?.id) {
    searchParams.set('selectedVersion', version.id);
  } else {
    searchParams.set('model', modelId);
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/models/versions?${searchParams.toString()}`;
};

const toTime = (value: string | null | undefined): number => {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export default function AdminApprovalsPage() {
  const { t } = useI18n();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const requestedReturnTo = sanitizeReturnToPath(searchParams.get('return_to'));
  const currentTaskPath = useMemo(
    () => `${location.pathname}${location.search || ''}`,
    [location.pathname, location.search]
  );
  const outboundReturnTo = requestedReturnTo ?? currentTaskPath;
  const initialSearchText = (searchParams.get('q') ?? '').trim();
  const preferredModelId = (searchParams.get('model') ?? searchParams.get('model_id') ?? '').trim();
  const preferredRequestId = (searchParams.get('request') ?? searchParams.get('request_id') ?? '').trim();
  const preferredDatasetId = (searchParams.get('dataset') ?? '').trim();
  const preferredDatasetVersionId = (searchParams.get('version') ?? '').trim();
  const preferredTaskType = (searchParams.get('task_type') ?? '').trim();
  const preferredFramework = (searchParams.get('framework') ?? searchParams.get('profile') ?? '').trim().toLowerCase();
  const preferredExecutionTarget = (searchParams.get('execution_target') ?? '').trim().toLowerCase();
  const preferredWorkerId = (searchParams.get('worker') ?? '').trim();
  const launchContext: LaunchContext = {
    datasetId: preferredDatasetId || null,
    versionId: preferredDatasetVersionId || null,
    taskType: preferredTaskType || null,
    framework: preferredFramework || null,
    executionTarget: preferredExecutionTarget || null,
    workerId: preferredWorkerId || null,
    returnTo: outboundReturnTo
  };
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [items, setItems] = useState<ApprovalRequest[]>([]);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [modelVersions, setModelVersions] = useState<ModelVersionRecord[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [visiblePendingCount, setVisiblePendingCount] = useState(approvalsBatchSize);
  const [searchText, setSearchText] = useState(initialSearchText);
  const [selectedRequestId, setSelectedRequestId] = useState('');

  const load = useCallback(async (mode: 'initial' | 'manual' = 'initial') => {
    if (mode === 'initial') {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setError('');

    try {
      const user = await api.me();
      setCurrentUser(user);
      if (user.role !== 'admin') {
        setItems([]);
        setModels([]);
        setModelVersions([]);
        setUsers([]);
        return;
      }

      const [approvals, nextModels, nextVersions, nextUsers] = await Promise.all([
        api.listApprovalRequests(),
        api.listModels(),
        api.listModelVersions(),
        api.listUsers()
      ]);
      setItems(approvals);
      setModels(nextModels);
      setModelVersions(nextVersions);
      setUsers(nextUsers);
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      if (mode === 'initial') {
        setLoading(false);
      } else {
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    load('initial').catch(() => {
      // handled in load state
    });
  }, [load]);

  const pendingItems = useMemo(
    () =>
      items
        .filter((item) => item.status === 'pending')
        .sort((left, right) => Date.parse(left.requested_at) - Date.parse(right.requested_at)),
    [items]
  );
  const modelIndex = useMemo(
    () => new Map(models.map((model) => [model.id, model])),
    [models]
  );
  const userIndex = useMemo(
    () => new Map(users.map((user) => [user.id, user])),
    [users]
  );
  const requesterCount = useMemo(
    () => new Set(pendingItems.map((item) => item.requested_by)).size,
    [pendingItems]
  );
  const oldestPendingRequestedAt = pendingItems[0]?.requested_at ?? null;
  const searchQuery = searchText.trim().toLowerCase();
  const latestVersionByModelId = useMemo(() => {
    const next = new Map<string, ModelVersionRecord>();

    [...modelVersions]
      .sort((left, right) => toTime(right.created_at) - toTime(left.created_at))
      .forEach((version) => {
        if (!next.has(version.model_id)) {
          next.set(version.model_id, version);
        }
      });

    return next;
  }, [modelVersions]);
  const filteredPendingItems = useMemo(() => {
    return pendingItems.filter((item) => {
      if (preferredModelId && item.model_id !== preferredModelId) {
        return false;
      }

      if (!searchQuery) {
        return true;
      }

      const model = modelIndex.get(item.model_id);
      const requester = userIndex.get(item.requested_by);
      const haystack = [
        item.model_id,
        model?.name ?? '',
        model?.description ?? '',
        model?.model_type ?? '',
        requester?.username ?? '',
        item.id
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(searchQuery);
    });
  }, [modelIndex, pendingItems, preferredModelId, searchQuery, userIndex]);
  const visiblePendingItems = useMemo(
    () => filteredPendingItems.slice(0, visiblePendingCount),
    [filteredPendingItems, visiblePendingCount]
  );
  const hiddenPendingCount = Math.max(0, filteredPendingItems.length - visiblePendingItems.length);
  const selectedRequest = useMemo(
    () => pendingItems.find((item) => item.id === selectedRequestId) ?? null,
    [pendingItems, selectedRequestId]
  );

  useEffect(() => {
    setVisiblePendingCount((previous) =>
      Math.min(
        filteredPendingItems.length,
        Math.max(approvalsBatchSize, previous > 0 ? previous : approvalsBatchSize)
      )
    );
  }, [filteredPendingItems.length]);

  useEffect(() => {
    if (selectedRequestId) {
      return;
    }

    if (preferredRequestId && pendingItems.some((item) => item.id === preferredRequestId)) {
      setSelectedRequestId(preferredRequestId);
      return;
    }

    if (!preferredModelId) {
      return;
    }

    const matchedRequest = filteredPendingItems.find((item) => item.model_id === preferredModelId) ?? null;
    if (matchedRequest) {
      setSelectedRequestId(matchedRequest.id);
    }
  }, [filteredPendingItems, pendingItems, preferredModelId, preferredRequestId, selectedRequestId]);

  const approve = useCallback(
    async (item: ApprovalRequest) => {
      setActionLoading(true);
      setError('');
      setResult('');

      try {
        await api.approveRequest(item.id, t('Approved in admin queue page.'));
        setResult(
          t('Approved request for {modelName}.', {
            modelName: modelIndex.get(item.model_id)?.name ?? t('Unavailable model record')
          })
        );
        setSelectedRequestId('');
        await load('manual');
      } catch (actionError) {
        setError((actionError as Error).message);
      } finally {
        setActionLoading(false);
      }
    },
    [load, modelIndex, t]
  );

  const reject = useCallback(
    async (item: ApprovalRequest) => {
      setActionLoading(true);
      setError('');
      setResult('');

      try {
        await api.rejectRequest(
          item.id,
          t('Quality review failed.'),
          t('Rejected in admin queue page.')
        );
        setResult(
          t('Rejected request for {modelName}.', {
            modelName: modelIndex.get(item.model_id)?.name ?? t('Unavailable model record')
          })
        );
        setSelectedRequestId('');
        await load('manual');
      } catch (actionError) {
        setError((actionError as Error).message);
      } finally {
        setActionLoading(false);
      }
    },
    [load, modelIndex, t]
  );

  const tableColumns = useMemo<StatusTableColumn<ApprovalRequest>[]>(
    () => [
      {
        key: 'requested_at',
        header: t('Requested at'),
        width: '17%',
        cell: (item) => <small className="muted">{formatCompactTimestamp(item.requested_at, t('n/a'))}</small>
      },
      {
        key: 'model',
        header: t('Model'),
        width: '27%',
        cell: (item) => {
          const model = modelIndex.get(item.model_id);
          return (
            <div className="stack tight">
              <strong>{model?.name ?? t('Unavailable model record')}</strong>
              <small className="muted">{model?.description ?? t('No model description')}</small>
            </div>
          );
        }
      },
      {
        key: 'requester',
        header: t('Requester'),
        width: '14%',
        cell: (item) => <small className="muted">{userIndex.get(item.requested_by)?.username ?? t('Unknown user')}</small>
      },
      {
        key: 'scope',
        header: t('Scope'),
        width: '18%',
        cell: (item) => {
          const model = modelIndex.get(item.model_id);
          if (!model) {
            return <Badge tone="neutral">{t('Model metadata unavailable')}</Badge>;
          }
          return (
            <div className="row gap wrap">
              <Badge tone="info">{t(model.model_type)}</Badge>
              <Badge tone="neutral">{t(model.visibility)}</Badge>
            </div>
          );
        }
      },
      {
        key: 'status',
        header: t('Status'),
        width: '10%',
        cell: () => <StatusTag status="pending">{t('pending')}</StatusTag>
      },
      {
        key: 'actions',
        header: t('Actions'),
        width: '14%',
        cell: (item) => (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              setSelectedRequestId(item.id);
            }}
          >
            {t('Review')}
          </Button>
        )
      }
    ],
    [modelIndex, t, userIndex]
  );

  const busy = actionLoading || refreshing || loading;
  const isDenied = currentUser !== null && currentUser.role !== 'admin';
  const selectedModel = selectedRequest ? modelIndex.get(selectedRequest.model_id) ?? null : null;
  const selectedRequester = selectedRequest ? userIndex.get(selectedRequest.requested_by) ?? null : null;
  const versionRegistryPath = useMemo(() => {
    const anchorModelId =
      selectedModel?.id ?? filteredPendingItems[0]?.model_id ?? preferredModelId;
    if (!anchorModelId) {
      const fallbackParams = new URLSearchParams();
      fallbackParams.set('focus', 'register');
      appendTrainingLaunchContext(fallbackParams, launchContext);
      return `/models/versions?${fallbackParams.toString()}`;
    }
    const latestVersion =
      [...modelVersions]
        .filter((version) => version.model_id === anchorModelId)
        .sort((left, right) => toTime(right.created_at) - toTime(left.created_at))[0] ?? null;
    return buildVersionRegistryPath(anchorModelId, latestVersion, launchContext);
  }, [filteredPendingItems, launchContext, modelVersions, preferredModelId, selectedModel?.id]);
  const selectedLatestVersion = selectedModel ? latestVersionByModelId.get(selectedModel.id) ?? null : null;
  const selectedOwnerPendingPath = selectedModel
    ? buildOwnerPendingPath(selectedModel, launchContext)
    : (() => {
        const params = new URLSearchParams();
        params.set('lane', 'pending');
        appendTrainingLaunchContext(params, launchContext);
        return `/models/my-models?${params.toString()}`;
      })();
  const selectedDraftFlowPath = selectedModel
    ? buildCreateModelContinuationPath(selectedModel.id, launchContext)
    : (() => {
        const params = new URLSearchParams();
        appendTrainingLaunchContext(params, launchContext);
        const query = params.toString();
        return query ? `/models/create?${query}` : '/models/create';
      })();
  const selectedVersionRegistryPath = selectedModel
    ? buildVersionRegistryPath(selectedModel.id, selectedLatestVersion, launchContext)
    : (() => {
        const params = new URLSearchParams();
        appendTrainingLaunchContext(params, launchContext);
        const query = params.toString();
        return query ? `/models/versions?${query}` : '/models/versions';
      })();
  const selectedTrainingJobPath = selectedLatestVersion?.training_job_id
    ? (() => {
        const params = new URLSearchParams();
        appendTrainingLaunchContext(params, launchContext);
        const query = params.toString();
        const base = `/training/jobs/${encodeURIComponent(selectedLatestVersion.training_job_id)}`;
        return query ? `${base}?${query}` : base;
      })()
    : '';

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Governance')}
        title={t('Admin Approval Queue')}
        description={t('Review pending model requests and complete approval decisions in one focused queue.')}
        meta={
          <div className="stack tight">
            <div className="row gap wrap align-center">
              <Badge tone="neutral">{t('Pending requests')}: {pendingItems.length}</Badge>
              <Badge tone="info">{t('Requesters')}: {requesterCount}</Badge>
              <Badge tone="neutral">
                {t('Oldest pending')}: {formatCompactTimestamp(oldestPendingRequestedAt, t('n/a'))}
              </Badge>
            </div>
            <TrainingLaunchContextPills
              taskType={launchContext.taskType}
              framework={launchContext.framework}
              executionTarget={launchContext.executionTarget}
              workerId={launchContext.workerId}
              t={t}
            />
          </div>
        }
        primaryAction={{
          label: refreshing ? t('Refreshing...') : t('Refresh'),
          onClick: () => {
            load('manual').catch(() => {
              // handled in load state
            });
          },
          disabled: busy
        }}
        secondaryActions={
          requestedReturnTo ? (
            <ButtonLink to={requestedReturnTo} variant="ghost" size="sm">
              {t('Return to current task')}
            </ButtonLink>
          ) : undefined
        }
      />

      {error ? <InlineAlert tone="danger" title={t('Action Failed')} description={error} /> : null}
      {result ? <InlineAlert tone="success" title={t('Action Completed')} description={result} /> : null}

      {loading ? (
        <StateBlock variant="loading" title={t('Loading')} description={t('Fetching approval queue.')} />
      ) : isDenied ? (
        <StateBlock
          variant="error"
          title={t('Permission Denied')}
          description={t('Only admin role can access approval operations.')}
        />
      ) : (
        <div className="workspace-main-stack">
          <SectionCard
            title={t('Decision handoff')}
            description={t('Process requests here, then move straight into the owner lane, draft flow, or version work without guessing the next page.')}
          >
            <div className="row gap wrap">
              <Badge tone="neutral">{t('Pending requests')}: {filteredPendingItems.length}</Badge>
              <Badge tone="info">{t('Open model lane after review')}</Badge>
            </div>
            <p className="muted">
              {t('Approve when the package is governance-ready, reject when the owner needs rework, and use the links below to continue immediately after each decision.')}
            </p>
            <div className="row gap wrap">
              <ButtonLink to={selectedOwnerPendingPath} variant="secondary" size="sm">
                {t('Open owner pending lane')}
              </ButtonLink>
              <ButtonLink to={versionRegistryPath} variant="ghost" size="sm">
                {t('Open version registry')}
              </ButtonLink>
            </div>
          </SectionCard>

          <FilterToolbar
            filters={
              <Input
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder={t('Search by model, requester, or request id')}
              />
            }
            actions={
              searchQuery ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setSearchText('')}>
                  {t('Clear')}
                </Button>
              ) : undefined
            }
          />

          <SectionCard
            title={t('Pending queue')}
            description={t('Review requests in chronological order. Open a row to approve or reject.')}
            actions={
              hiddenPendingCount > 0 ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setVisiblePendingCount((previous) =>
                      Math.min(filteredPendingItems.length, previous + approvalsBatchSize)
                    );
                  }}
                >
                  {t('Load More Requests')} ({hiddenPendingCount})
                </Button>
              ) : undefined
            }
          >
            <StatusTable
              columns={tableColumns}
              rows={visiblePendingItems}
              getRowKey={(item) => item.id}
              onRowClick={(item) => setSelectedRequestId(item.id)}
              emptyTitle={t('No Pending Requests')}
              emptyDescription={
                searchQuery
                  ? t('No pending request matches current search.')
                  : t('All model submissions have been processed.')
              }
            />
          </SectionCard>
        </div>
      )}

      <DetailDrawer
        open={Boolean(selectedRequest)}
        onClose={() => setSelectedRequestId('')}
        title={selectedModel?.name ?? t('Approval request')}
        description={
          selectedRequest
            ? t('Requested at {time}', {
                time: formatCompactTimestamp(selectedRequest.requested_at, t('n/a'))
              })
            : undefined
        }
        actions={
          selectedRequest ? (
            <>
              <Button type="button" size="sm" disabled={actionLoading} onClick={() => void approve(selectedRequest)}>
                {actionLoading ? t('Processing...') : t('Approve')}
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                disabled={actionLoading}
                onClick={() => void reject(selectedRequest)}
              >
                {actionLoading ? t('Processing...') : t('Reject')}
              </Button>
            </>
          ) : undefined
        }
      >
        {selectedRequest ? (
          <div className="stack">
            <Panel as="section" className="stack tight" tone="soft">
              <div className="row gap wrap">
                <StatusTag status="pending">{t('pending')}</StatusTag>
                <Badge tone="info">{selectedModel ? t(selectedModel.model_type) : t('Unknown model')}</Badge>
                <Badge tone="neutral">
                  {selectedModel ? t(selectedModel.visibility) : t('Metadata unavailable')}
                </Badge>
                {selectedLatestVersion ? (
                  <Badge tone="neutral">{t('Latest version')}: {selectedLatestVersion.version_name}</Badge>
                ) : (
                  <Badge tone="warning">{t('No versions yet')}</Badge>
                )}
              </div>
              <small className="muted">
                {t('Requester')}: {selectedRequester?.username ?? t('Unknown user')}
              </small>
              <small className="muted">
                {t('Requested by user id')}: {selectedRequest.requested_by}
              </small>
              <small className="muted">
                {t('Model id')}: {selectedRequest.model_id}
              </small>
              <small className="muted">
                {selectedModel?.description ??
                  t('No model description is available for this request.')}
              </small>
            </Panel>

            <Panel as="section" className="stack tight" tone="soft">
              <div className="stack tight">
                <strong>{t('Next page after this decision')}</strong>
                <small className="muted">
                  {t('Reject to send the owner back to the draft flow. Approve to keep version registration and validation nearby.')}
                </small>
              </div>
              <div className="row gap wrap">
                <ButtonLink to={selectedOwnerPendingPath} variant="secondary" size="sm">
                  {t('Open owner model lane')}
                </ButtonLink>
                <ButtonLink to={selectedDraftFlowPath} variant="ghost" size="sm">
                  {t('Open model draft flow')}
                </ButtonLink>
                <ButtonLink to={selectedVersionRegistryPath} variant="ghost" size="sm">
                  {selectedLatestVersion ? t('Open model versions') : t('Open version registry')}
                </ButtonLink>
                {selectedTrainingJobPath ? (
                  <ButtonLink to={selectedTrainingJobPath} variant="ghost" size="sm">
                    {t('Open linked training job')}
                  </ButtonLink>
                ) : null}
              </div>
            </Panel>
          </div>
        ) : null}
      </DetailDrawer>
    </WorkspacePage>
  );
}
