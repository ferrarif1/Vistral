import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AuditLogRecord, User } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import VirtualList from '../components/VirtualList';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceSplit
} from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

export default function AdminAuditPage() {
  const { t } = useI18n();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [items, setItems] = useState<AuditLogRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

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
        return;
      }

      const logs = await api.listAuditLogs();
      setItems(logs);
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
    () => [...items].sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime()),
    [items]
  );
  const shouldVirtualizeAuditLogs = useMemo(() => sortedItems.length > 12, [sortedItems.length]);
  const summary = useMemo(
    () => ({
      total: sortedItems.length,
      userTriggered: sortedItems.filter((item) => Boolean(item.user_id)).length,
      systemTriggered: sortedItems.filter((item) => !item.user_id).length,
      entityTypes: new Set(sortedItems.map((item) => item.entity_type)).size
    }),
    [sortedItems]
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
  const isDenied = currentUser !== null && currentUser.role !== 'admin';

  const renderAuditRecord = (item: AuditLogRecord, as: 'div' | 'li' = 'div') => (
    <Panel
      as={as}
      className={`workspace-record-item${as === 'div' ? ' virtualized' : ''}`}
      tone="soft"
    >
      <div className="workspace-record-item-top">
        <div className="workspace-record-summary stack tight">
          <strong>{item.action}</strong>
          <small className="muted">{new Date(item.timestamp).toLocaleString()}</small>
        </div>
        <div className="workspace-record-actions">
          <Badge tone={item.user_id ? 'info' : 'neutral'}>
            {item.user_id ? t('user') : t('system')}
          </Badge>
        </div>
      </div>
      <div className="row gap wrap">
        <Badge tone="info">{item.entity_type}</Badge>
        <Badge tone="neutral">{item.entity_id ?? t('n/a')}</Badge>
        <Badge tone="neutral">{item.user_id ?? t('system')}</Badge>
      </div>
      <small className="muted line-clamp-2">
        {t('metadata')}: {item.metadata ? JSON.stringify(item.metadata) : t('n/a')}
      </small>
    </Panel>
  );

  const heroSection = (
    <WorkspaceHero
      eyebrow={t('Governance Trail')}
      title={t('Admin Audit Logs')}
      description={t('Review policy-sensitive events across model, dataset, and training workflows.')}
      actions={
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            load('manual').catch(() => {
              // handled by local state
            });
          }}
          disabled={loading || refreshing}
        >
          {loading ? t('Loading') : refreshing ? t('Refreshing...') : t('Refresh')}
        </Button>
      }
      stats={[
        { label: t('Total records'), value: summary.total },
        { label: t('User triggered'), value: summary.userTriggered },
        { label: t('Entity types'), value: summary.entityTypes }
      ]}
    />
  );

  return (
    <WorkspacePage>
      {heroSection}

      {error ? <StateBlock variant="error" title={t('Load Failed')} description={error} /> : null}

      {isDenied ? (
        <StateBlock
          variant="error"
          title={t('Permission Denied')}
          description={t('Only admin can view audit logs.')}
        />
      ) : loading ? (
        <StateBlock variant="loading" title={t('Loading')} description={t('Fetching latest audit logs.')} />
      ) : sortedItems.length === 0 ? (
        <StateBlock variant="empty" title={t('No Logs Yet')} description={t('No audit events recorded yet.')} />
      ) : (
        <>
          <WorkspaceMetricGrid
            items={[
              {
                title: t('Total records'),
                description: t('All governance events currently retained in the visible log window.'),
                value: summary.total
              },
              {
                title: t('User triggered'),
                description: t('Events initiated by authenticated users instead of backend automation.'),
                value: summary.userTriggered
              },
              {
                title: t('System events'),
                description: t('Background jobs, policy hooks, and other platform-generated actions.'),
                value: summary.systemTriggered
              },
              {
                title: t('Entity types'),
                description: t('Distinct workflow resource types represented in the current audit sample.'),
                value: summary.entityTypes
              }
            ]}
          />

          <WorkspaceSplit
            main={
              <Card as="article">
                <WorkspaceSectionHeader
                  title={t('Recent audit timeline')}
                  description={t('Newest records first so governance follow-up stays easy to trace.')}
                  actions={
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        load('manual').catch(() => {
                          // handled by local state
                        });
                      }}
                      disabled={loading || refreshing}
                    >
                      {loading ? t('Loading') : refreshing ? t('Refreshing...') : t('Refresh')}
                    </Button>
                  }
                />

                {shouldVirtualizeAuditLogs ? (
                  <VirtualList
                    items={sortedItems}
                    itemHeight={152}
                    height={560}
                    ariaLabel={t('Admin Audit Logs')}
                    itemKey={(item) => item.id}
                    renderItem={(item: AuditLogRecord) => renderAuditRecord(item)}
                  />
                ) : (
                  <ul className="workspace-record-list">
                    {sortedItems.map((item) => renderAuditRecord(item, 'li'))}
                  </ul>
                )}
              </Card>
            }
            side={
              <>
                <Card as="article">
                  <div className="stack tight">
                    <h3>{t('Top entity types')}</h3>
                    <small className="muted">
                      {t('The most frequently touched resources in the current audit view.')}
                    </small>
                  </div>
                  {topEntityTypes.length === 0 ? (
                    <StateBlock
                      variant="empty"
                      title={t('No entities yet')}
                      description={t('Entity mix will appear after audit records are available.')}
                    />
                  ) : (
                    <ul className="workspace-record-list compact">
                      {topEntityTypes.map(([entityType, count]) => (
                        <Panel key={entityType} as="li" className="workspace-record-item compact" tone="soft">
                          <div className="row between gap wrap">
                            <strong>{entityType}</strong>
                            <Badge tone="info">{count}</Badge>
                          </div>
                          <small className="muted">{t('Records currently mapped to this entity type.')}</small>
                        </Panel>
                      ))}
                    </ul>
                  )}
                </Card>

                <Card as="article">
                  <div className="stack tight">
                    <h3>{t('Admin actions')}</h3>
                    <small className="muted">
                      {t('Jump from audit review into the next governance surface without losing context.')}
                    </small>
                  </div>
                  <div className="workspace-button-stack">
                    <ButtonLink to="/admin/models/pending" variant="secondary">
                      {t('Open approval queue')}
                    </ButtonLink>
                    <ButtonLink to="/admin/verification-reports" variant="secondary">
                      {t('Open verification reports')}
                    </ButtonLink>
                  </div>
                </Card>
              </>
            }
          />
        </>
      )}
    </WorkspacePage>
  );
}
