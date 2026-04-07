import { useState } from 'react';
import StateBlock from '../components/StateBlock';
import Button from '../components/ui/Button';
import { Input } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
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
    <div className="workspace-overview-page stack">
      <Card className="workspace-overview-hero">
        <div className="workspace-overview-hero-grid">
          <div className="workspace-overview-copy stack tight">
            <small className="workspace-eyebrow">{t('Account Access')}</small>
            <h1>{t('Login')}</h1>
            <p className="muted">
              {t('Enter your provisioned account to reopen chat history, settings, and workflow actions.')}
            </p>
          </div>
          <div className="workspace-overview-badges">
            <div className="workspace-overview-badge">
              <span>{t('Conversation Workspace')}</span>
              <strong>{t('Login')}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Settings')}</span>
              <strong>{t('Account')}</strong>
            </div>
          </div>
        </div>
      </Card>

      <section className="workspace-overview-panel-grid">
        <div className="workspace-overview-main">
          <Card className="stack">
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
        </div>

        <div className="workspace-overview-side">
          <Panel className="stack tight">
            <h3>{t('Account Provisioning')}</h3>
            <small className="muted">
              {t('Need access for the first time? Ask an administrator to provision your account.')}
            </small>
          </Panel>
        </div>
      </section>
    </div>
  );
}
