import { useDeferredValue, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { CreateUserInput, User } from '../../shared/domain';
import SettingsTabs from '../components/settings/SettingsTabs';
import StateBlock from '../components/StateBlock';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { Input, Select } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';

const accountDirectoryBatchSize = 40;

export default function AccountSettingsPage() {
  const { t, roleLabel } = useI18n();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [directoryQuery, setDirectoryQuery] = useState('');
  const deferredDirectoryQuery = useDeferredValue(directoryQuery);
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
  const [visibleDirectoryCount, setVisibleDirectoryCount] = useState(accountDirectoryBatchSize);
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
    const normalizedQuery = deferredDirectoryQuery.trim().toLowerCase();
    return sortedUsers.filter((user) => {
      const matchesRole = directoryRoleFilter === 'all' || user.role === directoryRoleFilter;
      const matchesStatus =
        directoryStatusFilter === 'all' || user.status === directoryStatusFilter;
      const matchesQuery =
        normalizedQuery.length === 0 || user.username.toLowerCase().includes(normalizedQuery);
      return matchesRole && matchesStatus && matchesQuery;
    });
  }, [deferredDirectoryQuery, directoryRoleFilter, directoryStatusFilter, sortedUsers]);
  const visibleFilteredUsers = useMemo(
    () => filteredUsers.slice(0, visibleDirectoryCount),
    [filteredUsers, visibleDirectoryCount]
  );
  const hiddenFilteredUserCount = Math.max(0, filteredUsers.length - visibleFilteredUsers.length);
  const hasDirectoryFilters =
    directoryQuery.trim().length > 0 ||
    directoryRoleFilter !== 'all' ||
    directoryStatusFilter !== 'all';

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

  const roleTone = (role: User['role']) => (role === 'admin' ? 'info' : 'neutral');

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

  useEffect(() => {
    setVisibleDirectoryCount((previous) =>
      Math.min(
        filteredUsers.length,
        Math.max(accountDirectoryBatchSize, previous > 0 ? previous : accountDirectoryBatchSize)
      )
    );
  }, [filteredUsers.length]);

  const resetDirectoryFilters = () => {
    setDirectoryQuery('');
    setDirectoryRoleFilter('all');
    setDirectoryStatusFilter('all');
  };

  return (
    <WorkspacePage>
      <SettingsTabs />

      <WorkspaceHero
        eyebrow={t('Account')}
        title={t('Account Settings')}
        description={t('Manage password access and admin-only account provisioning from one place.')}
        stats={[
          {
            label: t('Current user'),
            value: currentUser?.username ?? t('guest')
          },
          {
            label: t('Role'),
            value: currentUser ? roleLabel(currentUser.role) : t('User')
          },
          {
            label: t('Managed accounts'),
            value: managedAccountCount
          }
        ]}
      />

      <WorkspaceMetricGrid
        items={[
          {
            title: t('Managed accounts'),
            description: t('Accounts visible in this settings surface under the current role scope.'),
            value: managedAccountCount
          },
          {
            title: t('Admin accounts'),
            description: t('Provisioned admins currently visible to governance tools.'),
            value: directorySummary.admins
          },
          {
            title: t('Active accounts'),
            description: t('Accounts that can still open authenticated sessions.'),
            value: directorySummary.activeAccounts
          },
          {
            title: t('Disabled accounts'),
            description: t('Accounts with access paused and retained reason history.'),
            value: directorySummary.disabledAccounts,
            tone: directorySummary.disabledAccounts > 0 ? 'attention' : 'default'
          }
        ]}
      />

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
              <ButtonLink to="/auth/login" variant="secondary">
                {t('Login')}
              </ButtonLink>
            </div>
          }
        />
      ) : null}

      {!authRequired ? (
        <WorkspaceWorkbench
          toolbar={
            <Card as="section" className="workspace-toolbar-card">
              <div className="workspace-toolbar-head">
                <div className="workspace-toolbar-copy">
                  <h3>{t('Account Controls')}</h3>
                  <small className="muted">
                    {t('Keep password rotation, account governance, and directory filtering in one steady control strip.')}
                  </small>
                </div>
                <div className="workspace-toolbar-actions">
                  {currentUser?.role === 'admin' && hasDirectoryFilters ? (
                    <Button type="button" variant="ghost" size="sm" onClick={resetDirectoryFilters}>
                      {t('Clear filters')}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      reload().catch(() => {
                        // handled in helper
                      });
                    }}
                    disabled={loading || refreshing || passwordSaving || creatingUser}
                  >
                    {loading || refreshing ? t('Refreshing...') : t('Refresh')}
                  </Button>
                </div>
              </div>
              {currentUser?.role === 'admin' ? (
                <div className="workspace-filter-grid">
                  <label className="stack tight">
                    <small className="muted">{t('Search accounts')}</small>
                    <Input
                      value={directoryQuery}
                      onChange={(event) => setDirectoryQuery(event.target.value)}
                      placeholder={t('Search by username')}
                    />
                  </label>
                  <label className="stack tight">
                    <small className="muted">{t('Role')}</small>
                    <Select
                      value={directoryRoleFilter}
                      onChange={(event) =>
                        setDirectoryRoleFilter(event.target.value as 'all' | User['role'])
                      }
                    >
                      <option value="all">{t('All roles')}</option>
                      <option value="admin">{t('Admin')}</option>
                      <option value="user">{t('User')}</option>
                    </Select>
                  </label>
                  <label className="stack tight">
                    <small className="muted">{t('Status')}</small>
                    <Select
                      value={directoryStatusFilter}
                      onChange={(event) =>
                        setDirectoryStatusFilter(event.target.value as 'all' | User['status'])
                      }
                    >
                      <option value="all">{t('All statuses')}</option>
                      <option value="active">{t('active')}</option>
                      <option value="disabled">{t('disabled')}</option>
                    </Select>
                  </label>
                  <div className="stack tight">
                    <small className="muted">{t('Directory scope')}</small>
                    <div className="row gap wrap">
                      <Badge tone="info">{t('Matched')}: {filteredUsers.length}</Badge>
                      <Badge tone="neutral">{t('Total')}: {sortedUsers.length}</Badge>
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="workspace-toolbar-meta">
                <div className="workspace-segmented-actions">
                  <Badge tone="neutral">
                    {t('Current user')}: {currentUser?.username ?? t('guest')}
                  </Badge>
                  <Badge tone="neutral">
                    {t('Role')}: {currentUser ? roleLabel(currentUser.role) : t('User')}
                  </Badge>
                  <Badge tone="info">{t('Managed accounts')}: {managedAccountCount}</Badge>
                  {currentUser?.role === 'admin' ? (
                    <Badge tone={directorySummary.disabledAccounts > 0 ? 'warning' : 'neutral'}>
                      {t('Disabled accounts')}: {directorySummary.disabledAccounts}
                    </Badge>
                  ) : null}
                </div>
              </div>
            </Card>
          }
          main={
            <div className="workspace-main-stack">
              <Card>
                <WorkspaceSectionHeader
                  title={t('Change Password')}
                  description={t('All authenticated users can update their own password from this tab.')}
                />
                <small className="muted">
                  {t('Use this workbench to update your own password and manage account provisioning in one place.')}
                </small>

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
                        <Input
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
                        <Input
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
                        <Input
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
                      <Button type="submit" disabled={!canSubmitPassword}>
                        {passwordSaving ? t('Saving...') : t('Update Password')}
                      </Button>
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
              </Card>

              {currentUser?.role === 'admin' ? (
                <Card>
                  <WorkspaceSectionHeader
                    title={t('Account Directory')}
                    description={t('Review and narrow the account list before creating or auditing access.')}
                    actions={
                      <Badge tone="neutral">
                        {t('Total')}: {sortedUsers.length}
                      </Badge>
                    }
                  />
                  <small className="muted">
                    {t('Filter and review provisioned accounts before password reset or status changes.')} {t('Matched')}:{' '}
                    {filteredUsers.length} · {t('Total')}: {sortedUsers.length}
                  </small>
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
                      {visibleFilteredUsers.map((user) => (
                        <Panel key={user.id} as="li" className="workspace-record-item" tone="soft">
                          <div className="workspace-record-item-top">
                            <div className="workspace-record-summary stack tight">
                              <strong>{user.username}</strong>
                              <small className="muted">
                                {t('Created')}: {formatCompactTimestamp(user.created_at)}
                              </small>
                            </div>
                            <div className="workspace-record-actions">
                              <Badge tone={roleTone(user.role)}>{roleLabel(user.role)}</Badge>
                              <StatusTag status={user.status}>
                                {t('Status')}: {t(user.status)}
                              </StatusTag>
                            </div>
                          </div>
                          <div className="row gap wrap">
                            {user.id === currentUser?.id ? (
                              <Badge tone="info">{t('Current session')}</Badge>
                            ) : null}
                            <Badge tone={roleTone(user.role)}>
                              {t('Role')}: {roleLabel(user.role)}
                            </Badge>
                          </div>
                          <small className="muted">
                            {t('Last updated')}: {formatCompactTimestamp(user.updated_at)} · {t('Last login')}:{' '}
                            {user.last_login_at ? formatCompactTimestamp(user.last_login_at) : t('Never')}
                          </small>
                          {user.status === 'disabled' && user.status_reason ? (
                            <small className="muted">
                              {t('Disable reason')}: {user.status_reason}
                            </small>
                          ) : null}
                          <div className="row gap wrap">
                            <Button
                              type="button"
                              variant={passwordResetTargetId === user.id ? 'secondary' : 'ghost'}
                              size="sm"
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
                            </Button>
                            <Button
                              type="button"
                              variant={user.status === 'active' ? 'danger' : 'secondary'}
                              size="sm"
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
                            </Button>
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
                                <Input
                                  value={disableReasonValue}
                                  onChange={(event) => setDisableReasonValue(event.target.value)}
                                  placeholder={t('For example: Access paused during security review.')}
                                />
                              </label>
                              <small className="muted">
                                {t('Add a brief reason so future admins understand why access was paused.')}
                              </small>
                              <div className="row gap wrap">
                                <Button type="submit" variant="danger" size="sm" disabled={!canSubmitDisableReason}>
                                  {statusUpdatingUserId === user.id ? t('Saving...') : t('Confirm Disable')}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    setDisableReasonTargetId(null);
                                    setDisableReasonValue('');
                                  }}
                                  disabled={statusUpdatingUserId === user.id}
                                >
                                  {t('Cancel')}
                                </Button>
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
                                <Input
                                  type="password"
                                  value={passwordResetValue}
                                  onChange={(event) => setPasswordResetValue(event.target.value)}
                                />
                              </label>
                              <small className="muted">
                                {t('Use at least 8 characters, then share it securely with the account owner.')}
                              </small>
                              <div className="row gap wrap">
                                <Button type="submit" size="sm" disabled={!canSubmitPasswordReset}>
                                  {resettingUserId === user.id ? t('Saving...') : t('Confirm Password Reset')}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    setPasswordResetTargetId(null);
                                    setPasswordResetValue('');
                                  }}
                                  disabled={resettingUserId === user.id}
                                >
                                  {t('Cancel')}
                                </Button>
                              </div>
                            </form>
                          ) : null}
                        </Panel>
                      ))}
                    </ul>
                  )}
                  {hiddenFilteredUserCount > 0 ? (
                    <div className="workspace-record-actions">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setVisibleDirectoryCount((previous) =>
                            Math.min(filteredUsers.length, previous + accountDirectoryBatchSize)
                          );
                        }}
                      >
                        {t('Load More Users')} ({hiddenFilteredUserCount})
                      </Button>
                    </div>
                  ) : null}
                </Card>
              ) : null}
            </div>
          }
          side={
            <div className="workspace-inspector-rail">
              <Card className="workspace-inspector-card">
                <WorkspaceSectionHeader
                  title={t('Current account')}
                  description={t('Use this surface for password rotation and session-safe account operations.')}
                />
                <Panel as="section" className="stack tight" tone="soft">
                  <div className="row between gap wrap">
                    <strong>{currentUser?.username ?? t('guest')}</strong>
                    <div className="workspace-record-actions">
                      <Badge tone={currentUser?.role ? roleTone(currentUser.role) : 'neutral'}>
                        {currentUser ? roleLabel(currentUser.role) : t('guest')}
                      </Badge>
                      {currentUser ? (
                        <StatusTag status={currentUser.status}>
                          {t('Status')}: {t(currentUser.status)}
                        </StatusTag>
                      ) : null}
                    </div>
                  </div>
                  <small className="muted">
                    {t('Created')}: {currentUser ? formatCompactTimestamp(currentUser.created_at) : '-'} ·{' '}
                    {t('Last updated')}: {currentUser ? formatCompactTimestamp(currentUser.updated_at) : '-'}
                  </small>
                  {currentUser ? (
                    <small className="muted">
                      {t('Last login')}: {currentUser.last_login_at ? formatCompactTimestamp(currentUser.last_login_at) : t('Never')}
                    </small>
                  ) : null}
                </Panel>
              </Card>

              <Card className="workspace-inspector-card">
                <WorkspaceSectionHeader
                  title={t('Account Provisioning')}
                  description={
                    currentUser?.role === 'admin'
                      ? t('Administrators can create user or admin accounts from this tab.')
                      : t('Ask an administrator to provision your account before first login.')
                  }
                />

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
                        <Input
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
                        <Input
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
                        <Select
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
                        </Select>
                      </label>
                    </div>
                    <small className="muted">{t('Create passwords with at least 8 characters.')}</small>
                    <div className="row gap wrap">
                      <Button type="submit" disabled={!canCreateUser}>
                        {creatingUser ? t('Creating...') : t('Create Account')}
                      </Button>
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
              </Card>

              {currentUser?.role === 'admin' ? (
                <Card className="workspace-inspector-card">
                  <WorkspaceSectionHeader
                    title={t('Directory Summary')}
                    description={t('Quick account mix and current filter visibility in one panel.')}
                  />
                  <div className="workspace-keyline-list">
                    <div className="workspace-keyline-item">
                      <span>{t('Admin accounts')}</span>
                      <strong>{directorySummary.admins}</strong>
                    </div>
                    <div className="workspace-keyline-item">
                      <span>{t('User accounts')}</span>
                      <strong>{directorySummary.standardUsers}</strong>
                    </div>
                    <div className="workspace-keyline-item">
                      <span>{t('Active accounts')}</span>
                      <strong>{directorySummary.activeAccounts}</strong>
                    </div>
                    <div className="workspace-keyline-item">
                      <span>{t('Disabled accounts')}</span>
                      <strong>{directorySummary.disabledAccounts}</strong>
                    </div>
                    <div className="workspace-keyline-item">
                      <span>{t('Matched')}</span>
                      <strong>{filteredUsers.length}</strong>
                    </div>
                  </div>
                </Card>
              ) : null}
            </div>
          }
        />
      ) : null}
    </WorkspacePage>
  );
}
