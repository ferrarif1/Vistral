import type { ReactNode } from 'react';

interface TopBarProps {
  className?: string;
  leading: ReactNode;
  actions?: ReactNode;
}

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export default function TopBar({ className, leading, actions }: TopBarProps) {
  return (
    <header className={joinClasses('topbar-shell', className)}>
      <div className="topbar-shell-leading">{leading}</div>
      {actions ? <div className="topbar-shell-actions">{actions}</div> : null}
    </header>
  );
}
