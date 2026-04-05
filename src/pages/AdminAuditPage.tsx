import { useEffect, useMemo, useState } from 'react';
import type { AuditLogRecord, User } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import VirtualList from '../components/VirtualList';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

export default function AdminAuditPage() {
  const { t } = useI18n();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [items, setItems] = useState<AuditLogRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const shouldVirtualizeAuditLogs = useMemo(() => items.length > 12, [items.length]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError('');

      try {
        const [user, logs] = await Promise.all([api.me(), api.listAuditLogs()]);
        setCurrentUser(user);
        setItems(logs);
      } catch (loadError) {
        setError((loadError as Error).message);
      } finally {
        setLoading(false);
      }
    };

    load().catch(() => {
      // handled by load state
    });
  }, []);

  if (loading) {
    return (
      <div className="stack">
        <h2>{t('Admin Audit Logs')}</h2>
        <StateBlock variant="loading" title={t('Loading')} description={t('Fetching latest audit logs.')} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="stack">
        <h2>{t('Admin Audit Logs')}</h2>
        <StateBlock variant="error" title={t('Load Failed')} description={error} />
      </div>
    );
  }

  if (currentUser && currentUser.role !== 'admin') {
    return (
      <div className="stack">
        <h2>{t('Admin Audit Logs')}</h2>
        <StateBlock variant="error" title={t('Permission Denied')} description={t('Only admin can view audit logs.')} />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="stack">
        <h2>{t('Admin Audit Logs')}</h2>
        <StateBlock variant="empty" title={t('No Logs Yet')} description={t('No audit events recorded yet.')} />
      </div>
    );
  }

  return (
    <div className="stack">
      <h2>{t('Admin Audit Logs')}</h2>
      <p className="muted">{t('Recent governance and critical workflow events.')}</p>
      {shouldVirtualizeAuditLogs ? (
        <VirtualList
          items={items}
          itemHeight={112}
          height={560}
          ariaLabel={t('Admin Audit Logs')}
          itemKey={(item) => item.id}
          renderItem={(item: AuditLogRecord) => (
            <div className="card stack virtualized">
              <div className="row between">
                <strong>{item.action}</strong>
                <small>{new Date(item.timestamp).toLocaleString()}</small>
              </div>
              <small className="muted">
                {item.entity_type} · {item.entity_id ?? t('n/a')} · {t('user')} {item.user_id ?? t('system')}
              </small>
              <small className="muted line-clamp-2">{t('metadata')}: {JSON.stringify(item.metadata)}</small>
            </div>
          )}
        />
      ) : (
        <ul className="list">
          {items.map((item) => (
            <li key={item.id} className="card stack">
              <div className="row between">
                <strong>{item.action}</strong>
                <small>{new Date(item.timestamp).toLocaleString()}</small>
              </div>
              <small className="muted">
                {item.entity_type} · {item.entity_id ?? t('n/a')} · {t('user')} {item.user_id ?? t('system')}
              </small>
              <small className="muted">{t('metadata')}: {JSON.stringify(item.metadata)}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
