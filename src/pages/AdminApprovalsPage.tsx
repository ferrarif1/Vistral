import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApprovalRequest, ModelRecord, User } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
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

export default function AdminApprovalsPage() {
  const { t } = useI18n();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [items, setItems] = useState<ApprovalRequest[]>([]);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [visiblePendingCount, setVisiblePendingCount] = useState(approvalsBatchSize);
  const [searchText, setSearchText] = useState('');
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
        setUsers([]);
        return;
      }

      const [approvals, nextModels, nextUsers] = await Promise.all([
        api.listApprovalRequests(),
        api.listModels(),
        api.listUsers()
      ]);
      setItems(approvals);
      setModels(nextModels);
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
  const filteredPendingItems = useMemo(() => {
    if (!searchQuery) {
      return pendingItems;
    }
    return pendingItems.filter((item) => {
      const model = modelIndex.get(item.model_id);
      const requester = userIndex.get(item.requested_by);
      const haystack = [
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
  }, [modelIndex, pendingItems, searchQuery, userIndex]);
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
          t('Mock quality review failed.'),
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

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Governance')}
        title={t('Admin Approval Queue')}
        description={t('Review pending model requests and complete approval decisions in one focused queue.')}
        meta={
          <div className="row gap wrap align-center">
            <Badge tone="neutral">{t('Pending requests')}: {pendingItems.length}</Badge>
            <Badge tone="info">{t('Requesters')}: {requesterCount}</Badge>
            <Badge tone="neutral">
              {t('Oldest pending')}: {formatCompactTimestamp(oldestPendingRequestedAt, t('n/a'))}
            </Badge>
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
          <Panel as="section" className="stack tight" tone="soft">
            <div className="row gap wrap">
              <StatusTag status="pending">{t('pending')}</StatusTag>
              <Badge tone="info">{selectedModel ? t(selectedModel.model_type) : t('Unknown model')}</Badge>
              <Badge tone="neutral">
                {selectedModel ? t(selectedModel.visibility) : t('Metadata unavailable')}
              </Badge>
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
        ) : null}
      </DetailDrawer>
    </WorkspacePage>
  );
}
