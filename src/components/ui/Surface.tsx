import type { ElementType, HTMLAttributes, ReactNode } from 'react';

type SurfaceTone = 'default' | 'soft' | 'accent' | 'danger';

interface SurfaceProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  tone?: SurfaceTone;
  children: ReactNode;
}

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export function Card({
  as,
  tone = 'default',
  className,
  children,
  ...props
}: SurfaceProps) {
  const Component = (as ?? 'div') as ElementType;
  return (
    <Component className={joinClasses('ui-card', `ui-card--${tone}`, className)} {...props}>
      {children}
    </Component>
  );
}

export function Panel({
  as,
  tone = 'soft',
  className,
  children,
  ...props
}: SurfaceProps) {
  const Component = (as ?? 'div') as ElementType;
  return (
    <Component className={joinClasses('ui-panel', `ui-panel--${tone}`, className)} {...props}>
      {children}
    </Component>
  );
}

export default Card;
