import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApprovalRequest,
  FileAttachment,
  InferenceRunRecord,
  ModelRecord,
  TrainingJobRecord,
  User
} from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import { deriveTrainingExecutionInsight, type TrainingExecutionInsight } from '../features/trainingExecutionInsight';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';

interface ConsoleSnapshot {
  user: User;
  visibleModels: ModelRecord[];
  myModels: ModelRecord[];
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

const formatTimestamp = (iso: string): string => formatCompactTimestamp(iso);
const isAuthenticationRequiredMessage = (message: string): boolean => message === 'Authentication required.';
const terminalTrainingStatuses = new Set<TrainingJobRecord['status']>(['completed', 'failed', 'cancelled']);
const activeTrainingStatuses = new Set<TrainingJobRecord['status']>(['queued', 'preparing', 'running', 'evaluating']);

const detectInferenceFallback = (run: InferenceRunRecord): { fallback: boolean; reason: string | null } => {
  const normalizedMeta =
    run.normalized_output.normalized_output &&
    typeof run.normalized_output.normalized_output === 'object' &&
    !Array.isArray(run.normalized_output.normalized_output)
      ? (run.normalized_output.normalized_output as Record<string, unknown>)
      : {};
  const rawMeta =
    run.raw_output.meta && typeof run.raw_output.meta === 'object' && !Array.isArray(run.raw_output.meta)
      ? (run.raw_output.meta as Record<string, unknown>)
      : null;
  const normalizedSource =
    typeof normalizedMeta.source === 'string' && normalizedMeta.source.trim()
      ? normalizedMeta.source.toLowerCase()
      : '';
  const executionSource = run.execution_source.trim().toLowerCase();
  const source = normalizedSource || executionSource;
  const sourceIndicatesFallback = source.includes('mock') || source.includes('template') || source.includes('fallback');
  const templateMode = rawMeta && typeof rawMeta.mode === 'string' ? rawMeta.mode.toLowerCase() === 'template' : false;
  const localFallbackReason =
    typeof run.raw_output.local_command_fallback_reason === 'string' && run.raw_output.local_command_fallback_reason.trim()
      ? run.raw_output.local_command_fallback_reason.trim()
      : '';
  const runtimeFallbackReason =
    typeof run.raw_output.runtime_fallback_reason === 'string' && run.raw_output.runtime_fallback_reason.trim()
      ? run.raw_output.runtime_fallback_reason.trim()
      : '';
  const templateFallbackReason =
    rawMeta && typeof rawMeta.fallback_reason === 'string' && rawMeta.fallback_reason.trim()
      ? rawMeta.fallback_reason.trim()
      : '';
  const reason = localFallbackReason || runtimeFallbackReason || templateFallbackReason || null;
  return {
    fallback: sourceIndicatesFallback || templateMode || Boolean(reason),
    reason
  };
};

const formatCoveragePercent = (covered: number, total: number): string => {
  if (total <= 0) {
    return 'n/a';
  }
  return `${Math.round((covered / total) * 100)}%`;
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
  const [jobExecutionInsights, setJobExecutionInsights] = useState<Record<string, TrainingExecutionInsight>>({});
  const [jobInsightsLoading, setJobInsightsLoading] = useState(false);
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
      const [visibleModels, myModels, conversationAttachments, approvals, trainingJobs, inferenceRuns] = await Promise.all([
        api.listModels(),
        api.listMyModels(),
        api.listConversationAttachments(),
        user.role === 'admin' ? api.listApprovalRequests() : Promise.resolve([]),
        api.listTrainingJobs(),
        api.listInferenceRuns()
      ]);

      const nextSnapshot = {
        user,
        visibleModels,
        myModels,
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

  const terminalLocalCommandCandidates = useMemo(
    () =>
      snapshot
        ? [...snapshot.trainingJobs]
            .filter((job) => terminalTrainingStatuses.has(job.status) && job.execution_mode === 'local_command')
            .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
            .slice(0, 24)
        : [],
    [snapshot]
  );

  const terminalInsightSignature = useMemo(
    () =>
      terminalLocalCommandCandidates
        .map((job) => `${job.id}:${job.updated_at}`)
        .sort((left, right) => left.localeCompare(right))
        .join('|'),
    [terminalLocalCommandCandidates]
  );

  useEffect(() => {
    if (!terminalLocalCommandCandidates.length) {
      setJobExecutionInsights({});
      setJobInsightsLoading(false);
      return;
    }

    let active = true;
    setJobInsightsLoading(true);

    Promise.all(
      terminalLocalCommandCandidates.map(async (job) => {
        try {
          const detail = await api.getTrainingJobDetail(job.id);
          return [
            job.id,
            deriveTrainingExecutionInsight({
              status: detail.job.status,
              executionMode: detail.job.execution_mode,
              artifactSummary: detail.artifact_summary
            })
          ] as const;
        } catch {
          return [
            job.id,
            deriveTrainingExecutionInsight({
              status: job.status,
              executionMode: job.execution_mode,
              artifactSummary: null
            })
          ] as const;
        }
      })
    )
      .then((entries) => {
        if (!active) {
          return;
        }
        const next: Record<string, TrainingExecutionInsight> = {};
        entries.forEach(([id, insight]) => {
          next[id] = insight;
        });
        setJobExecutionInsights(next);
      })
      .finally(() => {
        if (!active) {
          return;
        }
        setJobInsightsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [terminalInsightSignature, terminalLocalCommandCandidates]);

  const nonRealTrainingJobs = useMemo(
    () =>
      snapshot
        ? snapshot.trainingJobs
            .filter((job) => terminalTrainingStatuses.has(job.status))
            .map((job) => {
              if (job.execution_mode !== 'local_command') {
                return {
                  job,
                  insight: deriveTrainingExecutionInsight({
                    status: job.status,
                    executionMode: job.execution_mode,
                    artifactSummary: null
                  })
                };
              }
              const insight =
                jobExecutionInsights[job.id] ??
                deriveTrainingExecutionInsight({
                  status: job.status,
                  executionMode: job.execution_mode,
                  artifactSummary: null
                });
              return {
                job,
                insight
              };
            })
            .filter((entry) => entry.insight.reality !== 'real')
            .sort((left, right) => Date.parse(right.job.updated_at) - Date.parse(left.job.updated_at))
        : [],
    [jobExecutionInsights, snapshot]
  );

  const inferenceFallbackRuns = useMemo(
    () =>
      snapshot
        ? snapshot.inferenceRuns
            .map((run) => ({ run, reality: detectInferenceFallback(run) }))
            .filter((entry) => entry.reality.fallback)
            .sort((left, right) => Date.parse(right.run.updated_at) - Date.parse(left.run.updated_at))
        : [],
    [snapshot]
  );
  const nonRealTrainingCount = nonRealTrainingJobs.length;
  const fallbackInferenceCount = inferenceFallbackRuns.length;
  const hasRealityWarning = nonRealTrainingCount > 0 || fallbackInferenceCount > 0;
  const terminalTrainingCount = snapshot
    ? snapshot.trainingJobs.filter((job) => terminalTrainingStatuses.has(job.status)).length
    : 0;
  const realTrainingCount = Math.max(terminalTrainingCount - nonRealTrainingCount, 0);
  const realTrainingCoverage = formatCoveragePercent(realTrainingCount, terminalTrainingCount);
  const totalInferenceCount = snapshot?.inferenceRuns.length ?? 0;
  const realInferenceCount = Math.max(totalInferenceCount - fallbackInferenceCount, 0);
  const realInferenceCoverage = formatCoveragePercent(realInferenceCount, totalInferenceCount);
  const topTrainingFallbackReasons = useMemo(
    () =>
      Array.from(
        nonRealTrainingJobs.reduce((counter, entry) => {
          const reason = entry.insight.fallbackReason?.trim() || 'unspecified_non_real_evidence';
          counter.set(reason, (counter.get(reason) ?? 0) + 1);
          return counter;
        }, new Map<string, number>())
      )
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3),
    [nonRealTrainingJobs]
  );
  const topInferenceFallbackReasons = useMemo(
    () =>
      Array.from(
        inferenceFallbackRuns.reduce((counter, entry) => {
          const reason = entry.reality.reason?.trim() || 'unspecified_runtime_fallback';
          counter.set(reason, (counter.get(reason) ?? 0) + 1);
          return counter;
        }, new Map<string, number>())
      )
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3),
    [inferenceFallbackRuns]
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
                  },
                  {
                    title: t('Non-real training outputs'),
                    description: t('Terminal jobs with template/simulated/unknown execution evidence.'),
                    value: nonRealTrainingCount,
                    tone: nonRealTrainingCount > 0 ? 'attention' : 'default'
                  },
                  {
                    title: t('Fallback inference runs'),
                    description: t('Inference runs marked as fallback/template/mock output.'),
                    value: fallbackInferenceCount,
                    tone: fallbackInferenceCount > 0 ? 'attention' : 'default'
                  },
                  {
                    title: t('Training real-run coverage'),
                    description: t('Share of terminal training jobs that carry real execution evidence.'),
                    value: `${realTrainingCoverage} (${realTrainingCount}/${terminalTrainingCount})`,
                    tone:
                      terminalTrainingCount > 0 && realTrainingCount !== terminalTrainingCount
                        ? 'attention'
                        : 'default'
                  },
                  {
                    title: t('Inference real-run coverage'),
                    description: t('Share of inference runs without fallback/template/mock markers.'),
                    value: `${realInferenceCoverage} (${realInferenceCount}/${totalInferenceCount})`,
                    tone:
                      totalInferenceCount > 0 && realInferenceCount !== totalInferenceCount
                        ? 'attention'
                        : 'default'
                  }
                ]}
              />

              <WorkspaceWorkbench
                toolbar={
                  <Card as="section" className="workspace-toolbar-card">
                    <div className="workspace-toolbar-head">
                      <div className="workspace-toolbar-copy">
                        <h3>{t('Console Controls')}</h3>
                        <small className="muted">
                          {t('Keep the current work priority, console refresh, and next lane selection in one stable strip.')}
                        </small>
                      </div>
                      <div className="workspace-toolbar-actions">
                        {priorityMode !== 'empty' ? (
                          <ButtonLink to={priorityCta.to} variant="ghost" size="sm">
                            {priorityCta.label}
                          </ButtonLink>
                        ) : null}
                        <ButtonLink to="/settings" variant="ghost" size="sm">
                          {t('Open Settings')}
                        </ButtonLink>
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
                    <div className="workspace-toolbar-meta">
                      <div className="workspace-segmented-actions">
                        <Badge tone="neutral">{t('Role')}: {roleLabel(snapshot.user.role)}</Badge>
                        <Badge tone={pendingReviews > 0 ? 'warning' : 'neutral'}>
                          {t('Pending reviews')}: {pendingReviews}
                        </Badge>
                        <Badge tone={processingFiles > 0 ? 'warning' : 'neutral'}>
                          {t('Processing files')}: {processingFiles}
                        </Badge>
                        <Badge tone={nonRealTrainingCount > 0 ? 'warning' : 'neutral'}>
                          {t('Non-real training')}: {nonRealTrainingCount}
                        </Badge>
                        <Badge tone={fallbackInferenceCount > 0 ? 'warning' : 'neutral'}>
                          {t('Fallback inference')}: {fallbackInferenceCount}
                        </Badge>
                        <Badge tone="info">
                          {t('Priority lane')}:{' '}
                          {priorityMode === 'approval'
                            ? t('Approvals')
                            : priorityMode === 'model'
                              ? t('Models')
                              : priorityMode === 'attachment'
                                ? t('Attachments')
                                : t('Idle')}
                        </Badge>
                      </div>
                    </div>
                  </Card>
                }
                main={
                  <div className="workspace-main-stack">
                    <Card as="article">
                      <WorkspaceSectionHeader
                        title={t('Reality Guardrail')}
                        description={t('Surface template/fallback outputs early so production decisions stay safe.')}
                      />
                      {jobInsightsLoading ? (
                        <small className="muted">{t('Refreshing training authenticity checks...')}</small>
                      ) : null}
                      {!hasRealityWarning ? (
                        <StateBlock
                          variant="success"
                          title={t('No non-real execution signals in recent runs')}
                          description={t('Recent terminal training jobs and inference runs look authenticity-safe.')}
                        />
                      ) : (
                        <div className="stack">
                          <Panel as="section" className="stack tight" tone="soft">
                            <div className="row between gap wrap align-center">
                              <strong>{t('Top fallback reasons')}</strong>
                              <Badge tone="info">{nonRealTrainingCount + fallbackInferenceCount}</Badge>
                            </div>
                            <div className="stack tight">
                              <small className="muted">{t('Training non-real reasons')}</small>
                              <div className="row gap wrap">
                                {topTrainingFallbackReasons.length > 0 ? (
                                  topTrainingFallbackReasons.map(([reason, count]) => (
                                    <Badge key={`training-${reason}`} tone="warning">
                                      {reason} · {count}
                                    </Badge>
                                  ))
                                ) : (
                                  <Badge tone="neutral">{t('none')}</Badge>
                                )}
                              </div>
                            </div>
                            <div className="stack tight">
                              <small className="muted">{t('Inference fallback reasons')}</small>
                              <div className="row gap wrap">
                                {topInferenceFallbackReasons.length > 0 ? (
                                  topInferenceFallbackReasons.map(([reason, count]) => (
                                    <Badge key={`inference-${reason}`} tone="warning">
                                      {reason} · {count}
                                    </Badge>
                                  ))
                                ) : (
                                  <Badge tone="neutral">{t('none')}</Badge>
                                )}
                              </div>
                            </div>
                          </Panel>
                          {nonRealTrainingCount > 0 ? (
                            <Panel as="section" className="stack tight" tone="soft">
                              <div className="row between gap wrap align-center">
                                <strong>{t('Training authenticity alerts')}</strong>
                                <Badge tone="warning">{nonRealTrainingCount}</Badge>
                              </div>
                              <small className="muted">
                                {t('These terminal jobs include template/simulated/unknown evidence and need review.')}
                              </small>
                              <ul className="workspace-record-list compact">
                                {nonRealTrainingJobs.slice(0, 4).map(({ job, insight }) => (
                                  <Panel key={job.id} as="li" className="workspace-record-item compact" tone="soft">
                                    <div className="workspace-record-item-top">
                                      <div className="workspace-record-summary stack tight">
                                        <strong>{job.name}</strong>
                                        <small className="muted">
                                          {t(job.framework)} · {t(job.execution_mode)} · {formatTimestamp(job.updated_at)}
                                        </small>
                                      </div>
                                      <Badge tone="warning">
                                        {insight.reality === 'template'
                                          ? t('Template/Fallback')
                                          : insight.reality === 'simulated'
                                            ? t('Simulated')
                                            : t('Unknown')}
                                      </Badge>
                                    </div>
                                    <ButtonLink to={`/training/jobs/${job.id}`} variant="ghost" size="sm">
                                      {t('Open Job Detail')}
                                    </ButtonLink>
                                  </Panel>
                                ))}
                              </ul>
                              <ButtonLink to="/training/jobs" variant="secondary" size="sm">
                                {t('Open Training Queue')}
                              </ButtonLink>
                            </Panel>
                          ) : null}
                          {fallbackInferenceCount > 0 ? (
                            <Panel as="section" className="stack tight" tone="soft">
                              <div className="row between gap wrap align-center">
                                <strong>{t('Inference fallback alerts')}</strong>
                                <Badge tone="warning">{fallbackInferenceCount}</Badge>
                              </div>
                              <small className="muted">
                                {t('These inference runs carry fallback/template markers and should not be treated as fully real output.')}
                              </small>
                              <ul className="workspace-record-list compact">
                                {inferenceFallbackRuns.slice(0, 4).map(({ run, reality }) => (
                                  <Panel key={run.id} as="li" className="workspace-record-item compact" tone="soft">
                                    <div className="workspace-record-item-top">
                                      <div className="workspace-record-summary stack tight">
                                        <strong>{run.id}</strong>
                                        <small className="muted">
                                          {t(run.framework)} · {run.execution_source} · {formatTimestamp(run.updated_at)}
                                        </small>
                                      </div>
                                      <Badge tone="warning">{t('Fallback')}</Badge>
                                    </div>
                                    {reality.reason ? <small className="muted">{reality.reason}</small> : null}
                                    <ButtonLink to="/inference/validate" variant="ghost" size="sm">
                                      {t('Open Validation')}
                                    </ButtonLink>
                                  </Panel>
                                ))}
                              </ul>
                              <ButtonLink to="/inference/validate" variant="secondary" size="sm">
                                {t('Open Inference Validation')}
                              </ButtonLink>
                            </Panel>
                          ) : null}
                        </div>
                      )}
                    </Card>

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

                    <Card as="article">
                      <WorkspaceSectionHeader
                        title={t('Workflow Lanes')}
                        description={t('Jump into the right operational lane without scanning the full navigation tree.')}
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
                  </div>
                }
                side={
                  <div className="workspace-inspector-rail">
                    <Card as="article" className="workspace-inspector-card">
                      <WorkspaceSectionHeader
                        title={t('Operational Context')}
                        description={t('Keep role, queue load, and in-flight file state visible while operating.')}
                        actions={
                          <ButtonLink to="/settings" variant="ghost" size="sm">
                            {t('Open Settings')}
                          </ButtonLink>
                        }
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
                        <Panel as="li" className="workspace-record-item compact" tone="soft">
                          <div className="row between gap wrap align-center">
                            <strong>{t('Non-real training')}</strong>
                            <Badge tone={nonRealTrainingCount > 0 ? 'warning' : 'neutral'}>{nonRealTrainingCount}</Badge>
                          </div>
                        </Panel>
                        <Panel as="li" className="workspace-record-item compact" tone="soft">
                          <div className="row between gap wrap align-center">
                            <strong>{t('Fallback inference')}</strong>
                            <Badge tone={fallbackInferenceCount > 0 ? 'warning' : 'neutral'}>{fallbackInferenceCount}</Badge>
                          </div>
                        </Panel>
                        <Panel as="li" className="workspace-record-item compact" tone="soft">
                          <div className="row between gap wrap align-center">
                            <strong>{t('Training real-run')}</strong>
                            <Badge tone={realTrainingCoverage === 'n/a' ? 'neutral' : 'info'}>
                              {realTrainingCoverage}
                            </Badge>
                          </div>
                        </Panel>
                        <Panel as="li" className="workspace-record-item compact" tone="soft">
                          <div className="row between gap wrap align-center">
                            <strong>{t('Inference real-run')}</strong>
                            <Badge tone={realInferenceCoverage === 'n/a' ? 'neutral' : 'info'}>
                              {realInferenceCoverage}
                            </Badge>
                          </div>
                        </Panel>
                      </ul>
                    </Card>

                    <Card as="article" className="workspace-inspector-card">
                      <WorkspaceSectionHeader
                        title={t('Current Focus')}
                        description={t('A compact explanation of what should be handled next in this console session.')}
                      />
                      <Panel as="section" className="stack tight" tone="soft">
                        <div className="row between gap wrap align-center">
                          <strong>
                            {priorityMode === 'approval'
                              ? t('Approval queue')
                              : priorityMode === 'model'
                                ? t('Recent model work')
                                : priorityMode === 'attachment'
                                  ? t('Attachment follow-up')
                                  : t('Idle lane')}
                          </strong>
                          <Badge tone="info">
                            {priorityMode === 'approval'
                              ? pendingApprovals.length
                              : priorityMode === 'model'
                                ? recentMyModels.length
                                : priorityMode === 'attachment'
                                  ? recentProcessingAttachments.length
                                  : 0}
                          </Badge>
                        </div>
                        <small className="muted">{priorityDescription}</small>
                        {priorityMode !== 'empty' ? (
                          <ButtonLink to={priorityCta.to} variant="secondary" size="sm" block>
                            {priorityCta.label}
                          </ButtonLink>
                        ) : null}
                      </Panel>
                    </Card>
                  </div>
                }
              />
            </>
          );

  return mainContent;
}
