import { useMemo } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Card } from '../ui/Surface';
import { useI18n } from '../../i18n/I18nProvider';

const scopedQueryKeys = [
  'dataset',
  'version',
  'task_type',
  'framework',
  'profile',
  'execution_target',
  'worker',
  'focus',
  'return_to'
] as const;

const sanitizeReturnToPath = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('://')) {
    return null;
  }
  return trimmed;
};

export default function SettingsTabs() {
  const location = useLocation();
  const { t } = useI18n();
  const scopedSearchParams = useMemo(() => {
    const incoming = new URLSearchParams(location.search || '');
    const scoped = new URLSearchParams();
    scopedQueryKeys.forEach((key) => {
      const value = incoming.get(key);
      if (!value?.trim()) {
        return;
      }
      if (key === 'return_to') {
        const safeReturnTo = sanitizeReturnToPath(value);
        if (!safeReturnTo) {
          return;
        }
        scoped.set(key, safeReturnTo);
        return;
      }
      scoped.set(key, value.trim());
    });
    return scoped;
  }, [location.search]);
  const buildTabPath = (basePath: string): string => {
    const [pathname, query = ''] = basePath.split('?');
    const searchParams = new URLSearchParams(query);
    scopedSearchParams.forEach((value, key) => {
      if (!searchParams.has(key)) {
        searchParams.set(key, value);
      }
    });
    const nextQuery = searchParams.toString();
    return nextQuery ? `${pathname}?${nextQuery}` : pathname;
  };
  const primaryTabs = useMemo(
    () => [
      { to: '/settings/account', label: t('Account Settings') },
      { to: '/settings/llm', label: t('LLM Settings') },
      { to: '/settings/runtime', label: t('Runtime Settings'), end: true },
      { to: '/settings/workers', label: t('Worker Settings') }
    ],
    [t]
  );
  const advancedTabs = useMemo(
    () => [{ to: '/settings/runtime/templates', label: t('Runtime Templates') }],
    [t]
  );

  return (
    <Card className="settings-surface-nav">
      <div className="stack tight">
        <strong>{t('Settings')}</strong>
        <small className="muted">
          {t('Pick one task at a time. Primary settings stay above, templates stay below.')}
        </small>
      </div>

      <nav className="settings-surface-tabs" aria-label={t('Settings')}>
        {primaryTabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={buildTabPath(tab.to)}
            end={tab.end}
            className={({ isActive }) =>
              isActive ? 'settings-surface-tab active' : 'settings-surface-tab'
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <div className="stack tight">
        <small className="muted">{t('Reference')}</small>
        <nav className="settings-surface-tabs" aria-label={t('Advanced settings')}>
          {advancedTabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={buildTabPath(tab.to)}
              className={({ isActive }) =>
                isActive ? 'settings-surface-tab active' : 'settings-surface-tab'
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </Card>
  );
}
