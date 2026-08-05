import type { SessionMessageView } from "../session-reducer";

export interface ChatTranscriptProps {
  messages: SessionMessageView[];
  activity: string | null;
}

/**
 * Streaming chat transcript. Each message is a stable row keyed by the
 * reducer's message key; streaming text updates in place, never re-renders as
 * new rows.
 */
export function ChatTranscript({ messages, activity }: ChatTranscriptProps) {
  return (
    <div className="chat-transcript" aria-label="Conversation">
      {messages.length === 0 && (
        <p className="chat-transcript__empty">No messages yet. Describe the paper you want to write.</p>
      )}
      <ul className="chat-transcript__list">
        {messages.map((message) => (
          <li key={message.key} className={`chat-message chat-message--${message.role}`}>
            <span className="chat-message__role">{message.role}</span>
            <span className={`chat-message__text${message.streaming ? " is-streaming" : ""}${message.error ? " is-error" : ""}`}>
              {message.text}
              {message.streaming && <span className="chat-message__caret" aria-hidden />}
            </span>
          </li>
        ))}
      </ul>
      {activity && <p className="chat-transcript__activity">{activity}</p>}
    </div>
  );
}
