import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { api } from '../services/api';
import type { User } from '../../shared/domain';

export default function AppShell({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<User | null>(null);

  useEffect(() => {
    api.me().then(setCurrentUser).catch(() => setCurrentUser(null));
  }, []);

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
            <span className="chip">
              {currentUser.username} · {currentUser.role}
            </span>
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
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}
