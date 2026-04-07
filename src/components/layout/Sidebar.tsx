import type { ReactNode } from 'react';

interface SidebarProps {
  className?: string;
  children: ReactNode;
  rail?: ReactNode;
  ariaHidden?: boolean;
}

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export default function Sidebar({ className, children, rail, ariaHidden }: SidebarProps) {
  return (
    <aside className={joinClasses('sidebar-shell', className)} aria-hidden={ariaHidden}>
      <div className="sidebar-shell-content">{children}</div>
      {rail ? <div className="sidebar-shell-rail">{rail}</div> : null}
    </aside>
  );
}
