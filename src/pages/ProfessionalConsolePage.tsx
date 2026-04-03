import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ApprovalRequest, FileAttachment, ModelRecord, User } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

interface ConsoleSnapshot {
  user: User;
  visibleModels: ModelRecord[];
  myModels: ModelRecord[];
  conversationAttachments: FileAttachment[];
  approvals: ApprovalRequest[];
}

export default function ProfessionalConsolePage() {
  const { t, roleLabel } = useI18n();
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
        <h2>{t('Professional Console')}</h2>
        <StateBlock variant="loading" title={t('Loading Console')} description={t('Building operational snapshot.')} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="stack">
        <h2>{t('Professional Console')}</h2>
        <StateBlock variant="error" title={t('Console Load Failed')} description={error} />
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="stack">
        <h2>{t('Professional Console')}</h2>
        <StateBlock variant="empty" title={t('No Snapshot')} description={t('No console data available.')} />
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
      <h2>{t('Professional Console')}</h2>
      <p className="muted">
        {t('Role: {role}. This panel provides a professional control-plane entry for structured model operations.', {
          role: roleLabel(snapshot.user.role)
        })}
      </p>

      <section className="console-grid">
        <article className="card stack">
          <h3>{t('Visibility')}</h3>
          <strong className="metric">{snapshot.visibleModels.length}</strong>
          <small className="muted">{t('Models currently visible to this account.')}</small>
        </article>

        <article className="card stack">
          <h3>{t('My Models')}</h3>
          <strong className="metric">{snapshot.myModels.length}</strong>
          <small className="muted">{t('Ownership-scoped model inventory.')}</small>
        </article>

        <article className="card stack">
          <h3>{t('Pending Model Approvals')}</h3>
          <strong className="metric">{pendingModels}</strong>
          <small className="muted">{t('Models waiting for admin review.')}</small>
        </article>

        <article className="card stack">
          <h3>{t('File Processing')}</h3>
          <strong className="metric">{processingFiles}</strong>
          <small className="muted">{t('Conversation attachments still in uploading/processing state.')}</small>
        </article>
      </section>

      <section className="card stack">
        <h3>{t('Approval Queue Snapshot')}</h3>
        {snapshot.approvals.length === 0 ? (
          <StateBlock variant="empty" title={t('No Requests')} description={t('No approval request has been submitted yet.')} />
        ) : (
          <ul className="list">
            {snapshot.approvals.map((approval) => (
              <li key={approval.id} className="list-item">
                <div className="row between gap">
                  <div className="stack tight">
                    <strong>{approval.id}</strong>
                    <small className="muted">{t('Model: {modelId}', { modelId: approval.model_id })}</small>
                  </div>
                  <span className="chip">{approval.status}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card stack">
        <h3>{t('Quick Actions')}</h3>
        <div className="quick-actions">
          <Link to="/workspace/chat" className="quick-link">
            {t('Open Conversation Workspace')}
          </Link>
          <Link to="/models/create" className="quick-link">
            {t('Create New Model')}
          </Link>
          <Link to="/models/my-models" className="quick-link">
            {t('Manage My Models')}
          </Link>
          <Link to="/models/explore" className="quick-link">
            {t('Explore Model Catalog')}
          </Link>
          <Link to="/datasets" className="quick-link">
            {t('Manage Datasets')}
          </Link>
          <Link to="/training/jobs" className="quick-link">
            {t('Open Training Jobs')}
          </Link>
          <Link to="/models/versions" className="quick-link">
            {t('Open Model Versions')}
          </Link>
          <Link to="/inference/validate" className="quick-link">
            {t('Validate Inference')}
          </Link>
          <Link to="/admin/models/pending" className="quick-link">
            {t('Review Approval Queue')}
          </Link>
          <Link to="/admin/audit" className="quick-link">
            {t('View Audit Logs')}
          </Link>
          <Link to="/admin/verification-reports" className="quick-link">
            {t('View Verification Reports')}
          </Link>
          <Link to="/settings/llm" className="quick-link">
            {t('Configure LLM Key')}
          </Link>
          <Link to="/settings/runtime" className="quick-link">
            {t('Check Runtime Connectivity')}
          </Link>
        </div>
        <small className="muted">{t('Pending approvals visible in queue: {count}.', { count: pendingApprovals })}</small>
      </section>
    </div>
  );
}
