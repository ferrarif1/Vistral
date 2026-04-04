import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { CreateUserInput, User } from '../../shared/domain';
import SettingsTabs from '../components/settings/SettingsTabs';
import StateBlock from '../components/StateBlock';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const formatTimestamp = (iso: string): string => {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) {
    return iso;
  }

  return new Date(value).toLocaleString();
};

export default function AccountSettingsPage() {
  const { t, roleLabel } = useI18n();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [directoryQuery, setDirectoryQuery] = useState('');
  const [directoryRoleFilter, setDirectoryRoleFilter] = useState<'all' | User['role']>('all');
  const [directoryStatusFilter, setDirectoryStatusFilter] = useState<'all' | User['status']>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [directoryError, setDirectoryError] = useState('');
  const [passwordStatus, setPasswordStatus] = useState<{
    variant: 'success' | 'error';
    text: string;
  } | null>(null);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordForm, setPasswordForm] = useState({
    current_password: '',
    new_password: '',
    confirm_password: ''
  });
  const [createStatus, setCreateStatus] = useState<{
    variant: 'success' | 'error';
    text: string;
  } | null>(null);
  const [creatingUser, setCreatingUser] = useState(false);
  const [createUserForm, setCreateUserForm] = useState<CreateUserInput>({
    username: '',
    password: '',
    role: 'user'
  });
  const [adminActionStatus, setAdminActionStatus] = useState<{
    variant: 'success' | 'error';
    text: string;
  } | null>(null);
  const [passwordResetTargetId, setPasswordResetTargetId] = useState<string | null>(null);
  const [passwordResetValue, setPasswordResetValue] = useState('');
  const [disableReasonTargetId, setDisableReasonTargetId] = useState<string | null>(null);
  const [disableReasonValue, setDisableReasonValue] = useState('');
  const [resettingUserId, setResettingUserId] = useState<string | null>(null);
  const [statusUpdatingUserId, setStatusUpdatingUserId] = useState<string | null>(null);

  const refresh = async () => {
    const me = await api.me();
    setCurrentUser(me);
    setLoadError('');

    if (me.role === 'admin') {
      try {
        const nextUsers = await api.listUsers();
        setUsers(nextUsers);
        setDirectoryError('');
      } catch (error) {
        setUsers([]);
        setDirectoryError((error as Error).message);
      }
      return;
    }

    setUsers([]);
    setDirectoryError('');
  };

  useEffect(() => {
    setLoading(true);
    refresh()
      .catch((error) => {
        setCurrentUser(null);
        setUsers([]);
        setLoadError((error as Error).message);
      })
      .finally(() => setLoading(false));
  }, []);

  const reload = async () => {
    setRefreshing(true);
    try {
      await refresh();
    } catch (error) {
      setLoadError((error as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const sortedUsers = useMemo(
    () =>
      [...users].sort((left, right) => {
        if (left.role !== right.role) {
          return left.role === 'admin' ? -1 : 1;
        }

        const leftTime = Date.parse(left.updated_at) || 0;
        const rightTime = Date.parse(right.updated_at) || 0;
        if (rightTime !== leftTime) {
          return rightTime - leftTime;
        }

        return left.username.localeCompare(right.username);
      }),
    [users]
  );

  const directorySummary = useMemo(
    () => ({
      total: sortedUsers.length,
      admins: sortedUsers.filter((user) => user.role === 'admin').length,
      activeAdmins: sortedUsers.filter((user) => user.role === 'admin' && user.status === 'active')
        .length,
      standardUsers: sortedUsers.filter((user) => user.role === 'user').length,
      activeAccounts: sortedUsers.filter((user) => user.status === 'active').length,
      disabledAccounts: sortedUsers.filter((user) => user.status === 'disabled').length
    }),
    [sortedUsers]
  );

  const filteredUsers = useMemo(() => {
    const normalizedQuery = directoryQuery.trim().toLowerCase();
    return sortedUsers.filter((user) => {
      const matchesRole = directoryRoleFilter === 'all' || user.role === directoryRoleFilter;
      const matchesStatus =
        directoryStatusFilter === 'all' || user.status === directoryStatusFilter;
      const matchesQuery =
        normalizedQuery.length === 0 || user.username.toLowerCase().includes(normalizedQuery);
      return matchesRole && matchesStatus && matchesQuery;
    });
  }, [directoryQuery, directoryRoleFilter, directoryStatusFilter, sortedUsers]);

  const authRequired = loadError === 'Authentication required.';
  const managedAccountCount = currentUser?.role === 'admin' ? users.length : currentUser ? 1 : 0;
  const passwordConfirmationMatches =
    passwordForm.confirm_password.trim().length === 0 ||
    passwordForm.new_password.trim() === passwordForm.confirm_password.trim();
  const canSubmitPassword =
    passwordForm.current_password.trim().length > 0 &&
    passwordForm.new_password.trim().length >= 8 &&
    passwordForm.confirm_password.trim().length > 0 &&
    passwordForm.new_password.trim() === passwordForm.confirm_password.trim() &&
    !passwordSaving;
  const canCreateUser =
    createUserForm.username.trim().length >= 3 &&
    createUserForm.password.trim().length >= 8 &&
    !creatingUser;
  const canSubmitPasswordReset = passwordResetValue.trim().length >= 8 && !resettingUserId;
  const canSubmitDisableReason =
    disableReasonValue.trim().length > 0 && statusUpdatingUserId === null;

  const applyUserUpdate = (nextUser: User) => {
    setUsers((previous) => previous.map((user) => (user.id === nextUser.id ? nextUser : user)));
    setCurrentUser((previous) => (previous && previous.id === nextUser.id ? nextUser : previous));
  };

  const submitPasswordChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPasswordStatus(null);

    if (passwordForm.new_password.trim() !== passwordForm.confirm_password.trim()) {
      setPasswordStatus({
        variant: 'error',
        text: t('New password confirmation does not match.')
      });
      return;
    }

    setPasswordSaving(true);
    try {
      await api.changeMyPassword({
        current_password: passwordForm.current_password,
        new_password: passwordForm.new_password
      });
      setPasswordForm({
        current_password: '',
        new_password: '',
        confirm_password: ''
      });
      setPasswordStatus({
        variant: 'success',
        text: t('Password updated successfully.')
      });
      await refresh();
    } catch (error) {
      setPasswordStatus({
        variant: 'error',
        text: (error as Error).message
      });
    } finally {
      setPasswordSaving(false);
    }
  };

  const submitCreateUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateStatus(null);

    setCreatingUser(true);
    try {
      const created = await api.createUserAccount(createUserForm);
      setCreateUserForm({
        username: '',
        password: '',
        role: 'user'
      });
      setCreateStatus({
        variant: 'success',
        text: t('Account created for {username}.', { username: created.username })
      });
      await refresh();
    } catch (error) {
      setCreateStatus({
        variant: 'error',
        text: (error as Error).message
      });
    } finally {
      setCreatingUser(false);
    }
  };

  const submitPasswordReset = async (user: User) => {
    setAdminActionStatus(null);
    setResettingUserId(user.id);
    try {
      const updated = await api.resetUserPassword(user.id, {
        new_password: passwordResetValue
      });
      applyUserUpdate(updated);
      setPasswordResetTargetId(null);
      setPasswordResetValue('');
      setAdminActionStatus({
        variant: 'success',
        text: t('Password reset for {username}.', { username: user.username })
      });
    } catch (error) {
      setAdminActionStatus({
        variant: 'error',
        text: (error as Error).message
      });
    } finally {
      setResettingUserId(null);
    }
  };

  const updateUserStatus = async (user: User, nextStatus: User['status'], reason?: string) => {
    setAdminActionStatus(null);
    setStatusUpdatingUserId(user.id);
    try {
      const updated = await api.updateUserStatus(user.id, {
        status: nextStatus,
        ...(nextStatus === 'disabled' ? { reason } : {})
      });
      applyUserUpdate(updated);
      if (nextStatus === 'disabled') {
        setDisableReasonTargetId(null);
        setDisableReasonValue('');
      }
      setAdminActionStatus({
        variant: 'success',
        text:
          nextStatus === 'disabled'
            ? t('Account disabled for {username}. Reason saved and active sessions were signed out.', {
                username: user.username
              })
            : t('Account reactivated for {username}.', { username: user.username })
      });
    } catch (error) {
      setAdminActionStatus({
        variant: 'error',
        text: (error as Error).message
      });
    } finally {
      setStatusUpdatingUserId(null);
    }
  };

  const submitDisableUser = async (user: User) => {
    const reason = disableReasonValue.trim();
    if (!reason) {
      setAdminActionStatus({
        variant: 'error',
        text: t('Disable reason is required before disabling.')
      });
      return;
    }

    await updateUserStatus(user, 'disabled', reason);
  };

  return (
    <div className="workspace-overview-page stack">
      <SettingsTabs />

      <section className="card workspace-overview-hero">
        <div className="workspace-overview-hero-grid">
          <div className="workspace-overview-copy stack">
            <small className="workspace-eyebrow">{t('Account')}</small>
            <h1>{t('Account Settings')}</h1>
            <p className="muted">
              {t('Manage password access and admin-only account provisioning from one place.')}
            </p>
          </div>
          <div className="workspace-overview-badges">
            <div className="workspace-overview-badge">
              <span>{t('Current user')}</span>
              <strong>{currentUser?.username ?? t('guest')}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Role')}</span>
              <strong>{currentUser ? roleLabel(currentUser.role) : t('User')}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Managed accounts')}</span>
              <strong>{managedAccountCount}</strong>
            </div>
          </div>
        </div>
      </section>

      {loadError && !authRequired ? (
        <StateBlock variant="error" title={t('Load Failed')} description={loadError} />
      ) : null}

      {authRequired ? (
        <StateBlock
          variant="empty"
          title={t('Login to manage account settings')}
          description={t('Sign in to change password or access admin account provisioning.')}
          extra={
            <div className="row gap wrap">
              <Link to="/auth/login" className="workspace-inline-link">
                {t('Login')}
              </Link>
            </div>
          }
        />
      ) : null}

      {!authRequired ? (
        <section className="workspace-overview-panel-grid">
          <article className="card stack workspace-overview-main">
            <div className="workspace-section-header">
              <div className="stack tight">
                <h3>{t('Change Password')}</h3>
                <small className="muted">
                  {t('All authenticated users can update their own password from this tab.')}
                </small>
              </div>
              <button
                type="button"
                className="workspace-inline-button"
                onClick={() => {
                  reload().catch(() => {
                    // handled in helper
                  });
                }}
                disabled={loading || refreshing || passwordSaving || creatingUser}
              >
                {loading || refreshing ? t('Refreshing...') : t('Refresh')}
              </button>
            </div>

            {loading ? (
              <StateBlock
                variant="loading"
                title={t('Loading')}
                description={t('Loading account settings and access scope.')}
              />
            ) : (
              <form className="stack" onSubmit={submitPasswordChange}>
                <div className="workspace-form-grid">
                  <label>
                    {t('Current Password')}
                    <input
                      type="password"
                      value={passwordForm.current_password}
                      onChange={(event) =>
                        setPasswordForm((previous) => ({
                          ...previous,
                          current_password: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    {t('New Password')}
                    <input
                      type="password"
                      value={passwordForm.new_password}
                      onChange={(event) =>
                        setPasswordForm((previous) => ({
                          ...previous,
                          new_password: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label className="workspace-form-span-2">
                    {t('Confirm New Password')}
                    <input
                      type="password"
                      value={passwordForm.confirm_password}
                      onChange={(event) =>
                        setPasswordForm((previous) => ({
                          ...previous,
                          confirm_password: event.target.value
                        }))
                      }
                    />
                  </label>
                </div>
                <small className="muted">
                  {t('Password updates require your current password plus a confirmed new password.')}
                </small>
                {!passwordConfirmationMatches ? (
                  <small className="muted">{t('New password confirmation does not match.')}</small>
                ) : null}
                <div className="row gap wrap">
                  <button type="submit" disabled={!canSubmitPassword}>
                    {passwordSaving ? t('Saving...') : t('Update Password')}
                  </button>
                </div>
              </form>
            )}

            {passwordStatus ? (
              <StateBlock
                variant={passwordStatus.variant}
                title={
                  passwordStatus.variant === 'success' ? t('Settings Updated') : t('Action Failed')
                }
                description={passwordStatus.text}
              />
            ) : null}
          </article>

          <div className="workspace-overview-side">
            <article className="card stack">
              <div className="stack tight">
                <h3>{t('Current account')}</h3>
                <small className="muted">
                  {t('Use this surface for password rotation and session-safe account operations.')}
                </small>
              </div>
              <ul className="workspace-record-list compact">
                <li className="workspace-record-item compact">
                  <div className="row between gap wrap">
                    <strong>{currentUser?.username ?? t('guest')}</strong>
                    <span className={`workspace-status-pill ${currentUser?.role ?? 'draft'}`}>
                      {currentUser ? roleLabel(currentUser.role) : t('guest')}
                    </span>
                  </div>
                  <small className="muted">
                    {t('Created')}: {currentUser ? formatTimestamp(currentUser.created_at) : '-'}
                  </small>
                  <small className="muted">
                    {t('Last updated')}: {currentUser ? formatTimestamp(currentUser.updated_at) : '-'}
                  </small>
                </li>
              </ul>
            </article>

            <article className="card stack">
              <div className="stack tight">
                <h3>{t('Account Provisioning')}</h3>
                <small className="muted">
                  {currentUser?.role === 'admin'
                    ? t('Administrators can create user or admin accounts from this tab.')
                    : t('Ask an administrator to provision your account before first login.')}
                </small>
              </div>

              {currentUser?.role !== 'admin' ? (
                <StateBlock
                  variant="empty"
                  title={t('Admin only')}
                  description={t('Only administrators can create new accounts.')}
                />
              ) : (
                <form className="stack" onSubmit={submitCreateUser}>
                  <div className="workspace-form-grid">
                    <label>
                      {t('Username')}
                      <input
                        value={createUserForm.username}
                        onChange={(event) =>
                          setCreateUserForm((previous) => ({
                            ...previous,
                            username: event.target.value
                          }))
                        }
                      />
                    </label>
                    <label>
                      {t('Password')}
                      <input
                        type="password"
                        value={createUserForm.password}
                        onChange={(event) =>
                          setCreateUserForm((previous) => ({
                            ...previous,
                            password: event.target.value
                          }))
                        }
                      />
                    </label>
                    <label className="workspace-form-span-2">
                      {t('Role')}
                      <select
                        value={createUserForm.role}
                        onChange={(event) =>
                          setCreateUserForm((previous) => ({
                            ...previous,
                            role: event.target.value as CreateUserInput['role']
                          }))
                        }
                      >
                        <option value="user">{t('User')}</option>
                        <option value="admin">{t('Admin')}</option>
                      </select>
                    </label>
                  </div>
                  <small className="muted">{t('Create passwords with at least 8 characters.')}</small>
                  <div className="row gap wrap">
                    <button type="submit" disabled={!canCreateUser}>
                      {creatingUser ? t('Creating...') : t('Create Account')}
                    </button>
                  </div>
                </form>
              )}

              {createStatus ? (
                <StateBlock
                  variant={createStatus.variant}
                  title={createStatus.variant === 'success' ? t('Action Completed') : t('Action Failed')}
                  description={createStatus.text}
                />
              ) : null}
            </article>
          </div>
        </section>
      ) : null}

      {!authRequired && currentUser?.role === 'admin' ? (
        <section className="card stack">
          <div className="workspace-section-header">
            <div className="stack tight">
              <h3>{t('Account Directory')}</h3>
              <small className="muted">
                {t('Review and narrow the account list before creating or auditing access.')}
              </small>
            </div>
            <span className="chip">
              {t('Total')}: {sortedUsers.length}
            </span>
          </div>

          <div className="row gap wrap">
            <span className="chip">
              {t('Admin accounts')}: {directorySummary.admins}
            </span>
            <span className="chip">
              {t('User accounts')}: {directorySummary.standardUsers}
            </span>
            <span className="chip">
              {t('Active accounts')}: {directorySummary.activeAccounts}
            </span>
            <span className="chip">
              {t('Disabled accounts')}: {directorySummary.disabledAccounts}
            </span>
          </div>

          <div className="filters-grid">
            <label>
              {t('Search accounts')}
              <input
                value={directoryQuery}
                onChange={(event) => setDirectoryQuery(event.target.value)}
                placeholder={t('Search by username')}
              />
            </label>
            <label>
              {t('Filter by role')}
              <select
                value={directoryRoleFilter}
                onChange={(event) =>
                  setDirectoryRoleFilter(event.target.value as 'all' | User['role'])
                }
              >
                <option value="all">{t('All roles')}</option>
                <option value="admin">{t('Admin')}</option>
                <option value="user">{t('User')}</option>
              </select>
            </label>
            <label>
              {t('Filter by status')}
              <select
                value={directoryStatusFilter}
                onChange={(event) =>
                  setDirectoryStatusFilter(event.target.value as 'all' | User['status'])
                }
              >
                <option value="all">{t('All statuses')}</option>
                <option value="active">{t('active')}</option>
                <option value="disabled">{t('disabled')}</option>
              </select>
            </label>
          </div>

          <small className="muted">
            {t('Disabling an account signs out its active sessions immediately. Reactivated users must log in again.')}
          </small>

          {adminActionStatus ? (
            <StateBlock
              variant={adminActionStatus.variant}
              title={
                adminActionStatus.variant === 'success' ? t('Action Completed') : t('Action Failed')
              }
              description={adminActionStatus.text}
            />
          ) : null}

          {directoryError ? (
            <StateBlock variant="error" title={t('Load Failed')} description={directoryError} />
          ) : loading ? (
            <StateBlock
              variant="loading"
              title={t('Loading')}
              description={t('Loading provisioned accounts.')}
            />
          ) : sortedUsers.length === 0 ? (
            <StateBlock
              variant="empty"
              title={t('No accounts yet.')}
              description={t('Provisioned accounts will appear here after an administrator creates them.')}
            />
          ) : filteredUsers.length === 0 ? (
            <StateBlock
              variant="empty"
              title={t('No accounts match current filters.')}
              description={t('Try another keyword or reset the role filter.')}
            />
          ) : (
            <ul className="workspace-record-list">
              {filteredUsers.map((user) => (
                <li key={user.id} className="workspace-record-item">
                  <div className="workspace-record-item-top">
                    <div className="workspace-record-summary stack tight">
                      <strong>{user.username}</strong>
                      <small className="muted">
                        {t('Created')}: {formatTimestamp(user.created_at)}
                      </small>
                    </div>
                    <div className="workspace-record-actions">
                      <span className={`workspace-status-pill ${user.role}`}>{roleLabel(user.role)}</span>
                    </div>
                  </div>
                  <div className="row gap wrap">
                    {user.id === currentUser?.id ? (
                      <span className="chip">{t('Current session')}</span>
                    ) : null}
                    <span className="chip">
                      {t('Role')}: {roleLabel(user.role)}
                    </span>
                    <span className="chip">
                      {t('Status')}: {t(user.status)}
                    </span>
                    <span className="chip">
                      {t('Last updated')}: {formatTimestamp(user.updated_at)}
                    </span>
                    <span className="chip">
                      {t('Last login')}: {user.last_login_at ? formatTimestamp(user.last_login_at) : t('Never')}
                    </span>
                  </div>
                  {user.status === 'disabled' && user.status_reason ? (
                    <small className="muted">
                      {t('Disable reason')}: {user.status_reason}
                    </small>
                  ) : null}
                  <div className="row gap wrap">
                    <button
                      type="button"
                      className="small-btn"
                      onClick={() => {
                        setAdminActionStatus(null);
                        setDisableReasonTargetId(null);
                        setDisableReasonValue('');
                        setPasswordResetTargetId((previous) =>
                          previous === user.id ? null : user.id
                        );
                        setPasswordResetValue('');
                      }}
                      disabled={statusUpdatingUserId === user.id}
                    >
                      {passwordResetTargetId === user.id ? t('Cancel') : t('Reset Password')}
                    </button>
                    <button
                      type="button"
                      className="small-btn"
                      onClick={() => {
                        if (user.status === 'active') {
                          const opening = disableReasonTargetId !== user.id;
                          setAdminActionStatus(null);
                          setPasswordResetTargetId(null);
                          setPasswordResetValue('');
                          setDisableReasonTargetId(opening ? user.id : null);
                          setDisableReasonValue(opening ? user.status_reason ?? '' : '');
                          return;
                        }

                        void updateUserStatus(user, 'active');
                      }}
                      disabled={
                        statusUpdatingUserId !== null ||
                        (user.status === 'active' &&
                          (user.id === currentUser?.id ||
                            (user.role === 'admin' && directorySummary.activeAdmins <= 1)))
                      }
                    >
                      {statusUpdatingUserId === user.id
                        ? t('Saving...')
                        : user.status === 'active'
                          ? disableReasonTargetId === user.id
                            ? t('Cancel')
                            : t('Disable Account')
                          : t('Reactivate Account')}
                    </button>
                  </div>
                  {user.id === currentUser?.id && user.status === 'active' ? (
                    <small className="muted">{t('Current admin session cannot be disabled from this directory.')}</small>
                  ) : null}
                  {user.role === 'admin' &&
                  user.status === 'active' &&
                  directorySummary.activeAdmins <= 1 ? (
                    <small className="muted">{t('Last active admin account cannot be disabled.')}</small>
                  ) : null}
                  {disableReasonTargetId === user.id ? (
                    <form
                      className="stack"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submitDisableUser(user);
                      }}
                    >
                      <label>
                        {t('Disable reason')}
                        <input
                          value={disableReasonValue}
                          onChange={(event) => setDisableReasonValue(event.target.value)}
                          placeholder={t('For example: Access paused during security review.')}
                        />
                      </label>
                      <small className="muted">
                        {t('Add a brief reason so future admins understand why access was paused.')}
                      </small>
                      <div className="row gap wrap">
                        <button type="submit" disabled={!canSubmitDisableReason}>
                          {statusUpdatingUserId === user.id ? t('Saving...') : t('Confirm Disable')}
                        </button>
                        <button
                          type="button"
                          className="small-btn"
                          onClick={() => {
                            setDisableReasonTargetId(null);
                            setDisableReasonValue('');
                          }}
                          disabled={statusUpdatingUserId === user.id}
                        >
                          {t('Cancel')}
                        </button>
                      </div>
                    </form>
                  ) : null}
                  {passwordResetTargetId === user.id ? (
                    <form
                      className="stack"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submitPasswordReset(user);
                      }}
                    >
                      <label>
                        {t('New temporary password')}
                        <input
                          type="password"
                          value={passwordResetValue}
                          onChange={(event) => setPasswordResetValue(event.target.value)}
                        />
                      </label>
                      <small className="muted">
                        {t('Use at least 8 characters, then share it securely with the account owner.')}
                      </small>
                      <div className="row gap wrap">
                        <button type="submit" disabled={!canSubmitPasswordReset}>
                          {resettingUserId === user.id ? t('Saving...') : t('Confirm Password Reset')}
                        </button>
                        <button
                          type="button"
                          className="small-btn"
                          onClick={() => {
                            setPasswordResetTargetId(null);
                            setPasswordResetValue('');
                          }}
                          disabled={resettingUserId === user.id}
                        >
                          {t('Cancel')}
                        </button>
                      </div>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
