import type { Conversation } from "../shared/conversation";
import {
  conversationTitle,
  formatConversationTime,
} from "./conversation-state";
import { texts } from "./texts";

type ConversationListProps = {
  readonly conversations: readonly Conversation[];
  readonly selectedConversationId: string | null;
  readonly isLoading: boolean;
  readonly isLoadingMore: boolean;
  readonly isCreating: boolean;
  readonly error: string | null;
  readonly createError: string | null;
  readonly hasMore: boolean;
  readonly onSelect: (conversationId: string) => void;
  readonly onCreate: () => void;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
};

export function ConversationList({
  conversations,
  selectedConversationId,
  isLoading,
  isLoadingMore,
  isCreating,
  error,
  createError,
  hasMore,
  onSelect,
  onCreate,
  onLoadMore,
  onRetry,
}: ConversationListProps) {
  const isBusy = isLoading || isLoadingMore || isCreating;

  return (
    <section
      className="panel conversation-list-panel"
      aria-labelledby="conversations-heading"
      aria-busy={isBusy}
    >
      <div className="conversation-list-head">
        <h2 className="panel-heading" id="conversations-heading">
          {texts.conversations.listHeading}
        </h2>
        <button
          className="button button-primary"
          type="button"
          onClick={onCreate}
          disabled={isCreating}
        >
          {isCreating
            ? texts.conversations.creating
            : texts.conversations.newConversation}
        </button>
      </div>

      {createError === null ? null : (
        <p className="form-error" role="alert">
          {createError}
        </p>
      )}

      {isLoading && conversations.length === 0 ? (
        <p className="panel-note" role="status" aria-live="polite">
          {texts.conversations.loading}
        </p>
      ) : null}

      {error === null ? null : (
        <>
          <p className="form-error" role="alert">
            {error}
          </p>
          <button
            className="button"
            type="button"
            onClick={onRetry}
            disabled={isBusy}
          >
            {texts.conversations.retry}
          </button>
        </>
      )}

      {!isLoading && error === null && conversations.length === 0 ? (
        <p className="panel-note">{texts.conversations.empty}</p>
      ) : null}

      {conversations.length === 0 ? null : (
        <ol
          className="conversation-list"
          aria-label={texts.conversations.listLabel}
        >
          {conversations.map((conversation) => {
            const isSelected = conversation.id === selectedConversationId;

            return (
              <li key={conversation.id}>
                <button
                  className="conversation-item"
                  type="button"
                  onClick={() => onSelect(conversation.id)}
                  aria-current={isSelected ? "true" : undefined}
                  data-selected={isSelected}
                >
                  <span className="conversation-title">
                    {conversationTitle(conversation)}
                  </span>
                  <time
                    className="conversation-time"
                    dateTime={conversation.updatedAt}
                  >
                    {formatConversationTime(conversation.updatedAt)}
                  </time>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {hasMore ? (
        <button
          className="button"
          type="button"
          onClick={onLoadMore}
          disabled={isBusy}
        >
          {isLoadingMore
            ? texts.conversations.loadingMore
            : texts.conversations.loadMore}
        </button>
      ) : null}
    </section>
  );
}
