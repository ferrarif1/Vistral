import type { ReactNode } from 'react';
import { Badge } from '../ui/Badge';
import { Panel } from '../ui/Surface';
import { useI18n } from '../../i18n/I18nProvider';

type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

interface WorkspaceStarterPanelProps {
  title: ReactNode;
  label?: ReactNode;
  progressLabel?: ReactNode;
  detail?: ReactNode;
  actions?: ReactNode;
  badgeLabel?: ReactNode;
  badgeTone?: BadgeTone;
  as?: 'article' | 'section' | 'li';
  className?: string;
}

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export default function WorkspaceStarterPanel({
  title,
  label,
  progressLabel,
  detail,
  actions,
  badgeLabel,
  badgeTone = 'warning',
  as = 'section',
  className
}: WorkspaceStarterPanelProps) {
  const { t } = useI18n();

  return (
    <Panel as={as} className={joinClasses('stack tight', className)} tone="soft">
      <div className="workspace-record-item-top">
        <div className="workspace-record-summary stack tight">
          <strong>{title}</strong>
          {label ? <small className="muted">{label}</small> : null}
          {progressLabel ? <small className="muted">{progressLabel}</small> : null}
          {detail ? <small className="muted">{detail}</small> : null}
        </div>
        <Badge tone={badgeTone}>{badgeLabel ?? t('Recommended next step')}</Badge>
      </div>
      {actions ? <div className="row gap wrap">{actions}</div> : null}
    </Panel>
  );
}
