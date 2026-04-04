import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { User } from '../../shared/domain';
import SessionMenu from '../components/SessionMenu';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { AUTH_UPDATED_EVENT, emitAuthUpdated } from '../services/authSession';

interface AppNavItem {
  to: string;
  label: string;
  shortLabel: string;
  matchPrefixes: string[];
  end?: boolean;
}

type AppNavGroupKey = 'workspaces' | 'model_build' | 'data_run' | 'governance' | 'settings';

interface AppNavGroup {
  key: AppNavGroupKey;
  label: string;
  items: AppNavItem[];
}

const appSidebarCollapsedStorageKey = 'vistral-app-sidebar-collapsed';
const appCollapsedNavGroupsStorageKey = 'vistral-app-collapsed-nav-groups';
const appNavGroupKeys: AppNavGroupKey[] = [
  'workspaces',
  'model_build',
  'data_run',
  'governance',
  'settings'
];
const defaultCollapsedNavGroups: AppNavGroupKey[] = ['governance', 'settings'];
const compactViewportMaxWidth = 960;

const readAppSidebarCollapsedFromStorage = (): boolean => {
  try {
    return localStorage.getItem(appSidebarCollapsedStorageKey) === 'true';
  } catch {
    return false;
  }
};

const writeAppSidebarCollapsedToStorage = (collapsed: boolean) => {
  try {
    localStorage.setItem(appSidebarCollapsedStorageKey, String(collapsed));
  } catch {
    // Ignore storage errors in prototype mode.
  }
};

const readCollapsedNavGroupsFromStorage = (): AppNavGroupKey[] => {
  try {
    const raw = localStorage.getItem(appCollapsedNavGroupsStorageKey);
    if (!raw) {
      return defaultCollapsedNavGroups;
    }

    const parsed = JSON.parse(raw) as string[];
    if (!Array.isArray(parsed)) {
      return defaultCollapsedNavGroups;
    }

    const parsedSet = new Set(parsed);
    return appNavGroupKeys.filter((key) => parsedSet.has(key));
  } catch {
    return defaultCollapsedNavGroups;
  }
};

const writeCollapsedNavGroupsToStorage = (groupKeys: AppNavGroupKey[]) => {
  try {
    const unique = Array.from(new Set(groupKeys)).filter((key): key is AppNavGroupKey =>
      appNavGroupKeys.includes(key as AppNavGroupKey)
    );
    localStorage.setItem(appCollapsedNavGroupsStorageKey, JSON.stringify(unique));
  } catch {
    // Ignore storage errors in prototype mode.
  }
};

const detectCompactViewport = (): boolean =>
  typeof window !== 'undefined' ? window.innerWidth <= compactViewportMaxWidth : false;

const getInitials = (username?: string): string => {
  if (!username) {
    return 'U';
  }

  return username.slice(0, 2).toUpperCase();
};

const matchesRailItem = (pathname: string, item: AppNavItem): boolean => {
  if (item.end) {
    return pathname === item.to;
  }

  return item.matchPrefixes.some((prefix) =>
    prefix === '/' ? pathname === '/' : pathname.startsWith(prefix)
  );
};

