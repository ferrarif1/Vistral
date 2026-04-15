import { useDeferredValue, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { CreateUserInput, User } from '../../shared/domain';
import SettingsTabs from '../components/settings/SettingsTabs';
import StateBlock from '../components/StateBlock';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import {
  ActionBar,
  ConfirmDangerDialog,
  DetailDrawer,
  DetailList,
  FilterToolbar,
  InlineAlert,
  PageHeader,
  SectionCard,
  StatusTable,
  type StatusTableColumn
} from '../components/ui/ConsolePage';
import { Input, Select } from '../components/ui/Field';
import { Drawer } from '../components/ui/Overlay';
import { WorkspacePage, WorkspaceWorkbench } from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';

type AccountStatusChangeIntent = {
  user: User;
  nextStatus: User['status'];
  reason?: string;
};

const roleTone = (role: User['role']) => (role === 'admin' ? 'info' : 'neutral');

export default function AccountSettingsPage() {
  const { t, roleLabel } = useI18n();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [directoryError, setDirectoryError] = useState('');

  const [passwordForm, setPasswordForm] = useState({
    current_password: '',
    new_password: '',
    confirm_password: ''
  });
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordStatus, setPasswordStatus] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);

  const [directoryQuery, setDirectoryQuery] = useState('');
  const deferredDirectoryQuery = useDeferredValue(directoryQuery);
  const [directoryRoleFilter, setDirectoryRoleFilter] = useState<'all' | User['role']>('all');
  const [directoryStatusFilter, setDirectoryStatusFilter] = useState<'all' | User['status']>('all');
  const [directoryExpanded, setDirectoryExpanded] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [adminActionStatus, setAdminActionStatus] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);

  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [createUserForm, setCreateUserForm] = useState<CreateUserInput>({
    username: '',
    password: '',
    role: 'user'
  });
  const [creatingUser, setCreatingUser] = useState(false);
  const [createStatus, setCreateStatus] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);

  const [passwordResetDraft, setPasswordResetDraft] = useState('');
  const [passwordResetBusy, setPasswordResetBusy] = useState(false);
  const [disableReasonDraft, setDisableReasonDraft] = useState('');
  const [statusUpdatingBusy, setStatusUpdatingBusy] = useState(false);
  const [statusChangeIntent, setStatusChangeIntent] = useState<AccountStatusChangeIntent | null>(null);

  const refresh = async () => {
    const me = await api.me();
    setCurrentUser(me);
    setLoadError('');

    if (me.role === 'admin') {
      try {
        const listed = await api.listUsers();
        setUsers(listed);
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

  const filteredUsers = useMemo(() => {
    const normalizedQuery = deferredDirectoryQuery.trim().toLowerCase();
    return sortedUsers.filter((user) => {
      const matchesQuery =
        normalizedQuery.length === 0 || user.username.toLowerCase().includes(normalizedQuery);
      const matchesRole = directoryRoleFilter === 'all' || user.role === directoryRoleFilter;
      const matchesStatus = directoryStatusFilter === 'all' || user.status === directoryStatusFilter;
      return matchesQuery && matchesRole && matchesStatus;
    });
  }, [deferredDirectoryQuery, directoryRoleFilter, directoryStatusFilter, sortedUsers]);

  const hasDirectoryFilters =
    directoryQuery.trim().length > 0 ||
    directoryRoleFilter !== 'all' ||
    directoryStatusFilter !== 'all';

  const directorySummary = useMemo(
    () => ({
      total: sortedUsers.length,
      admins: sortedUsers.filter((user) => user.role === 'admin').length,
      activeAdmins: sortedUsers.filter((user) => user.role === 'admin' && user.status === 'active').length,
      disabled: sortedUsers.filter((user) => user.status === 'disabled').length
    }),
    [sortedUsers]
  );

  const selectedUser = useMemo(
    () => (selectedUserId ? sortedUsers.find((item) => item.id === selectedUserId) ?? null : null),
    [selectedUserId, sortedUsers]
  );

  const canCreateUser =
    createUserForm.username.trim().length >= 3 &&
    createUserForm.password.trim().length >= 8 &&
    !creatingUser;

  const canSubmitPassword =
    passwordForm.current_password.trim().length > 0 &&
    passwordForm.new_password.trim().length >= 8 &&
    passwordForm.confirm_password.trim().length > 0 &&
    passwordForm.new_password.trim() === passwordForm.confirm_password.trim() &&
    !passwordSaving;

  const canSubmitPasswordReset = passwordResetDraft.trim().length >= 8 && !passwordResetBusy;
  const canSubmitDisableReason = disableReasonDraft.trim().length > 0 && !statusUpdatingBusy;

  const authRequired = loadError === 'Authentication required.';
  const isAdmin = currentUser?.role === 'admin';

  const passwordConfirmationMatches =
    passwordForm.confirm_password.trim().length === 0 ||
    passwordForm.new_password.trim() === passwordForm.confirm_password.trim();

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
    setPasswordResetBusy(true);
    try {
      const updated = await api.resetUserPassword(user.id, {
        new_password: passwordResetDraft.trim()
      });
      applyUserUpdate(updated);
      setPasswordResetDraft('');
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
      setPasswordResetBusy(false);
    }
  };

  const requestStatusChange = (user: User, nextStatus: User['status']) => {
    if (nextStatus === 'disabled' && !disableReasonDraft.trim()) {
      setAdminActionStatus({
        variant: 'error',
        text: t('Disable reason is required before disabling.')
      });
      return;
    }
    setStatusChangeIntent({
      user,
      nextStatus,
      reason: nextStatus === 'disabled' ? disableReasonDraft.trim() : undefined
    });
  };

  const confirmStatusChange = async () => {
    if (!statusChangeIntent) {
      return;
    }
    const { user, nextStatus, reason } = statusChangeIntent;
    setStatusUpdatingBusy(true);
    setAdminActionStatus(null);
    try {
      const updated = await api.updateUserStatus(user.id, {
        status: nextStatus,
        ...(nextStatus === 'disabled' ? { reason } : {})
      });
      applyUserUpdate(updated);
      if (nextStatus === 'disabled') {
        setDisableReasonDraft('');
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
      setStatusChangeIntent(null);
    } catch (error) {
      setAdminActionStatus({
        variant: 'error',
        text: (error as Error).message
      });
    } finally {
      setStatusUpdatingBusy(false);
    }
  };

  const userTableColumns = useMemo<StatusTableColumn<User>[]>(
    () => [
      {
        key: 'username',
        header: t('Username'),
        width: '24%',
        cell: (user) => (
          <div className="stack tight">
            <strong>{user.username}</strong>
            <small className="muted">{t('Created')}: {formatCompactTimestamp(user.created_at)}</small>
          </div>
        )
      },
      {
        key: 'role',
        header: t('Role'),
        width: '14%',
        cell: (user) => <Badge tone={roleTone(user.role)}>{roleLabel(user.role)}</Badge>
      },
      {
        key: 'status',
        header: t('Status'),
        width: '14%',
        cell: (user) => <StatusTag status={user.status}>{t(user.status)}</StatusTag>
      },
      {
        key: 'last_login',
        header: t('Last login'),
        width: '24%',
        cell: (user) => (
          <small className="muted">
            {user.last_login_at ? formatCompactTimestamp(user.last_login_at) : t('Never')}
          </small>
        )
      },
      {
        key: 'actions',
        header: t('Actions'),
        width: '24%',
        cell: (user) => (
          <div className="workspace-record-actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                setSelectedUserId(user.id);
                setPasswordResetDraft('');
                setDisableReasonDraft(user.status_reason ?? '');
              }}
            >
              {t('Open')}
            </Button>
          </div>
        )
      }
    ],
    [roleLabel, t]
  );

  const selectedUserCannotDisable = selectedUser
    ? selectedUser.status === 'active' &&
      (selectedUser.id === currentUser?.id ||
        (selectedUser.role === 'admin' && directorySummary.activeAdmins <= 1))
    : false;

  return (
    <WorkspacePage>
      <SettingsTabs />

      <PageHeader
        eyebrow={t('Account')}
        title={t('Account Settings')}
        description={
          isAdmin
            ? t('Primary task: manage your own account. Admin tools are grouped as a secondary lane.')
            : t('Primary task: view your account and rotate your password.')
        }
        primaryAction={{
          label: loading || refreshing ? t('Refreshing...') : t('Refresh'),
          onClick: () => {
            reload().catch(() => {
              // handled in helper
            });
          },
          disabled: loading || refreshing || passwordSaving || creatingUser
        }}
        secondaryActions={
          isAdmin ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => setCreateDrawerOpen(true)}>
              {t('Create account')}
            </Button>
          ) : undefined
        }
      />

      {loadError && !authRequired ? (
        <InlineAlert tone="danger" title={t('Load Failed')} description={loadError} />
      ) : null}
      {passwordStatus ? (
        <InlineAlert
          tone={passwordStatus.variant === 'success' ? 'success' : 'danger'}
          title={passwordStatus.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={passwordStatus.text}
        />
      ) : null}
      {adminActionStatus ? (
        <InlineAlert
          tone={adminActionStatus.variant === 'success' ? 'success' : 'danger'}
          title={adminActionStatus.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={adminActionStatus.text}
        />
      ) : null}

      {authRequired ? (
        <StateBlock
          variant="empty"
          title={t('Login to manage account settings')}
          description={t('Sign in to change password or access admin account tools.')}
          extra={
            <ButtonLink to="/auth/login" variant="secondary">
              {t('Login')}
            </ButtonLink>
          }
        />
      ) : (
        <WorkspaceWorkbench
          main={
            <div className="workspace-main-stack">
              <SectionCard
                title={t('My account')}
                description={t('User-facing identity context only.')}
              >
                <DetailList
                  items={[
                    { label: t('Username'), value: currentUser?.username ?? t('guest') },
                    { label: t('Role'), value: currentUser ? roleLabel(currentUser.role) : t('User') },
                    { label: t('Status'), value: currentUser ? t(currentUser.status) : t('n/a') },
                    {
                      label: t('Last login'),
                      value: currentUser?.last_login_at ? formatCompactTimestamp(currentUser.last_login_at) : t('Never')
                    },
                    {
                      label: t('Last updated'),
                      value: currentUser ? formatCompactTimestamp(currentUser.updated_at) : t('n/a')
                    }
                  ]}
                />
              </SectionCard>

              <SectionCard
                title={t('Change password')}
                description={t('All authenticated users can rotate their own password here.')}
              >
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
                  {!passwordConfirmationMatches ? (
                    <small className="muted">{t('New password confirmation does not match.')}</small>
                  ) : null}
                  <ActionBar
                    primary={
                      <Button type="submit" disabled={!canSubmitPassword}>
                        {passwordSaving ? t('Saving...') : t('Update Password')}
                      </Button>
                    }
                  />
                </form>
              </SectionCard>

              {isAdmin ? (
                <details
                  className="workspace-details"
                  open={directoryExpanded}
                  onToggle={(event) => setDirectoryExpanded(event.currentTarget.open)}
                >
                  <summary className="row between gap wrap align-center">
                    <span>{t('Administrator tools')}</span>
                    <Badge tone="neutral">
                      {t('{total} accounts', { total: directorySummary.total })}
                    </Badge>
                  </summary>
                  <div className="stack tight">
                    <small className="muted">
                      {t('Directory and governance actions stay collapsed until you need them.')}
                    </small>
                    <SectionCard
                      title={t('Account directory')}
                      description={t('Search, filter, and manage accounts from one table-first view.')}
                    >
                      <FilterToolbar
                        filters={
                          <>
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
                                onChange={(event) => setDirectoryRoleFilter(event.target.value as 'all' | User['role'])}
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
                          </>
                        }
                        actions={
                          hasDirectoryFilters ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setDirectoryQuery('');
                                setDirectoryRoleFilter('all');
                                setDirectoryStatusFilter('all');
                              }}
                            >
                              {t('Clear filters')}
                            </Button>
                          ) : undefined
                        }
                      />

                      {directoryError ? (
                        <StateBlock variant="error" title={t('Load Failed')} description={directoryError} />
                      ) : loading ? (
                        <StateBlock
                          variant="loading"
                          title={t('Loading')}
                          description={t('Loading account directory.')}
                        />
                      ) : (
                        <StatusTable
                          columns={userTableColumns}
                          rows={filteredUsers}
                          getRowKey={(user) => user.id}
                          emptyTitle={t('No accounts')}
                          emptyDescription={
                            hasDirectoryFilters
                              ? t('No accounts match current filters.')
                              : t('No provisioned accounts yet.')
                          }
                          onRowClick={(user) => {
                            setSelectedUserId(user.id);
                            setPasswordResetDraft('');
                            setDisableReasonDraft(user.status_reason ?? '');
                          }}
                        />
                      )}
                    </SectionCard>
                  </div>
                </details>
              ) : null}
            </div>
          }
          side={
            isAdmin ? (
              <div className="workspace-inspector-rail">
                <SectionCard
                  title={t('Administrator tools')}
                  description={t('Keep governance actions secondary to your own account tasks.')}
                >
                  <DetailList
                    items={[
                      { label: t('Total'), value: directorySummary.total },
                      { label: t('Admins'), value: directorySummary.admins },
                      { label: t('Active admins'), value: directorySummary.activeAdmins },
                      { label: t('Disabled'), value: directorySummary.disabled }
                    ]}
                  />
                  <ActionBar
                    primary={
                      <Button type="button" variant="secondary" size="sm" onClick={() => setDirectoryExpanded((prev) => !prev)}>
                        {directoryExpanded ? t('Hide directory') : t('Open directory')}
                      </Button>
                    }
                  />
                </SectionCard>
              </div>
            ) : undefined
          }
      />
      )}

      <Drawer
        open={createDrawerOpen}
        onClose={() => setCreateDrawerOpen(false)}
        side="right"
        className="runtime-worker-drawer"
        title={t('Create account')}
      >
        <div className="stack">
          <SectionCard
            title={t('Create account')}
            description={t('Admin-only provisioning. This does not interrupt user self-service flow.')}
          >
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
              <ActionBar
                primary={
                  <Button type="submit" disabled={!canCreateUser}>
                    {creatingUser ? t('Creating...') : t('Create Account')}
                  </Button>
                }
                secondary={
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setCreateUserForm({ username: '', password: '', role: 'user' });
                      setCreateStatus(null);
                    }}
                  >
                    {t('Reset Draft')}
                  </Button>
                }
              />
            </form>
            {createStatus ? (
              <InlineAlert
                tone={createStatus.variant === 'success' ? 'success' : 'danger'}
                title={createStatus.variant === 'success' ? t('Action Completed') : t('Action Failed')}
                description={createStatus.text}
              />
            ) : null}
          </SectionCard>
        </div>
      </Drawer>

      <DetailDrawer
        open={Boolean(selectedUser)}
        onClose={() => setSelectedUserId(null)}
        title={selectedUser ? selectedUser.username : t('Account detail')}
        description={t('Reset password and status actions are isolated here to reduce accidental operations.')}
      >
        {selectedUser ? (
          <>
            <div className="row gap wrap">
              <Badge tone={roleTone(selectedUser.role)}>{roleLabel(selectedUser.role)}</Badge>
              <StatusTag status={selectedUser.status}>{t(selectedUser.status)}</StatusTag>
              {selectedUser.id === currentUser?.id ? <Badge tone="info">{t('Current session')}</Badge> : null}
            </div>

            <DetailList
              items={[
                { label: t('Created'), value: formatCompactTimestamp(selectedUser.created_at) },
                { label: t('Last updated'), value: formatCompactTimestamp(selectedUser.updated_at) },
                {
                  label: t('Last login'),
                  value: selectedUser.last_login_at ? formatCompactTimestamp(selectedUser.last_login_at) : t('Never')
                },
                {
                  label: t('Disable reason'),
                  value: selectedUser.status_reason || t('n/a')
                }
              ]}
            />

            <SectionCard
              title={t('Reset password')}
              description={t('Set a temporary password, then share securely with the account owner.')}
            >
              <label>
                {t('New temporary password')}
                <Input
                  type="password"
                  value={passwordResetDraft}
                  onChange={(event) => setPasswordResetDraft(event.target.value)}
                />
              </label>
              <ActionBar
                primary={
                  <Button
                    type="button"
                    onClick={() => {
                      void submitPasswordReset(selectedUser);
                    }}
                    disabled={!canSubmitPasswordReset}
                  >
                    {passwordResetBusy ? t('Saving...') : t('Confirm Password Reset')}
                  </Button>
                }
              />
            </SectionCard>

            <SectionCard
              title={t('Status action')}
              description={t('Dangerous account status changes require explicit confirmation.')}
            >
              {selectedUserCannotDisable ? (
                <InlineAlert
                  tone="warning"
                  description={
                    selectedUser.id === currentUser?.id
                      ? t('Current admin session cannot be disabled from this directory.')
                      : t('Last active admin account cannot be disabled.')
                  }
                />
              ) : null}

              {selectedUser.status === 'active' ? (
                <>
                  <label>
                    {t('Disable reason')}
                    <Input
                      value={disableReasonDraft}
                      onChange={(event) => setDisableReasonDraft(event.target.value)}
                      placeholder={t('For example: Access paused during security review.')}
                    />
                  </label>
                  <ActionBar
                    primary={
                      <Button
                        type="button"
                        variant="danger"
                        disabled={selectedUserCannotDisable || !canSubmitDisableReason}
                        onClick={() => requestStatusChange(selectedUser, 'disabled')}
                      >
                        {t('Review disable action')}
                      </Button>
                    }
                  />
                </>
              ) : (
                <ActionBar
                  primary={
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={statusUpdatingBusy}
                      onClick={() => requestStatusChange(selectedUser, 'active')}
                    >
                      {t('Review reactivation')}
                    </Button>
                  }
                />
              )}
            </SectionCard>
          </>
        ) : null}
      </DetailDrawer>

      <ConfirmDangerDialog
        open={Boolean(statusChangeIntent)}
        onClose={() => setStatusChangeIntent(null)}
        title={
          statusChangeIntent?.nextStatus === 'disabled'
            ? t('Disable account')
            : t('Reactivate account')
        }
        description={
          statusChangeIntent
            ? statusChangeIntent.nextStatus === 'disabled'
              ? t(
                  'This will block new logins and terminate active sessions for {username}. Continue?',
                  { username: statusChangeIntent.user.username }
                )
              : t('This will reactivate {username}. Continue?', {
                  username: statusChangeIntent.user.username
                })
            : t('Confirm action')
        }
        confirmLabel={
          statusChangeIntent?.nextStatus === 'disabled' ? t('Confirm disable') : t('Confirm reactivate')
        }
        cancelLabel={t('Cancel')}
        confirmationPhrase={statusChangeIntent?.user.username}
        busy={statusUpdatingBusy}
        onConfirm={() => {
          void confirmStatusChange();
        }}
      />
    </WorkspacePage>
  );
}
