import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { User } from '../../shared/domain';
import { useI18n, type AppLanguage } from '../i18n/I18nProvider';

interface SessionMenuItem {
  label: string;
  to?: string;
  onSelect?: () => void | Promise<void>;
  tone?: 'default' | 'danger';
}

interface SessionMenuProps {
  currentUser: User;
  items: SessionMenuItem[];
  align?: 'start' | 'end';
  direction?: 'down' | 'up';
  variant?: 'pill' | 'sidebar' | 'rail';
  languageControl?: {
    value: AppLanguage;
    onChange: (value: AppLanguage) => void;
  };
}

const getInitials = (username?: string): string => {
  if (!username) {
    return 'U';
  }

  return username.slice(0, 2).toUpperCase();
};

export default function SessionMenu({
  currentUser,
  items,
  align = 'end',
  direction = 'down',
  variant = 'pill',
  languageControl
}: SessionMenuProps) {
  const { t, roleLabel } = useI18n();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const closeMenu = () => {
    setOpen(false);
  };

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`session-menu variant-${variant}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`session-menu-trigger variant-${variant}${open ? ' open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t('Open account menu')}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span className="session-menu-trigger-avatar" aria-hidden="true">
          {getInitials(currentUser.username)}
        </span>
        {variant === 'rail' ? null : (
          <>
            <span className="session-menu-trigger-copy">
              <strong>{currentUser.username}</strong>
              <small>{roleLabel(currentUser.role)}</small>
            </span>
            <span className="session-menu-trigger-chevron" aria-hidden="true">
              {open ? '▴' : '▾'}
            </span>
          </>
        )}
      </button>

      {open ? (
        <div
          id={menuId}
          className={`session-menu-panel ${align === 'start' ? 'align-start' : 'align-end'} ${direction === 'up' ? 'direction-up' : 'direction-down'}`}
          role="menu"
        >
          <div className="session-menu-panel-header">
            <div className="session-menu-panel-avatar" aria-hidden="true">
              {getInitials(currentUser.username)}
            </div>
            <div className="stack tight">
              <strong>{currentUser.username}</strong>
              <small className="muted">
                @{currentUser.username} · {roleLabel(currentUser.role)}
              </small>
            </div>
          </div>

          {languageControl ? (
            <div className="session-menu-language" role="group" aria-label={t('Language')}>
              <small className="muted">{t('Language')}</small>
              <div className="session-menu-language-options">
                <button
                  type="button"
                  className={`session-menu-language-option${languageControl.value === 'zh-CN' ? ' active' : ''}`}
                  onClick={() => languageControl.onChange('zh-CN')}
                >
                  {t('Chinese')}
                </button>
                <button
                  type="button"
                  className={`session-menu-language-option${languageControl.value === 'en-US' ? ' active' : ''}`}
                  onClick={() => languageControl.onChange('en-US')}
                >
                  {t('English')}
                </button>
              </div>
            </div>
          ) : null}

          <div className="session-menu-list">
            {items.map((item, index) =>
              item.to ? (
                <Link
                  key={`${item.to}-${index}`}
                  to={item.to}
                  className={`session-menu-item${item.tone === 'danger' ? ' danger' : ''}`}
                  role="menuitem"
                  onClick={closeMenu}
                >
                  {item.label}
                </Link>
              ) : (
                <button
                  key={`${item.label}-${index}`}
                  type="button"
                  className={`session-menu-item${item.tone === 'danger' ? ' danger' : ''}`}
                  role="menuitem"
                  onClick={() => {
                    closeMenu();
                    void item.onSelect?.();
                  }}
                >
                  {item.label}
                </button>
              )
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
