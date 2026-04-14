import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AuditLogRecord, User } from '../../shared/domain';
import WorkspaceOnboardingCard from '../components/onboarding/WorkspaceOnboardingCard';
import StateBlock from '../components/StateBlock';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import {
  DetailDrawer,
  DetailList,
  FilterToolbar,
  InlineAlert,
  KPIStatRow,
  PageHeader,
  SectionCard,
  StatusTable,
  type StatusTableColumn
} from '../components/ui/ConsolePage';
import { Card } from '../components/ui/Surface';
import {
  WorkspacePage
} from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';

const adminAuditOnboardingDismissedStorageKey = 'vistral-admin-audit-onboarding-dismissed';

const humanizeAuditToken = (value: string) => {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();

  if (!normalized) {
    return 'Unknown';
  }

  return normalized
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

export default function AdminAuditPage() {
  const { t } = useI18n();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [items, setItems] = useState<AuditLogRecord[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [searchText, setSearchText] = useState('');
  const [triggerFilter, setTriggerFilter] = useState<'all' | 'user' | 'system'>('all');
  const [entityFilter, setEntityFilter] = useState('all');
  const [selectedLogId, setSelectedLogId] = useState('');

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
        setUsers([]);
        return;
      }

      const [logs, directoryUsers] = await Promise.all([api.listAuditLogs(), api.listUsers()]);
      setItems(logs);
      setUsers(directoryUsers);
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
      // handled by local state
    });
  }, [load]);

  const sortedItems = useMemo(
    () =>
      [...items].sort(
        (left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp)
      ),
    [items]
  );

  const userIndex = useMemo(
    () => new Map<string, User>(users.map((user) => [user.id, user])),
    [users]
  );

  const summary = useMemo(
    () => ({
      total: sortedItems.length,
      userTriggered: sortedItems.filter((item) => Boolean(item.user_id)).length,
      systemTriggered: sortedItems.filter((item) => !item.user_id).length,
      entityTypes: new Set(sortedItems.map((item) => item.entity_type)).size
    }),
    [sortedItems]
  );
  const entityOptions = useMemo(
    () =>
      Array.from(new Set(sortedItems.map((item) => item.entity_type)))
        .sort((left, right) => left.localeCompare(right)),
    [sortedItems]
  );
  const onboardingSteps = useMemo(
    () => [
      {
        key: 'timeline',
        label: t('Review governance timeline'),
        detail: t('Start from the newest governance records so policy-sensitive actions are easy to trace.'),
        done: sortedItems.length > 0,
        to: '/admin/audit',
        cta: t('Review timeline')
      },
      {
        key: 'event_mix',
        label: t('Separate user vs system actions'),
        detail: t('Use event badges and counts to distinguish operator actions from background automation before deciding what to review next.'),
        done: summary.userTriggered > 0 || summary.systemTriggered > 0,
        to: '/admin/audit',
        cta: t('Compare event types')
      },
      {
        key: 'next_lane',
        label: t('Continue into adjacent admin lanes'),
        detail: t('Jump from audit logs into approvals or verification evidence when the timeline reveals the next governance action.'),
        done: sortedItems.length > 0,
        to: '/admin/models/pending',
        cta: t('Open approval queue'),
        secondaryTo: '/admin/verification-reports',
        secondaryLabel: t('Open verification reports')
      }
    ],
    [sortedItems.length, summary.systemTriggered, summary.userTriggered, t]
  );

  const topEntityTypes = useMemo(() => {
    const counts = sortedItems.reduce<Record<string, number>>((result, item) => {
      result[item.entity_type] = (result[item.entity_type] ?? 0) + 1;
      return result;
    }, {});

    return Object.entries(counts)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 4);
  }, [sortedItems]);
  const filteredItems = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return sortedItems.filter((item) => {
      if (triggerFilter === 'user' && !item.user_id) {
        return false;
      }
      if (triggerFilter === 'system' && item.user_id) {
        return false;
      }
      if (entityFilter !== 'all' && item.entity_type !== entityFilter) {
        return false;
      }
      if (!query) {
        return true;
      }

      const actor = item.user_id ? userIndex.get(item.user_id) ?? null : null;
      const haystack = [
        item.id,
        item.action,
        item.entity_type,
        item.entity_id ?? '',
        actor?.username ?? '',
        JSON.stringify(item.metadata ?? {})
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [entityFilter, searchText, sortedItems, triggerFilter, userIndex]);
  const selectedItem = useMemo(
    () => filteredItems.find((item) => item.id === selectedLogId) ?? null,
    [filteredItems, selectedLogId]
  );
  const hasActiveFilters =
    searchText.trim().length > 0 || triggerFilter !== 'all' || entityFilter !== 'all';

  const isDenied = currentUser !== null && currentUser.role !== 'admin';
  const resetFilters = () => {
    setSearchText('');
    setTriggerFilter('all');
    setEntityFilter('all');
  };
  const tableColumns = useMemo<StatusTableColumn<AuditLogRecord>[]>(
    () => [
      {
        key: 'time',
        header: t('Time'),
        width: '16%',
        cell: (item) => <small className="muted">{formatCompactTimestamp(item.timestamp, t('n/a'))}</small>
      },
      {
        key: 'action',
        header: t('Action'),
        width: '20%',
        cell: (item) => (
          <div className="stack tight">
            <strong>{humanizeAuditToken(item.action)}</strong>
            <small className="muted">{item.id}</small>
          </div>
        )
      },
      {
        key: 'entity',
        header: t('Entity'),
        width: '18%',
        cell: (item) => (
          <div className="stack tight">
            <Badge tone="info">{humanizeAuditToken(item.entity_type)}</Badge>
            <small className="muted">{item.entity_id ?? t('No target record')}</small>
          </div>
        )
      },
      {
        key: 'actor',
        header: t('Actor'),
        width: '18%',
        cell: (item) => {
          const actor = item.user_id ? userIndex.get(item.user_id) ?? null : null;
          return (
            <small className="muted">
              {item.user_id
                ? actor
                  ? `${actor.username} · ${t(actor.role === 'admin' ? 'Admin' : 'User')}`
                  : t('Unknown account')
                : t('Background automation')}
            </small>
          );
        }
      },
      {
        key: 'trigger',
        header: t('Trigger'),
        width: '12%',
        cell: (item) => (
          <Badge tone={item.user_id ? 'info' : 'neutral'}>
            {item.user_id ? t('User event') : t('System event')}
          </Badge>
        )
      },
      {
        key: 'metadata',
        header: t('Details'),
        width: '10%',
        cell: (item) => {
          const metadataCount = Object.keys(item.metadata ?? {}).length;
          return (
            <Badge tone={metadataCount > 0 ? 'warning' : 'neutral'}>
              {metadataCount > 0
                ? t('Detailed fields: {count}', { count: metadataCount })
                : t('No detailed fields')}
            </Badge>
          );
        }
      },
      {
        key: 'actions',
        header: t('Actions'),
        width: '10%',
        cell: (item) => (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              setSelectedLogId(item.id);
            }}
          >
            {t('View')}
          </Button>
        )
      }
    ],
    [t, userIndex]
  );

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Governance Trail')}
        title={t('Admin Audit Logs')}
        description={t('Use this page to read governance history, compare user vs system events, and continue into adjacent admin lanes without losing context.')}
        meta={
          <div className="row gap wrap align-center">
            <Badge tone="neutral">{t('Total records')}: {summary.total}</Badge>
            <Badge tone="info">{t('User triggered')}: {summary.userTriggered}</Badge>
            <Badge tone="neutral">{t('System events')}: {summary.systemTriggered}</Badge>
            <Badge tone="neutral">{t('Entity types')}: {summary.entityTypes}</Badge>
          </div>
        }
        primaryAction={{
          label: loading ? t('Loading') : refreshing ? t('Refreshing...') : t('Refresh'),
          onClick: () => {
            load('manual').catch(() => {
              // handled by local state
            });
          },
          disabled: loading || refreshing
        }}
        secondaryActions={
          <>
            <ButtonLink to="/admin/models/pending" variant="ghost" size="sm">
              {t('Approval Queue')}
            </ButtonLink>
            <ButtonLink to="/admin/verification-reports" variant="ghost" size="sm">
              {t('Verification Reports')}
            </ButtonLink>
          </>
        }
      />

      <KPIStatRow
        items={[
          {
            label: t('Total records'),
            value: summary.total,
            tone: summary.total > 0 ? 'info' : 'neutral',
            hint: t('All governance events currently retained in the visible log window.')
          },
          {
            label: t('User triggered'),
            value: summary.userTriggered,
            tone: summary.userTriggered > 0 ? 'info' : 'neutral',
            hint: t('Events initiated by authenticated users instead of backend automation.')
          },
          {
            label: t('System events'),
            value: summary.systemTriggered,
            tone: summary.systemTriggered > 0 ? 'warning' : 'neutral',
            hint: t('Background jobs, policy hooks, and other platform-generated actions.')
          },
          {
            label: t('Top entity'),
            value: topEntityTypes[0] ? humanizeAuditToken(topEntityTypes[0][0]) : t('n/a'),
            tone: topEntityTypes[0] ? 'neutral' : 'neutral',
            hint: topEntityTypes[0]
              ? t('Current leading entity count: {count}', { count: topEntityTypes[0][1] })
              : t('Entity mix will appear after audit records are available.')
          }
        ]}
      />

      {error ? <InlineAlert tone="danger" title={t('Load Failed')} description={error} /> : null}

      {isDenied ? (
        <StateBlock
          variant="error"
          title={t('Permission Denied')}
          description={t('Only admin can view audit logs.')}
        />
      ) : loading ? (
        <StateBlock variant="loading" title={t('Loading')} description={t('Fetching latest audit logs.')} />
      ) : sortedItems.length === 0 ? (
        <div className="workspace-main-stack">
          <WorkspaceOnboardingCard
            title={t('Audit log first-run guide')}
            description={t('Use this page to read governance history, compare user vs system events, and continue into adjacent admin lanes without losing context.')}
            summary={t('Guide status is computed from retained audit records and visible governance event mix.')}
            storageKey={adminAuditOnboardingDismissedStorageKey}
            steps={onboardingSteps.map((stepItem) => ({
              key: stepItem.key,
              label: stepItem.label,
              detail: stepItem.detail,
              done: stepItem.done,
              primaryAction: {
                to: stepItem.to,
                label: stepItem.cta
              },
              secondaryAction: stepItem.secondaryTo
                ? {
                    to: stepItem.secondaryTo,
                    label: stepItem.secondaryLabel ?? ''
                  }
                : undefined
            }))}
          />

          <StateBlock
            variant="empty"
            title={t('No Logs Yet')}
            description={t('Governance events will appear here after account, model, runtime, or training actions are executed.')}
            extra={
              <div className="row gap wrap">
                <ButtonLink to="/settings/account" variant="secondary" size="sm">
                  {t('Open Account Settings')}
                </ButtonLink>
                <ButtonLink to="/admin/models/pending" variant="ghost" size="sm">
                  {t('Open Pending Approvals')}
                </ButtonLink>
              </div>
            }
          />
        </div>
      ) : (
        <div className="workspace-main-stack">
          <WorkspaceOnboardingCard
            title={t('Audit log first-run guide')}
            description={t('Use this page to read governance history, compare user vs system events, and continue into adjacent admin lanes without losing context.')}
            summary={t('Guide status is computed from retained audit records and visible governance event mix.')}
            storageKey={adminAuditOnboardingDismissedStorageKey}
            steps={onboardingSteps.map((stepItem) => ({
              key: stepItem.key,
              label: stepItem.label,
              detail: stepItem.detail,
              done: stepItem.done,
              primaryAction: {
                to: stepItem.to,
                label: stepItem.cta
              },
              secondaryAction: stepItem.secondaryTo
                ? {
                    to: stepItem.secondaryTo,
                    label: stepItem.secondaryLabel ?? ''
                  }
                : undefined
            }))}
          />

          <FilterToolbar
            filters={
              <>
                <label className="stack tight">
                  <small className="muted">{t('Search')}</small>
                  <input
                    className="ui-input"
                    value={searchText}
                    onChange={(event) => setSearchText(event.target.value)}
                    placeholder={t('Search by action, entity, actor, or detailed fields')}
                  />
                </label>
                <label className="stack tight">
                  <small className="muted">{t('Trigger')}</small>
                  <select
                    className="ui-select"
                    value={triggerFilter}
                    onChange={(event) => setTriggerFilter(event.target.value as 'all' | 'user' | 'system')}
                  >
                    <option value="all">{t('All events')}</option>
                    <option value="user">{t('User event')}</option>
                    <option value="system">{t('System event')}</option>
                  </select>
                </label>
                <label className="stack tight">
                  <small className="muted">{t('Entity')}</small>
                  <select
                    className="ui-select"
                    value={entityFilter}
                    onChange={(event) => setEntityFilter(event.target.value)}
                  >
                    <option value="all">{t('All entity types')}</option>
                    {entityOptions.map((entityType) => (
                      <option key={entityType} value={entityType}>
                        {humanizeAuditToken(entityType)}
                      </option>
                    ))}
                  </select>
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
            summary={
              <div className="row gap wrap">
                <Badge tone="info">{t('Showing {count} records.', { count: filteredItems.length })}</Badge>
                {topEntityTypes.slice(0, 3).map(([entityType, count]) => (
                  <Badge key={entityType} tone="neutral">
                    {humanizeAuditToken(entityType)}: {count}
                  </Badge>
                ))}
              </div>
            }
          />

          <SectionCard
            title={t('Recent audit timeline')}
            description={t('Newest records first so governance follow-up stays easy to trace.')}
          >
            <StatusTable
              columns={tableColumns}
              rows={filteredItems}
              getRowKey={(item) => item.id}
              onRowClick={(item) => setSelectedLogId(item.id)}
              rowClassName={(item) => (selectedLogId === item.id ? 'selected' : undefined)}
              emptyTitle={t('No logs match current filters.')}
              emptyDescription={t('Try clearing filters or broadening the audit query scope.')}
            />
          </SectionCard>
        </div>
      )}

      <DetailDrawer
        open={Boolean(selectedItem)}
        onClose={() => setSelectedLogId('')}
        title={selectedItem ? humanizeAuditToken(selectedItem.action) : t('Audit detail')}
        description={t('Open one governance record here when you need full context, actor identity, and detailed fields.')}
      >
        {selectedItem ? (
          <>
            <div className="row gap wrap">
              <Badge tone={selectedItem.user_id ? 'info' : 'neutral'}>
                {selectedItem.user_id ? t('User event') : t('System event')}
              </Badge>
              <Badge tone="info">{humanizeAuditToken(selectedItem.entity_type)}</Badge>
              <Badge tone={selectedItem.entity_id ? 'success' : 'neutral'}>
                {selectedItem.entity_id ? t('Target record attached') : t('No target record')}
              </Badge>
            </div>
            <DetailList
              items={[
                { label: t('Time'), value: formatCompactTimestamp(selectedItem.timestamp, t('n/a')) },
                { label: t('Action'), value: humanizeAuditToken(selectedItem.action) },
                { label: t('Entity'), value: humanizeAuditToken(selectedItem.entity_type) },
                {
                  label: t('Actor'),
                  value: selectedItem.user_id
                    ? (() => {
                        const actor = userIndex.get(selectedItem.user_id ?? '');
                        return actor
                          ? `${actor.username} · ${t(actor.role === 'admin' ? 'Admin' : 'User')}`
                          : t('Unknown account');
                      })()
                    : t('Recorded by background automation.')
                },
                { label: t('Actor ID'), value: selectedItem.user_id ?? t('n/a') },
                { label: t('Target ID'), value: selectedItem.entity_id ?? t('n/a') }
              ]}
            />
            <Card as="section">
              <div className="stack tight">
                <strong>{t('Detailed fields (advanced)')}</strong>
                <pre className="code-block">
                  {Object.keys(selectedItem.metadata ?? {}).length > 0
                    ? JSON.stringify(selectedItem.metadata, null, 2)
                    : '{}'}
                </pre>
              </div>
            </Card>
          </>
        ) : null}
      </DetailDrawer>
    </WorkspacePage>
  );
}
