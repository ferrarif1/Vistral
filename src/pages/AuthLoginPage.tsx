import { useState } from 'react';
import StateBlock from '../components/StateBlock';
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
    <div className="stack page-width">
      <h2>{t('Login')}</h2>
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
        <button onClick={submit}>{t('Login')}</button>
      </section>
      {message ? <StateBlock variant={variant} title={t('Login Result')} description={message} /> : null}
    </div>
  );
}
