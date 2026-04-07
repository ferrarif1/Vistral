import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

interface SharedButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  unstyled?: boolean;
  className?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}

export interface ButtonProps
  extends SharedButtonProps,
    ButtonHTMLAttributes<HTMLButtonElement> {}

export interface ButtonLinkProps
  extends SharedButtonProps,
    Omit<LinkProps, 'className'> {
  children: ReactNode;
}

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    block = false,
    unstyled = false,
    className,
    leading,
    trailing,
    children,
    type = 'button',
    ...props
  },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={joinClasses(
        !unstyled && 'ui-button',
        !unstyled && `ui-button--${variant}`,
        !unstyled && `ui-button--${size}`,
        !unstyled && block && 'ui-button--block',
        className
      )}
      {...props}
    >
      {unstyled ? (
        children
      ) : (
        <>
          {leading ? <span className="ui-button-icon">{leading}</span> : null}
          {children ? <span className="ui-button-label">{children}</span> : null}
          {trailing ? <span className="ui-button-icon">{trailing}</span> : null}
        </>
      )}
    </button>
  );
});

export function ButtonLink({
  variant = 'primary',
  size = 'md',
  block = false,
  unstyled = false,
  className,
  leading,
  trailing,
  children,
  ...props
}: ButtonLinkProps) {
  return (
    <Link
      className={joinClasses(
        !unstyled && 'ui-button',
        !unstyled && `ui-button--${variant}`,
        !unstyled && `ui-button--${size}`,
        !unstyled && block && 'ui-button--block',
        className
      )}
      {...props}
    >
      {unstyled ? (
        children
      ) : (
        <>
          {leading ? <span className="ui-button-icon">{leading}</span> : null}
          <span className="ui-button-label">{children}</span>
          {trailing ? <span className="ui-button-icon">{trailing}</span> : null}
        </>
      )}
    </Link>
  );
}

export default Button;
