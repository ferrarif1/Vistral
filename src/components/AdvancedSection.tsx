import { useState, type ReactNode } from 'react';

interface AdvancedSectionProps {
  children: ReactNode;
  title?: string;
  description?: string;
}

export default function AdvancedSection({
  children,
  title = 'Advanced Parameters',
  description = 'Collapsed by default for progressive disclosure.'
}: AdvancedSectionProps) {
  const [open, setOpen] = useState(false);

  return (
    <section className="card stack">
      <div className="row between">
        <strong>{title}</strong>
        <button type="button" className="link-btn" onClick={() => setOpen((value) => !value)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      <p className="muted">{description}</p>
      {open ? <div className="stack">{children}</div> : null}
    </section>
  );
}
