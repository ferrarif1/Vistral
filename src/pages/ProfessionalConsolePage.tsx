import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalRequest, FileAttachment, ModelRecord, User } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { Card, Panel } from '../components/ui/Surface';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
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

const backgroundRefreshIntervalMs = 6000;
type LoadMode = 'initial' | 'manual' | 'background';

const formatTimestamp = (iso: string): string => {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) {
    return iso;
  }

  return new Date(value).toLocaleString();
};

const buildConsoleSnapshotSignature = (snapshot: ConsoleSnapshot): string =>
  JSON.stringify({
    user: {
      id: snapshot.user.id,
      role: snapshot.user.role,
      updated_at: snapshot.user.updated_at
    },
    visibleModels: snapshot.visibleModels
      .map((model) => ({
        id: model.id,
        status: model.status,
        updated_at: model.updated_at
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    myModels: snapshot.myModels
      .map((model) => ({
        id: model.id,
        status: model.status,
        updated_at: model.updated_at
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    conversationAttachments: snapshot.conversationAttachments
      .map((attachment) => ({
        id: attachment.id,
        status: attachment.status,
        updated_at: attachment.updated_at
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    approvals: snapshot.approvals
      .map((approval) => ({
        id: approval.id,
        status: approval.status,
        requested_at: approval.requested_at
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  });

export default function ProfessionalConsolePage() {
  const { t, roleLabel } = useI18n();
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const snapshotSignatureRef = useRef('');

  const load = useCallback(async (mode: LoadMode = 'initial') => {
    if (mode === 'initial') {
      setLoading(true);
    }

    if (mode === 'manual') {
      setRefreshing(true);
    }

    setError('');

    try {
      const user = await api.me();
      const [visibleModels, myModels, conversationAttachments, approvals] = await Promise.all([
        api.listModels(),
        api.listMyModels(),
        api.listConversationAttachments(),
        user.role === 'admin' ? api.listApprovalRequests() : Promise.resolve([])
      ]);

      const nextSnapshot = {
        user,
        visibleModels,
        myModels,
        conversationAttachments,
        approvals
      };
      const nextSignature = buildConsoleSnapshotSignature(nextSnapshot);
      if (snapshotSignatureRef.current !== nextSignature) {
        snapshotSignatureRef.current = nextSignature;
        setSnapshot(nextSnapshot);
      }
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      if (mode === 'initial') {
        setLoading(false);
      }

      if (mode === 'manual') {
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    load('initial').catch(() => {
      // handled by local state
    });
  }, [load]);

  const hasTransientConsoleState = Boolean(
    snapshot?.conversationAttachments.some(
      (attachment) => attachment.status === 'uploading' || attachment.status === 'processing'
    ) || snapshot?.approvals.some((approval) => approval.status === 'pending')
  );

  useBackgroundPolling(
    () => {
      load('background').catch(() => {
        // no-op
      });
    },
    {
      intervalMs: backgroundRefreshIntervalMs,
      enabled: hasTransientConsoleState
    }
  );

  const pendingReviews = snapshot?.approvals.filter((approval) => approval.status === 'pending').length ?? 0;
  const processingAttachments =
    snapshot?.conversationAttachments.filter(
      (attachment) => attachment.status === 'uploading' || attachment.status === 'processing'
    ).length ?? 0;

  const heroSection = (
    <Card className="workspace-overview-hero">
      <div className="workspace-overview-hero-grid">
        <div className="workspace-overview-copy stack">
          <small className="workspace-eyebrow">{t('Control Center')}</small>
          <div className="workspace-section-header">
            <div className="stack tight">
              <h1>{t('Professional Console')}</h1>
              <p className="muted">
                {snapshot
                  ? t('Role: {role}. This panel provides a professional control-plane entry for structured model operations.', {
                      role: roleLabel(snapshot.user.role)
                    })
                  : t('Role-aware operational snapshot for structured model operations.')}
              </p>
            </div>
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
              {refreshing ? t('Refreshing...') : t('Refresh')}
            </Button>
          </div>
        </div>
        <div className="workspace-overview-badges">
          <div className="workspace-overview-badge">
            <span>{t('Role overview')}</span>
            <strong>{snapshot ? roleLabel(snapshot.user.role) : t('Pending')}</strong>
          </div>
          <div className="workspace-overview-badge">
            <span>{t('Pending reviews')}</span>
            <strong>{pendingReviews}</strong>
          </div>
          <div className="workspace-overview-badge">
            <span>{t('Processing attachments')}</span>
            <strong>{processingAttachments}</strong>
          </div>
        </div>
      </div>
    </Card>
  );

  const renderPageShell = (content: ReactNode) => (
    <div className="workspace-overview-page stack">
      {heroSection}
      {content}
    </div>
  );

  if (loading) {
    return renderPageShell(
      <StateBlock variant="loading" title={t('Loading Console')} description={t('Building operational snapshot.')} />
    );
  }

  if (error) {
    return renderPageShell(
      <StateBlock variant="error" title={t('Console Load Failed')} description={error} />
    );
  }

  if (!snapshot) {
    return renderPageShell(
      <StateBlock variant="empty" title={t('No Snapshot')} description={t('No console data available.')} />
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
  const queueCta = snapshot.user.role === 'admin'
    ? { to: '/admin/models/pending', label: t('Open Queue') }
    : { to: '/models/my-models', label: t('Open My Models') };

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
    }
  ];

  if (snapshot.user.role === 'admin') {
    actionGroups.push({
      title: t('Admin & Audit'),
      description: t('Review approvals, audit trails, and release evidence from one lane.'),
      links: [
        { to: '/admin/models/pending', label: t('Review Approval Queue') },
        { to: '/admin/audit', label: t('View Audit Logs') },
        { to: '/admin/verification-reports', label: t('View Verification Reports') }
      ]
    });
  }

  return renderPageShell(
    <>
      <section className="workspace-overview-signal-grid">
        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Visibility')}</h3>
            <small className="muted">{t('Models currently visible to this account.')}</small>
          </div>
          <strong className="metric">{snapshot.visibleModels.length}</strong>
          <small className="muted">
            {t('Ready models')}: {readyVisibleModels}
          </small>
        </Card>

        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('My Models')}</h3>
            <small className="muted">{t('Ownership-scoped model inventory.')}</small>
          </div>
          <strong className="metric">{snapshot.myModels.length}</strong>
          <small className="muted">
            {t('Pending Model Approvals')}: {pendingModels}
          </small>
        </Card>

        <Card as="article" className={`workspace-signal-card${pendingApprovals.length > 0 ? ' attention' : ''}`}>
          <div className="workspace-signal-top">
            <h3>{t('Pending Model Approvals')}</h3>
            <small className="muted">{t('Models waiting for admin review.')}</small>
          </div>
          <strong className="metric">{pendingApprovals.length}</strong>
          <small className="muted">
            {t('Pending approvals visible in queue: {count}.', { count: pendingApprovals.length })}
          </small>
        </Card>

        <Card as="article" className={`workspace-signal-card${processingFiles > 0 ? ' attention' : ''}`}>
          <div className="workspace-signal-top">
            <h3>{t('File Processing')}</h3>
            <small className="muted">{t('Conversation attachments still in uploading/processing state.')}</small>
          </div>
          <strong className="metric">{processingFiles}</strong>
          <small className="muted">
            {processingFiles > 0 ? t('Continue in Chat') : t('No pending chat files')}
          </small>
        </Card>
      </section>

      <section className="workspace-overview-panel-grid">
        <Card as="article" className="workspace-overview-main">
          <div className="workspace-section-header">
            <div className="stack tight">
              <h3>{t('Priority Queue')}</h3>
              <small className="muted">{t('Items needing attention now.')}</small>
            </div>
            <div className="row gap wrap">
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
                {refreshing ? t('Refreshing...') : t('Refresh')}
              </Button>
              <ButtonLink to={queueCta.to} variant="secondary" size="sm">
                {queueCta.label}
              </ButtonLink>
            </div>
          </div>

          {queuePreview.length === 0 ? (
            <StateBlock
              variant="empty"
              title={t('No approvals need attention right now.')}
              description={t('All queued approvals are already resolved.')}
            />
          ) : (
            <ul className="workspace-record-list compact">
              {queuePreview.map((approval: ApprovalRequest) => (
                <Panel key={approval.id} as="li" className="workspace-record-item compact" tone="soft">
                  <div className="workspace-record-item-top">
                    <div className="workspace-record-summary stack tight">
                      <strong>{approval.id}</strong>
                      <small className="muted">{t('Model: {modelId}', { modelId: approval.model_id })}</small>
                      <small className="muted">
                        {t('Requested')}: {formatTimestamp(approval.requested_at)}
                      </small>
                    </div>
                    <div className="workspace-record-actions">
                      <StatusTag status={approval.status}>{t(approval.status)}</StatusTag>
                      <ButtonLink to={queueCta.to} variant="ghost" size="sm">
                        {t('Open Queue')}
                      </ButtonLink>
                    </div>
                  </div>
                </Panel>
              ))}
            </ul>
          )}
        </Card>

        <div className="workspace-overview-side">
          <Card as="article">
            <div className="stack tight">
              <h3>{t('Conversation carryover')}</h3>
              <small className="muted">
                {t('Files still processing in chat context can be revisited from the conversation workspace.')}
              </small>
            </div>
            <strong className="workspace-side-metric">{processingFiles}</strong>
            <small className="muted">
              {processingFiles > 0
                ? t('Continue attachment-driven work from chat when operational files are still processing.')
                : t('No chat files are currently processing.')}
            </small>
            <ButtonLink to="/workspace/chat" variant="secondary">
              {t('Continue in Chat')}
            </ButtonLink>
          </Card>

          <Card as="article">
            <div className="stack tight">
              <h3>{t('Quick Actions')}</h3>
              <small className="muted">
                {t('Use grouped action lanes instead of scanning a long mixed link list.')}
              </small>
            </div>
            <div className="workspace-action-grid">
              {actionGroups.map((group) => (
                <Panel key={group.title} as="section" className="stack" tone="soft">
                  <div className="stack tight">
                    <strong>{group.title}</strong>
                    <small className="muted">{group.description}</small>
                  </div>
                  <div className="workspace-button-stack">
                    {group.links.map((link) => (
                      <ButtonLink key={link.to} to={link.to} variant="secondary" size="sm" block>
                        {link.label}
                      </ButtonLink>
                    ))}
                  </div>
                </Panel>
              ))}
            </div>
          </Card>
        </div>
      </section>
    </>
  );
}
