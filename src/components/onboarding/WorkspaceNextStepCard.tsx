import type { ReactNode } from 'react';
import { Badge } from '../ui/Badge';
import { Card, Panel } from '../ui/Surface';
import { WorkspaceSectionHeader } from '../ui/WorkspacePage';
import { useI18n } from '../../i18n/I18nProvider';

type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

interface WorkspaceNextStepCardProps {
  title: string;
  description?: string;
  stepLabel: ReactNode;
  stepDetail?: ReactNode;
  current: number;
  total: number;
  actions?: ReactNode;
  badgeLabel?: ReactNode;
  badgeTone?: BadgeTone;
  as?: 'article' | 'section';
  className?: string;
}

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export default function WorkspaceNextStepCard({
  title,
  description,
  stepLabel,
  stepDetail,
  current,
  total,
  actions,
  badgeLabel,
  badgeTone = 'warning',
  as = 'article',
  className
}: WorkspaceNextStepCardProps) {
  const { t } = useI18n();

  return (
    <Card as={as} className={joinClasses('workspace-next-step-card', className)}>
      <WorkspaceSectionHeader title={title} description={description} />
      <Panel as="section" className="workspace-guide-highlight" tone="soft">
        <div className="workspace-record-item-top">
          <div className="workspace-record-summary stack tight">
            <strong>{stepLabel}</strong>
            <small className="muted">
              {t('Step {current} of {total}', {
                current,
                total
              })}
            </small>
            {stepDetail ? <small className="muted">{stepDetail}</small> : null}
          </div>
          <Badge tone={badgeTone}>{badgeLabel ?? t('Recommended next step')}</Badge>
        </div>
        {actions ? <div className="row gap wrap">{actions}</div> : null}
      </Panel>
    </Card>
  );
}
