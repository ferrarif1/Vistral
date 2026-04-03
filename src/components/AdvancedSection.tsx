import { useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider';

interface AdvancedSectionProps {
  children: ReactNode;
  title?: string;
  description?: string;
}

export default function AdvancedSection({
  children,
  title,
  description
}: AdvancedSectionProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const finalTitle = title ?? t('Advanced Parameters');
  const finalDescription = description ?? t('Collapsed by default for progressive disclosure.');

  return (
    <section className="card stack">
      <div className="row between">
        <strong>{finalTitle}</strong>
        <button type="button" className="link-btn" onClick={() => setOpen((value) => !value)}>
          {open ? t('Hide') : t('Show')}
        </button>
      </div>
      <p className="muted">{finalDescription}</p>
      {open ? <div className="stack">{children}</div> : null}
    </section>
  );
}
