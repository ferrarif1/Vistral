import { useEffect, useMemo, useState } from 'react';
import type { ApprovalRequest, User } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { api } from '../services/api';

export default function AdminApprovalsPage() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [items, setItems] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');

    try {
      const [user, approvals] = await Promise.all([api.me(), api.listApprovalRequests()]);
      setCurrentUser(user);
      setItems(approvals);
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load().catch(() => {
      // handled by load
    });
  }, []);

  const pendingItems = useMemo(
    () => items.filter((item) => item.status === 'pending'),
    [items]
  );

  const approve = async (approvalId: string) => {
    setActionLoading(true);
    setError('');
    setResult('');

    try {
      await api.approveRequest(approvalId, 'Approved in admin queue page.');
      setResult(`Approval ${approvalId} approved.`);
      await load();
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
        'Mock quality review failed.',
        'Rejected in admin queue page.'
      );
      setResult(`Approval ${approvalId} rejected.`);
      await load();
    } catch (actionError) {
      setError((actionError as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="stack">
        <h2>Admin Approval Queue</h2>
        <StateBlock variant="loading" title="Loading" description="Fetching approval queue." />
      </div>
    );
  }

  if (currentUser && currentUser.role !== 'admin') {
    return (
      <div className="stack">
        <h2>Admin Approval Queue</h2>
        <StateBlock
          variant="error"
          title="Permission Denied"
          description="Only admin role can access approval operations."
        />
      </div>
    );
  }

  return (
    <div className="stack">
      <h2>Admin Approval Queue</h2>
      <p className="muted">Review and process pending model approval requests.</p>

      {error ? <StateBlock variant="error" title="Action Failed" description={error} /> : null}
      {result ? <StateBlock variant="success" title="Action Completed" description={result} /> : null}

      {pendingItems.length === 0 ? (
        <StateBlock
          variant="empty"
          title="No Pending Requests"
          description="All model submissions have been processed."
        />
      ) : (
        <ul className="list">
          {pendingItems.map((item) => (
            <li key={item.id} className="card stack">
              <div className="row between">
                <strong>{item.id}</strong>
                <span className="chip">pending</span>
              </div>
              <small className="muted">Model: {item.model_id}</small>
              <small className="muted">Requested by: {item.requested_by}</small>
              <div className="row gap">
                <button disabled={actionLoading} onClick={() => approve(item.id)}>
                  Approve
                </button>
                <button disabled={actionLoading} onClick={() => reject(item.id)}>
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
