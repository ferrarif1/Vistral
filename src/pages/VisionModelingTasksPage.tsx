import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { VisionModelingTaskRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import {
  FilterToolbar,
  InlineAlert,
  KPIStatRow,
  PageHeader,
  SectionCard,
  StatusTable,
  type StatusTableColumn
} from '../components/ui/ConsolePage';
import { Select } from '../components/ui/Field';
import { WorkspacePage } from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

type VisionTaskStatusFilter = 'all' | VisionModelingTaskRecord['status'];
type VisionTaskInboxLane = 'blocked' | 'training' | 'ready' | 'other';

const actionableAgentActions = new Set(['start_training', 'register_model', 'mine_feedback']);

const formatTimestamp = (value: string): string => {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(parsed));
};

const getInboxLane = (task: VisionModelingTaskRecord): VisionTaskInboxLane => {
  const action = task.agent_next_action?.action ?? null;
  if (action === 'requires_input' || task.missing_requirements.length > 0) {
    return 'blocked';
  }
  if (action === 'wait_training' || task.status === 'training_started') {
    return 'training';
  }
  if (action && actionableAgentActions.has(action)) {
    return 'ready';
  }
  return 'other';
};

const isRecommendationActionable = (task: VisionModelingTaskRecord): boolean =>
  actionableAgentActions.has(task.agent_next_action?.action ?? '');