export default function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { language, setLanguage, t } = useI18n();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() =>
    readAppSidebarCollapsedFromStorage()
  );
  const [collapsedNavGroups, setCollapsedNavGroups] = useState<AppNavGroupKey[]>(() =>
    readCollapsedNavGroupsFromStorage()
  );
  const [isCompactViewport, setIsCompactViewport] = useState<boolean>(() => detectCompactViewport());
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const isConversationWorkspace = location.pathname === '/workspace/chat';

  const refreshUser = useCallback(() => {
    api.me().then(setCurrentUser).catch(() => setCurrentUser(null));
  }, []);

  useEffect(() => {
    refreshUser();

    window.addEventListener(AUTH_UPDATED_EVENT, refreshUser as EventListener);
    return () => {
      window.removeEventListener(AUTH_UPDATED_EVENT, refreshUser as EventListener);
    };
  }, [refreshUser]);

  useEffect(() => {
    writeAppSidebarCollapsedToStorage(sidebarCollapsed);
  }, [sidebarCollapsed]);

  useEffect(() => {
    writeCollapsedNavGroupsToStorage(collapsedNavGroups);
  }, [collapsedNavGroups]);

  useEffect(() => {
    const syncViewport = () => {
      setIsCompactViewport(detectCompactViewport());
    };

    syncViewport();
    window.addEventListener('resize', syncViewport);
    return () => {
      window.removeEventListener('resize', syncViewport);
    };
  }, []);

  useEffect(() => {
    if (!isCompactViewport) {
      setMobileSidebarOpen(false);
    }
  }, [isCompactViewport]);

  useEffect(() => {
    if (!isCompactViewport) {
      return;
    }

    setMobileSidebarOpen(false);
  }, [isCompactViewport, location.pathname]);

  useEffect(() => {
    if (!isCompactViewport || !mobileSidebarOpen) {
      document.body.style.removeProperty('overflow');
      return;
    }

    document.body.style.setProperty('overflow', 'hidden');
    return () => {
      document.body.style.removeProperty('overflow');
    };
  }, [isCompactViewport, mobileSidebarOpen]);

  const closeMobileSidebar = useCallback(() => {
    setMobileSidebarOpen(false);
  }, []);

  const toggleSidebar = useCallback(() => {
    if (isCompactViewport) {
      setMobileSidebarOpen((previous) => !previous);
      return;
    }

    setSidebarCollapsed((previous) => !previous);
  }, [isCompactViewport]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
      setCurrentUser(null);
      emitAuthUpdated();
      closeMobileSidebar();
      navigate('/', { replace: true });
    } catch {
      // Keep current user visible if logout fails in prototype mode.
    }
  }, [closeMobileSidebar, navigate]);

  const sessionMenuItems = useMemo(
    () => [
      { to: '/workspace/chat', label: t('Conversation Workspace') },
      { to: '/settings', label: t('Settings') },
      { label: t('Logout'), onSelect: logout, tone: 'danger' as const }
    ],
    [logout, t]
  );

  const navigationGroups = useMemo<AppNavGroup[]>(
    () => [
      {
        key: 'workspaces',
        label: t('Workspaces'),
        items: [
          {
            to: '/',
            label: t('Dual Entry'),
            shortLabel: 'H',
            matchPrefixes: ['/'],
            end: true
          },
          {
            to: '/workspace/chat',
            label: t('Conversation Workspace'),
            shortLabel: 'AI',
            matchPrefixes: ['/workspace/chat']
          },
          {
            to: '/workspace/console',
            label: t('Professional Console'),
            shortLabel: 'PC',
            matchPrefixes: ['/workspace/console']
          }
        ]
      },
      {
        key: 'model_build',
        label: t('Model Build'),
        items: [
          {
            to: '/models/explore',
            label: t('Models Explore'),
            shortLabel: 'M',
            matchPrefixes: ['/models/explore']
          },
          {
            to: '/models/my-models',
            label: t('My Models'),
            shortLabel: 'MY',
            matchPrefixes: ['/models/my-models']
          },
          {
            to: '/models/create',
            label: t('Create Model'),
            shortLabel: 'N',
            matchPrefixes: ['/models/create']
          },
          {
            to: '/models/versions',
            label: t('Model Versions'),
            shortLabel: 'V',
            matchPrefixes: ['/models/versions']
          }
        ]
      },
      {
        key: 'data_run',
        label: t('Data & Run'),
        items: [
          {
            to: '/datasets',
            label: t('Datasets'),
            shortLabel: 'D',
            matchPrefixes: ['/datasets']
          },
          {
            to: '/training/jobs',
            label: t('Training Jobs'),
            shortLabel: 'T',
            matchPrefixes: ['/training/jobs']
          },
          {
            to: '/inference/validate',
            label: t('Inference Validate'),
            shortLabel: 'I',
            matchPrefixes: ['/inference/validate']
          }
        ]
      },
      {
        key: 'governance',
        label: t('Governance'),
        items: [
          {
            to: '/admin/models/pending',
            label: t('Admin Approvals'),
            shortLabel: 'AP',
            matchPrefixes: ['/admin/models/pending']
          },
          {
            to: '/admin/audit',
            label: t('Admin Audit'),
            shortLabel: 'AU',
            matchPrefixes: ['/admin/audit']
          },
          {
            to: '/admin/verification-reports',
            label: t('Admin Verify Reports'),
            shortLabel: 'VR',
            matchPrefixes: ['/admin/verification-reports']
          }
        ]
      },
      {
        key: 'settings',
        label: t('Settings'),
        items: [
          {
            to: '/settings',
            label: t('Settings'),
            shortLabel: 'S',
            matchPrefixes: ['/settings']
          }
        ]
      }
    ],
    [t]
  );

  const railItems = useMemo<AppNavItem[]>(
    () => [
      {
        to: '/',
        label: t('Dual Entry'),
        shortLabel: 'H',
        matchPrefixes: ['/'],
        end: true
      },
      {
        to: '/workspace/chat',
        label: t('Conversation Workspace'),
        shortLabel: 'AI',
        matchPrefixes: ['/workspace/chat']
      },
      {
        to: '/workspace/console',
        label: t('Professional Console'),
        shortLabel: 'PC',
        matchPrefixes: ['/workspace/console']
      },
      {
        to: '/models/explore',
        label: t('Models Explore'),
        shortLabel: 'M',
        matchPrefixes: ['/models']
      },
      {
        to: '/datasets',
        label: t('Datasets'),
        shortLabel: 'D',
        matchPrefixes: ['/datasets']
      },
      {
        to: '/training/jobs',
        label: t('Training Jobs'),
        shortLabel: 'T',
        matchPrefixes: ['/training/jobs']
      },
      {
        to: '/admin/verification-reports',
        label: t('Admin Verify Reports'),
        shortLabel: 'G',
        matchPrefixes: ['/admin']
      },
      {
        to: '/settings',
        label: t('Settings'),
        shortLabel: 'S',
        matchPrefixes: ['/settings']
      }
    ],
    [t]
  );

  const activeContext = useMemo(() => {
    const pathname = location.pathname;

    if (pathname.startsWith('/workspace/console')) {
      return { section: t('Workspaces'), label: t('Professional Console') };
    }

    if (pathname.startsWith('/models/explore')) {
      return { section: t('Model Build'), label: t('Models Explore') };
    }

    if (pathname.startsWith('/models/my-models')) {
      return { section: t('Model Build'), label: t('My Models') };
    }

    if (pathname.startsWith('/models/create')) {
      return { section: t('Model Build'), label: t('Create Model') };
    }

    if (pathname.startsWith('/models/versions')) {
      return { section: t('Model Build'), label: t('Model Versions') };
    }

    if (pathname.startsWith('/datasets')) {
      return { section: t('Data & Run'), label: t('Datasets') };
    }

    if (pathname.startsWith('/training/jobs')) {
      return { section: t('Data & Run'), label: t('Training Jobs') };
    }

    if (pathname.startsWith('/inference/validate')) {
      return { section: t('Data & Run'), label: t('Inference Validate') };
    }

    if (pathname.startsWith('/admin/models/pending')) {
      return { section: t('Governance'), label: t('Admin Approvals') };
    }

    if (pathname.startsWith('/admin/audit')) {
      return { section: t('Governance'), label: t('Admin Audit') };
    }

    if (pathname.startsWith('/admin/verification-reports')) {
      return { section: t('Governance'), label: t('Admin Verify Reports') };
    }

    if (pathname.startsWith('/settings')) {
      return { section: t('Settings'), label: t('Settings') };
    }

    if (pathname.startsWith('/auth/login')) {
      return { section: t('Workspaces'), label: t('Login') };
    }

    return { section: t('Workspaces'), label: t('Dual Entry') };
  }, [location.pathname, t]);

  const toggleNavGroup = useCallback((groupKey: AppNavGroupKey) => {
    setCollapsedNavGroups((previous) =>
      previous.includes(groupKey)
        ? previous.filter((item) => item !== groupKey)
        : [...previous, groupKey]
    );
  }, []);

  const isDesktopSidebarCollapsed = sidebarCollapsed && !isCompactViewport;
  const shellClassName = [
    'app-shell',
    isDesktopSidebarCollapsed ? 'sidebar-collapsed' : '',
    isCompactViewport ? 'sidebar-compact' : '',
    mobileSidebarOpen ? 'mobile-sidebar-open' : ''
  ]
    .filter(Boolean)
    .join(' ');
  const sidebarToggleLabel = isCompactViewport
    ? mobileSidebarOpen
      ? t('Close navigation')
      : t('Open navigation')
    : isDesktopSidebarCollapsed
      ? t('Expand sidebar')
      : t('Collapse sidebar');
  const sidebarToggleToken = isCompactViewport ? (mobileSidebarOpen ? 'X' : '=') : isDesktopSidebarCollapsed ? '>' : '<';

  if (isConversationWorkspace) {
    return <main className="chat-route-main">{children}</main>;
  }

  return (
    <div className={shellClassName}>
      {isCompactViewport ? (
        <button
          type="button"
          className={`app-sidebar-scrim${mobileSidebarOpen ? ' visible' : ''}`}
          onClick={closeMobileSidebar}
          aria-label={t('Close navigation')}
        />
      ) : null}

      <header className="topbar">
        <div className="topbar-leading">
          <button
            type="button"
            className="app-sidebar-toggle"
            onClick={toggleSidebar}
            aria-label={sidebarToggleLabel}
            title={sidebarToggleLabel}
          >
            {sidebarToggleToken}
          </button>
          <Link to="/" className="topbar-brand-chip">
            Vistral
          </Link>
          <div className="topbar-page-context">
            <small className="muted">{activeContext.section}</small>
            <strong>{activeContext.label}</strong>
          </div>
        </div>

        <nav className="topbar-actions row gap wrap">
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
          {!currentUser ? (
            <div className="topbar-auth-links">
              <NavLink to="/auth/login">{t('Login')}</NavLink>
            </div>
          ) : null}
          {currentUser && isCompactViewport ? (
            <SessionMenu currentUser={currentUser} items={sessionMenuItems} />
          ) : null}
        </nav>
      </header>

      <aside className="sidebar" aria-hidden={isCompactViewport && !mobileSidebarOpen}>
        <div className="sidebar-content">
          <div className="sidebar-brand-row">
            <Link to="/" className="sidebar-brand-link" onClick={closeMobileSidebar}>
              <span className="sidebar-brand-mark" aria-hidden="true">
                V
              </span>
              <div className="stack tight">
                <strong>{t('Vistral Prototype')}</strong>
                <small className="muted">{activeContext.section}</small>
              </div>
            </Link>
            <button
              type="button"
              className="sidebar-inline-toggle"
              onClick={toggleSidebar}
              aria-label={sidebarToggleLabel}
              title={sidebarToggleLabel}
            >
              {sidebarToggleToken}
            </button>
          </div>

          <div className="sidebar-workspace-switch">
            <NavLink
              to="/workspace/chat"
              className={({ isActive }) =>
                isActive ? 'sidebar-workspace-pill active' : 'sidebar-workspace-pill'
              }
              onClick={closeMobileSidebar}
            >
              {t('Conversation Workspace')}
            </NavLink>
            <NavLink
              to="/workspace/console"
              className={({ isActive }) =>
                isActive ? 'sidebar-workspace-pill active' : 'sidebar-workspace-pill'
              }
              onClick={closeMobileSidebar}
            >
              {t('Professional Console')}
            </NavLink>
          </div>

          <nav className="sidebar-nav" aria-label={t('Navigation')}>
            {navigationGroups.map((group) => (
              <section key={group.label} className="sidebar-nav-group">
                {(() => {
                  const groupIsActive = group.items.some((item) =>
                    matchesRailItem(location.pathname, item)
                  );
                  const groupIsCollapsed =
                    collapsedNavGroups.includes(group.key) && !groupIsActive;

                  return (
                    <>
                      <button
                        type="button"
                        className={`sidebar-nav-group-title${groupIsActive ? ' active' : ''}`}
                        onClick={() => toggleNavGroup(group.key)}
                        aria-label={groupIsCollapsed ? t('Expand section') : t('Collapse section')}
                      >
                        <span className="sidebar-nav-group-title-copy">
                          <span>{group.label}</span>
                          <span className="sidebar-nav-group-count">{group.items.length}</span>
                        </span>
                        <span className="sidebar-nav-group-chevron" aria-hidden="true">
                          {groupIsCollapsed ? '▸' : '▾'}
                        </span>
                      </button>

                      {groupIsCollapsed ? null : (
                        <div className="sidebar-nav-list">
                          {group.items.map((item) => (
                            <NavLink
                              key={item.to}
                              to={item.to}
                              end={item.end}
                              className={({ isActive }) =>
                                isActive ? 'sidebar-nav-link active' : 'sidebar-nav-link'
                              }
                              onClick={closeMobileSidebar}
                            >
                              {item.label}
                            </NavLink>
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
              </section>
            ))}
          </nav>

          <div className="sidebar-footer">
            {currentUser ? (
              <SessionMenu
                currentUser={currentUser}
                items={sessionMenuItems}
                align="start"
                direction="up"
                variant="sidebar"
              />
            ) : (
              <div className="sidebar-session-card guest">
                <div className="sidebar-session-summary">
                  <div className="sidebar-session-avatar">{getInitials()}</div>
                  <div className="stack tight">
                    <strong>{t('guest')}</strong>
                    <small className="muted">{t('Login')}</small>
                  </div>
                </div>
                <div className="sidebar-session-actions">
                  <NavLink to="/auth/login">{t('Login')}</NavLink>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="sidebar-collapsed-rail">
          <button
            type="button"
            className="sidebar-rail-btn sidebar-rail-control"
            onClick={toggleSidebar}
            aria-label={t('Expand sidebar')}
            title={t('Expand sidebar')}
          >
            &gt;
          </button>

          {railItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={matchesRailItem(location.pathname, item) ? 'sidebar-rail-btn active' : 'sidebar-rail-btn'}
              onClick={closeMobileSidebar}
              aria-label={item.label}
              title={item.label}
            >
              {item.shortLabel}
            </NavLink>
          ))}

          <div className="sidebar-rail-footer">
            {currentUser ? (
              <SessionMenu
                currentUser={currentUser}
                items={sessionMenuItems}
                align="start"
                direction="up"
                variant="rail"
              />
            ) : (
              <div className="sidebar-rail-avatar" title={t('guest')}>
                {getInitials()}
              </div>
            )}
          </div>
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}
