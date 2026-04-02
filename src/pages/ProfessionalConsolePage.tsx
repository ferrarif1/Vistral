import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ApprovalRequest, FileAttachment, ModelRecord, User } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { api } from '../services/api';

interface ConsoleSnapshot {
  user: User;
  visibleModels: ModelRecord[];
  myModels: ModelRecord[];
  conversationAttachments: FileAttachment[];
  approvals: ApprovalRequest[];
}

export default function ProfessionalConsolePage() {
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);

    Promise.all([
      api.me(),
      api.listModels(),
      api.listMyModels(),
      api.listConversationAttachments(),
      api.listApprovalRequests()
    ])
      .then(([user, visibleModels, myModels, conversationAttachments, approvals]) => {
        setSnapshot({ user, visibleModels, myModels, conversationAttachments, approvals });
        setError('');
      })
      .catch((loadError) => setError((loadError as Error).message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="stack">
        <h2>Professional Console</h2>
        <StateBlock variant="loading" title="Loading Console" description="Building operational snapshot." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="stack">
        <h2>Professional Console</h2>
        <StateBlock variant="error" title="Console Load Failed" description={error} />
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="stack">
        <h2>Professional Console</h2>
        <StateBlock variant="empty" title="No Snapshot" description="No console data available." />
      </div>
    );
  }

  const processingFiles = snapshot.conversationAttachments.filter(
    (attachment) => attachment.status === 'uploading' || attachment.status === 'processing'
  ).length;

  const pendingApprovals = snapshot.approvals.filter((approval) => approval.status === 'pending').length;

  const pendingModels = snapshot.myModels.filter((model) => model.status === 'pending_approval').length;

  return (
    <div className="stack">
      <h2>Professional Console</h2>
      <p className="muted">
        Role: {snapshot.user.role}. This panel provides a professional control-plane entry for structured
        model operations.
      </p>

      <section className="console-grid">
        <article className="card stack">
          <h3>Visibility</h3>
          <strong className="metric">{snapshot.visibleModels.length}</strong>
          <small className="muted">Models currently visible to this account.</small>
        </article>

        <article className="card stack">
          <h3>My Models</h3>
          <strong className="metric">{snapshot.myModels.length}</strong>
          <small className="muted">Ownership-scoped model inventory.</small>
        </article>

        <article className="card stack">
          <h3>Pending Model Approvals</h3>
          <strong className="metric">{pendingModels}</strong>
          <small className="muted">Models waiting for admin review.</small>
        </article>

        <article className="card stack">
          <h3>File Processing</h3>
          <strong className="metric">{processingFiles}</strong>
          <small className="muted">Conversation attachments still in uploading/processing state.</small>
        </article>
      </section>

      <section className="card stack">
        <h3>Approval Queue Snapshot</h3>
        {snapshot.approvals.length === 0 ? (
          <StateBlock variant="empty" title="No Requests" description="No approval request has been submitted yet." />
        ) : (
          <ul className="list">
            {snapshot.approvals.map((approval) => (
              <li key={approval.id} className="list-item">
                <div className="row between gap">
                  <div className="stack tight">
                    <strong>{approval.id}</strong>
                    <small className="muted">Model: {approval.model_id}</small>
                  </div>
                  <span className="chip">{approval.status}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card stack">
        <h3>Quick Actions</h3>
        <div className="quick-actions">
          <Link to="/workspace/chat" className="quick-link">
            Open Conversation Workspace
          </Link>
          <Link to="/models/create" className="quick-link">
            Create New Model
          </Link>
          <Link to="/models/my-models" className="quick-link">
            Manage My Models
          </Link>
          <Link to="/models/explore" className="quick-link">
            Explore Model Catalog
          </Link>
          <Link to="/datasets" className="quick-link">
            Manage Datasets
          </Link>
          <Link to="/training/jobs" className="quick-link">
            Open Training Jobs
          </Link>
          <Link to="/models/versions" className="quick-link">
            Open Model Versions
          </Link>
          <Link to="/inference/validate" className="quick-link">
            Validate Inference
          </Link>
          <Link to="/admin/models/pending" className="quick-link">
            Review Approval Queue
          </Link>
          <Link to="/admin/audit" className="quick-link">
            View Audit Logs
          </Link>
          <Link to="/settings/llm" className="quick-link">
            Configure LLM Key
          </Link>
        </div>
        <small className="muted">Pending approvals visible in queue: {pendingApprovals}.</small>
      </section>
    </div>
  );
}
