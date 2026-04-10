import { useEffect, useMemo, useState } from 'react';
import type { ApprovalRequest, ModelRecord, User } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
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

  const load = async (mode: 'initial' | 'manual' = 'initial') => {
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
  };

  useEffect(() => {
    load('initial').catch(() => {
      // handled by load
    });
  }, []);

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
  const visiblePendingItems = useMemo(
    () => pendingItems.slice(0, visiblePendingCount),
    [pendingItems, visiblePendingCount]
  );
  const hiddenPendingCount = Math.max(0, pendingItems.length - visiblePendingItems.length);
  const requesterCount = useMemo(
    () => new Set(pendingItems.map((item) => item.requested_by)).size,
    [pendingItems]
  );
  const oldestPendingRequestedAt = pendingItems[0]?.requested_at ?? null;
  const busy = actionLoading || refreshing || loading;

  useEffect(() => {
    setVisiblePendingCount((previous) =>
      Math.min(
        pendingItems.length,
        Math.max(approvalsBatchSize, previous > 0 ? previous : approvalsBatchSize)
      )
    );
  }, [pendingItems.length]);

  const approve = async (item: ApprovalRequest) => {
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
      await load('manual');
    } catch (actionError) {
      setError((actionError as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const reject = async (item: ApprovalRequest) => {
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
      await load('manual');
    } catch (actionError) {
      setError((actionError as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const heroSection = (
    <WorkspaceHero
      eyebrow={t('Governance')}
      title={t('Admin Approval Queue')}
      description={t('Review and process pending model approval requests.')}
      stats={[
        { label: t('Pending requests'), value: pendingItems.length },
        { label: t('Active reviewer'), value: currentUser?.username ?? t('guest') }
      ]}
    />
  );

  if (loading) {
    return (
      <WorkspacePage>
        {heroSection}
        <StateBlock variant="loading" title={t('Loading')} description={t('Fetching approval queue.')} />
      </WorkspacePage>
    );
  }

  if (currentUser && currentUser.role !== 'admin') {
    return (
      <WorkspacePage>
        {heroSection}
        <StateBlock
          variant="error"
          title={t('Permission Denied')}
          description={t('Only admin role can access approval operations.')}
        />
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage>
      {heroSection}

      {error ? <StateBlock variant="error" title={t('Action Failed')} description={error} /> : null}
      {result ? <StateBlock variant="success" title={t('Action Completed')} description={result} /> : null}

      <WorkspaceMetricGrid
        items={[
          {
            title: t('Pending requests'),
            description: t('Requests currently waiting for admin approval decisions.'),
            value: pendingItems.length
          },
          {
            title: t('Requesters in queue'),
            description: t('Unique users represented in the active pending queue.'),
            value: requesterCount
          },
          {
            title: t('Oldest pending'),
            description: t('Oldest approval request currently waiting for action.'),
            value: formatCompactTimestamp(oldestPendingRequestedAt, t('n/a'))
          }
        ]}
      />

      <WorkspaceWorkbench
        toolbar={
          <Card as="section" className="workspace-toolbar-card">
            <div className="workspace-toolbar-head">
              <div className="workspace-toolbar-copy">
                <h3>{t('Approval Controls')}</h3>
                <small className="muted">
                  {t('Keep queue refresh and adjacent governance lanes in one stable strip.')}
                </small>
              </div>
              <div className="workspace-toolbar-actions">
                <ButtonLink to="/admin/audit" variant="ghost" size="sm">
                  {t('Audit Logs')}
                </ButtonLink>
                <ButtonLink to="/admin/verification-reports" variant="ghost" size="sm">
                  {t('Verification Reports')}
                </ButtonLink>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    load('manual').catch(() => {
                      // handled by load
                    });
                  }}
                  disabled={busy}
                >
                  {refreshing ? t('Refreshing...') : t('Refresh')}
                </Button>
              </div>
            </div>
            <div className="workspace-toolbar-meta">
              <div className="workspace-segmented-actions">
                <Badge tone="neutral">{t('Pending requests')}: {pendingItems.length}</Badge>
                <Badge tone="info">{t('Requesters')}: {requesterCount}</Badge>
                <Badge tone="neutral">
                  {t('Oldest pending')}: {formatCompactTimestamp(oldestPendingRequestedAt, t('n/a'))}
                </Badge>
              </div>
            </div>
          </Card>
        }
        main={
          <div className="workspace-main-stack">
            <Card as="article">
              <WorkspaceSectionHeader
                title={t('Pending queue')}
                description={t('Review requests in chronological order and keep governance decisions traceable.')}
              />

              {pendingItems.length === 0 ? (
                <StateBlock
                  variant="empty"
                  title={t('No Pending Requests')}
                  description={t('All model submissions have been processed.')}
                />
              ) : (
                <>
                  <ul className="workspace-record-list">
                    {visiblePendingItems.map((item) => {
                      const model = modelIndex.get(item.model_id);
                      const requester = userIndex.get(item.requested_by);

                      return (
                        <Panel key={item.id} as="li" className="workspace-record-item" tone="soft">
                          <div className="workspace-record-item-top">
                            <div className="workspace-record-summary stack tight">
                              <strong>{model?.name ?? t('Model request')}</strong>
                              <small className="muted">
                                {[
                                  model ? t(model.model_type) : null,
                                  model ? t(model.visibility) : null,
                                  `${t('Requested at')}: ${formatCompactTimestamp(item.requested_at, t('n/a'))}`
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </small>
                            </div>
                            <div className="workspace-record-actions">
                              <StatusTag status="pending">{t('pending')}</StatusTag>
                            </div>
                          </div>
                          <p className="line-clamp-2">
                            {model?.description ??
                              t('This request is waiting for an approval decision before the model can move forward.')}
                          </p>
                          <div className="row gap wrap">
                            <Badge tone="info">
                              {t('Requester')}: {requester?.username ?? t('Requester unavailable')}
                            </Badge>
                            {model ? (
                              <Badge tone="neutral">
                                {t('Model Type')}: {t(model.model_type)}
                              </Badge>
                            ) : null}
                            {model ? (
                              <Badge tone="neutral">
                                {t('Visibility')}: {t(model.visibility)}
                              </Badge>
                            ) : (
                              <Badge tone="neutral">
                                {t('Model')}: {t('Unavailable model record')}
                              </Badge>
                            )}
                          </div>
                          <div className="workspace-record-actions">
                            <Button size="sm" disabled={busy} onClick={() => approve(item)}>
                              {t('Approve')}
                            </Button>
                            <Button variant="danger" size="sm" disabled={busy} onClick={() => reject(item)}>
                              {t('Reject')}
                            </Button>
                          </div>
                        </Panel>
                      );
                    })}
                  </ul>

                  {hiddenPendingCount > 0 ? (
                    <div className="workspace-record-actions">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setVisiblePendingCount((previous) =>
                            Math.min(pendingItems.length, previous + approvalsBatchSize)
                          );
                        }}
                      >
                        {t('Load More Requests')} ({hiddenPendingCount})
                      </Button>
                    </div>
                  ) : null}
                </>
              )}
            </Card>
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <Card as="article" className="workspace-inspector-card">
              <div className="stack tight">
                <h3>{t('Review guidance')}</h3>
                <small className="muted">
                  {t('Approvals should include clear notes and rejections should stay actionable for follow-up.')}
                </small>
              </div>
              <ul className="workspace-record-list compact">
                <Panel as="li" className="workspace-record-item compact" tone="soft">
                  <strong>{t('Queue policy')}</strong>
                  <small className="muted">
                    {t('Prioritize older pending requests first to keep review latency predictable.')}
                  </small>
                </Panel>
                <Panel as="li" className="workspace-record-item compact" tone="soft">
                  <strong>{t('Review guidance')}</strong>
                  <small className="muted">
                    {t('Approvals should include clear notes and rejections should stay actionable for follow-up.')}
                  </small>
                </Panel>
              </ul>
            </Card>

            <Card as="article" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Queue summary')}
                description={t('A compact view of the current approval workload and reviewer context.')}
              />
              <div className="workspace-keyline-list">
                <div className="workspace-keyline-item">
                  <span>{t('Pending requests')}</span>
                  <strong>{pendingItems.length}</strong>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Requesters')}</span>
                  <strong>{requesterCount}</strong>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Reviewer')}</span>
                  <small>{currentUser?.username ?? t('guest')}</small>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Oldest pending')}</span>
                  <small>{formatCompactTimestamp(oldestPendingRequestedAt, t('n/a'))}</small>
                </div>
              </div>
            </Card>
          </div>
        }
      />
    </WorkspacePage>
  );
}
