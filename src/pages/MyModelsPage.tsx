import { useEffect, useState } from 'react';
import { api } from '../services/api';
import type { ModelRecord } from '../types/domain';

export default function MyModelsPage() {
  const [models, setModels] = useState<ModelRecord[]>([]);

  useEffect(() => {
    api.listMyModels().then(setModels);
  }, []);

  return (
    <div className="stack">
      <h2>My Models</h2>
      <p>Ownership-based result set.</p>
      <ul className="list">
        {models.map((m) => (
          <li key={m.id} className="card">
            <strong>{m.name}</strong>
            <p>{m.description}</p>
            <small>owner_user_id: {m.owner_user_id}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}
