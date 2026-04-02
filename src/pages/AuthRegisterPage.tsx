import { useState } from 'react';
import StateBlock from '../components/StateBlock';
import { api } from '../services/api';
import { emitAuthUpdated } from '../services/authSession';

export default function AuthRegisterPage() {
  const [email, setEmail] = useState('new@vistral.dev');
  const [username, setUsername] = useState('newuser');
  const [message, setMessage] = useState('');
  const [variant, setVariant] = useState<'success' | 'error'>('success');

  const submit = async () => {
    setMessage('');
    try {
      const created = await api.register({
        email,
        password: 'mock-pass',
        username
      });
      emitAuthUpdated();
      setVariant('success');
      setMessage(`Registered as ${created.role}. Public registration can only create user accounts.`);
    } catch (error) {
      setVariant('error');
      setMessage((error as Error).message);
    }
  };

  return (
    <div className="stack page-width">
      <h2>Register</h2>
      <section className="card">
        <label>
          Email
          <input value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label>
          Username
          <input value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <button onClick={submit}>Create User Account</button>
      </section>
      {message ? <StateBlock variant={variant} title="Register Result" description={message} /> : null}
    </div>
  );
}
