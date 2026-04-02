import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import type { User } from '../../shared/domain';
import { api } from '../services/api';
import { AUTH_UPDATED_EVENT, emitAuthUpdated } from '../services/authSession';

export default function AppShell({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<User | null>(null);

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

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/" className="brand">
          Vistral Prototype
        </Link>
        <nav className="row gap">
          <NavLink to="/auth/login">Login</NavLink>
          <NavLink to="/auth/register">Register</NavLink>
          {currentUser ? (
            <>
              <span className="chip">
                {currentUser.username} · {currentUser.role}
              </span>
              <button type="button" onClick={logout} className="small-btn">
                Logout
              </button>
            </>
          ) : null}
        </nav>
      </header>

      <aside className="sidebar">
        <NavLink to="/">Dual Entry</NavLink>
        <NavLink to="/workspace/chat">Conversation Workspace</NavLink>
        <NavLink to="/workspace/console">Professional Console</NavLink>
        <NavLink to="/models/explore">Models Explore</NavLink>
        <NavLink to="/models/my-models">My Models</NavLink>
        <NavLink to="/models/create">Create Model</NavLink>
        <NavLink to="/models/versions">Model Versions</NavLink>
        <NavLink to="/datasets">Datasets</NavLink>
        <NavLink to="/training/jobs">Training Jobs</NavLink>
        <NavLink to="/inference/validate">Inference Validate</NavLink>
        <NavLink to="/admin/models/pending">Admin Approvals</NavLink>
        <NavLink to="/admin/audit">Admin Audit</NavLink>
        <NavLink to="/settings/llm">LLM Settings</NavLink>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}
