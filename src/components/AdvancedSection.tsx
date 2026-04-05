import { useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider';

interface AdvancedSectionProps {
  children: ReactNode;
  title?: string;
  description?: string;
  defaultOpen?: boolean;
  collapsible?: boolean;
}

export default function AdvancedSection({
  children,
  title,
  description,
  defaultOpen = false,
  collapsible = true
}: AdvancedSectionProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  const finalTitle = title ?? t('Advanced Parameters');
  const finalDescription = description ?? t('Collapsed by default for progressive disclosure.');

  return (
    <section className="card stack">
      <div className="row between">
        <strong>{finalTitle}</strong>
        {collapsible ? (
          <button type="button" className="link-btn" onClick={() => setOpen((value) => !value)}>
            {open ? t('Hide') : t('Show')}
          </button>
        ) : null}
      </div>
      <p className="muted">{finalDescription}</p>
      {collapsible ? (open ? <div className="stack">{children}</div> : null) : <div className="stack">{children}</div>}
    </section>
  );
}
