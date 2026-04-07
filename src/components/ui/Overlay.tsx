import type { ReactNode } from 'react';

interface OverlayProps {
  open: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
  onClose?: () => void;
}

interface DrawerProps extends OverlayProps {
  side?: 'left' | 'right' | 'bottom';
}

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export function Modal({ open, children, className, title, onClose }: OverlayProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="ui-overlay" role="presentation">
      <button
        type="button"
        className="ui-overlay-scrim"
        aria-label={title ?? 'Close'}
        onClick={onClose}
      />
      <div className={joinClasses('ui-modal', className)} role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}

export function Drawer({
  open,
  children,
  className,
  title,
  onClose,
  side = 'left'
}: DrawerProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="ui-overlay" role="presentation">
      <button
        type="button"
        className="ui-overlay-scrim"
        aria-label={title ?? 'Close'}
        onClick={onClose}
      />
      <div
        className={joinClasses('ui-drawer', `ui-drawer--${side}`, className)}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </div>
  );
}
