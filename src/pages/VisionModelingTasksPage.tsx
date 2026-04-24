import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { VisionModelingTaskRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import {
  FilterToolbar,
  InlineAlert,
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
            <small className="muted">{task.spec.task_type}</small>
          </div>
        )
      },
      {
        key: 'status',
        header: t('Status'),
        cell: (task) => <Badge tone="info">{task.status}</Badge>,
        width: '160px'
      },
      {
        key: 'dataset',
        header: t('Dataset'),
        cell: (task) => task.dataset_id || '-',
        width: '160px'
      },
      {
        key: 'job',
        header: t('Training Job'),
        cell: (task) => task.training_job_id || '-',
        width: '180px'
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
              {advancingTaskId === task.id ? t('Advancing...') : t('Auto advance')}
            </Button>
          </div>
        ),
        width: '260px'
      }
    ],
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

      <SectionCard
        title={t('Task List')}
        description={t('Click a row to open the detailed page.')}
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
