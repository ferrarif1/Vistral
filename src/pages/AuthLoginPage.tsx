import { useState } from 'react';
import StateBlock from '../components/StateBlock';
import Button from '../components/ui/Button';
import { Input } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import { PageHeader } from '../components/ui/ConsolePage';
import {
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceSplit
} from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { emitAuthUpdated } from '../services/authSession';

export default function AuthLoginPage() {
  const { t, roleLabel } = useI18n();
  const [username, setUsername] = useState('alice');
  const [password, setPassword] = useState('mock-pass');
  const [message, setMessage] = useState('');
  const [variant, setVariant] = useState<'success' | 'error'>('success');

  const submit = async () => {
    setMessage('');
    try {
      const user = await api.login({ username, password });
      emitAuthUpdated();
      setVariant('success');
      setMessage(t('Logged in as {username} ({role}).', { username: user.username, role: roleLabel(user.role) }));
    } catch (error) {
      setVariant('error');
      setMessage((error as Error).message);
    }
  };

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Account Access')}
        title={t('Login')}
        description={t('Enter your provisioned account to reopen chat history, settings, and workflow actions.')}
        meta={
          <div className="row gap wrap align-center">
            <span className="muted">{t('Access mode')}: {t('Username + password')}</span>
            <span className="muted">{t('Provisioning')}: {t('Administrator only')}</span>
          </div>
        }
        primaryAction={{
          label: t('Login'),
          onClick: submit
        }}
      />

      <WorkspaceSplit
        main={
          <>
            <Card className="stack">
              <WorkspaceSectionHeader
                title={t('Sign in with a provisioned account')}
                description={t('Your saved chat history, settings, and governed actions return after sign-in.')}
              />
              <label>
                {t('Username')}
                <Input value={username} onChange={(event) => setUsername(event.target.value)} />
              </label>
              <label>
                {t('Password')}
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <Button onClick={submit} block>
                {t('Login')}
              </Button>
            </Card>
            {message ? <StateBlock variant={variant} title={t('Login Result')} description={message} /> : null}
          </>
        }
        side={
          <>
            <Panel className="stack tight">
              <h3>{t('Account Provisioning')}</h3>
              <small className="muted">
                {t('Need access for the first time? Ask an administrator to provision your account.')}
              </small>
            </Panel>
            <Panel className="stack tight">
              <h3>{t('What you unlock after sign-in')}</h3>
              <small className="muted">
                {t('Conversation history, workspace settings, dataset actions, and training flows all resume from the same account context.')}
              </small>
            </Panel>
          </>
        }
      />
    </WorkspacePage>
  );
}
