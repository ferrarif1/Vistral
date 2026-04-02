import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ConversationRecord,
  FileAttachment,
  MessageRecord,
  ModelRecord
} from '../../shared/domain';
import AttachmentUploader from '../components/AttachmentUploader';
import StateBlock from '../components/StateBlock';
import { api } from '../services/api';

export default function ConversationPage() {
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [conversation, setConversation] = useState<ConversationRecord | null>(null);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [input, setInput] = useState('Please summarize the attached files.');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const refreshAttachments = useCallback(async () => {
    const result = await api.listConversationAttachments();
    setAttachments(result);
  }, []);

  useEffect(() => {
    setLoading(true);

    Promise.all([api.listModels(), refreshAttachments()])
      .then(([modelResults]) => {
        setModels(modelResults);
        if (modelResults.length > 0) {
          setSelectedModelId(modelResults[0].id);
        }
        setError('');
      })
      .catch((loadError) => setError((loadError as Error).message))
      .finally(() => setLoading(false));
  }, [refreshAttachments]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      refreshAttachments().catch(() => {
        // Keep UI stable in polling loop; explicit errors are reported by direct actions.
      });
    }, 500);

    return () => window.clearInterval(timer);
  }, [refreshAttachments]);

  const readyAttachmentIds = useMemo(
    () => attachments.filter((item) => item.status === 'ready').map((item) => item.id),
    [attachments]
  );

  const onUpload = async (filename: string) => {
    await api.uploadConversationAttachment(filename);
    await refreshAttachments();
  };

  const onDelete = async (attachmentId: string) => {
    await api.removeAttachment(attachmentId);
    await refreshAttachments();
  };

  const send = async () => {
    if (!input.trim()) {
      return;
    }

    setSending(true);
    setError('');

    try {
      if (!conversation) {
        const modelId = selectedModelId || models[0]?.id;
        if (!modelId) {
          throw new Error('No available model found for this account.');
        }

        const started = await api.startConversation({
          model_id: modelId,
          initial_message: input.trim(),
          attachment_ids: readyAttachmentIds
        });

        setConversation(started.conversation);
        setMessages(started.messages);
      } else {
        const response = await api.sendConversationMessage({
          conversation_id: conversation.id,
          content: input.trim(),
          attachment_ids: readyAttachmentIds
        });

        setMessages(response.messages);
      }

      setInput('');
    } catch (sendError) {
      setError((sendError as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="stack">
      <h2>Conversation Workspace</h2>
      <p className="muted">
        Mock loop: upload files -&gt; send message -&gt; receive assistant response.
      </p>

      {loading ? (
        <StateBlock
          variant="loading"
          title="Preparing Workspace"
          description="Loading models and attachment context."
        />
      ) : null}

      {error ? <StateBlock variant="error" title="Conversation Error" description={error} /> : null}

      {!loading && !error && models.length === 0 ? (
        <StateBlock
          variant="empty"
          title="No Available Models"
          description="No model is visible for this account. Publish or authorize one first."
        />
      ) : null}

      {!loading && models.length > 0 ? (
        <section className="workspace-grid">
          <div className="stack">
            <section className="card stack">
              <label>
                Active Model
                <select
                  value={selectedModelId}
                  onChange={(event) => setSelectedModelId(event.target.value)}
                  disabled={sending || Boolean(conversation)}
                >
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name} ({model.status})
                    </option>
                  ))}
                </select>
              </label>
              <small className="muted">
                Ready attachments in context: {readyAttachmentIds.length}. Conversation
                {conversation ? ` ${conversation.id}` : ' not started yet'}.
              </small>
            </section>

            <section className="card stack">
              <h3>Timeline</h3>
              {messages.length === 0 ? (
                <StateBlock
                  variant="empty"
                  title="No Messages Yet"
                  description="Upload optional files, then send your first message."
                />
              ) : (
                <ul className="list">
                  {messages.map((message) => (
                    <li key={message.id} className={`message-bubble ${message.sender}`}>
                      <div className="row between">
                        <strong>{message.sender}</strong>
                        <small>{new Date(message.created_at).toLocaleTimeString()}</small>
                      </div>
                      <p>{message.content}</p>
                      {message.attachment_ids.length > 0 ? (
                        <small className="muted">
                          Attachments: {message.attachment_ids.join(', ')}
                        </small>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card stack">
              <label>
                Message
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  rows={4}
                  placeholder="Ask the model about your uploaded files"
                />
              </label>
              <button onClick={send} disabled={sending}>
                {sending ? 'Sending...' : conversation ? 'Send Message' : 'Start Conversation'}
              </button>
            </section>
          </div>

          <AttachmentUploader
            title="Conversation Attachments"
            items={attachments}
            onUpload={onUpload}
            onDelete={onDelete}
            emptyDescription="Uploaded files will stay visible here for the full conversation context."
            uploadButtonLabel="Upload to Conversation"
            disabled={sending}
          />
        </section>
      ) : null}
    </div>
  );
}
