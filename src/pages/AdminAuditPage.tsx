import { useEffect, useState } from 'react';
import type { AuditLogRecord, User } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { api } from '../services/api';

export default function AdminAuditPage() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [items, setItems] = useState<AuditLogRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
        <h2>Admin Audit Logs</h2>
        <StateBlock variant="loading" title="Loading" description="Fetching latest audit logs." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="stack">
        <h2>Admin Audit Logs</h2>
        <StateBlock variant="error" title="Load Failed" description={error} />
      </div>
    );
  }

  if (currentUser && currentUser.role !== 'admin') {
    return (
      <div className="stack">
        <h2>Admin Audit Logs</h2>
        <StateBlock variant="error" title="Permission Denied" description="Only admin can view audit logs." />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="stack">
        <h2>Admin Audit Logs</h2>
        <StateBlock variant="empty" title="No Logs Yet" description="No audit events recorded yet." />
      </div>
    );
  }

  return (
    <div className="stack">
      <h2>Admin Audit Logs</h2>
      <p className="muted">Recent governance and critical workflow events.</p>
      <ul className="list">
        {items.map((item) => (
          <li key={item.id} className="card stack">
            <div className="row between">
              <strong>{item.action}</strong>
              <small>{new Date(item.timestamp).toLocaleString()}</small>
            </div>
            <small className="muted">
              {item.entity_type} · {item.entity_id ?? 'n/a'} · user {item.user_id ?? 'system'}
            </small>
            <small className="muted">metadata: {JSON.stringify(item.metadata)}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}
