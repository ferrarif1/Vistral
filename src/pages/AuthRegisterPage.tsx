import { useState } from 'react';
import { api } from '../services/api';
import StateBlock from '../components/StateBlock';

export default function AuthRegisterPage() {
  const [email, setEmail] = useState('new@vistral.dev');
  const [username, setUsername] = useState('newuser');
  const [message, setMessage] = useState('');

  const submit = async () => {
    try {
      const created = await api.register({ email, password: 'mock-pass', username, role: 'admin' });
      setMessage(`Registered as ${created.role}`);
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  return (
    <div className="stack">
      <h2>Register</h2>
      <section className="card">
        <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} /></label>
        <button onClick={submit}>Register</button>
      </section>
      {message ? <StateBlock variant="success" title="Register Result" description={message} /> : null}
    </div>
  );
}
