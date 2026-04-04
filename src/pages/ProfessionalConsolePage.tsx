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

interface ConsoleActionGroup {
  title: string;
  description: string;
  links: Array<{ to: string; label: string }>;
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
  const pendingApprovals = snapshot.approvals.filter((approval) => approval.status === 'pending');
  const pendingModels = snapshot.myModels.filter((model) => model.status === 'pending_approval').length;
  const readyVisibleModels = snapshot.visibleModels.filter(
    (model) => model.status === 'approved' || model.status === 'published'
  ).length;
  const queuePreview = (pendingApprovals.length > 0 ? pendingApprovals : snapshot.approvals).slice(0, 4);

  const actionGroups: ConsoleActionGroup[] = [
    {
      title: t('Workspace routing'),
      description: t('Jump into the right surface based on the task you want to finish next.'),
      links: [
        { to: '/workspace/chat', label: t('Open Conversation Workspace') },
        { to: '/workspace/console', label: t('Open Professional Console') },
        { to: '/settings', label: t('Open Settings') }
      ]
    },
    {
      title: t('Build & Ship'),
      description: t('Move from draft creation to registered model versions with less context switching.'),
      links: [
        { to: '/models/create', label: t('Create New Model') },
        { to: '/models/my-models', label: t('Manage My Models') },
        { to: '/models/versions', label: t('Open Model Versions') }
      ]
    },
    {
      title: t('Operations'),
      description: t('Open the core execution surfaces for datasets, training, and inference validation.'),
      links: [
        { to: '/datasets', label: t('Manage Datasets') },
        { to: '/training/jobs', label: t('Open Training Jobs') },
        { to: '/inference/validate', label: t('Validate Inference') }
      ]
    },
    {
      title: t('Admin & Audit'),
      description: t('Review approvals, audit trails, and release evidence from one lane.'),
      links: [
        { to: '/admin/models/pending', label: t('Review Approval Queue') },
        { to: '/admin/audit', label: t('View Audit Logs') },
        { to: '/admin/verification-reports', label: t('View Verification Reports') }
      ]
    }
  ];

  return (
    <div className="console-page stack">
      <section className="console-hero card">
        <div className="console-hero-grid">
          <div className="console-hero-copy stack">
            <small className="console-eyebrow">{t('Control Center')}</small>
            <h1>{t('Professional Console')}</h1>
            <p className="muted">
              {t('Role: {role}. This panel provides a professional control-plane entry for structured model operations.', {
                role: roleLabel(snapshot.user.role)
              })}
            </p>
          </div>
          <div className="console-hero-badges">
            <div className="console-hero-badge">
              <span>{t('Role overview')}</span>
              <strong>{roleLabel(snapshot.user.role)}</strong>
            </div>
            <div className="console-hero-badge">
              <span>{t('Pending reviews')}</span>
              <strong>{pendingApprovals.length}</strong>
            </div>
            <div className="console-hero-badge">
              <span>{t('Pending conversations')}</span>
              <strong>{processingFiles}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="console-signal-grid">
        <article className="card stack console-signal-card">
          <div className="console-signal-top">
            <h3>{t('Visibility')}</h3>
            <small className="muted">{t('Models currently visible to this account.')}</small>
          </div>
          <strong className="metric">{snapshot.visibleModels.length}</strong>
          <small className="console-metric-caption">
            {t('Ready models')}: {readyVisibleModels}
          </small>
        </article>

        <article className="card stack console-signal-card">
          <div className="console-signal-top">
            <h3>{t('My Models')}</h3>
            <small className="muted">{t('Ownership-scoped model inventory.')}</small>
          </div>
          <strong className="metric">{snapshot.myModels.length}</strong>
          <small className="console-metric-caption">
            {t('Pending Model Approvals')}: {pendingModels}
          </small>
        </article>

        <article className={`card stack console-signal-card${pendingApprovals.length > 0 ? ' attention' : ''}`}>
          <div className="console-signal-top">
            <h3>{t('Pending Model Approvals')}</h3>
            <small className="muted">{t('Models waiting for admin review.')}</small>
          </div>
          <strong className="metric">{pendingApprovals.length}</strong>
          <small className="console-metric-caption">
            {t('Pending approvals visible in queue: {count}.', { count: pendingApprovals.length })}
          </small>
        </article>

        <article className={`card stack console-signal-card${processingFiles > 0 ? ' attention soft' : ''}`}>
          <div className="console-signal-top">
            <h3>{t('File Processing')}</h3>
            <small className="muted">{t('Conversation attachments still in uploading/processing state.')}</small>
          </div>
          <strong className="metric">{processingFiles}</strong>
          <small className="console-metric-caption">
            {processingFiles > 0 ? t('Continue in Chat') : t('No pending chat files')}
          </small>
        </article>
      </section>

      <section className="console-panel-grid">
        <article className="card stack console-panel-card">
          <div className="console-section-header">
            <div className="stack tight">
              <h3>{t('Priority Queue')}</h3>
              <small className="muted">{t('Items needing attention now.')}</small>
            </div>
            <Link to="/admin/models/pending" className="console-inline-link">
              {t('Open Queue')}
            </Link>
          </div>

          {queuePreview.length === 0 ? (
            <StateBlock
              variant="empty"
              title={t('No approvals need attention right now.')}
              description={t('All queued approvals are already resolved.')}
            />
          ) : (
            <ul className="console-queue-list">
              {queuePreview.map((approval: ApprovalRequest) => (
                <li key={approval.id} className="console-queue-item">
                  <div className="stack tight">
                    <strong>{approval.id}</strong>
                    <small className="muted">{t('Model: {modelId}', { modelId: approval.model_id })}</small>
                  </div>
                  <span className={`console-status-pill ${approval.status}`}>{approval.status}</span>
                </li>
              ))}
            </ul>
          )}
        </article>

        <div className="console-side-stack">
          <article className="card stack console-panel-card">
            <div className="stack tight">
              <h3>{t('Conversation carryover')}</h3>
              <small className="muted">
                {t('Files still processing in chat context can be revisited from the conversation workspace.')}
              </small>
            </div>
            <strong className="console-side-metric">{processingFiles}</strong>
            <small className="muted">
              {processingFiles > 0
                ? t('Continue attachment-driven work from chat when operational files are still processing.')
                : t('No chat files are currently processing.')}
            </small>
            <Link to="/workspace/chat" className="console-inline-link">
              {t('Continue in Chat')}
            </Link>
          </article>

          <article className="card stack console-panel-card">
            <div className="stack tight">
              <h3>{t('Quick Actions')}</h3>
              <small className="muted">
                {t('Use grouped action lanes instead of scanning a long mixed link list.')}
              </small>
            </div>
            <div className="console-action-grid">
              {actionGroups.map((group) => (
                <section key={group.title} className="console-action-group">
                  <div className="stack tight">
                    <strong>{group.title}</strong>
                    <small className="muted">{group.description}</small>
                  </div>
                  <div className="console-action-group-links">
                    {group.links.map((link) => (
                      <Link key={link.to} to={link.to} className="console-action-link">
                        {link.label}
                      </Link>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}
