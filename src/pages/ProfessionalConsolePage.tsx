import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApprovalRequest,
  DatasetRecord,
  FileAttachment,
  InferenceRunRecord,
  ModelRecord,
  ModelVersionRecord,
  TrainingJobRecord,
  User
} from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { Badge, StatusTag } from '../components/ui/Badge';
import { ButtonLink } from '../components/ui/Button';
import { InlineAlert, PageHeader } from '../components/ui/ConsolePage';
import WorkspaceActionStack from '../components/ui/WorkspaceActionStack';
import { Card, Panel } from '../components/ui/Surface';
import { WorkspacePage, WorkspaceSectionHeader, WorkspaceWorkbench } from '../components/ui/WorkspacePage';
import { deriveTrainingExecutionInsight } from '../features/trainingExecutionInsight';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';
import { detectInferenceRunReality } from '../utils/inferenceSource';

interface ConsoleSnapshot {
  user: User;
  datasets: DatasetRecord[];
  visibleModels: ModelRecord[];
  myModels: ModelRecord[];
  modelVersions: ModelVersionRecord[];
  conversationAttachments: FileAttachment[];
  approvals: ApprovalRequest[];
  trainingJobs: TrainingJobRecord[];
  inferenceRuns: InferenceRunRecord[];
}

interface ConsoleActionGroup {
  title: string;
  description: string;
  links: Array<{ to: string; label: string }>;
}

const backgroundRefreshIntervalMs = 6000;
type LoadMode = 'initial' | 'manual' | 'background';
const terminalTrainingStatuses = new Set<TrainingJobRecord['status']>(['completed', 'failed', 'cancelled']);
const activeTrainingStatuses = new Set<TrainingJobRecord['status']>(['queued', 'preparing', 'running', 'evaluating']);

const formatTimestamp = (iso: string): string => formatCompactTimestamp(iso);
const isAuthenticationRequiredMessage = (message: string): boolean => message === 'Authentication required.';

