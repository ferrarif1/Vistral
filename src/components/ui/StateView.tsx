import type { ReactNode } from 'react';

type StateVariant = 'empty' | 'loading' | 'error' | 'success';

interface StateViewProps {
  variant: StateVariant;
  title: string;
  description: string;
  extra?: ReactNode;
  className?: string;
}

interface SharedStateProps {
  title: string;
  description: string;
  extra?: ReactNode;
  className?: string;
}

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export function StateView({ variant, title, description, extra, className }: StateViewProps) {
  return (
    <div className={joinClasses('ui-state', `ui-state--${variant}`, className)}>
      <div className="ui-state-copy">
        <h4>{title}</h4>
        <p>{description}</p>
      </div>
      {extra ? <div className="ui-state-extra">{extra}</div> : null}
    </div>
  );
}

export function EmptyState(props: SharedStateProps) {
  return <StateView variant="empty" {...props} />;
}

export function LoadingState(props: SharedStateProps) {
  return <StateView variant="loading" {...props} />;
}

export function ErrorState(props: SharedStateProps) {
  return <StateView variant="error" {...props} />;
}

export default StateView;
