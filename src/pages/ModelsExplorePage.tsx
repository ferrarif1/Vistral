import { useEffect, useState } from 'react';
import { api } from '../services/api';
import type { ModelRecord } from '../types/domain';

export default function ModelsExplorePage() {
  const [models, setModels] = useState<ModelRecord[]>([]);

  useEffect(() => {
    api.listModels().then(setModels);
  }, []);

  return (
    <div className="stack">
      <h2>Model List</h2>
      <ul className="list">
        {models.map((m) => (
          <li key={m.id} className="card">
            <h4>{m.name}</h4>
            <p>{m.description}</p>
            <small>{m.visibility} · {m.status}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}
