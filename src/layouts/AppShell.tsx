import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/" className="brand">Vistral Baseline</Link>
        <nav>
          <NavLink to="/auth/login">Login</NavLink>
          <NavLink to="/auth/register">Register</NavLink>
        </nav>
      </header>
      <aside className="sidebar">
        <NavLink to="/">Conversation</NavLink>
        <NavLink to="/models/explore">Models</NavLink>
        <NavLink to="/models/my-models">My Models</NavLink>
        <NavLink to="/models/create">Create Model</NavLink>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
