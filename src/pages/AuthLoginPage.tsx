import { useState } from 'react';
import StateBlock from '../components/StateBlock';
import { api } from '../services/api';
import { emitAuthUpdated } from '../services/authSession';

export default function AuthLoginPage() {
  const [email, setEmail] = useState('user@vistral.dev');
  const [message, setMessage] = useState('');
  const [variant, setVariant] = useState<'success' | 'error'>('success');

  const submit = async () => {
    setMessage('');
    try {
      const user = await api.login({ email, password: 'mock-pass' });
      emitAuthUpdated();
      setVariant('success');
      setMessage(`Logged in as ${user.username} (${user.role}).`);
    } catch (error) {
      setVariant('error');
      setMessage((error as Error).message);
    }
  };

  return (
    <div className="stack page-width">
      <h2>Login</h2>
      <section className="card">
        <label>
          Email
          <input value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <button onClick={submit}>Login</button>
      </section>
      {message ? <StateBlock variant={variant} title="Login Result" description={message} /> : null}
    </div>
  );
}
