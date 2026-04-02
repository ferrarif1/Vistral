import { useEffect, useState } from 'react';
import { api } from '../services/api';
import type { AttachmentItem } from '../types/domain';
import StatusBadge from './StatusBadge';

export default function AttachmentUploader() {
  const [items, setItems] = useState<AttachmentItem[]>([]);
  const [filename, setFilename] = useState('example-image.png');

  const refresh = async () => setItems(await api.listAttachments());

  useEffect(() => {
    refresh();
  }, []);

  const upload = async () => {
    await api.uploadAttachment(filename || `file-${Date.now()}.bin`);
    await refresh();
  };

  const remove = async (id: string) => {
    await api.removeAttachment(id);
    await refresh();
  };

  return (
    <section className="card">
      <h3>Attachments</h3>
      <div className="row gap">
        <input value={filename} onChange={(e) => setFilename(e.target.value)} />
        <button onClick={upload}>Upload</button>
      </div>
      <ul className="list">
        {items.map((item) => (
          <li key={item.id} className="list-item">
            <div>
              <strong>{item.filename}</strong>
              <StatusBadge status={item.status} />
            </div>
            <button onClick={() => remove(item.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
