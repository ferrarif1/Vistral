import { Link } from 'react-router-dom';
import { useI18n } from '../i18n/I18nProvider';

export default function DualEntryPage() {
  const { t } = useI18n();

  return (
    <div className="stack page-width">
      <h2>{t('Dual Work Entry')}</h2>
      <p className="muted">
        {t(
          'Choose your primary mode: AI-native conversation for rapid exploration, or professional console for structured operations.'
        )}
      </p>

      <section className="entry-grid">
        <article className="entry-card conversational">
          <h3>{t('AI-Native Conversation Workspace')}</h3>
          <p>
            {t(
              'Start with natural language and draft attachments. Open the attachment tray only when you need files or recent context.'
            )}
          </p>
          <ul className="list plain">
            <li>{t('On-demand attachment tray')}</li>
            <li>{t('Context-aware chat timeline')}</li>
            <li>{t('Fast trial and follow-up loop')}</li>
          </ul>
          <Link to="/workspace/chat" className="entry-cta">
            {t('Enter Conversation Workspace')}
          </Link>
        </article>

        <article className="entry-card console">
          <h3>{t('Professional Console')}</h3>
          <p>
            {t(
              'Operate model lifecycle with a control-plane view: pipeline status, approvals, and key model operations in one place.'
            )}
          </p>
          <ul className="list plain">
            <li>{t('Operational snapshot')}</li>
            <li>{t('Approval queue visibility')}</li>
            <li>{t('Quick jump to model workflows')}</li>
          </ul>
          <Link to="/workspace/console" className="entry-cta secondary">
            {t('Open Professional Console')}
          </Link>
        </article>
      </section>

      <section className="card stack">
        <h3>{t('Bring Your Own LLM Key')}</h3>
        <p className="muted">
          {t(
            'To use your own provider credentials, open LLM Settings and configure base URL, API key, and model.'
          )}
        </p>
        <Link to="/settings" className="quick-link">
          {t('Open LLM Settings')}
        </Link>
      </section>
    </div>
  );
}
