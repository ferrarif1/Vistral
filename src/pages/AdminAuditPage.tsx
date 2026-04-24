import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import type { AuditLogRecord, User } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import TrainingLaunchContextPills from '../components/onboarding/TrainingLaunchContextPills';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import {
  DetailDrawer,
  DetailList,
  FilterToolbar,
  InlineAlert,
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

const buildAdminVerificationReportsPath = (launchContext?: LaunchContext): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
  const query = searchParams.toString();
  return query ? `/admin/verification-reports?${query}` : '/admin/verification-reports';
};

const buildAdminPendingApprovalsPath = (launchContext?: LaunchContext): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
  const query = searchParams.toString();
  return query ? `/admin/models/pending?${query}` : '/admin/models/pending';
};

export default function AdminAuditPage() {
  const { t } = useI18n();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const requestedReturnTo = sanitizeReturnToPath(searchParams.get('return_to'));
  const currentTaskPath = useMemo(
    () => `${location.pathname}${location.search || ''}`,
    [location.pathname, location.search]
  );
  const outboundReturnTo = requestedReturnTo ?? currentTaskPath;
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
  const verificationReportsPath = useMemo(
    () => buildAdminVerificationReportsPath(launchContext),
    [launchContext]
  );
  const pendingApprovalsPath = useMemo(
    () => buildAdminPendingApprovalsPath(launchContext),
    [launchContext]
  );
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

  const entityOptions = useMemo(
    () =>
      Array.from(new Set(sortedItems.map((item) => item.entity_type)))
        .sort((left, right) => left.localeCompare(right)),
    [sortedItems]
  );

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
        key: 'actions',
        header: t('Actions'),
        width: '12%',
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
        description={t('Search governance history and inspect one record at a time.')}
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
              // handled by local state
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
            <ButtonLink to={pendingApprovalsPath} variant="ghost" size="sm">
              {t('Open pending requests')}
            </ButtonLink>
            <ButtonLink to={verificationReportsPath} variant="ghost" size="sm">
              {t('Open verification reports')}
            </ButtonLink>
          </div>
        }
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
          <StateBlock
            variant="empty"
            title={t('No Logs Yet')}
            description={t('Governance events will appear here after account, model, runtime, or training actions are executed.')}
            extra={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  load('manual').catch(() => {
                    // handled by local state
                  });
                }}
                disabled={refreshing || loading}
              >
                {refreshing ? t('Refreshing...') : t('Refresh')}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="workspace-main-stack">
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
          />

          <SectionCard
            title={t('Recent audit timeline')}
            description={t('Newest records first so one governance record stays easy to inspect.')}
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
        description={t('Use the drawer for actor identity and raw fields.')}
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
                { label: t('Target record'), value: selectedItem.entity_id ?? t('n/a') }
              ]}
            />
            <details className="workspace-details">
              <summary>{t('Detailed fields (advanced)')}</summary>
              <Card as="section">
                <div className="stack tight">
                  <small className="muted">
                    {t('Raw metadata and internal identifiers stay here so the main audit drawer remains readable.')}
                  </small>
                  <DetailList
                    items={[
                      { label: t('Actor ID'), value: selectedItem.user_id ?? t('n/a') },
                      { label: t('Target ID'), value: selectedItem.entity_id ?? t('n/a') }
                    ]}
                  />
                  <pre className="code-block">
                    {Object.keys(selectedItem.metadata ?? {}).length > 0
                      ? JSON.stringify(selectedItem.metadata, null, 2)
                      : '{}'}
                  </pre>
                </div>
              </Card>
            </details>
          </>
        ) : null}
      </DetailDrawer>
    </WorkspacePage>
  );
}
