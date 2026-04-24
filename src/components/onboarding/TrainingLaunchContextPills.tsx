import { Badge } from '../ui/Badge';

type TrainingLaunchContextPillsProps = {
  taskType?: string | null;
  framework?: string | null;
  executionTarget?: string | null;
  workerId?: string | null;
  t: (key: string, variables?: Record<string, string | number>) => string;
};

const toLabel = (value: string | null | undefined): string => {
  if (!value) {
    return '';
  }
  return value.trim();
};

export default function TrainingLaunchContextPills({
  taskType,
  framework,
  executionTarget,
  workerId,
  t
}: TrainingLaunchContextPillsProps) {
  const normalizedTaskType = toLabel(taskType);
  const normalizedFramework = toLabel(framework);
  const normalizedExecutionTarget = toLabel(executionTarget);
  const normalizedWorkerId = toLabel(workerId);
  const hasContext = Boolean(
    normalizedTaskType ||
      normalizedFramework ||
      (normalizedExecutionTarget && normalizedExecutionTarget !== 'auto') ||
      normalizedWorkerId
  );

  if (!hasContext) {
    return null;
  }

  return (
    <div className="row gap wrap align-center">
      <small className="muted">{t('Current context')}</small>
      {normalizedTaskType ? <Badge tone="info">{t('Task')}: {t(normalizedTaskType)}</Badge> : null}
      {normalizedFramework ? <Badge tone="neutral">{t('Framework')}: {t(normalizedFramework)}</Badge> : null}
      {normalizedExecutionTarget && normalizedExecutionTarget !== 'auto' ? (
        <Badge tone="neutral">{t('Dispatch')}: {t(normalizedExecutionTarget)}</Badge>
      ) : null}
      {normalizedWorkerId ? <Badge tone="neutral">{t('Worker')}: {normalizedWorkerId}</Badge> : null}
    </div>
  );
}
