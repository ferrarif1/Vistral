import { NavLink } from 'react-router-dom';
import { useI18n } from '../../i18n/I18nProvider';

export default function SettingsTabs() {
  const { t } = useI18n();

  return (
    <section className="card settings-surface-nav">
      <div className="stack tight">
        <strong>{t('Settings')}</strong>
        <small className="muted">
          {t('Use one settings entry, then switch between Account, LLM, and runtime controls here.')}
        </small>
      </div>

      <nav className="settings-surface-tabs" aria-label={t('Settings')}>
        <NavLink
          to="/settings/account"
          className={({ isActive }) =>
            isActive ? 'settings-surface-tab active' : 'settings-surface-tab'
          }
        >
          {t('Account Settings')}
        </NavLink>
        <NavLink
          to="/settings/llm"
          className={({ isActive }) =>
            isActive ? 'settings-surface-tab active' : 'settings-surface-tab'
          }
        >
          {t('LLM Settings')}
        </NavLink>
        <NavLink
          to="/settings/runtime"
          className={({ isActive }) =>
            isActive ? 'settings-surface-tab active' : 'settings-surface-tab'
          }
        >
          {t('Runtime Settings')}
        </NavLink>
      </nav>
    </section>
  );
}