const buildConsoleSnapshotSignature = (snapshot: ConsoleSnapshot): string =>
  JSON.stringify({
    user: {
      id: snapshot.user.id,
      role: snapshot.user.role,
      updated_at: snapshot.user.updated_at
    },
    datasets: snapshot.datasets
      .map((dataset) => ({
        id: dataset.id,
        status: dataset.status,
        updated_at: dataset.updated_at
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
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
    modelVersions: snapshot.modelVersions
      .map((version) => ({
        id: version.id,
        status: version.status,
        updated_at: version.created_at
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
      .sort((left, right) => left.id.localeCompare(right.id)),
    trainingJobs: snapshot.trainingJobs
      .map((job) => ({
        id: job.id,
        status: job.status,
        execution_mode: job.execution_mode,
        updated_at: job.updated_at
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    inferenceRuns: snapshot.inferenceRuns
      .map((run) => ({
        id: run.id,
        status: run.status,
        execution_source: run.execution_source,
        updated_at: run.updated_at
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
      const [
        datasets,
        visibleModels,
        myModels,
        modelVersions,
        conversationAttachments,
        approvals,
        trainingJobs,
        inferenceRuns
      ] = await Promise.all([
        api.listDatasets(),
        api.listModels(),
        api.listMyModels(),
        api.listModelVersions(),
        api.listConversationAttachments(),
        user.role === 'admin' ? api.listApprovalRequests() : Promise.resolve([]),
        api.listTrainingJobs(),
        api.listInferenceRuns()
      ]);

      const nextSnapshot = {
        user,
        datasets,
        visibleModels,
        myModels,
        modelVersions,
        conversationAttachments,
        approvals,
        trainingJobs,
        inferenceRuns
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
    ) ||
      snapshot?.approvals.some((approval) => approval.status === 'pending') ||
      snapshot?.trainingJobs.some((job) => activeTrainingStatuses.has(job.status))
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
  const nonRealTrainingCount = useMemo(
    () =>
      snapshot
        ? snapshot.trainingJobs
            .filter((job) => terminalTrainingStatuses.has(job.status))
            .filter(
              (job) =>
                deriveTrainingExecutionInsight({
                  status: job.status,
                  executionMode: job.execution_mode,
                  artifactSummary: null
                }).reality !== 'real'
            ).length
        : 0,
    [snapshot]
  );
  const fallbackInferenceCount = useMemo(
    () =>
      snapshot
        ? snapshot.inferenceRuns
            .map((run) => detectInferenceRunReality(run))
            .filter((reality) => reality.fallback).length
        : 0,
    [snapshot]
  );
  const hasRealityWarning = nonRealTrainingCount > 0 || fallbackInferenceCount > 0;

  const actionGroups: ConsoleActionGroup[] = useMemo(() => {
    const groups: ConsoleActionGroup[] = [
      {
        title: t('Build & Ship'),
        description: t('Move from draft to version.'),
        links: [
          { to: '/models/create', label: t('Create New Model') },
          { to: '/models/my-models', label: t('Manage My Models') },
          { to: '/models/versions', label: t('Open Model Versions') }
        ]
      },
      {
        title: t('Data & Run'),
        description: t('Open data, training, and validation.'),
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
        description: t('Review approvals and audit trails.'),
        links: [
          { to: '/admin/models/pending', label: t('Review Approval Queue') },
          { to: '/admin/audit', label: t('View Audit Logs') },
          { to: '/admin/verification-reports', label: t('View Verification Reports') }
        ]
      });
    }

    return groups;
  }, [snapshot?.user.role, t]);

  const priorityMode =
    pendingApprovals.length > 0
      ? 'approval'
      : recentMyModels.length > 0
        ? 'model'
        : recentProcessingAttachments.length > 0
          ? 'attachment'
          : 'idle';
  const priorityDescription =
    priorityMode === 'approval'
      ? t('Items needing governance decisions now.')
      : priorityMode === 'model'
        ? t('Continue the latest model work without scanning the full navigation tree.')
        : priorityMode === 'attachment'
          ? t('Recent files still processing can be resumed from chat.')
          : t('No immediate follow-up item.');
  const priorityCta =
    priorityMode === 'approval'
      ? { to: '/admin/models/pending', label: t('Open Queue') }
      : priorityMode === 'model'
        ? { to: '/models/my-models', label: t('Inspect my models') }
        : priorityMode === 'attachment'
          ? { to: '/workspace/chat', label: t('Continue in Chat') }
          : { to: '/datasets', label: t('Open Datasets') };

  const authRequired = isAuthenticationRequiredMessage(error);

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Workspace')}
        title={t('Professional Console')}
        description={t('Focus on one priority lane, then jump in.')}
        meta={
          snapshot ? (
            <div className="row gap wrap align-center">
              <Badge tone="neutral">{t('Role')}: {roleLabel(snapshot.user.role)}</Badge>
              <Badge tone={pendingReviews > 0 ? 'warning' : 'neutral'}>
                {t('Pending reviews')}: {pendingReviews}
              </Badge>
              <Badge tone={processingFiles > 0 ? 'warning' : 'neutral'}>
                {t('Processing files')}: {processingFiles}
              </Badge>
              <Badge tone={hasRealityWarning ? 'warning' : 'success'}>
                {t('Execution warnings')}: {nonRealTrainingCount + fallbackInferenceCount}
              </Badge>
            </div>
          ) : undefined
        }
        primaryAction={{
          label: refreshing ? t('Refreshing...') : t('Refresh'),
          onClick: () => {
            load('manual').catch(() => {
              // handled by local state
            });
          },
          disabled: loading || refreshing
        }}
        secondaryActions={
          <ButtonLink to="/settings" variant="ghost" size="sm">
            {t('Open Settings')}
          </ButtonLink>
        }
      />

      {loading ? (
        <StateBlock
          variant="loading"
          title={t('Loading Console')}
          description={t('Preparing workspace summary.')}
        />
      ) : error && !snapshot ? (
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
      ) : !snapshot ? (
        <StateBlock
          variant="empty"
        title={t('No Snapshot')}
          description={t('It fills itself after data, training, or runtime work.')}
          extra={
            <div className="row gap wrap">
              <ButtonLink to="/datasets" variant="secondary" size="sm">
                {t('Open Datasets')}
              </ButtonLink>
              <ButtonLink to="/settings/runtime" variant="ghost" size="sm">
                {t('Open Runtime Settings')}
              </ButtonLink>
            </div>
          }
        />
      ) : (
        <>
          {hasRealityWarning ? (
            <InlineAlert
              tone="warning"
              title={t('Execution quality warnings detected')}
              description={t(
                'Training degraded outputs: {trainingCount}; inference degraded outputs: {inferenceCount}. Check the dedicated pages before publishing.',
                {
                  trainingCount: nonRealTrainingCount,
                  inferenceCount: fallbackInferenceCount
                }
              )}
              actions={
                <div className="row gap wrap">
                  <ButtonLink to="/training/jobs" variant="secondary" size="sm">
                    {t('Open Training Jobs')}
                  </ButtonLink>
                  <ButtonLink to="/inference/validate" variant="ghost" size="sm">
                    {t('Open Inference Validation')}
                  </ButtonLink>
                </div>
              }
            />
          ) : null}

          <WorkspaceWorkbench
            toolbar={
              <Card as="section" className="workspace-toolbar-card">
                <div className="workspace-toolbar-head">
                  <div className="workspace-toolbar-copy">
                    <h3>{t('Current Priority')}</h3>
                    <small className="muted">{priorityDescription}</small>
                  </div>
                  <div className="workspace-toolbar-actions">
                    <ButtonLink to={priorityCta.to} variant="secondary" size="sm">
                      {priorityCta.label}
                    </ButtonLink>
                  </div>
                </div>
              </Card>
            }
            main={
              <div className="workspace-main-stack">
                <Card as="article">
                  <WorkspaceSectionHeader
                    title={t('Main Work Queue')}
                    description={t('Handle one priority lane, then continue in the linked page.')}
                  />

                  {priorityMode === 'idle' ? (
                    <StateBlock
                      variant="empty"
                      title={t('No follow-up items right now')}
                      description={t('No pending approvals, active model work, or processing attachments were found.')}
                      extra={
                        <div className="row gap wrap">
                          <ButtonLink to="/datasets" variant="secondary" size="sm">
                            {t('Open Datasets')}
                          </ButtonLink>
                          <ButtonLink to="/models/create" variant="ghost" size="sm">
                            {t('Create New Model')}
                          </ButtonLink>
                        </div>
                      }
                    />
                  ) : (
                    <ul className="workspace-record-list compact">
                      {priorityMode === 'approval'
                        ? pendingApprovals.slice(0, 4).map((approval) => {
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

                <Card as="article">
                  <WorkspaceSectionHeader
                    title={t('Workflow Lanes')}
                    description={t('Open the dedicated page for each task.')}
                  />
                  <div className="workspace-action-grid">
                    {actionGroups.map((group) => (
                      <Panel key={group.title} as="section" className="stack tight" tone="soft">
                        <div className="stack tight">
                          <strong>{group.title}</strong>
                          <small className="muted">{group.description}</small>
                        </div>
                        <WorkspaceActionStack>
                          {group.links.map((link) => (
                            <ButtonLink key={link.to} to={link.to} variant="secondary" size="sm" block>
                              {link.label}
                            </ButtonLink>
                          ))}
                        </WorkspaceActionStack>
                      </Panel>
                    ))}
                  </div>
                </Card>
              </div>
            }
          />
        </>
      )}
    </WorkspacePage>
  );
}
