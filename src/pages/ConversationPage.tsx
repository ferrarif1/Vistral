import AttachmentUploader from '../components/AttachmentUploader';
import StateBlock from '../components/StateBlock';

export default function ConversationPage() {
  return (
    <div className="stack">
      <h2>Conversation Workspace</h2>
      <StateBlock variant="success" title="Mock Ready" description="Conversation skeleton is ready for first-round development." />
      <section className="card">
        <h3>Chat Skeleton</h3>
        <p>Input + timeline placeholder. Real model inference will be wired in next rounds.</p>
      </section>
      <AttachmentUploader />
    </div>
  );
}
