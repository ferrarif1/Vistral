import type { HTMLAttributes, ReactNode } from 'react';
import { Card } from './Surface';

interface WorkspacePageProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

interface WorkspaceHeroStat {
  label: ReactNode;
  value: ReactNode;
}

interface WorkspaceHeroProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  stats?: WorkspaceHeroStat[];
}

interface WorkspaceMetricItem {
  title: ReactNode;
  description?: ReactNode;
  value: ReactNode;
  tone?: 'default' | 'attention';
}

interface WorkspaceMetricGridProps extends HTMLAttributes<HTMLElement> {
  items: WorkspaceMetricItem[];
}

interface WorkspaceSplitProps extends HTMLAttributes<HTMLElement> {
  main: ReactNode;
  side?: ReactNode;
}

interface WorkspaceSectionHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

interface WorkspaceContextBarProps extends HTMLAttributes<HTMLElement> {
  leading?: ReactNode;
  trailing?: ReactNode;
  summary?: ReactNode;
}

interface WorkspaceWorkbenchProps extends HTMLAttributes<HTMLElement> {
  toolbar?: ReactNode;
  main: ReactNode;
  side?: ReactNode;
}

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export function WorkspacePage({ className, children, ...props }: WorkspacePageProps) {
  return (
    <div className={joinClasses('workspace-overview-page', 'stack', className)} {...props}>
      {children}
    </div>
  );
}

export function WorkspaceHero({
  className,
  eyebrow,
  title,
  description,
  actions,
  stats,
  ...props
}: WorkspaceHeroProps) {
  return (
    <Card as="section" className={joinClasses('workspace-overview-hero', className)} {...props}>
      <div className="workspace-overview-hero-grid">
        <div className="workspace-overview-copy stack">
          {eyebrow ? <small className="workspace-eyebrow">{eyebrow}</small> : null}
          {actions ? (
            <div className="workspace-section-header">
              <div className="stack tight">
                <h1>{title}</h1>
                {description ? <p className="muted">{description}</p> : null}
              </div>
              {actions}
            </div>
          ) : (
            <>
              <h1>{title}</h1>
              {description ? <p className="muted">{description}</p> : null}
            </>
          )}
        </div>
        {stats?.length ? (
          <div className="workspace-overview-badges">
            {stats.map((stat, index) => (
              <div className="workspace-overview-badge" key={index}>
                <span>{stat.label}</span>
                <strong>{stat.value}</strong>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

export function WorkspaceMetricGrid({
  className,
  items,
  ...props
}: WorkspaceMetricGridProps) {
  return (
    <section className={joinClasses('workspace-overview-signal-grid', className)} {...props}>
      {items.map((item, index) => (
        <Card
          as="article"
          key={index}
          className={joinClasses(
            'workspace-signal-card',
            item.tone === 'attention' && 'attention'
          )}
        >
          <div className="workspace-signal-top">
            <h3>{item.title}</h3>
            {item.description ? <small className="muted">{item.description}</small> : null}
          </div>
          <strong className="metric">{item.value}</strong>
        </Card>
      ))}
    </section>
  );
}

export function WorkspaceSplit({
  className,
  main,
  side,
  ...props
}: WorkspaceSplitProps) {
  return (
    <section className={joinClasses('workspace-overview-panel-grid', className)} {...props}>
      <div className="workspace-overview-main">{main}</div>
      {side ? <div className="workspace-overview-side">{side}</div> : null}
    </section>
  );
}

export function WorkspaceSectionHeader({
  className,
  title,
  description,
  actions,
  ...props
}: WorkspaceSectionHeaderProps) {
  return (
    <div className={joinClasses('workspace-section-header', className)} {...props}>
      <div className="stack tight">
        <h3>{title}</h3>
        {description ? <small className="muted">{description}</small> : null}
      </div>
      {actions}
    </div>
  );
}

export function WorkspaceContextBar({
  className,
  leading,
  trailing,
  summary,
  ...props
}: WorkspaceContextBarProps) {
  return (
    <section className={joinClasses('workspace-context-bar', className)} {...props}>
      <div className="workspace-context-bar-row">
        <div className="workspace-context-leading">{leading}</div>
        {trailing ? <div className="workspace-context-trailing">{trailing}</div> : null}
      </div>
      {summary ? <div className="workspace-context-summary">{summary}</div> : null}
    </section>
  );
}

export function WorkspaceWorkbench({
  className,
  toolbar,
  main,
  side,
  ...props
}: WorkspaceWorkbenchProps) {
  return (
    <section className={joinClasses('workspace-workbench', className)} {...props}>
      {toolbar ? <div className="workspace-workbench-toolbar">{toolbar}</div> : null}
      <div className="workspace-workbench-grid">
        <div className="workspace-workbench-main">{main}</div>
        {side ? <aside className="workspace-workbench-side">{side}</aside> : null}
      </div>
    </section>
  );
}

export default WorkspacePage;
