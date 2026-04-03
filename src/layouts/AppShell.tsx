import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import type { User } from '../../shared/domain';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { AUTH_UPDATED_EVENT, emitAuthUpdated } from '../services/authSession';

export default function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { language, setLanguage, t, roleLabel } = useI18n();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const isConversationWorkspace = location.pathname === '/workspace/chat';

  const refreshUser = () => {
    api.me().then(setCurrentUser).catch(() => setCurrentUser(null));
  };

  useEffect(() => {
    refreshUser();

    window.addEventListener(AUTH_UPDATED_EVENT, refreshUser as EventListener);
    return () => {
      window.removeEventListener(AUTH_UPDATED_EVENT, refreshUser as EventListener);
    };
  }, []);

  const logout = async () => {
    try {
      await api.logout();
      emitAuthUpdated();
    } catch {
      // Keep current user visible if logout fails in prototype mode.
    }
  };

  if (isConversationWorkspace) {
    return <main className="chat-route-main">{children}</main>;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/" className="brand">
          {t('Vistral Prototype')}
        </Link>
        <nav className="row gap">
          <label className="language-switch-inline">
            <span>{t('Language')}</span>
            <select
              value={language}
              onChange={(event) => setLanguage(event.target.value as 'zh-CN' | 'en-US')}
            >
              <option value="zh-CN">{t('Chinese')}</option>
              <option value="en-US">{t('English')}</option>
            </select>
          </label>
          <NavLink to="/auth/login">{t('Login')}</NavLink>
          <NavLink to="/auth/register">{t('Register')}</NavLink>
          {currentUser ? (
            <>
              <span className="chip">
                {currentUser.username} · {roleLabel(currentUser.role)}
              </span>
              <button type="button" onClick={logout} className="small-btn">
                {t('Logout')}
              </button>
            </>
          ) : null}
        </nav>
      </header>

      <aside className="sidebar">
        <NavLink to="/">{t('Dual Entry')}</NavLink>
        <NavLink to="/workspace/chat">{t('Conversation Workspace')}</NavLink>
        <NavLink to="/workspace/console">{t('Professional Console')}</NavLink>
        <NavLink to="/models/explore">{t('Models Explore')}</NavLink>
        <NavLink to="/models/my-models">{t('My Models')}</NavLink>
        <NavLink to="/models/create">{t('Create Model')}</NavLink>
        <NavLink to="/models/versions">{t('Model Versions')}</NavLink>
        <NavLink to="/datasets">{t('Datasets')}</NavLink>
        <NavLink to="/training/jobs">{t('Training Jobs')}</NavLink>
        <NavLink to="/inference/validate">{t('Inference Validate')}</NavLink>
        <NavLink to="/admin/models/pending">{t('Admin Approvals')}</NavLink>
        <NavLink to="/admin/audit">{t('Admin Audit')}</NavLink>
        <NavLink to="/admin/verification-reports">{t('Admin Verify Reports')}</NavLink>
        <NavLink to="/settings/llm">{t('LLM Settings')}</NavLink>
        <NavLink to="/settings/runtime">{t('Runtime Settings')}</NavLink>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}