export default function VisionModelingTasksPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<VisionModelingTaskRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [statusFilter, setStatusFilter] = useState<VisionTaskStatusFilter>('all');
  const [advancingTaskId, setAdvancingTaskId] = useState('');

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const list = await api.listVisionTasks();
      setTasks(list);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const filteredTasks = useMemo(() => {
    if (statusFilter === 'all') {
      return tasks;
    }
    return tasks.filter((task) => task.status === statusFilter);
  }, [statusFilter, tasks]);

  const statusCounts = useMemo(
    () =>
      tasks.reduce<Record<string, number>>((acc, task) => {
        const current = acc[task.status] ?? 0;
        acc[task.status] = current + 1;
        return acc;
      }, {}),
    [tasks]
  );

  const inbox = useMemo(() => {
    const blocked: VisionModelingTaskRecord[] = [];
    const training: VisionModelingTaskRecord[] = [];
    const ready: VisionModelingTaskRecord[] = [];
    for (const task of tasks) {
      const lane = getInboxLane(task);
      if (lane === 'blocked') {
        blocked.push(task);
      } else if (lane === 'training') {
        training.push(task);
      } else if (lane === 'ready') {
        ready.push(task);
      }
    }
    return {
      blocked,
      training,
      ready
    };
  }, [tasks]);

  const handleAutoAdvance = useCallback(
    async (task: VisionModelingTaskRecord) => {
      setAdvancingTaskId(task.id);
      setNotice('');
      setError('');
      try {
        const result = await api.autoAdvanceVisionTask(task.id, { max_rounds: 3 });
        setTasks((previous) =>
          previous.map((item) => (item.id === task.id ? result.task : item))
        );
        setNotice(
          t('Task {{task}} auto advanced: {{action}} - {{message}}', {
            task: result.task.id,
            action: result.action,
            message: result.message
          })
        );
      } catch (requestError) {
        setError((requestError as Error).message);
      } finally {
        setAdvancingTaskId('');
      }
    },
    [t]
  );

  const columns = useMemo<StatusTableColumn<VisionModelingTaskRecord>[]>(
    () => [
      {
        key: 'id',
        header: t('Task'),
        cell: (task) => (
          <div className="stack-tight">
            <strong>{task.id}</strong>
            <small className="muted">
              {task.spec.task_type} · {t(task.status)}
            </small>
          </div>
        )
      },
      {
        key: 'recommendation',
        header: t('Agent recommendation'),
        cell: (task) => (
          <div className="stack-tight">
            <div className="inline-actions">
              <Badge
                tone={
                  getInboxLane(task) === 'blocked'
                    ? 'warning'
                    : getInboxLane(task) === 'training'
                      ? 'info'
                      : getInboxLane(task) === 'ready'
                        ? 'success'
                        : 'neutral'
                }
              >
                {t(task.agent_next_action?.title ?? 'Pending recommendation')}
              </Badge>
              {task.promotion_gate ? (
                <Badge
                  tone={
                    task.promotion_gate.status === 'pass'
                      ? 'success'
                      : task.promotion_gate.status === 'needs_review'
                        ? 'warning'
                        : task.promotion_gate.status === 'fail'
                          ? 'danger'
                          : 'info'
                  }
                >
                  {t(task.promotion_gate.title)}
                </Badge>
              ) : null}
              {task.evaluation_suite ? (
                <Badge tone="neutral">
                  {task.evaluation_suite.primary_metric}: {task.evaluation_suite.threshold_target ?? '-'}
                </Badge>
              ) : null}
              {task.run_comparison ? <Badge tone="neutral">{t(task.run_comparison.decision)}</Badge> : null}
            </div>
            <small className="muted">
              {t(
                task.agent_next_action?.summary ??
                  'The agent recommendation will appear after task understanding or runtime sync.'
              )}
            </small>
          </div>
        ),
        width: '320px'
      },
      {
        key: 'linked',
        header: t('Linked assets'),
        cell: (task) => (
          <div className="stack-tight">
            <small>{task.dataset_id || '-'}</small>
            <small className="muted">{task.training_job_id || task.model_version_id || '-'}</small>
          </div>
        ),
        width: '220px'
      },
      {
        key: 'updated',
        header: t('Updated'),
        cell: (task) => formatTimestamp(task.updated_at),
        width: '180px'
      },
      {
        key: 'actions',
        header: t('Actions'),
        cell: (task) => (
          <div className="inline-actions">
            <ButtonLink
              to={`/vision/tasks/${encodeURIComponent(task.id)}`}
              variant="secondary"
              size="sm"
              onClick={(event) => event.stopPropagation()}
            >
              {t('Open')}
            </ButtonLink>
            {isRecommendationActionable(task) ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  void handleAutoAdvance(task);
                }}
                disabled={advancingTaskId === task.id}
              >
                {advancingTaskId === task.id ? t('Advancing...') : t('Continue as agent')}
              </Button>
            ) : (
              <ButtonLink
                to={`/vision/tasks/${encodeURIComponent(task.id)}`}
                variant="ghost"
                size="sm"
                onClick={(event) => event.stopPropagation()}
              >
                {t(
                  task.agent_next_action?.action === 'requires_input'
                    ? 'Resolve inputs'
                    : task.agent_next_action?.action === 'wait_training'
                      ? 'View status'
                      : 'Review task'
                )}
              </ButtonLink>
            )}
          </div>
        ),
        width: '260px'
      }
    ],
    [advancingTaskId, handleAutoAdvance, t]
  );

  const renderInboxTasks = useCallback(
    (items: VisionModelingTaskRecord[], emptyMessage: string) => {
      if (items.length <= 0) {
        return <p className="muted">{t(emptyMessage)}</p>;
      }
      return (
        <div className="stack">
          {items.slice(0, 3).map((task) => (
            <InlineAlert
              key={task.id}
              tone={getInboxLane(task) === 'blocked' ? 'warning' : getInboxLane(task) === 'ready' ? 'success' : 'info'}
              title={task.id}
              description={
                <span>
                  {t(task.agent_next_action?.summary ?? 'Pending recommendation')}
                  <br />
                  <small className="muted">
                    {(task.agent_next_action?.blocking_items ?? []).length > 0
                      ? task.agent_next_action?.blocking_items.join(', ')
                      : task.agent_next_action?.evidence?.join(' · ') || task.dataset_id || t('No linked dataset yet.')}
                  </small>
                </span>
              }
              actions={
                <div className="inline-actions">
                  <ButtonLink to={`/vision/tasks/${encodeURIComponent(task.id)}`} variant="secondary" size="sm">
                    {t('Open')}
                  </ButtonLink>
                  {isRecommendationActionable(task) ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void handleAutoAdvance(task)}
                      disabled={advancingTaskId === task.id}
                    >
                      {advancingTaskId === task.id ? t('Advancing...') : t('Continue as agent')}
                    </Button>
                  ) : null}
                </div>
              }
            />
          ))}
        </div>
      );
    },
    [advancingTaskId, handleAutoAdvance, t]
  );

  if (loading) {
    return (
      <WorkspacePage className="stack">
        <PageHeader title={t('Vision Modeling Tasks')} description={t('Loading tasks...')} eyebrow={t('Vision Modeling')} />
        <StateBlock variant="loading" title={t('Loading')} description={t('Reading vision modeling tasks.')} />
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage className="stack">
      <PageHeader
        title={t('Vision Modeling Tasks')}
        description={t('Monitor auto-orchestrated vision training workflows and jump into task detail.')}
        eyebrow={t('Vision Modeling')}
        primaryAction={{
          label: t('Refresh'),
          onClick: () => void loadTasks()
        }}
      />
      {error ? <InlineAlert tone="danger" title={t('Request failed')} description={error} /> : null}
      {notice ? <InlineAlert tone="success" title={t('Updated')} description={notice} /> : null}

      <FilterToolbar
        filters={
          <Select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as VisionTaskStatusFilter)}
          >
            <option value="all">{t('All statuses')}</option>
            <option value="requires_input">{t('requires_input')}</option>
            <option value="plan_ready">{t('plan_ready')}</option>
            <option value="training_started">{t('training_started')}</option>
            <option value="training_completed">{t('training_completed')}</option>
            <option value="failed">{t('failed')}</option>
          </Select>
        }
        summary={t('Total {{count}} tasks', { count: tasks.length })}
      />

      <KPIStatRow
        items={[
          {
            label: t('Blocked tasks'),
            value: inbox.blocked.length,
            tone: 'warning',
            hint: t('Need more input before the agent can mutate safely.')
          },
          {
            label: t('Training now'),
            value: inbox.training.length,
            tone: 'info',
            hint: t('Already linked to an active training round.')
          },
          {
            label: t('Ready for next action'),
            value: inbox.ready.length,
            tone: 'success',
            hint: t('Can continue with one visible operator confirmation.')
          }
        ]}
      />

      <SectionCard
        title={t('Agent inbox')}
        description={t('The first screen should answer which tasks are blocked, running, or ready to move.')}
      >
        <div className="stack">
          <div className="stack-tight">
            <strong>{t('Blocked by missing requirements')}</strong>
            {renderInboxTasks(inbox.blocked, 'No blocked tasks are visible right now.')}
          </div>
          <div className="stack-tight">
            <strong>{t('Currently training')}</strong>
            {renderInboxTasks(inbox.training, 'No active training tasks are visible right now.')}
          </div>
          <div className="stack-tight">
            <strong>{t('Ready for the next operator action')}</strong>
            {renderInboxTasks(inbox.ready, 'No tasks are waiting for the next operator action right now.')}
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title={t('Task List')}
        description={t('Click a row to open the detailed page or continue from the agent inbox above.')}
        actions={
          <div className="inline-actions">
            <Badge tone="neutral">{t('requires_input')}: {statusCounts.requires_input ?? 0}</Badge>
            <Badge tone="neutral">{t('training_started')}: {statusCounts.training_started ?? 0}</Badge>
            <Badge tone="neutral">{t('training_completed')}: {statusCounts.training_completed ?? 0}</Badge>
          </div>
        }
      >
        <StatusTable
          columns={columns}
          rows={filteredTasks}
          getRowKey={(task) => task.id}
          emptyTitle={t('No vision tasks')}
          emptyDescription={t('Create or continue a vision modeling task from the conversation workspace.')}
          onRowClick={(task) => navigate(`/vision/tasks/${encodeURIComponent(task.id)}`)}
        />
      </SectionCard>
    </WorkspacePage>
  );
}
