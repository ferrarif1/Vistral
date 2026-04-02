import { Link } from 'react-router-dom';

export default function DualEntryPage() {
  return (
    <div className="stack page-width">
      <h2>Dual Work Entry</h2>
      <p className="muted">
        Choose your primary mode: AI-native conversation for rapid exploration, or professional console
        for structured operations.
      </p>

      <section className="entry-grid">
        <article className="entry-card conversational">
          <h3>AI-Native Conversation Workspace</h3>
          <p>
            Start with natural language and attachments. Keep context visible while iterating with mock
            model responses.
          </p>
          <ul className="list plain">
            <li>Persistent attachment panel</li>
            <li>Context-aware chat timeline</li>
            <li>Fast trial and follow-up loop</li>
          </ul>
          <Link to="/workspace/chat" className="entry-cta">
            Enter Conversation Workspace
          </Link>
        </article>

        <article className="entry-card console">
          <h3>Professional Console</h3>
          <p>
            Operate model lifecycle with a control-plane view: pipeline status, approvals, and key model
            operations in one place.
          </p>
          <ul className="list plain">
            <li>Operational snapshot</li>
            <li>Approval queue visibility</li>
            <li>Quick jump to model workflows</li>
          </ul>
          <Link to="/workspace/console" className="entry-cta secondary">
            Open Professional Console
          </Link>
        </article>
      </section>

      <section className="card stack">
        <h3>Bring Your Own LLM Key</h3>
        <p className="muted">
          To use your own provider credentials, open LLM Settings and configure base URL, API key, and
          model.
        </p>
        <Link to="/settings/llm" className="quick-link">
          Open LLM Settings
        </Link>
      </section>
    </div>
  );
}
