import { useEffect, useMemo, useState } from 'react';
import type { ApprovalRequest, User } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { Card, Panel } from '../components/ui/Surface';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const approvalsBatchSize = 30;

export default function AdminApprovalsPage() {
  const { t } = useI18n();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [items, setItems] = useState<ApprovalRequest[]>([]);
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
      const [user, approvals] = await Promise.all([api.me(), api.listApprovalRequests()]);
      setCurrentUser(user);
      setItems(approvals);
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
    () => items.filter((item) => item.status === 'pending'),
    [items]
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
  const oldestPendingRequestedAt = useMemo(() => {
    if (pendingItems.length === 0) {
      return null;
    }

    const sortedPending = [...pendingItems].sort(
      (left, right) => Date.parse(left.requested_at) - Date.parse(right.requested_at)
    );
    return sortedPending[0]?.requested_at ?? null;
  }, [pendingItems]);
  const busy = actionLoading || refreshing || loading;

  useEffect(() => {
    setVisiblePendingCount((previous) =>
      Math.min(
        pendingItems.length,
        Math.max(approvalsBatchSize, previous > 0 ? previous : approvalsBatchSize)
      )
    );
  }, [pendingItems.length]);

  const approve = async (approvalId: string) => {
    setActionLoading(true);
    setError('');
    setResult('');

    try {
      await api.approveRequest(approvalId, t('Approved in admin queue page.'));
      setResult(t('Approval {approvalId} approved.', { approvalId }));
      await load('manual');
    } catch (actionError) {
      setError((actionError as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const reject = async (approvalId: string) => {
    setActionLoading(true);
    setError('');
    setResult('');

    try {
      await api.rejectRequest(
        approvalId,
        t('Mock quality review failed.'),
        t('Rejected in admin queue page.')
      );
      setResult(t('Approval {approvalId} rejected.', { approvalId }));
      await load('manual');
    } catch (actionError) {
      setError((actionError as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const heroSection = (
    <Card className="workspace-overview-hero">
      <div className="workspace-overview-hero-grid">
        <div className="workspace-overview-copy stack">
          <small className="workspace-eyebrow">{t('Governance')}</small>
          <h1>{t('Admin Approval Queue')}</h1>
          <p className="muted">{t('Review and process pending model approval requests.')}</p>
        </div>
        <div className="workspace-overview-badges">
          <div className="workspace-overview-badge">
            <span>{t('Pending')}</span>
            <strong>{pendingItems.length}</strong>
          </div>
          <div className="workspace-overview-badge">
            <span>{t('Active reviewer')}</span>
            <strong>{currentUser?.username ?? t('guest')}</strong>
          </div>
        </div>
      </div>
    </Card>
  );

  const formatTimestamp = (value: string | null) => {
    if (!value) {
      return t('n/a');
    }
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      return value;
    }
    return new Date(parsed).toLocaleString();
  };

  if (loading) {
    return (
      <div className="workspace-overview-page stack">
        {heroSection}
        <StateBlock variant="loading" title={t('Loading')} description={t('Fetching approval queue.')} />
      </div>
    );
  }

  if (currentUser && currentUser.role !== 'admin') {
    return (
      <div className="workspace-overview-page stack">
        {heroSection}
        <StateBlock
          variant="error"
          title={t('Permission Denied')}
          description={t('Only admin role can access approval operations.')}
        />
      </div>
    );
  }

  return (
    <div className="workspace-overview-page stack">
      {heroSection}

      {error ? <StateBlock variant="error" title={t('Action Failed')} description={error} /> : null}
      {result ? <StateBlock variant="success" title={t('Action Completed')} description={result} /> : null}

      <section className="workspace-overview-signal-grid">
        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Pending requests')}</h3>
            <small className="muted">{t('Requests currently waiting for admin approval decisions.')}</small>
          </div>
          <strong className="metric">{pendingItems.length}</strong>
        </Card>
        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Requesters in queue')}</h3>
            <small className="muted">{t('Unique users represented in the active pending queue.')}</small>
          </div>
          <strong className="metric">{requesterCount}</strong>
        </Card>
        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Oldest pending')}</h3>
            <small className="muted">{t('Oldest approval request currently waiting for action.')}</small>
          </div>
          <strong className="metric">{formatTimestamp(oldestPendingRequestedAt)}</strong>
        </Card>
      </section>

      <section className="workspace-overview-panel-grid">
        <Card as="article" className="workspace-overview-main">
          <div className="workspace-section-header">
            <div className="stack tight">
              <h3>{t('Pending queue')}</h3>
              <small className="muted">
                {t('Review requests in chronological order and keep governance decisions traceable.')}
              </small>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => {
                load('manual').catch(() => {
                  // handled by local state
                });
              }}
            >
              {refreshing ? t('Refreshing...') : t('Refresh queue')}
            </Button>
          </div>

          {pendingItems.length === 0 ? (
            <StateBlock
              variant="empty"
              title={t('No Pending Requests')}
              description={t('All model submissions have been processed.')}
            />
          ) : (
            <>
              <ul className="workspace-record-list">
                {visiblePendingItems.map((item) => (
                  <Panel key={item.id} as="li" className="workspace-record-item" tone="soft">
                    <div className="workspace-record-item-top">
                      <div className="workspace-record-summary stack tight">
                        <strong>{item.id}</strong>
                        <small className="muted">
                          {t('Requested at')}: {formatTimestamp(item.requested_at)}
                        </small>
                      </div>
                      <div className="workspace-record-actions">
                        <StatusTag status="pending">{t('pending')}</StatusTag>
                      </div>
                    </div>
                    <div className="row gap wrap">
                      <Badge tone="neutral">
                        {t('Model')}: {item.model_id}
                      </Badge>
                      <Badge tone="info">
                        {t('Requested by: {requestedBy}', { requestedBy: item.requested_by })}
                      </Badge>
                    </div>
                    <div className="workspace-record-actions">
                      <Button size="sm" disabled={busy} onClick={() => approve(item.id)}>
                        {t('Approve')}
                      </Button>
                      <Button variant="danger" size="sm" disabled={busy} onClick={() => reject(item.id)}>
                        {t('Reject')}
                      </Button>
                    </div>
                  </Panel>
                ))}
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

        <div className="workspace-overview-side">
          <Card as="article">
            <div className="stack tight">
              <h3>{t('Review guidance')}</h3>
              <small className="muted">
                {t('Approvals should include clear notes and rejections should stay actionable for follow-up.')
                }
              </small>
            </div>
            <StateBlock
              variant="empty"
              title={t('Queue policy')}
              description={t('Prioritize older pending requests first to keep review latency predictable.')}
            />
          </Card>

          <Card as="article">
            <div className="stack tight">
              <h3>{t('Governance actions')}</h3>
              <small className="muted">
                {t('Open adjacent admin surfaces without leaving the queue context.')}
              </small>
            </div>
            <div className="workspace-button-stack">
              <ButtonLink to="/admin/audit" variant="secondary">
                {t('Open audit logs')}
              </ButtonLink>
              <ButtonLink to="/admin/verification-reports" variant="secondary">
                {t('Open verification reports')}
              </ButtonLink>
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}
