import type { ReactNode } from 'react';
import { Card, Panel } from './Surface';
import { WorkspaceSectionHeader } from './WorkspacePage';

type SurfaceTone = 'default' | 'soft' | 'accent' | 'danger';

interface WorkspaceActionPanelProps {
  title: string;
  description?: string;
  headerActions?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  as?: 'article' | 'section' | 'div';
  surface?: 'card' | 'panel';
  tone?: SurfaceTone;
}

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export default function WorkspaceActionPanel({
  title,
  description,
  headerActions,
  actions,
  children,
  className,
  as = 'article',
  surface = 'card',
  tone = surface === 'panel' ? 'soft' : 'default'
}: WorkspaceActionPanelProps) {
  const Container = surface === 'panel' ? Panel : Card;

  return (
    <Container as={as} className={joinClasses('workspace-inspector-card', className)} tone={tone}>
      <WorkspaceSectionHeader title={title} description={description} actions={headerActions} />
      {children}
      {actions ? <div className="workspace-button-stack">{actions}</div> : null}
    </Container>
  );
}
