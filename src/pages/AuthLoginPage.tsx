import { useState } from 'react';
import { api } from '../services/api';
import StateBlock from '../components/StateBlock';

export default function AuthLoginPage() {
  const [email, setEmail] = useState('user@vistral.dev');
  const [message, setMessage] = useState('');

  const submit = async () => {
    const user = await api.login({ email, password: 'mock-pass' });
    setMessage(`Logged in as ${user.username} (${user.role})`);
  };

  return (
    <div className="stack">
      <h2>Login</h2>
      <section className="card">
        <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <button onClick={submit}>Login</button>
      </section>
      {message ? <StateBlock variant="success" title="Login Result" description={message} /> : null}
    </div>
  );
}
