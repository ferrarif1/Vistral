import { useState, type ReactNode } from 'react';

export default function AdvancedSection({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="card">
      <button type="button" className="link-btn" onClick={() => setOpen((v) => !v)}>
        Advanced Parameters ({open ? 'Hide' : 'Show'})
      </button>
      {open ? <div className="advanced-content">{children}</div> : null}
    </section>
  );
}
