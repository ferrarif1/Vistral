import type { HTMLAttributes, ReactNode } from 'react';

interface WorkspaceActionStackProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export default function WorkspaceActionStack({
  className,
  children,
  ...props
}: WorkspaceActionStackProps) {
  return (
    <div className={joinClasses('workspace-button-stack', className)} {...props}>
      {children}
    </div>
  );
}
