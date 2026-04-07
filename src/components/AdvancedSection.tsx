import { useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { Button } from './ui/Button';
import { Panel } from './ui/Surface';

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
    <Panel className="stack advanced-panel">
      <div className="row between">
        <strong>{finalTitle}</strong>
        {collapsible ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? t('Hide') : t('Show')}
          </Button>
        ) : null}
      </div>
      <p className="muted">{finalDescription}</p>
      {collapsible ? (open ? <div className="stack">{children}</div> : null) : <div className="stack">{children}</div>}
    </Panel>
  );
}
