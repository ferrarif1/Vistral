import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ApprovalRequest, FileAttachment, ModelRecord, User } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { Input } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceContextBar,
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { emitAuthUpdated } from '../services/authSession';
import { formatCompactTimestamp } from '../utils/formatting';

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

const formatTimestamp = (iso: string): string => formatCompactTimestamp(iso);
const isAuthenticationRequiredMessage = (message: string): boolean => message === 'Authentication required.';

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
  const navigate = useNavigate();
  const { t, roleLabel } = useI18n();
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [consoleCommandInput, setConsoleCommandInput] = useState('');
  const [consoleCommandNotice, setConsoleCommandNotice] = useState('');
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
      setSnapshot(null);
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

  const processingFiles =
    snapshot?.conversationAttachments.filter(
      (attachment) => attachment.status === 'uploading' || attachment.status === 'processing'
    ).length ?? 0;
  const pendingApprovals =
    snapshot?.approvals.filter((approval) => approval.status === 'pending') ?? [];
  const pendingReviews = pendingApprovals.length;

  const recentMyModels = useMemo(
    () =>
      snapshot
        ? [...snapshot.myModels]
            .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
            .slice(0, 4)
        : [],
    [snapshot]
  );
  const recentProcessingAttachments = useMemo(
    () =>
      snapshot
        ? snapshot.conversationAttachments
            .filter(
              (attachment) => attachment.status === 'uploading' || attachment.status === 'processing'
            )
            .slice(0, 4)
        : [],
    [snapshot]
  );
  const modelIndex = useMemo(
    () =>
      new Map(snapshot ? [...snapshot.visibleModels, ...snapshot.myModels].map((model) => [model.id, model]) : []),
    [snapshot]
  );

  const priorityMode =
    pendingApprovals.length > 0
      ? 'approval'
      : recentMyModels.length > 0
        ? 'model'
        : recentProcessingAttachments.length > 0
          ? 'attachment'
          : 'empty';
  const priorityDescription =
    priorityMode === 'approval'
      ? t('Items needing attention now.')
      : priorityMode === 'model'
        ? t('Continue the latest model work without scanning the full navigation tree.')
        : priorityMode === 'attachment'
          ? t('Recent files still processing in conversation context can be resumed from chat.')
          : t('No console data available.');
  const priorityCta =
    priorityMode === 'approval'
      ? { to: '/admin/models/pending', label: t('Open Queue') }
      : priorityMode === 'model'
        ? { to: '/models/my-models', label: t('Inspect my models') }
        : { to: '/workspace/chat', label: t('Continue in Chat') };

  const actionGroups: ConsoleActionGroup[] = useMemo(() => {
    const groups: ConsoleActionGroup[] = [
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
        title: t('Data & Run'),
        description: t('Open the core execution surfaces for datasets, training, and inference validation.'),
        links: [
          { to: '/datasets', label: t('Manage Datasets') },
          { to: '/training/jobs', label: t('Open Training Jobs') },
          { to: '/inference/validate', label: t('Validate Inference') }
        ]
      }
    ];

    if (snapshot?.user.role === 'admin') {
      groups.push({
        title: t('Admin & Audit'),
        description: t('Review approvals, audit trails, and release evidence from one place.'),
        links: [
          { to: '/admin/models/pending', label: t('Review Approval Queue') },
          { to: '/admin/audit', label: t('View Audit Logs') },
          { to: '/admin/verification-reports', label: t('View Verification Reports') }
        ]
      });
    }

    return groups;
  }, [snapshot?.user.role, t]);

  const commandCandidates = useMemo(
    () =>
      actionGroups
        .flatMap((group) => group.links)
        .filter((link, index, list) => list.findIndex((candidate) => candidate.to === link.to) === index),
    [actionGroups]
  );

  const runConsoleCommand = useCallback(() => {
    const query = consoleCommandInput.trim();
    if (!query) {
      return;
    }

    const normalizedQuery = query.toLowerCase();
    const target = commandCandidates.find((candidate) =>
      candidate.label.toLowerCase().includes(normalizedQuery)
    );
    if (!target) {
      setConsoleCommandNotice(t('No matching destination found. Try a feature keyword.'));
      return;
    }

    setConsoleCommandNotice(t('Opening {label}', { label: target.label }));
    setConsoleCommandInput('');
    navigate(target.to);
  }, [commandCandidates, consoleCommandInput, navigate, t]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
      setSnapshot(null);
      setError('');
      emitAuthUpdated();
      navigate('/', { replace: true });
    } catch (logoutError) {
      setError((logoutError as Error).message);
    }
  }, [navigate]);

  const renderPageShell = (content: ReactNode) => (
    <WorkspacePage>
      <WorkspaceHero
        eyebrow={t('Workspace overview')}
        title={t('Professional Console')}
        description={
          snapshot
            ? t('Keep approvals, recent model work, and next actions in one stable workspace.')
            : t('Loading overview')
        }
        actions={
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
            {snapshot ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => void logout()}>
                {t('Logout')}
              </Button>
            ) : null}
          </div>
        }
        stats={[
          {
            label: t('Role overview'),
            value: snapshot ? roleLabel(snapshot.user.role) : t('Pending')
          },
          {
            label: t('Pending reviews'),
            value: pendingReviews
          },
          {
            label: t('File Processing'),
            value: processingFiles
          }
        ]}
      />
      {content}
    </WorkspacePage>
  );

  const authRequired = isAuthenticationRequiredMessage(error);
  const mainContent = loading
    ? renderPageShell(
        <StateBlock
          variant="loading"
          title={t('Loading Console')}
          description={t('Preparing workspace overview.')}
        />
      )
    : error && !snapshot
      ? renderPageShell(
          authRequired ? (
            <StateBlock
              variant="empty"
              title={t('Login to open professional workspace')}
              description={t('Sign in to access operational snapshots and console actions.')}
              extra={
                <div className="chat-auth-state-actions">
                  <ButtonLink to="/auth/login" variant="secondary" size="sm">
                    {t('Login')}
                  </ButtonLink>
                </div>
              }
            />
          ) : (
            <StateBlock variant="error" title={t('Console Load Failed')} description={error} />
          )
        )
      : !snapshot
        ? renderPageShell(
            <StateBlock variant="empty" title={t('No Snapshot')} description={t('No console data available.')} />
          )
        : renderPageShell(
            <>
              <WorkspaceMetricGrid
                items={[
                  {
                    title: t('Visibility'),
                    description: t('Models currently visible to this account.'),
                    value: snapshot.visibleModels.length
                  },
                  {
                    title: t('My Models'),
                    description: t('Ownership-scoped model inventory.'),
                    value: snapshot.myModels.length
                  },
                  {
                    title: t('Pending Model Approvals'),
                    description: t('Models waiting for admin review.'),
                    value: pendingApprovals.length,
                    tone: pendingApprovals.length > 0 ? 'attention' : 'default'
                  },
                  {
                    title: t('File Processing'),
                    description: t('Conversation attachments still in uploading/processing state.'),
                    value: processingFiles,
                    tone: processingFiles > 0 ? 'attention' : 'default'
                  }
                ]}
              />

              <WorkspaceWorkbench
                toolbar={
                  <WorkspaceContextBar
                    leading={
                      <>
                        <Input
                          value={consoleCommandInput}
                          onChange={(event) => setConsoleCommandInput(event.target.value)}
                          placeholder={t('Find a page, e.g. dataset / training / audit')}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              runConsoleCommand();
                            }
                          }}
                        />
                        <Button
                          type="button"
                          variant={consoleCommandInput.trim() ? 'primary' : 'secondary'}
                          size="sm"
                          onClick={runConsoleCommand}
                          disabled={!consoleCommandInput.trim()}
                        >
                          {t('Go')}
                        </Button>
                      </>
                    }
                    trailing={
                      <ButtonLink to="/settings" variant="ghost" size="sm">
                        {t('Open Settings')}
                      </ButtonLink>
                    }
                    summary={<small className="muted">{consoleCommandNotice || t('Use keyword routing for faster navigation.')}</small>}
                  />
                }
                main={
                  <Card as="article">
                    <WorkspaceSectionHeader
                      title={t('Main Work Queue')}
                      description={priorityDescription}
                      actions={
                        priorityMode !== 'empty' ? (
                          <ButtonLink to={priorityCta.to} variant="secondary" size="sm">
                            {priorityCta.label}
                          </ButtonLink>
                        ) : null
                      }
                    />

                    {priorityMode === 'empty' ? (
                      <StateBlock
                        variant="empty"
                        title={t('No follow-up items right now.')}
                        description={t('All queued approvals are already resolved.')}
                      />
                    ) : (
                      <ul className="workspace-record-list compact">
                        {priorityMode === 'approval'
                          ? pendingApprovals.slice(0, 6).map((approval: ApprovalRequest) => {
                              const model = modelIndex.get(approval.model_id);

                              return (
                                <Panel key={approval.id} as="li" className="workspace-record-item compact" tone="soft">
                                  <div className="workspace-record-item-top">
                                    <div className="workspace-record-summary stack tight">
                                      <strong>{model?.name ?? t('Unavailable model record')}</strong>
                                      <small className="muted">
                                        {model
                                          ? `${t(model.model_type)} · ${t(model.status)}`
                                          : t('Model record is not currently available in the catalog.')}
                                      </small>
                                      <small className="muted">
                                        {t('Requested at')}: {formatTimestamp(approval.requested_at)}
                                      </small>
                                    </div>
                                    <StatusTag status={approval.status}>{t(approval.status)}</StatusTag>
                                  </div>
                                  <ButtonLink to="/admin/models/pending" variant="ghost" size="sm">
                                    {t('Open Queue')}
                                  </ButtonLink>
                                </Panel>
                              );
                            })
                          : null}
                        {priorityMode === 'model'
                          ? recentMyModels.map((model) => (
                              <Panel key={model.id} as="li" className="workspace-record-item compact" tone="soft">
                                <div className="workspace-record-item-top">
                                  <div className="workspace-record-summary stack tight">
                                    <strong>{model.name}</strong>
                                    <small className="muted">
                                      {t(model.model_type)} · {t(model.status)}
                                    </small>
                                    <small className="muted">
                                      {t('Last updated')}: {formatTimestamp(model.updated_at)}
                                    </small>
                                  </div>
                                  <StatusTag status={model.status}>{t(model.status)}</StatusTag>
                                </div>
                                <ButtonLink to="/models/my-models" variant="ghost" size="sm">
                                  {t('Inspect my models')}
                                </ButtonLink>
                              </Panel>
                            ))
                          : null}
                        {priorityMode === 'attachment'
                          ? recentProcessingAttachments.map((attachment) => (
                              <Panel key={attachment.id} as="li" className="workspace-record-item compact" tone="soft">
                                <div className="workspace-record-item-top">
                                  <div className="workspace-record-summary stack tight">
                                    <strong>{attachment.filename}</strong>
                                    <small className="muted">
                                      {t(attachment.status)} · {t('Last updated')}: {formatTimestamp(attachment.updated_at)}
                                    </small>
                                  </div>
                                  <StatusTag status={attachment.status}>{t(attachment.status)}</StatusTag>
                                </div>
                                <ButtonLink to="/workspace/chat" variant="ghost" size="sm">
                                  {t('Continue in Chat')}
                                </ButtonLink>
                              </Panel>
                            ))
                          : null}
                      </ul>
                    )}
                  </Card>
                }
                side={
                  <>
                    <Card as="article">
                      <WorkspaceSectionHeader
                        title={t('Operational Context')}
                        description={t('Keep role, queue load, and in-flight file state visible while operating.')}
                      />
                      <ul className="workspace-record-list compact">
                        <Panel as="li" className="workspace-record-item compact" tone="soft">
                          <div className="row between gap wrap align-center">
                            <strong>{t('Role')}</strong>
                            <Badge tone="neutral">{roleLabel(snapshot.user.role)}</Badge>
                          </div>
                        </Panel>
                        <Panel as="li" className="workspace-record-item compact" tone="soft">
                          <div className="row between gap wrap align-center">
                            <strong>{t('Pending reviews')}</strong>
                            <Badge tone={pendingReviews > 0 ? 'warning' : 'neutral'}>{pendingReviews}</Badge>
                          </div>
                        </Panel>
                        <Panel as="li" className="workspace-record-item compact" tone="soft">
                          <div className="row between gap wrap align-center">
                            <strong>{t('Processing files')}</strong>
                            <Badge tone={processingFiles > 0 ? 'warning' : 'neutral'}>{processingFiles}</Badge>
                          </div>
                        </Panel>
                      </ul>
                    </Card>

                    <Card as="article">
                      <WorkspaceSectionHeader
                        title={t('Action Lanes')}
                        description={t('Grouped by workflow so you can jump into the right workbench quickly.')}
                      />
                      <div className="workspace-action-grid">
                        {actionGroups.map((group) => (
                          <Panel key={group.title} as="section" className="stack tight" tone="soft">
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
                  </>
                }
              />
            </>
          );

  return mainContent;
}
