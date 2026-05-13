import { Link } from 'react-router-dom';
import type { PixelRoomContext } from './pixelRoomContextModel';

interface PixelRoomContextBarProps {
  context: PixelRoomContext;
  ariaLabel?: string;
  className?: string;
  copyClassName?: string;
  avatarClassName?: string;
  actionsClassName?: string;
  actionClassName?: string;
}

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export function PixelRoomContextBar({
  context,
  ariaLabel = 'Pixel workshop room context',
  className,
  copyClassName,
  avatarClassName,
  actionsClassName,
  actionClassName
}: PixelRoomContextBarProps) {
  return (
    <nav className={joinClasses('pixel-room-context', className)} aria-label={ariaLabel}>
      <div className={joinClasses('pixel-room-context__copy', copyClassName)}>
        <span className={joinClasses('pixel-room-context__avatar', avatarClassName)} aria-hidden="true" />
        <span>
          <strong>{context.label}</strong>
          <small>{context.description}</small>
        </span>
      </div>
      {context.actions?.length ? (
        <div className={joinClasses('pixel-room-context__actions', actionsClassName)}>
          {context.actions.map((action) => (
            <Link key={action.to} to={action.to} className={actionClassName}>
              {action.label}
            </Link>
          ))}
        </div>
      ) : null}
    </nav>
  );
}
