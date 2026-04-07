import type { ReactNode } from 'react';

interface ChatInputProps {
  className?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
}

interface AttachmentChipProps {
  className?: string;
  label: string;
  title?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  status?: ReactNode;
  onOpen?: () => void;
  disabled?: boolean;
}

interface MessageBubbleProps {
  className?: string;
  sender?: 'user' | 'assistant' | 'system';
  children: ReactNode;
}

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export function ChatInput({ className, leading, trailing, meta, children }: ChatInputProps) {
  return (
    <section className={joinClasses('ui-chat-input', className)}>
      <div className="ui-chat-input-row">
        {leading ? <div className="ui-chat-input-leading">{leading}</div> : null}
        <div className="ui-chat-input-field">{children}</div>
        {trailing ? <div className="ui-chat-input-trailing">{trailing}</div> : null}
      </div>
      {meta ? <div className="ui-chat-input-meta">{meta}</div> : null}
    </section>
  );
}

export function AttachmentChip({
  className,
  label,
  title,
  leading,
  trailing,
  status,
  onOpen,
  disabled = false
}: AttachmentChipProps) {
  const body = onOpen ? (
    <button
      type="button"
      className="ui-attachment-chip-main"
      onClick={onOpen}
      disabled={disabled}
      title={title ?? label}
    >
      {leading ? <span className="ui-attachment-chip-leading">{leading}</span> : null}
      <span className="ui-attachment-chip-label">{label}</span>
    </button>
  ) : (
    <span className="ui-attachment-chip-main" title={title ?? label}>
      {leading ? <span className="ui-attachment-chip-leading">{leading}</span> : null}
      <span className="ui-attachment-chip-label">{label}</span>
    </span>
  );

  return (
    <div className={joinClasses('ui-attachment-chip', className)}>
      {body}
      {status ? <span className="ui-attachment-chip-status">{status}</span> : null}
      {trailing ? <span className="ui-attachment-chip-trailing">{trailing}</span> : null}
    </div>
  );
}

export function MessageBubble({ className, sender = 'assistant', children }: MessageBubbleProps) {
  return <div className={joinClasses('ui-message-bubble', `ui-message-bubble--${sender}`, className)}>{children}</div>;
}
