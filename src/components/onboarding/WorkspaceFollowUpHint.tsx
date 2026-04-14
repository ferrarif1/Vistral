import type { ReactNode } from 'react';

interface WorkspaceFollowUpHintProps {
  actions?: ReactNode;
  detail?: ReactNode;
  layout?: 'stacked' | 'inline';
  className?: string;
}

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export default function WorkspaceFollowUpHint({
  actions,
  detail,
  layout = 'stacked',
  className
}: WorkspaceFollowUpHintProps) {
  if (!actions && !detail) {
    return null;
  }

  if (layout === 'inline') {
    return (
      <div className={joinClasses('row gap wrap', className)}>
        {actions}
        {detail ? <small className="muted">{detail}</small> : null}
      </div>
    );
  }

  return (
    <div className={joinClasses('stack tight', className)}>
      {actions ? <div className="row gap wrap">{actions}</div> : null}
      {detail ? <small className="muted">{detail}</small> : null}
    </div>
  );
}
