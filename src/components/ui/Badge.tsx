import type { ReactNode } from 'react';

type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}

interface StatusTagProps {
  status: string;
  children?: ReactNode;
  className?: string;
}

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

const resolveStatusTone = (status: string): BadgeTone => {
  const value = status.toLowerCase();

  if (['ready', 'active', 'completed', 'approved', 'published', 'registered', 'success'].includes(value)) {
    return 'success';
  }

  if (['queued', 'preparing', 'running', 'evaluating', 'uploading', 'processing', 'pending', 'pending_approval'].includes(value)) {
    return 'warning';
  }

  if (['error', 'failed', 'disabled', 'rejected', 'cancelled'].includes(value)) {
    return 'danger';
  }

  if (['info', 'draft', 'archived', 'deprecated'].includes(value)) {
    return 'info';
  }

  return 'neutral';
};

export function Badge({ children, tone = 'neutral', className }: BadgeProps) {
  return <span className={joinClasses('ui-badge', `ui-badge--${tone}`, className)}>{children}</span>;
}

export function StatusTag({ status, children, className }: StatusTagProps) {
  const tone = resolveStatusTone(status);
  return (
    <span className={joinClasses('ui-status-tag', `ui-status-tag--${tone}`, className)}>
      {children ?? status}
    </span>
  );
}

export default Badge;
