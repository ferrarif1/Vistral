import type { ConversationActionMetadata } from '../../shared/domain';

type TranslateFn = (source: string, vars?: Record<string, string | number>) => string;

export type ConversationActionNextStepKind = 'href' | 'ops' | 'none';

export interface ConversationActionNextStep {
  id: string;
  title: string;
  detail: string;
  kind: ConversationActionNextStepKind;
  href?: string;
  api?: string;
  params?: Record<string, string>;
}

const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const firstNonEmpty = (...values: unknown[]): string => {
  for (const value of values) {
    if (hasText(value)) {
      return value.trim();
    }
  }
  return '';
};

export const getConversationActionTrainingJobId = (action: ConversationActionMetadata): string =>
  firstNonEmpty(
    action.collected_fields.training_job_id,
    action.collected_fields.job_id,
    action.created_entity_type === 'TrainingJob' ? action.created_entity_id : ''
  );

const buildActionSearchText = (action: ConversationActionMetadata): string =>
  [
    action.summary,
    action.status,
    action.created_entity_label ?? '',
    ...Object.entries(action.collected_fields).flatMap(([key, value]) => [key, value])
  ]
    .filter(hasText)
    .join('\n')
    .toLowerCase();

const appendUnique = (items: ConversationActionNextStep[], item: ConversationActionNextStep) => {
  if (!items.some((existing) => existing.id === item.id)) {
    items.push(item);
  }
};

export const buildConversationActionNextStepInput = (step: ConversationActionNextStep): string => {
  if (step.kind !== 'ops' || !step.api) {
    return '';
  }
  return `/ops ${JSON.stringify({ api: step.api, params: step.params ?? {} })}`;
};

export const deriveConversationActionNextSteps = (
  action: ConversationActionMetadata,
  t: TranslateFn
): ConversationActionNextStep[] => {
  const trainingJobId = getConversationActionTrainingJobId(action);
  const text = buildActionSearchText(action);
  const status = firstNonEmpty(action.collected_fields.status).toLowerCase();
  const isTrainingAction =
    action.action === 'create_training_job' ||
    trainingJobId.length > 0 ||
    action.collected_fields.api === 'retry_training_job' ||
    action.collected_fields.api === 'cancel_training_job';
  const isFailedTrainingContext =
    isTrainingAction &&
    (action.status === 'failed' ||
      status === 'failed' ||
      status === 'cancelled' ||
      /failed|cancelled|失败|已取消|timeout|unreachable|offline|worker|heartbeat/.test(text));
  const items: ConversationActionNextStep[] = [];

  if (!isTrainingAction) {
    return items;
  }

  if (trainingJobId && isFailedTrainingContext) {
    appendUnique(items, {
      id: 'retry-control-plane',
      title: t('Retry on control-plane lane'),
      detail: t('Send a guarded retry request from this conversation and keep the confirmation step in-thread.'),
      kind: 'ops',
      api: 'retry_training_job',
      params: {
        job_id: trainingJobId,
        execution_target: 'control_plane'
      }
    });
  }

  if (/(module not found|no module named|importerror|pip|python|dependency|command not found|fallback|template)/i.test(text)) {
    appendUnique(items, {
      id: 'open-runtime-settings',
      title: t('Review runtime environment'),
      detail: t('Open runtime settings when logs point to dependencies, local commands, fallback, or template evidence.'),
      kind: 'href',
      href: '/settings/runtime'
    });
  }

  if (/(worker|offline|heartbeat|timeout|connection refused|unreachable)/i.test(text)) {
    appendUnique(items, {
      id: 'open-worker-settings',
      title: t('Check worker/account permissions'),
      detail: t('Open worker settings when the failure looks tied to worker reachability or scheduling.'),
      kind: 'href',
      href: '/settings/workers'
    });
  }

  if (trainingJobId) {
    const errorHint = action.status === 'failed' && action.summary ? `&error_hint=${encodeURIComponent(action.summary)}` : '';
    appendUnique(items, {
      id: 'open-training-logs',
      title: t('Open training logs'),
      detail: t('Inspect the run detail with logs already selected before taking manual action.'),
      kind: 'href',
      href: `/training/jobs/${encodeURIComponent(trainingJobId)}?evidence=logs${errorHint}`
    });
  }

  if (items.length === 0 && action.status === 'failed') {
    appendUnique(items, {
      id: 'review-card-summary',
      title: t('Recheck logs then retry'),
      detail: t('This card failed without a training job id. Review the summary and continue with a precise follow-up.'),
      kind: 'none'
    });
  }

  return items;
};
