import { useMemo } from 'react';
import { NavLink } from 'react-router-dom';
import { Card } from '../ui/Surface';
import { useI18n } from '../../i18n/I18nProvider';

export default function SettingsTabs() {
  const { t } = useI18n();
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
          {t('Pick one task at a time. Primary settings stay above, advanced templates stay below.')}
        </small>
      </div>

      <nav className="settings-surface-tabs" aria-label={t('Settings')}>
        {primaryTabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
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
        <small className="muted">{t('Advanced')}</small>
        <nav className="settings-surface-tabs" aria-label={t('Advanced settings')}>
          {advancedTabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
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
