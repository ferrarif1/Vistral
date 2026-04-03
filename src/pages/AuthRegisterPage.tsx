import { useState } from 'react';
import StateBlock from '../components/StateBlock';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { emitAuthUpdated } from '../services/authSession';

export default function AuthRegisterPage() {
  const { t, roleLabel } = useI18n();
  const [username, setUsername] = useState('newuser');
  const [password, setPassword] = useState('newpass123');
  const [message, setMessage] = useState('');
  const [variant, setVariant] = useState<'success' | 'error'>('success');

  const submit = async () => {
    setMessage('');
    try {
      const created = await api.register({
        password,
        username
      });
      emitAuthUpdated();
      setVariant('success');
      setMessage(
        t('Registered as {role}. Public registration can only create user accounts.', {
          role: roleLabel(created.role)
        })
      );
    } catch (error) {
      setVariant('error');
      setMessage((error as Error).message);
    }
  };

  return (
    <div className="stack page-width">
      <h2>{t('Register')}</h2>
      <section className="card">
        <label>
          {t('Username')}
          <input value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label>
          {t('Password')}
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button onClick={submit}>{t('Create User Account')}</button>
      </section>
      {message ? <StateBlock variant={variant} title={t('Register Result')} description={message} /> : null}
    </div>
  );
}
