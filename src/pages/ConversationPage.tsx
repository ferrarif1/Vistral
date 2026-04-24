import {
  startTransition,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ChangeEvent as ReactChangeEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
  type TouchEvent as ReactTouchEvent,
  type UIEvent as ReactUIEvent
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type {
  ConversationActionMetadata,
  ConversationRecord,
  FileAttachment,
  LlmConfigView,
  MessageRecord,
  ModelRecord,
  User
} from '../../shared/domain';
import {
  UPLOAD_SOFT_LIMIT_LABEL,
  findOversizedUpload,
  formatByteSize
} from '../../shared/uploadLimits';
import SessionMenu from '../components/SessionMenu';
import AdvancedSection from '../components/AdvancedSection';
import { useI18n } from '../i18n/I18nProvider';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import useCompactViewport from '../hooks/useCompactViewport';
import StateBlock from '../components/StateBlock';
import StatusBadge from '../components/StatusBadge';
import VirtualList from '../components/VirtualList';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { AttachmentChip, ChatInput, MessageBubble } from '../components/ui/Chat';
import { HiddenFileInput, Input, Select, Textarea } from '../components/ui/Field';
import { api } from '../services/api';
import { AUTH_UPDATED_EVENT, emitAuthUpdated } from '../services/authSession';
import { LLM_CONFIG_UPDATED_EVENT } from '../services/llmConfig';
import {
  buildConversationActionNextStepInput,
  deriveConversationActionNextSteps,
  type ConversationActionNextStep
} from '../features/conversationActionNextSteps';
import { isFallbackExecutionSource } from '../utils/inferenceSource';
import { resolveRegistrationEvidenceLevel, resolveRegistrationGateLevel } from '../utils/registrationEvidence';

interface LocalChatHistoryItem {
  id: string;
  title: string;
  updated_at: string;
  pinned: boolean;
}

interface HistoryContextMenuState {
  id: string;
  x: number;
  y: number;
}

type HistoryContextMenuAction = 'rename' | 'pin' | 'delete';
interface AttachmentStatusSummary {
  uploading: number;
  processing: number;
  ready: number;
  error: number;
}

const historyStorageKey = 'vistral-conversation-history';
const hiddenHistoryStorageKey = 'vistral-hidden-conversations';
const pinnedOrderStorageKey = 'vistral-pinned-history-order';
const sidebarCollapsedStorageKey = 'vistral-chat-sidebar-collapsed';
const backgroundRefreshIntervalMs = 5000;
const historyVirtualItemHeight = 44;
const historyVirtualOverscan = 6;
const historyVirtualMinCount = 20;
const messageRenderBatchSize = 40;
const attachmentTrayVirtualizationThreshold = 24;
const attachmentTrayVirtualRowHeight = 48;
const attachmentTrayVirtualViewportHeight = 156;

const readHistoryFromStorage = (): LocalChatHistoryItem[] => {
  try {
    const raw = localStorage.getItem(historyStorageKey);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as LocalChatHistoryItem[];
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string')
      .map((item) => ({
        id: item.id,
        title: item.title,
        updated_at: typeof item.updated_at === 'string' ? item.updated_at : new Date().toISOString(),
        pinned: Boolean(item.pinned)
      }))
      .slice(0, 40);
  } catch {
    return [];
  }
};

const writeHistoryToStorage = (items: LocalChatHistoryItem[]) => {
  try {
    localStorage.setItem(historyStorageKey, JSON.stringify(items.slice(0, 40)));
  } catch {
    // Ignore storage errors in local client mode.
  }
};

const normalizeHiddenConversationIds = (ids: string[]): string[] =>
  Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.trim().length > 0))).slice(0, 200);

const readHiddenConversationIdsFromStorage = (): string[] => {
  try {
    const raw = localStorage.getItem(hiddenHistoryStorageKey);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as string[];
    if (!Array.isArray(parsed)) {
      return [];
    }

    return normalizeHiddenConversationIds(parsed);
  } catch {
    return [];
  }
};

const writeHiddenConversationIdsToStorage = (ids: string[]) => {
  try {
    localStorage.setItem(hiddenHistoryStorageKey, JSON.stringify(normalizeHiddenConversationIds(ids)));
  } catch {
    // Ignore storage errors in local client mode.
  }
};

const readPinnedHistoryOrderFromStorage = (): string[] => {
  try {
    const raw = localStorage.getItem(pinnedOrderStorageKey);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as string[];
    if (!Array.isArray(parsed)) {
      return [];
    }

    return Array.from(
      new Set(parsed.filter((item) => typeof item === 'string' && item.trim().length > 0))
    ).slice(0, 200);
  } catch {
    return [];
  }
};

const writePinnedHistoryOrderToStorage = (ids: string[]) => {
  try {
    const unique = Array.from(
      new Set(ids.filter((item) => typeof item === 'string' && item.trim().length > 0))
    ).slice(0, 200);
    localStorage.setItem(pinnedOrderStorageKey, JSON.stringify(unique));
  } catch {
    // Ignore storage errors in local client mode.
  }
};

const readSidebarCollapsedFromStorage = (): boolean => {
  try {
    return localStorage.getItem(sidebarCollapsedStorageKey) === 'true';
  } catch {
    return false;
  }
};

const writeSidebarCollapsedToStorage = (collapsed: boolean) => {
  try {
    localStorage.setItem(sidebarCollapsedStorageKey, String(collapsed));
  } catch {
    // Ignore storage errors in local client mode.
  }
};

const arraysEqual = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const buildConversationAttachmentsSignature = (items: FileAttachment[]): string =>
  JSON.stringify(
    [...items]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => ({
        id: item.id,
        filename: item.filename,
        status: item.status,
        updated_at: item.updated_at,
        upload_error: item.upload_error,
        attached_to_type: item.attached_to_type,
        attached_to_id: item.attached_to_id
      }))
  );

const getPinnedOrderIndex = (id: string, pinnedOrder: string[]): number => {
  const index = pinnedOrder.indexOf(id);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
};

const reconcilePinnedHistoryOrder = (
  items: LocalChatHistoryItem[],
  pinnedOrder: string[]
): string[] => {
  const pinnedIds = items.filter((item) => item.pinned).map((item) => item.id);
  const pinnedSet = new Set(pinnedIds);
  const keptOrder = pinnedOrder.filter((id) => pinnedSet.has(id));
  const missing = pinnedIds.filter((id) => !keptOrder.includes(id));
  return [...keptOrder, ...missing];
};

const reorderPinnedHistoryOrder = (
  currentOrder: string[],
  draggedId: string,
  targetId: string
): string[] => {
  if (draggedId === targetId) {
    return currentOrder;
  }

  const sourceIndex = currentOrder.indexOf(draggedId);
  const targetIndex = currentOrder.indexOf(targetId);
  if (sourceIndex === -1 || targetIndex === -1) {
    return currentOrder;
  }

  const next = [...currentOrder];
  const [dragged] = next.splice(sourceIndex, 1);
  if (!dragged) {
    return currentOrder;
  }

  next.splice(targetIndex, 0, dragged);
  return next;
};

const reorderSelectedAttachmentOrder = (
  currentOrder: string[],
  draggedId: string,
  targetId: string
): string[] => {
  if (draggedId === targetId) {
    return currentOrder;
  }

  const sourceIndex = currentOrder.indexOf(draggedId);
  const targetIndex = currentOrder.indexOf(targetId);
  if (sourceIndex === -1 || targetIndex === -1) {
    return currentOrder;
  }

  const next = [...currentOrder];
  const [dragged] = next.splice(sourceIndex, 1);
  if (!dragged) {
    return currentOrder;
  }

  next.splice(targetIndex, 0, dragged);
  return next;
};

const sortHistoryItems = (items: LocalChatHistoryItem[], pinnedOrder: string[]): LocalChatHistoryItem[] => {
  const next = [...items];
  next.sort((a, b) => {
    const pinnedDelta = Number(b.pinned) - Number(a.pinned);
    if (pinnedDelta !== 0) {
      return pinnedDelta;
    }

    if (a.pinned && b.pinned) {
      const aPinnedOrderIndex = getPinnedOrderIndex(a.id, pinnedOrder);
      const bPinnedOrderIndex = getPinnedOrderIndex(b.id, pinnedOrder);
      if (aPinnedOrderIndex !== bPinnedOrderIndex) {
        return aPinnedOrderIndex - bPinnedOrderIndex;
      }
    }

    const aTime = Date.parse(a.updated_at);
    const bTime = Date.parse(b.updated_at);
    return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
  });
  return next;
};

const mergeHistoryWithConversations = (
  conversations: ConversationRecord[],
  previous: LocalChatHistoryItem[],
  hiddenConversationIds: string[],
  pinnedOrder: string[]
): LocalChatHistoryItem[] => {
  const hiddenIdSet = new Set(hiddenConversationIds);
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const conversationIdSet = new Set(conversations.map((item) => item.id));

  const serverItems = conversations
    .filter((item) => !hiddenIdSet.has(item.id))
    .map((item) => {
      const existing = previousById.get(item.id);
      return {
        id: item.id,
        title: item.title || existing?.title || '新建会话',
        updated_at: item.updated_at || item.created_at,
        pinned: existing?.pinned ?? false
      };
    });

  const localOnlyItems = previous.filter(
    (item) => !conversationIdSet.has(item.id) && !hiddenIdSet.has(item.id)
  );

  return sortHistoryItems([...serverItems, ...localOnlyItems], pinnedOrder).slice(0, 40);
};

const buildHistoryTitle = (message: string): string => {
  const trimmed = message.trim();
  if (!trimmed) {
    return '新建会话';
  }
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}...` : trimmed;
};

const getInitials = (username?: string): string => {
  if (!username) {
    return 'U';
  }

  return username.slice(0, 2).toUpperCase();
};

const triggerHapticFeedback = (): void => {
  if (typeof navigator === 'undefined') {
    return;
  }

  if ('vibrate' in navigator && typeof navigator.vibrate === 'function') {
    navigator.vibrate(10);
  }
};

const copyToClipboard = async (content: string): Promise<boolean> => {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(content);
      return true;
    }
  } catch {
    // fallback below
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = content;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'absolute';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
};

const formatMessageParagraphs = (content: string): string[] =>
  content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const formatMessageTime = (value: string): string => {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(parsed));
};

const hasChineseText = (value: string): boolean => /[\u4e00-\u9fff]/.test(value);

const actionRouteByEntityType: Record<'Dataset' | 'TrainingJob' | 'Model' | 'VisionTask', string> = {
  Dataset: '/datasets',
  TrainingJob: '/training/jobs',
  Model: '/models/my-models',
  VisionTask: '/vision/tasks'
};

const appendReturnToPath = (base: string, returnTo?: string | null): string => {
  const normalized = returnTo?.trim() ?? '';
  if (
    !normalized ||
    !normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    normalized.includes('://')
  ) {
    return base;
  }
  const [pathname, query = ''] = base.split('?');
  const searchParams = new URLSearchParams(query);
  if (!searchParams.has('return_to')) {
    searchParams.set('return_to', normalized);
  }
  const nextQuery = searchParams.toString();
  return nextQuery ? `${pathname}?${nextQuery}` : pathname;
};

const buildLoginPath = (returnTo?: string | null): string => {
  return appendReturnToPath('/auth/login', returnTo);
};

const datasetIdPattern = /\((d-\d+)\)$/i;
const isAuthenticationRequiredMessage = (message: string): boolean => message === 'Authentication required.';
const isConversationMissingError = (error: unknown): boolean => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return /conversation not found|会话.*不存在|not found/i.test(message);
};
type TranslateFn = (source: string, vars?: Record<string, string | number>) => string;

interface ConversationHistoryItemRowProps {
  item: LocalChatHistoryItem;
  isActive: boolean;
  isPinnedItem: boolean;
  isDragging: boolean;
  isDragOver: boolean;
  isLongPressing: boolean;
  isMenuOpen: boolean;
  isEditing: boolean;
  editingConversationTitle: string;
  isRenaming: boolean;
  isRestoring: boolean;
  t: TranslateFn;
  renderConversationTitle: (title: string) => string;
  setEditingConversationTitle: Dispatch<SetStateAction<string>>;
  requestSaveConversationTitle: (conversationId: string) => void;
  onCancelRenameConversation: () => void;
  requestRestoreConversation: (conversationId: string) => void;
  consumeHistoryLongPressTrigger: () => boolean;
  onHistoryItemKeyDown: (event: ReactKeyboardEvent<HTMLElement>, itemId: string) => void;
  onOpenHistoryContextMenu: (event: ReactMouseEvent<HTMLLIElement>, itemId: string) => void;
  onOpenHistoryContextMenuFromButton: (
    event: ReactMouseEvent<HTMLButtonElement>,
    itemId: string
  ) => void;
  onHistoryItemTouchStart: (event: ReactTouchEvent<HTMLLIElement>, itemId: string) => void;
  onHistoryItemTouchMove: () => void;
  onHistoryItemTouchEnd: () => void;
  onHistoryItemTouchCancel: () => void;
  onPinnedDragStart: (event: ReactDragEvent<HTMLLIElement>, itemId: string) => void;
  onPinnedDragOver: (event: ReactDragEvent<HTMLLIElement>, itemId: string) => void;
  onPinnedDrop: (event: ReactDragEvent<HTMLLIElement>, itemId: string) => void;
  onPinnedDragEnd: () => void;
}

const ConversationHistoryItemRow = memo(function ConversationHistoryItemRow({
  item,
  isActive,
  isPinnedItem,
  isDragging,
  isDragOver,
  isLongPressing,
  isMenuOpen,
  isEditing,
  editingConversationTitle,
  isRenaming,
  isRestoring,
  t,
  renderConversationTitle,
  setEditingConversationTitle,
  requestSaveConversationTitle,
  onCancelRenameConversation,
  requestRestoreConversation,
  consumeHistoryLongPressTrigger,
  onHistoryItemKeyDown,
  onOpenHistoryContextMenu,
  onOpenHistoryContextMenuFromButton,
  onHistoryItemTouchStart,
  onHistoryItemTouchMove,
  onHistoryItemTouchEnd,
  onHistoryItemTouchCancel,
  onPinnedDragStart,
  onPinnedDragOver,
  onPinnedDrop,
  onPinnedDragEnd
}: ConversationHistoryItemRowProps) {
  const itemClasses = [
    isActive ? 'chat-history-item active' : 'chat-history-item',
    isMenuOpen ? 'menu-open' : '',
    isPinnedItem ? 'chat-history-item-draggable' : '',
    isDragging ? 'dragging' : '',
    isDragOver ? 'drag-over' : '',
    isLongPressing ? 'long-pressing' : ''
  ]
    .filter(Boolean)
    .join(' ');

  const handleDragStart = useCallback(
    (event: ReactDragEvent<HTMLLIElement>) => {
      onPinnedDragStart(event, item.id);
    },
    [item.id, onPinnedDragStart]
  );

  const handleDragOver = useCallback(
    (event: ReactDragEvent<HTMLLIElement>) => {
      if (isPinnedItem) {
        onPinnedDragOver(event, item.id);
      }
    },
    [isPinnedItem, item.id, onPinnedDragOver]
  );

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLLIElement>) => {
      if (isPinnedItem) {
        onPinnedDrop(event, item.id);
      }
    },
    [isPinnedItem, item.id, onPinnedDrop]
  );

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLLIElement>) => {
      onOpenHistoryContextMenu(event, item.id);
    },
    [item.id, onOpenHistoryContextMenu]
  );

  const handleTouchStart = useCallback(
    (event: ReactTouchEvent<HTMLLIElement>) => {
      onHistoryItemTouchStart(event, item.id);
    },
    [item.id, onHistoryItemTouchStart]
  );

  const handleRestore = useCallback(() => {
    if (consumeHistoryLongPressTrigger()) {
      return;
    }

    requestRestoreConversation(item.id);
  }, [consumeHistoryLongPressTrigger, item.id, requestRestoreConversation]);

  const handleItemKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      onHistoryItemKeyDown(event, item.id);
    },
    [item.id, onHistoryItemKeyDown]
  );

  const handleOpenMenuFromButton = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      onOpenHistoryContextMenuFromButton(event, item.id);
    },
    [item.id, onOpenHistoryContextMenuFromButton]
  );

  const handleEditingTitleChange = useCallback(
    (event: ReactChangeEvent<HTMLInputElement>) => {
      setEditingConversationTitle(event.target.value);
    },
    [setEditingConversationTitle]
  );

  const handleEditingTitleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        requestSaveConversationTitle(item.id);
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        onCancelRenameConversation();
      }
    },
    [item.id, onCancelRenameConversation, requestSaveConversationTitle]
  );

  const handleSaveTitle = useCallback(() => {
    requestSaveConversationTitle(item.id);
  }, [item.id, requestSaveConversationTitle]);

  return (
    <li
      className={itemClasses}
      draggable={isPinnedItem && !isEditing}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragEnd={onPinnedDragEnd}
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onTouchMove={onHistoryItemTouchMove}
      onTouchEnd={onHistoryItemTouchEnd}
      onTouchCancel={onHistoryItemTouchCancel}
    >
      {isEditing ? (
        <div className="chat-history-edit stack tight">
          <Input
            value={editingConversationTitle}
            onChange={handleEditingTitleChange}
            onKeyDown={handleEditingTitleKeyDown}
            placeholder={t('Conversation title')}
            autoFocus
            disabled={isRenaming}
          />
          <div className="row gap">
            <Button
              className="chat-history-action"
              variant="secondary"
              size="sm"
              onClick={handleSaveTitle}
              disabled={isRenaming}
              type="button"
            >
              {isRenaming ? t('Saving...') : t('Save')}
            </Button>
            <Button
              className="chat-history-action"
              variant="secondary"
              size="sm"
              onClick={onCancelRenameConversation}
              disabled={isRenaming}
              type="button"
            >
              {t('Cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="chat-history-item-shell">
          <Button
            className="chat-history-open"
            variant="ghost"
            size="sm"
            onClick={handleRestore}
            onKeyDown={handleItemKeyDown}
            disabled={isRestoring}
            type="button"
          >
            <span className="chat-history-title-row">
              {isPinnedItem ? (
                <span className="chat-history-drag-handle" aria-hidden="true">
                  ::
                </span>
              ) : null}
              <span className="chat-history-title-text">{renderConversationTitle(item.title)}</span>
            </span>
          </Button>
          <Button
            className={`chat-history-more${isMenuOpen ? ' active' : ''}`}
            variant="ghost"
            size="icon"
            type="button"
            onClick={handleOpenMenuFromButton}
            title={t('More actions')}
            aria-label={t('More actions')}
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
            >
              <span className="chat-history-more-dots" aria-hidden="true">
                <span className="chat-history-more-dot" />
                <span className="chat-history-more-dot" />
                <span className="chat-history-more-dot" />
              </span>
          </Button>
        </div>
      )}
    </li>
  );
});

interface ConversationHistoryListProps {
  historyItems: LocalChatHistoryItem[];
  activeConversationId: string | null;
  menuConversationId: string | null;
  editingConversationId: string | null;
  editingConversationTitle: string;
  renamingConversationId: string | null;
  restoringConversationId: string | null;
  draggingPinnedConversationId: string | null;
  dragOverPinnedConversationId: string | null;
  longPressingConversationId: string | null;
  t: TranslateFn;
  renderConversationTitle: (title: string) => string;
  setEditingConversationTitle: Dispatch<SetStateAction<string>>;
  requestSaveConversationTitle: (conversationId: string) => void;
  onCancelRenameConversation: () => void;
  requestRestoreConversation: (conversationId: string) => void;
  consumeHistoryLongPressTrigger: () => boolean;
  onHistoryItemKeyDown: (event: ReactKeyboardEvent<HTMLElement>, itemId: string) => void;
  onOpenHistoryContextMenu: (event: ReactMouseEvent<HTMLLIElement>, itemId: string) => void;
  onOpenHistoryContextMenuFromButton: (
    event: ReactMouseEvent<HTMLButtonElement>,
    itemId: string
  ) => void;
  onHistoryItemTouchStart: (event: ReactTouchEvent<HTMLLIElement>, itemId: string) => void;
  onHistoryItemTouchMove: () => void;
  onHistoryItemTouchEnd: () => void;
  onHistoryItemTouchCancel: () => void;
  onPinnedDragStart: (event: ReactDragEvent<HTMLLIElement>, itemId: string) => void;
  onPinnedDragOver: (event: ReactDragEvent<HTMLLIElement>, itemId: string) => void;
  onPinnedDrop: (event: ReactDragEvent<HTMLLIElement>, itemId: string) => void;
  onPinnedDragEnd: () => void;
}

const ConversationHistoryList = memo(function ConversationHistoryList({
  historyItems,
  activeConversationId,
  menuConversationId,
  editingConversationId,
  editingConversationTitle,
  renamingConversationId,
  restoringConversationId,
  draggingPinnedConversationId,
  dragOverPinnedConversationId,
  longPressingConversationId,
  t,
  renderConversationTitle,
  setEditingConversationTitle,
  requestSaveConversationTitle,
  onCancelRenameConversation,
  requestRestoreConversation,
  consumeHistoryLongPressTrigger,
  onHistoryItemKeyDown,
  onOpenHistoryContextMenu,
  onOpenHistoryContextMenuFromButton,
  onHistoryItemTouchStart,
  onHistoryItemTouchMove,
  onHistoryItemTouchEnd,
  onHistoryItemTouchCancel,
  onPinnedDragStart,
  onPinnedDragOver,
  onPinnedDrop,
  onPinnedDragEnd
}: ConversationHistoryListProps) {
  return historyItems.map((item) => (
    <ConversationHistoryItemRow
      key={item.id}
      item={item}
      isActive={item.id === activeConversationId}
      isPinnedItem={item.pinned}
      isDragging={draggingPinnedConversationId === item.id}
      isDragOver={
        dragOverPinnedConversationId === item.id &&
        draggingPinnedConversationId !== item.id
      }
      isLongPressing={longPressingConversationId === item.id}
      isMenuOpen={menuConversationId === item.id}
      isEditing={editingConversationId === item.id}
      editingConversationTitle={editingConversationTitle}
      isRenaming={renamingConversationId === item.id}
      isRestoring={restoringConversationId === item.id}
      t={t}
      renderConversationTitle={renderConversationTitle}
      setEditingConversationTitle={setEditingConversationTitle}
      requestSaveConversationTitle={requestSaveConversationTitle}
      onCancelRenameConversation={onCancelRenameConversation}
      requestRestoreConversation={requestRestoreConversation}
      consumeHistoryLongPressTrigger={consumeHistoryLongPressTrigger}
      onHistoryItemKeyDown={onHistoryItemKeyDown}
      onOpenHistoryContextMenu={onOpenHistoryContextMenu}
      onOpenHistoryContextMenuFromButton={onOpenHistoryContextMenuFromButton}
      onHistoryItemTouchStart={onHistoryItemTouchStart}
      onHistoryItemTouchMove={onHistoryItemTouchMove}
      onHistoryItemTouchEnd={onHistoryItemTouchEnd}
      onHistoryItemTouchCancel={onHistoryItemTouchCancel}
      onPinnedDragStart={onPinnedDragStart}
      onPinnedDragOver={onPinnedDragOver}
      onPinnedDrop={onPinnedDrop}
      onPinnedDragEnd={onPinnedDragEnd}
    />
  ));
});

interface ConversationHistorySidebarPanelProps {
  t: TranslateFn;
  historyItems: LocalChatHistoryItem[];
  activeConversationId: string | null;
  editingConversationId: string | null;
  editingConversationTitle: string;
  renamingConversationId: string | null;
  restoringConversationId: string | null;
  historyContextMenu: HistoryContextMenuState | null;
  historyContextMenuActiveIndex: number;
  historyContextMenuActions: HistoryContextMenuAction[];
  draggingPinnedConversationId: string | null;
  dragOverPinnedConversationId: string | null;
  longPressingConversationId: string | null;
  historyMenuButtonRefs: MutableRefObject<Array<HTMLButtonElement | null>>;
  contextMenuPinned: boolean;
  renderConversationTitle: (title: string) => string;
  setEditingConversationTitle: Dispatch<SetStateAction<string>>;
  requestSaveConversationTitle: (conversationId: string) => void;
  onCancelRenameConversation: () => void;
  requestRestoreConversation: (conversationId: string) => void;
  consumeHistoryLongPressTrigger: () => boolean;
  onSetHistoryContextMenuActiveIndex: Dispatch<SetStateAction<number>>;
  onExecuteHistoryContextAction: (action: HistoryContextMenuAction) => void;
  getHistoryContextMenuActionLabel: (action: HistoryContextMenuAction) => string;
  getHistoryContextMenuActionShortcut: (action: HistoryContextMenuAction) => string;
  getHistoryContextMenuActionIcon: (action: HistoryContextMenuAction) => ReactNode;
  onHistoryItemKeyDown: (event: ReactKeyboardEvent<HTMLElement>, itemId: string) => void;
  onOpenHistoryContextMenu: (event: ReactMouseEvent<HTMLLIElement>, itemId: string) => void;
  onOpenHistoryContextMenuFromButton: (
    event: ReactMouseEvent<HTMLButtonElement>,
    itemId: string
  ) => void;
  onHistoryItemTouchStart: (event: ReactTouchEvent<HTMLLIElement>, itemId: string) => void;
  onHistoryItemTouchMove: () => void;
  onHistoryItemTouchEnd: () => void;
  onHistoryItemTouchCancel: () => void;
  onPinnedDragStart: (event: ReactDragEvent<HTMLLIElement>, itemId: string) => void;
  onPinnedDragOver: (event: ReactDragEvent<HTMLLIElement>, itemId: string) => void;
  onPinnedDrop: (event: ReactDragEvent<HTMLLIElement>, itemId: string) => void;
  onPinnedDragEnd: () => void;
}

const ConversationHistorySidebarPanel = memo(function ConversationHistorySidebarPanel({
  t,
  historyItems,
  activeConversationId,
  editingConversationId,
  editingConversationTitle,
  renamingConversationId,
  restoringConversationId,
  historyContextMenu,
  historyContextMenuActiveIndex,
  historyContextMenuActions,
  draggingPinnedConversationId,
  dragOverPinnedConversationId,
  longPressingConversationId,
  historyMenuButtonRefs,
  contextMenuPinned,
  renderConversationTitle,
  setEditingConversationTitle,
  requestSaveConversationTitle,
  onCancelRenameConversation,
  requestRestoreConversation,
  consumeHistoryLongPressTrigger,
  onSetHistoryContextMenuActiveIndex,
  onExecuteHistoryContextAction,
  getHistoryContextMenuActionLabel,
  getHistoryContextMenuActionShortcut,
  getHistoryContextMenuActionIcon,
  onHistoryItemKeyDown,
  onOpenHistoryContextMenu,
  onOpenHistoryContextMenuFromButton,
  onHistoryItemTouchStart,
  onHistoryItemTouchMove,
  onHistoryItemTouchEnd,
  onHistoryItemTouchCancel,
  onPinnedDragStart,
  onPinnedDragOver,
  onPinnedDrop,
  onPinnedDragEnd
}: ConversationHistorySidebarPanelProps) {
  const historyListRef = useRef<HTMLUListElement | null>(null);
  const [historyViewportHeight, setHistoryViewportHeight] = useState(0);
  const [historyScrollTop, setHistoryScrollTop] = useState(0);

  useEffect(() => {
    const container = historyListRef.current;
    if (!container) {
      setHistoryViewportHeight(0);
      return;
    }

    const updateHeight = () => {
      setHistoryViewportHeight(Math.max(0, Math.floor(container.clientHeight)));
    };

    updateHeight();

    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(() => {
        updateHeight();
      });
      resizeObserver.observe(container);
      return () => {
        resizeObserver.disconnect();
      };
    }

    window.addEventListener('resize', updateHeight);
    return () => {
      window.removeEventListener('resize', updateHeight);
    };
  }, [historyItems.length]);

  const onHistoryScroll = useCallback((event: ReactUIEvent<HTMLUListElement>) => {
    setHistoryScrollTop(event.currentTarget.scrollTop);
  }, []);

  const virtualizedWindow = useMemo(() => {
    const shouldVirtualize =
      historyItems.length >= historyVirtualMinCount &&
      historyViewportHeight > 0 &&
      !editingConversationId &&
      !renamingConversationId;
    if (!shouldVirtualize) {
      return {
        isVirtualized: false,
        visibleItems: historyItems,
        topSpacerHeight: 0,
        bottomSpacerHeight: 0
      };
    }

    const startIndex = Math.max(
      0,
      Math.floor(historyScrollTop / historyVirtualItemHeight) - historyVirtualOverscan
    );
    const endIndex = Math.min(
      historyItems.length,
      Math.ceil((historyScrollTop + historyViewportHeight) / historyVirtualItemHeight) + historyVirtualOverscan
    );

    return {
      isVirtualized: true,
      visibleItems: historyItems.slice(startIndex, endIndex),
      topSpacerHeight: startIndex * historyVirtualItemHeight,
      bottomSpacerHeight: Math.max(0, (historyItems.length - endIndex) * historyVirtualItemHeight)
    };
  }, [
    editingConversationId,
    historyItems,
    historyScrollTop,
    historyViewportHeight,
    renamingConversationId
  ]);

  useEffect(() => {
    const container = historyListRef.current;
    if (!container) {
      return;
    }

    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (historyScrollTop > maxScrollTop) {
      setHistoryScrollTop(maxScrollTop);
      container.scrollTop = maxScrollTop;
    }
  }, [historyItems.length, historyScrollTop]);

  return (
    <section className="chat-sidebar-section chat-sidebar-history-only">
      <div className="chat-history-wrap">
        {historyItems.length > 0 ? (
          <ul
            className={`chat-history-list${virtualizedWindow.isVirtualized ? ' virtualized' : ''}`}
            ref={historyListRef}
            onScroll={onHistoryScroll}
          >
            {virtualizedWindow.topSpacerHeight > 0 ? (
              <li
                className="chat-history-spacer"
                style={{ height: virtualizedWindow.topSpacerHeight }}
                aria-hidden="true"
              />
            ) : null}
            <ConversationHistoryList
              historyItems={virtualizedWindow.visibleItems}
              activeConversationId={activeConversationId}
              menuConversationId={historyContextMenu?.id ?? null}
              editingConversationId={editingConversationId}
              editingConversationTitle={editingConversationTitle}
              renamingConversationId={renamingConversationId}
              restoringConversationId={restoringConversationId}
              draggingPinnedConversationId={draggingPinnedConversationId}
              dragOverPinnedConversationId={dragOverPinnedConversationId}
              longPressingConversationId={longPressingConversationId}
              t={t}
              renderConversationTitle={renderConversationTitle}
              setEditingConversationTitle={setEditingConversationTitle}
              requestSaveConversationTitle={requestSaveConversationTitle}
              onCancelRenameConversation={onCancelRenameConversation}
              requestRestoreConversation={requestRestoreConversation}
              consumeHistoryLongPressTrigger={consumeHistoryLongPressTrigger}
              onHistoryItemKeyDown={onHistoryItemKeyDown}
              onOpenHistoryContextMenu={onOpenHistoryContextMenu}
              onOpenHistoryContextMenuFromButton={onOpenHistoryContextMenuFromButton}
              onHistoryItemTouchStart={onHistoryItemTouchStart}
              onHistoryItemTouchMove={onHistoryItemTouchMove}
              onHistoryItemTouchEnd={onHistoryItemTouchEnd}
              onHistoryItemTouchCancel={onHistoryItemTouchCancel}
              onPinnedDragStart={onPinnedDragStart}
              onPinnedDragOver={onPinnedDragOver}
              onPinnedDrop={onPinnedDrop}
              onPinnedDragEnd={onPinnedDragEnd}
            />
            {virtualizedWindow.bottomSpacerHeight > 0 ? (
              <li
                className="chat-history-spacer"
                style={{ height: virtualizedWindow.bottomSpacerHeight }}
                aria-hidden="true"
              />
            ) : null}
          </ul>
        ) : null}
        {historyContextMenu ? (
          <div
            className="chat-history-menu"
            style={{ left: historyContextMenu.x, top: historyContextMenu.y }}
            onClick={(event) => event.stopPropagation()}
            role="menu"
            aria-label={t('Conversation actions')}
          >
            {historyContextMenuActions.map((action, index) => (
              <div key={action}>
                {action === 'delete' ? <div className="chat-history-menu-divider" aria-hidden="true" /> : null}
                <Button
                  className={`chat-history-menu-item${action === 'delete' ? ' danger' : ''}${historyContextMenuActiveIndex === index ? ' active' : ''}`}
                  variant={action === 'delete' ? 'danger' : 'ghost'}
                  size="sm"
                  onMouseEnter={() => onSetHistoryContextMenuActiveIndex(index)}
                  onClick={() => onExecuteHistoryContextAction(action)}
                  ref={(element) => {
                    historyMenuButtonRefs.current[index] = element;
                  }}
                  tabIndex={historyContextMenuActiveIndex === index ? 0 : -1}
                  aria-selected={historyContextMenuActiveIndex === index}
                  role="menuitem"
                >
                  <span className="chat-history-menu-item-label">
                    <span className="chat-history-menu-icon">
                      {getHistoryContextMenuActionIcon(action)}
                    </span>
                    <span className="chat-history-menu-item-main">
                      {action === 'pin' ? (contextMenuPinned ? t('Unpin') : t('Pin')) : getHistoryContextMenuActionLabel(action)}
                    </span>
                  </span>
                  <span className="chat-history-menu-shortcut" aria-hidden="true">
                    {getHistoryContextMenuActionShortcut(action)}
                  </span>
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
});

interface ConversationMessageViewportProps {
  t: TranslateFn;
  loading: boolean;
  error: string;
  authRequired: boolean;
  modelCount: number;
  visibleMessages: MessageRecord[];
  hiddenMessageCount: number;
  currentUsername: string | null;
  onLoadEarlierMessages: () => void;
  onCopyMessage: (content: string) => void;
  onQuoteMessage: (content: string) => void;
  onConfirmConversationAction: (action: ConversationActionMetadata) => void;
  onAutoFillConversationAction: (action: ConversationActionMetadata) => void;
  onApplyConversationSuggestion: (action: ConversationActionMetadata, suggestion: string) => void;
  onRunConversationNextStep: (step: ConversationActionNextStep) => void;
  formatConversationActionLabel: (action: ConversationActionMetadata['action']) => string;
  formatConversationActionStatusLabel: (status: ConversationActionMetadata['status']) => string;
  formatConversationActionFieldLabel: (field: string) => string;
  formatConversationActionFieldValue: (field: string, value: unknown) => string;
  resolveConversationActionFieldHref: (
    action: ConversationActionMetadata,
    field: string,
    value: unknown
  ) => string | null;
  resolveConversationActionHref: (action: ConversationActionMetadata) => string | null;
  resolveConversationActionLinks: (action: ConversationActionMetadata) => Array<{ label: string; href: string }>;
  resolveMessageAttachmentNames: (message: MessageRecord) => string[];
  loginPath: string;
}

const ConversationMessageViewport = memo(function ConversationMessageViewport({
  t,
  loading,
  error,
  authRequired,
  modelCount,
  visibleMessages,
  hiddenMessageCount,
  currentUsername,
  onLoadEarlierMessages,
  onCopyMessage,
  onQuoteMessage,
  onConfirmConversationAction,
  onAutoFillConversationAction,
  onApplyConversationSuggestion,
  onRunConversationNextStep,
  formatConversationActionLabel,
  formatConversationActionStatusLabel,
  formatConversationActionFieldLabel,
  formatConversationActionFieldValue,
  resolveConversationActionFieldHref,
  resolveConversationActionHref,
  resolveConversationActionLinks,
  resolveMessageAttachmentNames,
  loginPath
}: ConversationMessageViewportProps) {
  const normalizeActionLinks = useCallback(
    (links: Array<{ label: string; href: string }> | undefined | null): Array<{ label: string; href: string }> => {
      if (!Array.isArray(links) || links.length === 0) {
        return [];
      }
      const seen = new Set<string>();
      const normalized: Array<{ label: string; href: string }> = [];
      for (const item of links) {
        if (!item || typeof item.label !== 'string' || typeof item.href !== 'string') {
          continue;
        }
        const href = item.href.trim();
        const label = item.label.trim();
        if (!href.startsWith('/') || href.startsWith('//') || label.length === 0) {
          continue;
        }
        const dedupeKey = href;
        if (seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);
        normalized.push({ label, href });
      }
      return normalized;
    },
    []
  );

  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const prependAnchorRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
    hiddenMessageCount: number;
  } | null>(null);
  const previousLastMessageIdRef = useRef<string | null>(null);

  const handleLoadEarlierMessages = useCallback(() => {
    const container = messageScrollRef.current;
    if (container) {
      prependAnchorRef.current = {
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
        hiddenMessageCount
      };
    }
    onLoadEarlierMessages();
  }, [hiddenMessageCount, onLoadEarlierMessages]);

  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    const container = messageScrollRef.current;
    if (!anchor || !container) {
      return;
    }

    if (hiddenMessageCount < anchor.hiddenMessageCount) {
      const deltaHeight = container.scrollHeight - anchor.scrollHeight;
      container.scrollTop = anchor.scrollTop + Math.max(0, deltaHeight);
    }

    prependAnchorRef.current = null;
  }, [hiddenMessageCount, visibleMessages.length]);

  useEffect(() => {
    const container = messageScrollRef.current;
    if (!container) {
      return;
    }

    const nextLastMessageId = visibleMessages.length > 0 ? visibleMessages[visibleMessages.length - 1]?.id ?? null : null;
    const previousLastMessageId = previousLastMessageIdRef.current;
    const hasNewTailMessage = Boolean(nextLastMessageId && nextLastMessageId !== previousLastMessageId);

    if (hasNewTailMessage) {
      const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (distanceToBottom <= 120 || previousLastMessageId === null) {
        container.scrollTop = container.scrollHeight;
      }
    }

    previousLastMessageIdRef.current = nextLastMessageId;
  }, [visibleMessages]);

  return (
    <section className="chat-message-stage">
      {loading ? (
        <StateBlock
          variant="loading"
          title={t('Preparing Workspace')}
          description={t('Loading models and attachment context.')}
        />
      ) : null}

      {error ? <StateBlock variant="error" title={t('Conversation Error')} description={error} /> : null}

      {!loading && !error && authRequired ? (
        <StateBlock
          variant="empty"
          title={t('Login to use conversation workspace')}
          description={t('Sign in to access chat history, settings, attachments, and governed conversation actions.')}
          extra={
            <div className="chat-auth-state-actions">
              <ButtonLink to={loginPath} variant="secondary" size="sm">
                {t('Login')}
              </ButtonLink>
            </div>
          }
        />
      ) : null}

      {!loading && !error && !authRequired && modelCount === 0 ? (
        <StateBlock
          variant="empty"
          title={t('No Available Models')}
          description={t('No model is visible for this account. Publish or authorize one first.')}
        />
      ) : null}

      {!loading && !error && !authRequired && modelCount > 0 ? (
        <div className="chat-message-scroll" ref={messageScrollRef}>
          {visibleMessages.length === 0 ? (
            <div className="chat-empty-center">
              <h2>{t('How can I help you today?')}</h2>
              <small className="muted">
                {t('Upload files, ask a question, then iterate in this chat-style workspace.')}
              </small>
            </div>
          ) : (
            <>
              {hiddenMessageCount > 0 ? (
                <div className="chat-message-load-earlier-wrap">
                  <Button
                    className="chat-message-load-earlier-btn"
                    variant="secondary"
                    size="sm"
                    type="button"
                    onClick={handleLoadEarlierMessages}
                  >
                    {t('Load earlier messages ({count})', { count: hiddenMessageCount })}
                  </Button>
                </div>
              ) : null}
              <ul className="chat-message-list">
                {visibleMessages.map((message) => {
                const actionMetadata = message.metadata?.conversation_action ?? null;
                const actionExecutionSource = actionMetadata?.collected_fields.execution_source ?? '';
                const isInferenceFallbackResult =
                  actionMetadata?.action === 'run_model_inference' &&
                  actionMetadata.status === 'completed' &&
                  isFallbackExecutionSource(actionExecutionSource);
                const actionDisplayStatus = isInferenceFallbackResult ? 'failed' : actionMetadata?.status ?? 'failed';
                const actionDisplayStatusLabel = isInferenceFallbackResult
                  ? t('Restricted mode')
                  : actionMetadata
                    ? formatConversationActionStatusLabel(actionMetadata.status)
                    : formatConversationActionStatusLabel('failed');
                const actionNextSteps = actionMetadata ? deriveConversationActionNextSteps(actionMetadata, t) : [];
                const actionHref = actionMetadata ? resolveConversationActionHref(actionMetadata) : null;
                const actionLinks = normalizeActionLinks(
                  actionMetadata
                    ? [
                        ...(actionMetadata.action_links ?? []),
                        ...resolveConversationActionLinks(actionMetadata)
                      ]
                    : []
                );
                const normalizedActionHref =
                  actionHref && actionLinks.some((item) => item.href === actionHref) ? null : actionHref;
                const attachmentNames = resolveMessageAttachmentNames(message);
                const contentParagraphs = formatMessageParagraphs(message.content);

                return (
                  <li
                    key={message.id}
                    className={message.sender === 'user' ? 'chat-message-row user' : 'chat-message-row assistant'}
                  >
                    <div className="chat-message-meta">
                      <span>{message.sender === 'user' ? currentUsername || t('you') : t('Vistral')}</span>
                      <small>{formatMessageTime(message.created_at)}</small>
                    </div>
                    <MessageBubble
                      sender={message.sender}
                      className="chat-message-bubble"
                    >
                      <div className="chat-message-content">
                        {(contentParagraphs.length > 0 ? contentParagraphs : [message.content]).map((paragraph, index) => (
                          <p key={`${message.id}-p-${index}`} className="chat-message-paragraph">
                            {paragraph}
                          </p>
                        ))}
                      </div>
                      {attachmentNames.length > 0 ? (
                        <small className="muted chat-message-attachment-summary">
                          {t('Attachments:')} {attachmentNames.join(', ')}
                        </small>
                      ) : null}
                      {actionMetadata ? (
                        <div className={`chat-message-action-card ${actionDisplayStatus}`}>
                          <div className="chat-message-action-card-header">
                            <strong>{formatConversationActionLabel(actionMetadata.action)}</strong>
                            <span className={`chat-message-action-status ${actionDisplayStatus}`}>
                              {actionDisplayStatusLabel}
                            </span>
                          </div>
                          {actionMetadata.missing_fields.length > 0 ? (
                            <div className="stack tight">
                              <small className="muted">{t('Missing info')}</small>
                              <div className="chat-message-action-tags">
                                {actionMetadata.missing_fields.map((field) => (
                                  <span key={`${message.id}-missing-${field}`} className="chat-message-action-tag">
                                    {formatConversationActionFieldLabel(field)}
                                  </span>
                                ))}
                              </div>
                            </div>
                          ) : null}
                          {Object.keys(actionMetadata.collected_fields).length > 0 ? (
                            <div className="stack tight">
                              <small className="muted">{t('Collected info')}</small>
                              <ul className="chat-message-action-details">
                                {Object.entries(actionMetadata.collected_fields).map(([field, value]) => {
                                  const fieldValueHref = resolveConversationActionFieldHref(actionMetadata, field, value);
                                  return (
                                    <li key={`${message.id}-collected-${field}`}>
                                      <strong>{formatConversationActionFieldLabel(field)}:</strong>{' '}
                                      {fieldValueHref ? (
                                        <ButtonLink
                                          to={fieldValueHref}
                                          variant="ghost"
                                          size="sm"
                                          className="chat-action-btn"
                                        >
                                          {formatConversationActionFieldValue(field, value)}
                                        </ButtonLink>
                                      ) : (
                                        formatConversationActionFieldValue(field, value)
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          ) : null}
                          {actionMetadata.status === 'requires_input' ? (
                            <div className="row gap wrap">
                              <Button
                                type="button"
                                className="chat-action-btn"
                                variant="secondary"
                                size="sm"
                                onClick={() => onAutoFillConversationAction(actionMetadata)}
                              >
                                {t('Auto fill all')}
                              </Button>
                              {actionMetadata.suggestions && actionMetadata.suggestions.length > 0 ? (
                                <Button
                                  type="button"
                                  className="chat-action-btn"
                                  variant="secondary"
                                  size="sm"
                                  onClick={() =>
                                    onApplyConversationSuggestion(actionMetadata, (actionMetadata.suggestions ?? [])[0] ?? '')
                                  }
                                >
                                  {t('Auto apply top suggestion')}
                                </Button>
                              ) : null}
                            </div>
                          ) : null}
                          {actionMetadata.suggestions && actionMetadata.suggestions.length > 0 ? (
                            <div className="stack tight">
                              <small className="muted">{t('Suggestions')}</small>
                              <div className="chat-message-action-tags">
                                {actionMetadata.suggestions.map((suggestion) => (
                                  <Button
                                    key={`${message.id}-suggestion-${suggestion}`}
                                    type="button"
                                    className="chat-message-action-tag chat-message-action-tag-button muted"
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => onApplyConversationSuggestion(actionMetadata, suggestion)}
                                  >
                                    {suggestion}
                                  </Button>
                                ))}
                              </div>
                            </div>
                          ) : null}
                          {actionMetadata.requires_confirmation && actionMetadata.confirmation_phrase ? (
                            <div className="row gap wrap">
                              <Button
                                className="chat-action-btn"
                                variant="primary"
                                size="sm"
                                type="button"
                                onClick={() => onConfirmConversationAction(actionMetadata)}
                              >
                                {t('Confirm now')}
                              </Button>
                            </div>
                          ) : null}
                          {actionNextSteps.length > 0 ? (
                            <div className="stack tight">
                              <small className="muted">{t('Suggested next steps')}</small>
                              <div className="row gap wrap">
                                {actionNextSteps.slice(0, 3).map((step) =>
                                  step.kind === 'href' && step.href ? (
                                    <ButtonLink
                                      key={`${message.id}-next-step-${step.id}`}
                                      className="chat-action-btn"
                                      variant="secondary"
                                      size="sm"
                                      to={step.href}
                                    >
                                      {step.title}
                                    </ButtonLink>
                                  ) : step.kind === 'ops' ? (
                                    <Button
                                      key={`${message.id}-next-step-${step.id}`}
                                      type="button"
                                      className="chat-action-btn"
                                      variant="secondary"
                                      size="sm"
                                      onClick={() => onRunConversationNextStep(step)}
                                    >
                                      {step.title}
                                    </Button>
                                  ) : (
                                    <small key={`${message.id}-next-step-${step.id}`} className="muted">
                                      {step.title}
                                    </small>
                                  )
                                )}
                              </div>
                              <small className="muted">{actionNextSteps[0]?.detail}</small>
                            </div>
                          ) : null}
                          {normalizedActionHref ? (
                            <div className="row gap wrap">
                              <ButtonLink className="chat-action-btn" variant="secondary" size="sm" to={normalizedActionHref}>
                                {t('Open result')}
                              </ButtonLink>
                            </div>
                          ) : null}
                          {actionLinks.length > 0 ? (
                            <div className="row gap wrap">
                              {actionLinks.map((link) => (
                                <ButtonLink
                                  key={`${message.id}-action-link-${link.href}-${link.label}`}
                                  className="chat-action-btn"
                                  variant="secondary"
                                  size="sm"
                                  to={link.href}
                                >
                                  {link.label}
                                </ButtonLink>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="chat-message-actions row gap wrap">
                        <Button
                          className="chat-action-btn"
                          variant="secondary"
                          size="sm"
                          onClick={() => onCopyMessage(message.content)}
                          type="button"
                        >
                          {t('Copy')}
                        </Button>
                        <Button
                          className="chat-action-btn"
                          variant="secondary"
                          size="sm"
                          onClick={() => onQuoteMessage(message.content)}
                          type="button"
                        >
                          {t('Reuse')}
                        </Button>
                        {message.sender === 'assistant' ? (
                          <Button
                            className="chat-action-btn"
                            variant="secondary"
                            size="sm"
                            onClick={() => onQuoteMessage(`继续分析：${message.content}`)}
                            type="button"
                          >
                            {t('Quote')}
                          </Button>
                        ) : null}
                      </div>
                    </MessageBubble>
                  </li>
                );
                })}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
});

interface ConversationDraftAttachmentPanelProps {
  t: TranslateFn;
  selectedAttachments: FileAttachment[];
  hasPendingSelectedAttachments: boolean;
  sending: boolean;
  uploading: boolean;
  attachmentListExpanded: boolean;
  attachments: FileAttachment[];
  selectedAttachmentCount: number;
  readyAttachmentCount: number;
  attachmentStatusSummary: AttachmentStatusSummary;
  selectedAttachmentIdSet: Set<string>;
  draggingSelectedAttachmentId: string | null;
  dragOverSelectedAttachmentId: string | null;
  onOpenUploadFileDialog: () => void;
  onUploadFilenameReference: (filename: string) => Promise<boolean>;
  onIncludeAllReadyAttachments: () => void;
  onClearCurrentAttachmentContext: () => void;
  onOpenAttachment: (attachmentId: string) => void;
  onExcludeAttachmentFromCurrentMessage: (attachment: FileAttachment) => void;
  onIncludeAttachmentInCurrentMessage: (attachment: FileAttachment) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onSelectedAttachmentDragStart: (event: ReactDragEvent<HTMLLIElement>, attachmentId: string) => void;
  onSelectedAttachmentDragOver: (event: ReactDragEvent<HTMLLIElement>, attachmentId: string) => void;
  onSelectedAttachmentDrop: (event: ReactDragEvent<HTMLLIElement>, attachmentId: string) => void;
  onSelectedAttachmentDragEnd: () => void;
}

const ConversationDraftAttachmentPanel = memo(function ConversationDraftAttachmentPanel({
  t,
  selectedAttachments,
  hasPendingSelectedAttachments,
  sending,
  uploading,
  attachmentListExpanded,
  attachments,
  selectedAttachmentCount,
  readyAttachmentCount,
  attachmentStatusSummary,
  selectedAttachmentIdSet,
  draggingSelectedAttachmentId,
  dragOverSelectedAttachmentId,
  onOpenUploadFileDialog,
  onUploadFilenameReference,
  onIncludeAllReadyAttachments,
  onClearCurrentAttachmentContext,
  onOpenAttachment,
  onExcludeAttachmentFromCurrentMessage,
  onIncludeAttachmentInCurrentMessage,
  onRemoveAttachment,
  onSelectedAttachmentDragStart,
  onSelectedAttachmentDragOver,
  onSelectedAttachmentDrop,
  onSelectedAttachmentDragEnd
}: ConversationDraftAttachmentPanelProps) {
  const [manualFilename, setManualFilename] = useState('');
  const shouldVirtualizeAttachmentTray = attachments.length > attachmentTrayVirtualizationThreshold;

  const submitManualFilenameReference = useCallback(async () => {
    const uploaded = await onUploadFilenameReference(manualFilename);
    if (uploaded) {
      setManualFilename('');
    }
  }, [manualFilename, onUploadFilenameReference]);

  const handleManualFilenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'Enter') {
        return;
      }

      event.preventDefault();
      void submitManualFilenameReference();
    },
    [submitManualFilenameReference]
  );

  const renderAttachmentTrayItem = (item: FileAttachment) => {
    const isSelected = selectedAttachmentIdSet.has(item.id);

    return (
      <div className={`chat-simple-attachment-item${isSelected ? ' selected' : ''}`}>
        {item.status === 'ready' ? (
          <Button
            className="chat-simple-attachment-open"
            variant="ghost"
            size="sm"
            onClick={() => onOpenAttachment(item.id)}
            disabled={uploading || sending}
            title={item.filename}
            type="button"
          >
            {item.filename}
          </Button>
        ) : (
          <span className="chat-simple-attachment-name" title={item.filename}>
            {item.filename}
          </span>
        )}
        <StatusBadge status={item.status} />
        {isSelected || item.status === 'ready' ? (
          <Button
            type="button"
            className={`chat-simple-attachment-item-action${isSelected ? ' active' : ''}`}
            variant="secondary"
            size="sm"
            onClick={() =>
              isSelected
                ? onExcludeAttachmentFromCurrentMessage(item)
                : onIncludeAttachmentInCurrentMessage(item)
            }
            disabled={uploading || sending || (!isSelected && item.status !== 'ready')}
          >
            {isSelected ? t('Exclude') : t('Include')}
          </Button>
        ) : null}
        <Button
          className="chat-simple-attachment-delete"
          variant="secondary"
          size="icon"
          onClick={() => onRemoveAttachment(item.id)}
          disabled={uploading || sending}
          title={t('Delete')}
          aria-label={t('Delete')}
          type="button"
        >
          ×
        </Button>
      </div>
    );
  };

  if (selectedAttachments.length === 0 && !attachmentListExpanded) {
    return null;
  }

  return (
    <>
      {selectedAttachments.length > 0 ? (
        <div className="chat-simple-selected-inline">
          <ul className="chat-simple-selected-list">
            {selectedAttachments.map((attachment) => {
              const isDragging = draggingSelectedAttachmentId === attachment.id;
              const isDragOver =
                dragOverSelectedAttachmentId === attachment.id &&
                draggingSelectedAttachmentId !== attachment.id;
              const chipClasses = [
                'chat-simple-selected-chip',
                isDragging ? 'dragging' : '',
                isDragOver ? 'drag-over' : ''
              ]
                .filter(Boolean)
                .join(' ');

              return (
                <li
                  key={attachment.id}
                  className={chipClasses}
                  draggable={!sending && selectedAttachments.length > 1}
                  onDragStart={(event) => onSelectedAttachmentDragStart(event, attachment.id)}
                  onDragOver={(event) => onSelectedAttachmentDragOver(event, attachment.id)}
                  onDrop={(event) => onSelectedAttachmentDrop(event, attachment.id)}
                  onDragEnd={onSelectedAttachmentDragEnd}
                >
                  <AttachmentChip
                    className="chat-simple-selected-chip"
                    label={attachment.filename}
                    title={attachment.filename}
                    onOpen={
                      attachment.status === 'ready'
                        ? () => onOpenAttachment(attachment.id)
                        : undefined
                    }
                    disabled={sending}
                    leading={
                      <span className="chat-simple-selected-chip-handle" aria-hidden="true">
                        ≡
                      </span>
                    }
                    status={<StatusBadge status={attachment.status} />}
                    trailing={
                      <Button
                        type="button"
                        className="chat-simple-selected-chip-remove"
                        variant="secondary"
                        size="icon"
                        onClick={() => onExcludeAttachmentFromCurrentMessage(attachment)}
                        disabled={sending}
                        title={t('Exclude')}
                        aria-label={t('Exclude')}
                      >
                        ×
                      </Button>
                    }
                  />
                </li>
              );
            })}
          </ul>
          <div className="chat-simple-selected-inline-meta">
            <small className="muted">{t('Draft attachments only appear in the current message.')}</small>
            {hasPendingSelectedAttachments ? (
              <small className="muted">{t('Wait for selected files to finish processing before sending.')}</small>
            ) : null}
          </div>
        </div>
      ) : null}

      {attachmentListExpanded ? (
        <div className="chat-simple-attachment-tray">
          <div className="chat-simple-attachment-toolbar">
            <div className="chat-simple-attachment-toolbar-actions">
              <Button
                type="button"
                className="chat-simple-attachment-action-btn"
                variant="secondary"
                size="sm"
                onClick={onOpenUploadFileDialog}
                disabled={uploading || sending}
              >
                {uploading ? t('Processing...') : t('Upload files')}
              </Button>
              <Button
                type="button"
                className="chat-simple-attachment-action-btn"
                variant="secondary"
                size="sm"
                onClick={onIncludeAllReadyAttachments}
                disabled={uploading || sending || readyAttachmentCount === 0}
              >
                {t('Use all ready files')}
              </Button>
              <Button
                type="button"
                className="chat-simple-attachment-action-btn"
                variant="secondary"
                size="sm"
                onClick={onClearCurrentAttachmentContext}
                disabled={uploading || sending || selectedAttachmentCount === 0}
              >
                {t('Clear current context')}
              </Button>
            </div>
            <small className="muted chat-simple-attachment-toolbar-summary">
              {t('Attachments:')} {attachments.length} · {t('Selected {count}', { count: selectedAttachmentCount })} ·{' '}
              {t('Ready {count}', { count: attachmentStatusSummary.ready })}
            </small>
          </div>
          <small className="muted chat-simple-attachment-toolbar-summary">
            {t('BMP and common image/document files are supported. Keep each file under {limit}.', {
              limit: UPLOAD_SOFT_LIMIT_LABEL
            })}
          </small>
          <AdvancedSection
            title={t('Manual filename upload')}
            description={t('Use this compatibility mode when direct file selection is unavailable.')}
          >
            <div className="chat-simple-attachment-manual">
              <Input
                value={manualFilename}
                onChange={(event) => setManualFilename(event.target.value)}
                onKeyDown={handleManualFilenameKeyDown}
                placeholder={t('Enter file name, for example: sample-image.jpg')}
                disabled={uploading || sending}
              />
              <Button
                type="button"
                className="chat-simple-attachment-action-btn"
                variant="secondary"
                size="sm"
                onClick={() => void submitManualFilenameReference()}
                disabled={uploading || sending}
              >
                {uploading ? t('Working...') : t('Upload')}
              </Button>
            </div>
          </AdvancedSection>
          {attachments.length > 0 ? shouldVirtualizeAttachmentTray ? (
            <VirtualList
              items={attachments}
              itemHeight={attachmentTrayVirtualRowHeight}
              height={attachmentTrayVirtualViewportHeight}
              itemKey={(item) => item.id}
              className="chat-simple-attachment-list-viewport"
              listClassName="chat-simple-attachment-list virtualized"
              rowClassName="chat-simple-attachment-row"
              ariaLabel={t('Attachment tray')}
              renderItem={(item) => renderAttachmentTrayItem(item)}
            />
          ) : (
            <ul className="chat-simple-attachment-list">
              {attachments.map((item) => (
                <li key={item.id} className="chat-simple-attachment-list-item">
                  {renderAttachmentTrayItem(item)}
                </li>
              ))}
            </ul>
          ) : (
            <small className="muted chat-simple-selected-empty">
              {t('No files yet. Use + to upload files for this draft or reopen recent conversation files.')}
            </small>
          )}
        </div>
      ) : null}
    </>
  );
});

export default function ConversationPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { language, setLanguage, t } = useI18n();
  const currentConversationPath = useMemo(
    () => {
      const params = new URLSearchParams(location.search || '');
      params.delete('return_to');
      const query = params.toString();
      return `${location.pathname}${query ? `?${query}` : ''}`;
    },
    [location.pathname, location.search]
  );
  const loginPath = useMemo(
    () => buildLoginPath(currentConversationPath),
    [currentConversationPath]
  );
  const scopedSettingsPath = useMemo(
    () => appendReturnToPath('/settings/account', currentConversationPath),
    [currentConversationPath]
  );
  const scopedConsolePath = useMemo(
    () => appendReturnToPath('/workspace/console', currentConversationPath),
    [currentConversationPath]
  );
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [conversation, setConversation] = useState<ConversationRecord | null>(null);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [visibleMessageCount, setVisibleMessageCount] = useState(messageRenderBatchSize);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [history, setHistory] = useState<LocalChatHistoryItem[]>(() => readHistoryFromStorage());
  const [hiddenHistoryIds, setHiddenHistoryIds] = useState<string[]>(() =>
    readHiddenConversationIdsFromStorage()
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() =>
    readSidebarCollapsedFromStorage()
  );
  const isCompactViewport = useCompactViewport(960);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [pinnedHistoryOrder, setPinnedHistoryOrder] = useState<string[]>(() =>
    readPinnedHistoryOrderFromStorage()
  );
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [editingConversationTitle, setEditingConversationTitle] = useState('');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [restoringConversationId, setRestoringConversationId] = useState<string | null>(null);
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [historyContextMenu, setHistoryContextMenu] = useState<HistoryContextMenuState | null>(null);
  const [historyContextMenuActiveIndex, setHistoryContextMenuActiveIndex] = useState(0);
  const [longPressingConversationId, setLongPressingConversationId] = useState<string | null>(null);
  const [draggingPinnedConversationId, setDraggingPinnedConversationId] = useState<string | null>(null);
  const [dragOverPinnedConversationId, setDragOverPinnedConversationId] = useState<string | null>(null);
  const [attachmentListExpanded, setAttachmentListExpanded] = useState(false);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [draggingSelectedAttachmentId, setDraggingSelectedAttachmentId] = useState<string | null>(null);
  const [dragOverSelectedAttachmentId, setDragOverSelectedAttachmentId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [error, setError] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const [llmView, setLlmView] = useState<LlmConfigView | null>(null);
  const [notice, setNotice] = useState('');
  const hiddenHistoryIdsRef = useRef<string[]>(hiddenHistoryIds);
  const pinnedHistoryOrderRef = useRef<string[]>(pinnedHistoryOrder);
  const attachmentsSignatureRef = useRef(buildConversationAttachmentsSignature([]));
  const historyMenuButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const uploadFileInputRef = useRef<HTMLInputElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const historyLongPressTimerRef = useRef<number | null>(null);
  const historyLongPressTriggeredRef = useRef(false);
  const autoConversationFollowUpRef = useRef<{
    armed: boolean;
    baselineMessageId: string | null;
    inFlight: boolean;
  }>({
    armed: false,
    baselineMessageId: null,
    inFlight: false
  });

  useEffect(() => {
    document.body.classList.add('workspace-immersive-lock');
    return () => {
      document.body.classList.remove('workspace-immersive-lock');
    };
  }, []);

  const refreshLlmConfig = useCallback(async () => {
    const config = await api.getLlmConfig();
    setLlmView(config);
  }, []);

  const refreshAttachments = useCallback(async () => {
    const result = await api.listConversationAttachments();
    const nextSignature = buildConversationAttachmentsSignature(result);
    if (attachmentsSignatureRef.current !== nextSignature) {
      attachmentsSignatureRef.current = nextSignature;
      setAttachments(result);
    }
  }, []);

  const refreshConversations = useCallback(async () => {
    const conversationResults = await api.listConversations();
    const visibleConversationIdSet = new Set(
      conversationResults
        .map((conversation) => conversation.id)
        .filter((conversationId) => typeof conversationId === 'string' && conversationId.trim().length > 0)
    );
    const prunedHiddenHistoryIds = hiddenHistoryIdsRef.current.filter((conversationId) =>
      visibleConversationIdSet.has(conversationId)
    );
    if (prunedHiddenHistoryIds.length !== hiddenHistoryIdsRef.current.length) {
      hiddenHistoryIdsRef.current = prunedHiddenHistoryIds;
      setHiddenHistoryIds(prunedHiddenHistoryIds);
    }
    setHistory((previous) =>
      mergeHistoryWithConversations(
        conversationResults,
        previous,
        prunedHiddenHistoryIds,
        pinnedHistoryOrderRef.current
      )
    );
  }, []);

  const clearWorkspaceForAnonymousSession = useCallback(() => {
    autoConversationFollowUpRef.current = {
      armed: false,
      baselineMessageId: null,
      inFlight: false
    };
    attachmentsSignatureRef.current = buildConversationAttachmentsSignature([]);
    setCurrentUser(null);
    setModels([]);
    setSelectedModelId('');
    setConversation(null);
    setMessages([]);
    setAttachments([]);
    setSelectedAttachmentIds([]);
    setAttachmentListExpanded(false);
    setSending(false);
    setUploading(false);
  }, []);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);

    try {
      const user = await api.me();
      setCurrentUser(user);
      setAuthRequired(false);

      const [modelResults] = await Promise.all([
        api.listModels(),
        refreshAttachments(),
        refreshLlmConfig(),
        refreshConversations()
      ]);

      setModels(modelResults);
      setSelectedModelId((current) => {
        if (modelResults.length === 0) {
          return '';
        }

        return current && modelResults.some((model) => model.id === current)
          ? current
          : modelResults[0].id;
      });
      setError('');
    } catch (loadError) {
      const message = (loadError as Error).message;
      if (isAuthenticationRequiredMessage(message)) {
        clearWorkspaceForAnonymousSession();
        setAuthRequired(true);
        setError('');
        return;
      }

      setError(message);
    } finally {
      setLoading(false);
    }
  }, [clearWorkspaceForAnonymousSession, refreshAttachments, refreshConversations, refreshLlmConfig]);

  useEffect(() => {
    loadWorkspace().catch(() => {
      // handled by local state
    });
  }, [loadWorkspace]);

  useEffect(() => {
    const handleWorkspaceUpdate = () => {
      loadWorkspace().catch(() => {
        // Keep current state on transient errors.
      });
    };

    window.addEventListener(LLM_CONFIG_UPDATED_EVENT, handleWorkspaceUpdate as EventListener);
    window.addEventListener(AUTH_UPDATED_EVENT, handleWorkspaceUpdate as EventListener);

    return () => {
      window.removeEventListener(LLM_CONFIG_UPDATED_EVENT, handleWorkspaceUpdate as EventListener);
      window.removeEventListener(AUTH_UPDATED_EVENT, handleWorkspaceUpdate as EventListener);
    };
  }, [loadWorkspace]);

  useEffect(() => {
    writeHistoryToStorage(history);
  }, [history]);

  useEffect(() => {
    hiddenHistoryIdsRef.current = hiddenHistoryIds;
    writeHiddenConversationIdsToStorage(hiddenHistoryIds);
  }, [hiddenHistoryIds]);

  useEffect(() => {
    writeSidebarCollapsedToStorage(sidebarCollapsed);
  }, [sidebarCollapsed]);

  useEffect(() => {
    pinnedHistoryOrderRef.current = pinnedHistoryOrder;
    writePinnedHistoryOrderToStorage(pinnedHistoryOrder);
  }, [pinnedHistoryOrder]);

  useEffect(() => {
    if (!isCompactViewport) {
      setMobileSidebarOpen(false);
    }
  }, [isCompactViewport]);

  useEffect(() => {
    if (!isCompactViewport || !mobileSidebarOpen) {
      document.body.style.removeProperty('overflow');
      return;
    }

    document.body.style.setProperty('overflow', 'hidden');
    return () => {
      document.body.style.removeProperty('overflow');
    };
  }, [isCompactViewport, mobileSidebarOpen]);

  useEffect(() => {
    setPinnedHistoryOrder((previous) => {
      const next = reconcilePinnedHistoryOrder(history, previous);
      return arraysEqual(previous, next) ? previous : next;
    });
  }, [history]);

  useEffect(() => {
    setVisibleMessageCount(messageRenderBatchSize);
  }, [conversation?.id]);

  useEffect(() => {
    setVisibleMessageCount((previous) => {
      if (messages.length <= 0) {
        return messageRenderBatchSize;
      }

      const normalizedPrevious = previous > 0 ? previous : messageRenderBatchSize;
      return Math.min(messages.length, normalizedPrevious);
    });
  }, [messages.length]);

  useEffect(
    () => () => {
      if (historyLongPressTimerRef.current !== null) {
        window.clearTimeout(historyLongPressTimerRef.current);
        historyLongPressTimerRef.current = null;
      }
    },
    []
  );

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timer = window.setTimeout(() => {
      setNotice('');
    }, 2200);

    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = '0px';
    const nextScrollHeight = textarea.scrollHeight;
    const nextHeight = Math.max(44, Math.min(nextScrollHeight, 180));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = nextScrollHeight > 180 ? 'auto' : 'hidden';
  }, [input]);

  const attachmentById = useMemo(
    () => new Map(attachments.map((item) => [item.id, item])),
    [attachments]
  );
  const selectedAttachments = useMemo(
    () =>
      selectedAttachmentIds
        .map((itemId) => attachmentById.get(itemId))
        .filter((item): item is FileAttachment => Boolean(item)),
    [attachmentById, selectedAttachmentIds]
  );
  const readyAttachmentIds = useMemo(
    () => attachments.filter((item) => item.status === 'ready').map((item) => item.id),
    [attachments]
  );
  const selectedReadyAttachmentIds = useMemo(
    () => selectedAttachments.filter((item) => item.status === 'ready').map((item) => item.id),
    [selectedAttachments]
  );
  const selectedAttachmentIdSet = useMemo(
    () => new Set(selectedAttachmentIds),
    [selectedAttachmentIds]
  );
  const hasPendingSelectedAttachments = useMemo(
    () => selectedAttachments.some((item) => item.status !== 'ready'),
    [selectedAttachments]
  );

  const attachmentStatusSummary = useMemo<AttachmentStatusSummary>(() => {
    const summary: AttachmentStatusSummary = {
      uploading: 0,
      processing: 0,
      ready: 0,
      error: 0
    };

    attachments.forEach((item) => {
      summary[item.status] += 1;
    });

    return summary;
  }, [attachments]);

  const visibleMessages = useMemo(() => {
    if (messages.length <= visibleMessageCount) {
      return messages;
    }

    return messages.slice(-visibleMessageCount);
  }, [messages, visibleMessageCount]);

  const hiddenMessageCount = useMemo(
    () => Math.max(0, messages.length - visibleMessages.length),
    [messages.length, visibleMessages.length]
  );

  const loadEarlierMessages = useCallback(() => {
    if (messages.length <= visibleMessageCount) {
      return;
    }

    startTransition(() => {
      setVisibleMessageCount((previous) => {
        const normalizedPrevious = Math.max(messageRenderBatchSize, previous);
        return Math.min(messages.length, normalizedPrevious + messageRenderBatchSize);
      });
    });
  }, [messages.length, visibleMessageCount]);

  useBackgroundPolling(
    () => {
      refreshAttachments().catch(() => {
        // Keep UI stable in polling loop; explicit errors are reported by direct actions.
      });
    },
    {
      intervalMs: backgroundRefreshIntervalMs,
      enabled:
        Boolean(currentUser) &&
        (attachmentStatusSummary.uploading > 0 || attachmentStatusSummary.processing > 0)
    }
  );

  useEffect(() => {
    setSelectedAttachmentIds((previous) => {
      const availableIdSet = new Set(attachments.map((item) => item.id));
      const next = previous.filter((itemId) => availableIdSet.has(itemId));
      return arraysEqual(previous, next) ? previous : next;
    });
  }, [attachments]);

  const llmModeText = useMemo(() => {
    if (!llmView || !llmView.enabled || !llmView.has_api_key) {
      return t('Compatibility mode');
    }

    return `${llmView.provider} · ${llmView.model} · ${llmView.api_key_masked}`;
  }, [llmView, t]);

  const formatConversationActionLabel = useCallback(
    (action: ConversationActionMetadata['action']) => {
      if (action === 'create_dataset') {
        return t('Create Dataset');
      }
      if (action === 'create_training_job') {
        return t('Create Training Job');
      }
      if (action === 'run_model_inference') {
        return t('Run Inference');
      }
      if (action === 'console_api_call') {
        return t('Console API');
      }
      return t('Create Model');
    },
    [t]
  );

  const formatConversationActionStatusLabel = useCallback(
    (status: ConversationActionMetadata['status']) => {
      if (status === 'requires_input') {
        return t('Needs More Info');
      }
      if (status === 'completed') {
        return t('Completed');
      }
      if (status === 'cancelled') {
        return t('Cancelled');
      }
      return t('Failed');
    },
    [t]
  );

  const formatConversationActionFieldLabel = useCallback(
    (field: string) => {
      if (field === 'dataset_id') {
        return t('Dataset');
      }
      if (field === 'dataset_name') {
        return t('Dataset');
      }
      if (field === 'dataset_reference') {
        return t('Dataset');
      }
      if (field === 'task_type') {
        return t('Task Type');
      }
      if (field === 'model_type') {
        return t('Model Type');
      }
      if (field === 'framework') {
        return t('Framework');
      }
      if (field === 'base_model') {
        return t('Base model');
      }
      if (field === 'label_classes') {
        return t('Label Classes');
      }
      if (field === 'name') {
        return t('Name');
      }
      if (field === 'description') {
        return t('Description');
      }
      if (field === 'visibility') {
        return t('Visibility');
      }
      if (field === 'dataset_version_id') {
        return t('Dataset Version');
      }
      if (field === 'training_job_id' || field === 'job_id') {
        return t('Training Job');
      }
      if (field === 'epochs') {
        return t('Epochs');
      }
      if (field === 'batch_size') {
        return t('Batch Size');
      }
      if (field === 'learning_rate') {
        return t('Learning Rate');
      }
      if (field === 'warmup_ratio') {
        return t('Warmup Ratio');
      }
      if (field === 'weight_decay') {
        return t('Weight Decay');
      }
      if (field === 'annotation_id') {
        return t('Annotation');
      }
      if (field === 'dataset_item_id') {
        return t('Dataset Item');
      }
      if (field === 'model_id') {
        return t('Model');
      }
      if (field === 'model_name') {
        return t('Model');
      }
      if (field === 'model_version_id') {
        return t('Model Version');
      }
      if (field === 'orchestration_mode') {
        return t('Orchestration mode');
      }
      if (field === 'orchestration_strategy') {
        return t('Orchestration strategy');
      }
      if (field === 'model_auto_created') {
        return t('Auto-created model');
      }
      if (field === 'dataset_auto_selected') {
        return t('Auto-selected dataset');
      }
      if (field === 'dataset_version_auto_selected') {
        return t('Auto-selected dataset version');
      }
      if (field === 'dataset_version_auto_created') {
        return t('Auto-created dataset version');
      }
      if (field === 'split_auto_applied') {
        return t('Auto split');
      }
      if (field === 'pre_annotation_auto_applied') {
        return t('Auto pre-annotation');
      }
      if (field === 'feedback_dataset_id') {
        return t('Feedback Dataset');
      }
      if (field === 'profile_id') {
        return t('Runtime Profile');
      }
      if (field === 'overwrite_endpoint') {
        return t('Overwrite endpoints');
      }
      if (field === 'inference_run_id') {
        return t('Inference Run');
      }
      if (field === 'run_id') {
        return t('Inference Run');
      }
      if (field === 'execution_source') {
        return t('Execution Status');
      }
      if (field === 'registration_evidence_mode') {
        return t('Evidence mode');
      }
      if (field === 'registration_evidence_level') {
        return t('Evidence mode');
      }
      if (field === 'registration_gate_exempted') {
        return t('Gate status');
      }
      if (field === 'registration_gate_status') {
        return t('Gate status');
      }
      if (field === 'registration_gate_exemption_reason') {
        return t('Gate exemption reason');
      }
      return field;
    },
    [t]
  );

  const formatConversationActionFieldValue = useCallback(
    (field: string, value: unknown): string => {
      if (field === 'execution_source') {
        const source = typeof value === 'string' ? value.trim() : '';
        if (!source) {
          return t('Unknown execution');
        }
        return isFallbackExecutionSource(source) ? t('Restricted mode') : t('Standard execution');
      }
      if (field === 'registration_evidence_mode' || field === 'registration_evidence_level') {
        const evidenceLevel = resolveRegistrationEvidenceLevel(value);
        if (evidenceLevel === 'standard') {
          return t('Standard evidence');
        }
        if (evidenceLevel === 'calibrated') {
          return t('Calibrated evidence');
        }
        if (evidenceLevel === 'compatibility') {
          return t('Compatibility evidence');
        }
        return t('Pending evidence');
      }
      if (field === 'registration_gate_exempted' || field === 'registration_gate_status') {
        let gateExempted: boolean | undefined;
        if (typeof value === 'string') {
          const normalized = value.trim().toLowerCase();
          if (normalized === 'true' || normalized === '1') {
            gateExempted = true;
          } else if (normalized === 'false' || normalized === '0') {
            gateExempted = false;
          } else {
            gateExempted = undefined;
          }
        } else if (typeof value === 'boolean') {
          gateExempted = value;
        } else {
          gateExempted = undefined;
        }
        const gateLevel = resolveRegistrationGateLevel({
          registration_gate_status: field === 'registration_gate_status' ? value : undefined,
          registration_gate_exempted: gateExempted
        });
        if (gateLevel === 'override') {
          return t('Policy override');
        }
        if (gateLevel === 'standard') {
          return t('Standard gate');
        }
        return t('Gate pending');
      }
      if (field === 'orchestration_mode') {
        const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
        if (normalized === 'full_pipeline') {
          return t('Full pipeline');
        }
        if (normalized === 'training_only') {
          return t('Training only');
        }
        return normalized || t('Unknown');
      }
      if (field === 'orchestration_strategy') {
        const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
        if (normalized === 'conservative') {
          return t('Conservative');
        }
        if (normalized === 'standard') {
          return t('Standard');
        }
        if (normalized === 'aggressive') {
          return t('Aggressive');
        }
        return normalized || t('Unknown');
      }
      if (
        field === 'model_auto_created' ||
        field === 'dataset_auto_selected' ||
        field === 'dataset_version_auto_selected' ||
        field === 'dataset_version_auto_created' ||
        field === 'split_auto_applied' ||
        field === 'pre_annotation_auto_applied'
      ) {
        const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
        if (normalized === 'true' || normalized === '1') {
          return t('Yes');
        }
        if (normalized === 'false' || normalized === '0') {
          return t('No');
        }
        return t('Unknown');
      }
      if (typeof value === 'string') {
        return value;
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
      if (value === null || value === undefined) {
        return '';
      }
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    },
    [t]
  );

  const resolveMessageAttachmentNames = useCallback(
    (message: MessageRecord) =>
      message.attachment_ids.map((attachmentId) => attachmentById.get(attachmentId)?.filename ?? attachmentId),
    [attachmentById]
  );

  const resolveLatestAssistantActionMessage = useCallback(
    (messageList: MessageRecord[]): MessageRecord | null => {
      for (let index = messageList.length - 1; index >= 0; index -= 1) {
        const candidate = messageList[index];
        if (candidate.sender !== 'assistant') {
          continue;
        }
        if (candidate.metadata?.conversation_action) {
          return candidate;
        }
      }
      return null;
    },
    []
  );

  const resolveConversationActionHref = useCallback(
    (action: ConversationActionMetadata) => {
      if (!action.created_entity_type || !action.created_entity_id) {
        return null;
      }

      const appendReturnTo = (base: string): string => {
        const returnTo = currentConversationPath.trim();
        if (!returnTo || !returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.includes('://')) {
          return base;
        }
        const searchParams = new URLSearchParams();
        searchParams.set('return_to', returnTo);
        return `${base}?${searchParams.toString()}`;
      };

      if (action.created_entity_type === 'Dataset') {
        return appendReturnTo(`${actionRouteByEntityType.Dataset}/${action.created_entity_id}`);
      }

      if (action.created_entity_type === 'TrainingJob') {
        return appendReturnTo(`${actionRouteByEntityType.TrainingJob}/${action.created_entity_id}`);
      }

      if (action.created_entity_type === 'Model') {
        const searchParams = new URLSearchParams();
        searchParams.set('model', action.created_entity_id);
        return appendReturnTo(`${actionRouteByEntityType.Model}?${searchParams.toString()}`);
      }

      if (action.created_entity_type === 'VisionTask') {
        return appendReturnTo(`${actionRouteByEntityType.VisionTask}/${action.created_entity_id}`);
      }

      return appendReturnTo(actionRouteByEntityType.Model);
    },
    [currentConversationPath]
  );

  const resolveConversationActionLinks = useCallback(
    (action: ConversationActionMetadata): Array<{ label: string; href: string }> => {
      const api = action.collected_fields.api ?? '';
      let payloadParams: Record<string, unknown> = {};
      const rawPayload = action.collected_fields.payload_json ?? '';
      if (action.action === 'console_api_call' && rawPayload) {
        try {
          const parsed = JSON.parse(rawPayload) as { params?: Record<string, unknown> };
          if (parsed.params && typeof parsed.params === 'object') {
            payloadParams = parsed.params;
          }
        } catch {
          payloadParams = {};
        }
      }

      const readParam = (...keys: string[]): string => {
        for (const key of keys) {
          const value =
            (action.action === 'console_api_call' ? payloadParams[key] : undefined) ??
            action.collected_fields[key];
          if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
          }
        }
        return '';
      };

      const datasetId = readParam('dataset_id', 'datasetId');
      const datasetVersionId = readParam('dataset_version_id', 'datasetVersionId', 'version_id', 'versionId');
      const modelVersionId = readParam('model_version_id', 'modelVersionId');
      const modelId = readParam('model_id', 'modelId');
      const trainingJobId = readParam('training_job_id', 'trainingJobId', 'job_id', 'jobId');
      const visionTaskId = readParam('vision_task_id', 'task_id', 'visionTaskId', 'taskId');
      const inferenceRunId = readParam('inference_run_id', 'inferenceRunId', 'run_id', 'runId');
      const feedbackDatasetId = readParam('feedback_dataset_id', 'feedbackDatasetId');
      const taskType = readParam('task_type', 'taskType');
      const framework = readParam('framework', 'profile');
      const executionTarget = readParam('execution_target', 'executionTarget');
      const workerId = readParam('worker_id', 'worker', 'workerId');
      const normalizedTaskFilter = (() => {
        const value = taskType.trim().toLowerCase();
        return value === 'ocr' ||
          value === 'detection' ||
          value === 'classification' ||
          value === 'segmentation' ||
          value === 'obb'
          ? value
          : '';
      })();
      const normalizedFrameworkFilter = (() => {
        const value = framework.trim().toLowerCase();
        return value === 'yolo' || value === 'paddleocr' || value === 'doctr' ? value : '';
      })();

      const appendTrainingLaunchContext = (searchParams: URLSearchParams) => {
        if (datasetId && !searchParams.has('dataset')) {
          searchParams.set('dataset', datasetId);
        }
        if (datasetVersionId && !searchParams.has('version')) {
          searchParams.set('version', datasetVersionId);
        }
        if (taskType && !searchParams.has('task_type')) {
          searchParams.set('task_type', taskType);
        }
        if (framework && !searchParams.has('framework')) {
          searchParams.set('framework', framework);
        }
        if (executionTarget && executionTarget !== 'auto' && !searchParams.has('execution_target')) {
          searchParams.set('execution_target', executionTarget);
        }
        if (workerId && !searchParams.has('worker')) {
          searchParams.set('worker', workerId);
        }
        const returnTo = currentConversationPath.trim();
        if (
          returnTo &&
          returnTo.startsWith('/') &&
          !returnTo.startsWith('//') &&
          !returnTo.includes('://') &&
          !searchParams.has('return_to')
        ) {
          searchParams.set('return_to', returnTo);
        }
      };

      const buildPath = (base: string, params?: Record<string, string | null | undefined>): string => {
        const searchParams = new URLSearchParams();
        Object.entries(params ?? {}).forEach(([key, value]) => {
          if (typeof value === 'string' && value.trim().length > 0) {
            searchParams.set(key, value.trim());
          }
        });
        appendTrainingLaunchContext(searchParams);
        const query = searchParams.toString();
        return query ? `${base}?${query}` : base;
      };

      const datasetsLandingPath = buildPath('/datasets');
      const datasetDetailPath = datasetId
        ? buildPath(`/datasets/${encodeURIComponent(datasetId)}`, {
            version: datasetVersionId || null
          })
        : datasetsLandingPath;
      const annotationWorkspacePath = datasetId
        ? buildPath(`/datasets/${encodeURIComponent(datasetId)}/annotate`, {
            version: datasetVersionId || null
          })
        : datasetsLandingPath;
      const trainingJobsPath = buildPath('/training/jobs', {
        task_filter: normalizedTaskFilter || null,
        framework_filter: normalizedFrameworkFilter || null
      });
      const modelVersionsPath = buildPath('/models/versions', {
        selectedVersion: modelVersionId || null,
        focus: modelVersionId ? 'device' : null,
        task_filter: normalizedTaskFilter || null,
        framework_filter: normalizedFrameworkFilter || null
      });
      const myModelsPath = buildPath('/models/my-models', {
        model: modelId || null
      });
      const trainingJobDetailPath = trainingJobId
        ? buildPath(`/training/jobs/${encodeURIComponent(trainingJobId)}`, {
            drawer: 'open'
          })
        : trainingJobsPath;
      const modelVersionDetailPath = modelVersionId
        ? buildPath('/models/versions', {
            selectedVersion: modelVersionId,
            drawer: 'open',
            task_filter: normalizedTaskFilter || null,
            framework_filter: normalizedFrameworkFilter || null
          })
        : modelVersionsPath;
      const inferenceValidationPath = buildPath('/inference/validate', {
        modelVersion: modelVersionId || null
      });
      const inferenceRunDetailPath = inferenceRunId
        ? buildPath('/inference/validate', {
            run: inferenceRunId,
            modelVersion: modelVersionId || null
          })
        : inferenceValidationPath;
      const closurePath = datasetId
        ? buildPath('/workflow/closure', {
            dataset: datasetId,
            version: datasetVersionId || null
          })
        : buildPath('/workflow/closure');
      const runtimeSettingsPath = buildPath('/settings/runtime', {
        focus: 'readiness',
        framework: framework || null
      });
      const feedbackDatasetPath = feedbackDatasetId
        ? buildPath(`/datasets/${encodeURIComponent(feedbackDatasetId)}`)
        : datasetDetailPath;
      const modelDraftPath = buildPath('/models/create', {
        task_type: taskType || null,
        job: trainingJobId || null,
        version_name: readParam('version_name', 'versionName', 'name') || null
      });
      const trainingCreatePath = buildPath('/training/jobs/new');
      const visionTasksPath = buildPath('/vision/tasks');
      const visionTaskDetailPath = visionTaskId
        ? buildPath(`/vision/tasks/${encodeURIComponent(visionTaskId)}`)
        : visionTasksPath;

      const linkMap: Record<string, Array<{ label: string; href: string }>> = {
        list_datasets: [{ label: t('Open Datasets'), href: datasetsLandingPath }],
        create_dataset: [
          { label: t('Open Dataset Detail'), href: datasetDetailPath },
          { label: t('Open Datasets'), href: datasetsLandingPath }
        ],
        create_dataset_version: [
          { label: t('Open Dataset Detail'), href: datasetDetailPath },
          { label: t('Open Datasets'), href: datasetsLandingPath }
        ],
        list_dataset_annotations: [{ label: t('Open Annotation Workspace'), href: annotationWorkspacePath }],
        export_dataset_annotations: [{ label: t('Open Annotation Workspace'), href: annotationWorkspacePath }],
        import_dataset_annotations: [{ label: t('Open Annotation Workspace'), href: annotationWorkspacePath }],
        upsert_dataset_annotation: [{ label: t('Open Annotation Workspace'), href: annotationWorkspacePath }],
        review_dataset_annotation: [{ label: t('Open Annotation Workspace'), href: annotationWorkspacePath }],
        run_dataset_pre_annotations: [{ label: t('Open Annotation Workspace'), href: annotationWorkspacePath }],
        list_training_jobs: [{ label: t('Open Training Jobs'), href: trainingJobsPath }],
        create_training_job: [
          { label: t('Open Job'), href: trainingJobDetailPath },
          { label: t('Open Training Jobs'), href: trainingJobsPath }
        ],
        cancel_training_job: [
          { label: t('Open Job'), href: trainingJobDetailPath },
          { label: t('Open Training Jobs'), href: trainingJobsPath }
        ],
        retry_training_job: [
          { label: t('Open Job'), href: trainingJobDetailPath },
          { label: t('Open Training Jobs'), href: trainingJobsPath }
        ],
        list_vision_tasks: [{ label: t('Open Vision Tasks'), href: visionTasksPath }],
        get_vision_task: [{ label: t('Open Vision Task'), href: visionTaskDetailPath }],
        auto_continue_vision_task: [
          { label: t('Open Vision Task'), href: visionTaskDetailPath },
          { label: t('Open Job'), href: trainingJobDetailPath }
        ],
        auto_advance_vision_task: [
          { label: t('Open Vision Task'), href: visionTaskDetailPath },
          { label: t('Open Job'), href: trainingJobDetailPath },
          { label: t('Open Version Controls'), href: modelVersionDetailPath },
          { label: t('Open feedback dataset'), href: feedbackDatasetPath }
        ],
        generate_vision_task_feedback_dataset: [
          { label: t('Open Vision Task'), href: visionTaskDetailPath },
          { label: t('Open feedback dataset'), href: feedbackDatasetPath }
        ],
        register_vision_task_model: [
          { label: t('Open Vision Task'), href: visionTaskDetailPath },
          { label: t('Open Version Controls'), href: modelVersionDetailPath }
        ],
        list_model_versions: [{ label: t('Open Model Versions'), href: modelVersionsPath }],
        register_model_version: [
          { label: t('Open Version Controls'), href: modelVersionDetailPath },
          { label: t('Open Model Versions'), href: modelVersionsPath }
        ],
        run_inference: [
          {
            label: t('View full detail'),
            href: inferenceRunDetailPath
          },
          {
            label: t('Open Inference Validation'),
            href: inferenceValidationPath
          }
        ],
        send_inference_feedback: [
          {
            label: t('View full detail'),
            href: inferenceRunDetailPath
          },
          { label: t('Open Inference Validation'), href: inferenceValidationPath }
        ],
        activate_runtime_profile: [{ label: t('Open Runtime Settings'), href: runtimeSettingsPath }],
        auto_configure_runtime_settings: [{ label: t('Open Runtime Settings'), href: runtimeSettingsPath }],
        list_models: [{ label: t('Open My Models'), href: myModelsPath }],
        create_model_draft: [
          { label: t('Open My Models'), href: myModelsPath },
          { label: t('Create model draft'), href: modelDraftPath }
        ],
        submit_approval_request: [{ label: t('Open My Models'), href: myModelsPath }]
      };

      const requiresInputFieldSet = new Set(
        (action.missing_fields ?? []).map((field) => field.trim()).filter(Boolean)
      );
      const requiresInputLinks: Array<{ label: string; href: string }> = [];
      const pushRequiresInputLink = (label: string, href: string) => {
        if (!href || !href.startsWith('/')) {
          return;
        }
        requiresInputLinks.push({ label, href });
      };
      if (action.status === 'requires_input' && requiresInputFieldSet.size > 0) {
        for (const field of requiresInputFieldSet) {
          if (field.startsWith('dataset_issue:')) {
            pushRequiresInputLink(t('Open Dataset Detail'), datasetDetailPath);
            pushRequiresInputLink(t('Open Annotation Workspace'), annotationWorkspacePath);
            continue;
          }
          if (field === 'dataset_id') {
            pushRequiresInputLink(t('Open Datasets'), datasetsLandingPath);
            continue;
          }
          if (field === 'dataset_version_id') {
            pushRequiresInputLink(t('Open Dataset Detail'), datasetDetailPath);
            continue;
          }
          if (
            field === 'task_type' ||
            field === 'framework' ||
            field === 'base_model' ||
            field === 'name' ||
            field === 'version_name'
          ) {
            pushRequiresInputLink(t('Create Training Job'), trainingCreatePath);
            continue;
          }
          if (field === 'model_id' || field === 'model_type' || field === 'visibility') {
            pushRequiresInputLink(t('Open My Models'), myModelsPath);
            pushRequiresInputLink(t('Create model draft'), modelDraftPath);
            continue;
          }
          if (field === 'model_version_id' || field === 'source_model_version_id') {
            pushRequiresInputLink(t('Open Model Versions'), modelVersionsPath);
            continue;
          }
          if (field === 'training_job_id' || field === 'job_id') {
            pushRequiresInputLink(t('Open Training Jobs'), trainingJobsPath);
            continue;
          }
          if (field === 'run_id' || field === 'inference_run_id') {
            pushRequiresInputLink(t('Open Inference Validation'), inferenceValidationPath);
            continue;
          }
          if (field === 'vision_task_id' || field === 'task_id') {
            pushRequiresInputLink(t('Open Vision Tasks'), visionTasksPath);
            pushRequiresInputLink(t('Open Vision Task'), visionTaskDetailPath);
            continue;
          }
          if (field === 'attachment_id' || field === 'input_attachment_id') {
            pushRequiresInputLink(t('Conversation Workspace'), buildPath('/workspace/chat'));
            continue;
          }
          if (
            field === 'dataset_item_id' ||
            field === 'annotation_id' ||
            field === 'status' ||
            field === 'source'
          ) {
            pushRequiresInputLink(t('Open Annotation Workspace'), annotationWorkspacePath);
            continue;
          }
          if (field === 'profile_id') {
            pushRequiresInputLink(t('Open Runtime Settings'), runtimeSettingsPath);
            continue;
          }
        }
      }
      if (action.status === 'requires_input' && requiresInputLinks.length > 0) {
        if (action.action === 'console_api_call') {
          return [...requiresInputLinks, ...(linkMap[api] ?? [])];
        }
        return requiresInputLinks;
      }

      if (action.action === 'console_api_call') {
        return linkMap[api] ?? [];
      }
      if (action.action === 'create_dataset') {
        return [
          { label: t('Open Dataset Detail'), href: datasetDetailPath },
          { label: t('Open Annotation Workspace'), href: annotationWorkspacePath },
          { label: t('Create Training Job'), href: trainingCreatePath }
        ];
      }
      if (action.action === 'create_training_job') {
        return [
          { label: t('Open Job'), href: trainingJobDetailPath },
          { label: t('Open closure lane'), href: closurePath },
          { label: t('Open Training Jobs'), href: trainingJobsPath }
        ];
      }
      if (action.action === 'create_model_draft') {
        return [
          { label: t('Create model draft'), href: modelDraftPath },
          { label: t('Open My Models'), href: buildPath('/models/my-models') },
          { label: t('Open Model Versions'), href: modelVersionsPath }
        ];
      }
      if (action.action === 'run_model_inference') {
        return [
          { label: t('View full detail'), href: inferenceRunDetailPath },
          { label: t('Open Inference Validation'), href: inferenceValidationPath },
          { label: t('Open feedback dataset'), href: feedbackDatasetPath },
          { label: t('Open closure lane'), href: closurePath }
        ];
      }
      return [];
    },
    [currentConversationPath, t]
  );
  const resolveConversationActionFieldHref = useCallback(
    (action: ConversationActionMetadata, field: string, value: unknown): string | null => {
      const normalizedValue = typeof value === 'string' ? value.trim() : '';
      if (!normalizedValue) {
        return null;
      }
      const appendReturnTo = (base: string): string => appendReturnToPath(base, currentConversationPath);
      const datasetIdFromAction =
        action.collected_fields.dataset_id?.trim() || action.collected_fields.datasetId?.trim() || '';
      const modelVersionIdFromAction =
        action.collected_fields.model_version_id?.trim() ||
        action.collected_fields.modelVersionId?.trim() ||
        '';

      if (field === 'dataset_id' || field === 'dataset_reference' || field === 'feedback_dataset_id') {
        return appendReturnTo(`/datasets/${encodeURIComponent(normalizedValue)}`);
      }

      if (field === 'dataset_version_id') {
        if (!datasetIdFromAction) {
          return appendReturnTo('/datasets');
        }
        const searchParams = new URLSearchParams();
        searchParams.set('version', normalizedValue);
        return appendReturnTo(`/datasets/${encodeURIComponent(datasetIdFromAction)}?${searchParams.toString()}`);
      }

      if (field === 'training_job_id' || field === 'job_id') {
        return appendReturnTo(`/training/jobs/${encodeURIComponent(normalizedValue)}`);
      }

      if (field === 'vision_task_id' || field === 'task_id') {
        return appendReturnTo(`/vision/tasks/${encodeURIComponent(normalizedValue)}`);
      }

      if (field === 'model_id') {
        const searchParams = new URLSearchParams();
        searchParams.set('model', normalizedValue);
        return appendReturnTo(`/models/my-models?${searchParams.toString()}`);
      }

      if (field === 'model_version_id') {
        const searchParams = new URLSearchParams();
        searchParams.set('selectedVersion', normalizedValue);
        searchParams.set('focus', 'device');
        return appendReturnTo(`/models/versions?${searchParams.toString()}`);
      }
      if (
        (field === 'registration_evidence_mode' ||
          field === 'registration_evidence_level' ||
          field === 'registration_gate_status' ||
          field === 'registration_gate_exempted' ||
          field === 'registration_gate_exemption_reason') &&
        modelVersionIdFromAction
      ) {
        const searchParams = new URLSearchParams();
        searchParams.set('selectedVersion', modelVersionIdFromAction);
        searchParams.set('drawer', 'open');
        return appendReturnTo(`/models/versions?${searchParams.toString()}`);
      }

      if (field === 'inference_run_id' || field === 'run_id') {
        const searchParams = new URLSearchParams();
        searchParams.set('run', normalizedValue);
        searchParams.set('focus', 'result');
        if (modelVersionIdFromAction) {
          searchParams.set('modelVersion', modelVersionIdFromAction);
        }
        return appendReturnTo(`/inference/validate?${searchParams.toString()}`);
      }

      return null;
    },
    [currentConversationPath]
  );

  const upsertHistoryItem = useCallback((id: string, seedText: string) => {
    setHistory((previous) => {
      const existing = previous.find((item) => item.id === id);
      const next: LocalChatHistoryItem = {
        id,
        title: buildHistoryTitle(seedText),
        updated_at: new Date().toISOString(),
        pinned: existing?.pinned ?? false
      };

      const withoutCurrent = previous.filter((item) => item.id !== id);
      return sortHistoryItems([next, ...withoutCurrent], pinnedHistoryOrderRef.current).slice(0, 40);
    });
  }, []);

  const uploadAttachmentsByFiles = useCallback(async (files: File[]) => {
    const targets = files.filter((item) => item && item.name.trim().length > 0);
    if (targets.length === 0) {
      return;
    }

    const oversized = findOversizedUpload(targets);
    if (oversized) {
      setAttachmentListExpanded(true);
      setError(
        t('File {filename} is {size}. Keep each file under {limit} to avoid proxy rejection (413).', {
          filename: oversized.name,
          size: formatByteSize(oversized.size),
          limit: UPLOAD_SOFT_LIMIT_LABEL
        })
      );
      return;
    }

    setUploading(true);
    setError('');

    try {
      const uploadedAttachmentIds: string[] = [];
      for (const file of targets) {
        const uploaded = await api.uploadConversationFile(file);
        uploadedAttachmentIds.push(uploaded.id);
      }
      await refreshAttachments();
      setSelectedAttachmentIds((previous) =>
        Array.from(new Set([...previous, ...uploadedAttachmentIds]))
      );
      setAttachmentListExpanded(false);
      setNotice(t('{count} file(s) queued for upload.', { count: targets.length }));
    } catch (uploadError) {
      setError((uploadError as Error).message);
    } finally {
      setUploading(false);
    }
  }, [refreshAttachments, t]);

  const uploadAttachmentByFilenameReference = useCallback(async (filename: string) => {
    const normalizedFilename = filename.trim();
    if (!normalizedFilename) {
      setAttachmentListExpanded(true);
      setError(t('Reference filename is required.'));
      return false;
    }

    setUploading(true);
    setError('');

    try {
      const uploaded = await api.uploadConversationAttachment(normalizedFilename);
      await refreshAttachments();
      setSelectedAttachmentIds((previous) =>
        Array.from(new Set([...previous, uploaded.id]))
      );
      setAttachmentListExpanded(false);
      setNotice(
        t('Attachment {filename} included in current message.', {
          filename: uploaded.filename || normalizedFilename
        })
      );
      return true;
    } catch (uploadError) {
      setError((uploadError as Error).message);
      return false;
    } finally {
      setUploading(false);
    }
  }, [refreshAttachments, t]);

  const openUploadFileDialog = useCallback(() => {
    uploadFileInputRef.current?.click();
  }, []);

  const toggleAttachmentTray = useCallback(() => {
    setAttachmentListExpanded((previous) => !previous);
  }, []);

  const onUploadFileInputChange = async (event: ReactChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    if (selected.length === 0) {
      return;
    }

    await uploadAttachmentsByFiles(selected);
  };

  const removeAttachment = useCallback(async (attachmentId: string) => {
    setUploading(true);
    setError('');

    try {
      await api.removeAttachment(attachmentId);
      setSelectedAttachmentIds((previous) => previous.filter((itemId) => itemId !== attachmentId));
      await refreshAttachments();
    } catch (removeError) {
      setError((removeError as Error).message);
    } finally {
      setUploading(false);
    }
  }, [refreshAttachments]);

  const openAttachment = useCallback((attachmentId: string) => {
    window.open(api.attachmentContentUrl(attachmentId), '_blank', 'noopener,noreferrer');
  }, []);

  const includeAttachmentInCurrentMessage = useCallback((attachment: FileAttachment) => {
    if (attachment.status !== 'ready') {
      return;
    }

    if (selectedAttachmentIdSet.has(attachment.id)) {
      setNotice(t('Attachment {filename} already in context.', { filename: attachment.filename }));
      return;
    }

    setSelectedAttachmentIds((previous) => [...previous, attachment.id]);
    setNotice(t('Attachment {filename} included in current message.', { filename: attachment.filename }));
  }, [selectedAttachmentIdSet, t]);

  const excludeAttachmentFromCurrentMessage = useCallback((attachment: FileAttachment) => {
    if (!selectedAttachmentIdSet.has(attachment.id)) {
      return;
    }

    setSelectedAttachmentIds((previous) => previous.filter((itemId) => itemId !== attachment.id));
    setNotice(t('Attachment {filename} removed from current message.', { filename: attachment.filename }));
  }, [selectedAttachmentIdSet, t]);

  const includeAllReadyAttachments = useCallback(() => {
    setSelectedAttachmentIds(readyAttachmentIds);
    setAttachmentListExpanded(false);
    setNotice(t('All ready files are now included in current message.'));
  }, [readyAttachmentIds, t]);

  const clearCurrentAttachmentContext = useCallback(() => {
    setSelectedAttachmentIds([]);
    setNotice(t('Current attachment context has been cleared.'));
  }, [t]);

  const closeMobileSidebar = useCallback(() => {
    setMobileSidebarOpen(false);
  }, []);

  const toggleSidebar = useCallback(() => {
    if (isCompactViewport) {
      setMobileSidebarOpen((previous) => !previous);
      return;
    }

    setSidebarCollapsed((previous) => !previous);
  }, [isCompactViewport]);

  const sendWithContent = async (content: string) => {
    setSending(true);
    setError('');

    try {
      if (!conversation) {
        const modelId = selectedModelId || models[0]?.id;
        if (!modelId) {
          throw new Error(t('No available model found for this account.'));
        }

        const started = await api.startConversation({
          model_id: modelId,
          initial_message: content,
          attachment_ids: selectedReadyAttachmentIds
        });

        setConversation(started.conversation);
        setMessages(started.messages);
        upsertHistoryItem(started.conversation.id, content);
      } else {
        const response = await api.sendConversationMessage({
          conversation_id: conversation.id,
          content,
          attachment_ids: selectedReadyAttachmentIds
        });

        setMessages(response.messages);
        upsertHistoryItem(conversation.id, content);
      }

      setSelectedAttachmentIds([]);
      setAttachmentListExpanded(false);
      refreshConversations().catch(() => {
        // Keep active chat responsive even if sidebar sync fails transiently.
      });
    } catch (sendError) {
      setError((sendError as Error).message);
      throw sendError;
    } finally {
      setSending(false);
    }
  };

  const send = async () => {
    const finalInput = input.trim();
    if (!finalInput) {
      return;
    }

    await sendWithContent(finalInput);
    setInput('');
  };

  const toggleHistoryPin = useCallback((id: string) => {
    const target = history.find((item) => item.id === id);
    if (!target) {
      return;
    }

    const nextPinnedOrder = target.pinned
      ? pinnedHistoryOrder.filter((itemId) => itemId !== id)
      : [id, ...pinnedHistoryOrder.filter((itemId) => itemId !== id)];
    setPinnedHistoryOrder(nextPinnedOrder);
    pinnedHistoryOrderRef.current = nextPinnedOrder;

    setHistory((previous) =>
      sortHistoryItems(
        previous.map((item) => (item.id === id ? { ...item, pinned: !item.pinned } : item)),
        nextPinnedOrder
      )
    );
  }, [history, pinnedHistoryOrder]);

  const beginRenameConversation = useCallback((item: LocalChatHistoryItem) => {
    setEditingConversationId(item.id);
    setEditingConversationTitle(item.title);
    setNotice('');
  }, []);

  const cancelRenameConversation = useCallback(() => {
    setEditingConversationId(null);
    setEditingConversationTitle('');
  }, []);

  const startNewConversation = useCallback(() => {
    autoConversationFollowUpRef.current = {
      armed: false,
      baselineMessageId: null,
      inFlight: false
    };
    setConversation(null);
    setMessages([]);
    cancelRenameConversation();
    setInput('');
    setSelectedAttachmentIds([]);
    setAttachmentListExpanded(false);
    setError('');
    setNotice(t('Started a fresh conversation.'));
    closeMobileSidebar();
  }, [cancelRenameConversation, closeMobileSidebar, t]);

  const saveConversationTitleLocal = useCallback((conversationId: string, nextTitle: string) => {
    setHistory((previous) =>
      sortHistoryItems(
        previous.map((item) =>
          item.id === conversationId ? { ...item, title: nextTitle, updated_at: new Date().toISOString() } : item
        ),
        pinnedHistoryOrderRef.current
      )
    );
  }, []);

  const saveConversationTitle = useCallback(async (conversationId: string) => {
    const normalizedTitle = editingConversationTitle.trim();
    if (!normalizedTitle) {
      setNotice(t('Title cannot be empty.'));
      return;
    }

    setRenamingConversationId(conversationId);
    setError('');

    try {
      const renamedConversation = await api.renameConversation(conversationId, normalizedTitle);
      saveConversationTitleLocal(conversationId, renamedConversation.title);

      if (conversation?.id === conversationId) {
        setConversation((previous) =>
          previous
            ? {
                ...previous,
                title: renamedConversation.title,
                updated_at: renamedConversation.updated_at
              }
            : previous
        );
      }

      cancelRenameConversation();
      setNotice(t('Conversation renamed.'));
      refreshConversations().catch(() => {
        // Keep local state even when background sync is unavailable.
      });
    } catch (renameError) {
      setError((renameError as Error).message);
    } finally {
      setRenamingConversationId(null);
    }
  }, [cancelRenameConversation, conversation?.id, editingConversationTitle, refreshConversations, saveConversationTitleLocal, t]);

  const appendHiddenHistoryIds = useCallback((ids: string[]) => {
    if (ids.length === 0) {
      return;
    }

    setHiddenHistoryIds((previous) => normalizeHiddenConversationIds([...previous, ...ids]));
  }, []);

  const restoreConversation = useCallback(async (conversationId: string) => {
    if (conversation?.id === conversationId) {
      return;
    }

    setRestoringConversationId(conversationId);
    setError('');

    try {
      const detail = await api.getConversationDetail(conversationId);
      setConversation(detail.conversation);
      setMessages(detail.messages);
      setSelectedAttachmentIds([]);
      setAttachmentListExpanded(false);
      setSelectedModelId(detail.conversation.model_id);
      setHistory((previous) => {
        const existing = previous.find((item) => item.id === detail.conversation.id);
        const next: LocalChatHistoryItem = {
          id: detail.conversation.id,
          title: detail.conversation.title || existing?.title || '新建会话',
          updated_at: detail.conversation.updated_at || detail.conversation.created_at,
          pinned: existing?.pinned ?? false
        };

        return sortHistoryItems([
          next,
          ...previous.filter((item) => item.id !== detail.conversation.id)
        ], pinnedHistoryOrderRef.current).slice(0, 40);
      });
      setNotice(t('Conversation restored.'));
      closeMobileSidebar();
    } catch (restoreError) {
      setError((restoreError as Error).message);
    } finally {
      setRestoringConversationId(null);
    }
  }, [closeMobileSidebar, conversation?.id, t]);

  const deleteHistoryItem = useCallback(
    async (id: string) => {
      setError('');
      try {
        await api.deleteConversation(id);
      } catch (deleteError) {
        if (!isConversationMissingError(deleteError)) {
          setError((deleteError as Error).message);
          return;
        }
      }

      appendHiddenHistoryIds([id]);
      setPinnedHistoryOrder((previous) => {
        const next = previous.filter((itemId) => itemId !== id);
        pinnedHistoryOrderRef.current = next;
        return next;
      });
      setHistory((previous) => previous.filter((item) => item.id !== id));
      if (editingConversationId === id) {
        cancelRenameConversation();
      }
      if (conversation?.id === id) {
        setConversation(null);
        setMessages([]);
        setInput('');
        setSelectedAttachmentIds([]);
        setAttachmentListExpanded(false);
      }
      setNotice(t('Conversation deleted.'));
      refreshConversations().catch(() => {
        // Keep local state even when background sync is unavailable.
      });
    },
    [
      appendHiddenHistoryIds,
      cancelRenameConversation,
      conversation?.id,
      editingConversationId,
      refreshConversations,
      t
    ]
  );
  const clearAllHistory = useCallback(async () => {
    if (clearingHistory) {
      return;
    }
    if (history.length === 0) {
      setNotice(t('No conversation history to clear.'));
      return;
    }

    const confirmed = window.confirm(t('Delete all conversation history in this account?'));
    if (!confirmed) {
      return;
    }

    setError('');
    setClearingHistory(true);
    try {
      let deletedIds: string[] = [];
      let failedIds: string[] = [];
      try {
        const result = await api.clearConversations();
        deletedIds = Array.isArray(result.deleted_ids)
          ? result.deleted_ids
              .filter((id) => typeof id === 'string' && id.trim().length > 0)
              .map((id) => id.trim())
          : [];
        failedIds = Array.isArray(result.failed_ids)
          ? result.failed_ids
              .filter((id) => typeof id === 'string' && id.trim().length > 0)
              .map((id) => id.trim())
          : [];
      } catch {
        let ids: string[] = [];
        try {
          const allConversations = await api.listConversations();
          const remoteIds = allConversations
            .map((item) => item.id)
            .filter((id) => typeof id === 'string' && id.trim().length > 0);
          ids = [...remoteIds, ...history.map((item) => item.id)];
        } catch {
          ids = history.map((item) => item.id);
        }
        ids = Array.from(new Set(ids));
        const results = await Promise.allSettled(ids.map((id) => api.deleteConversation(id)));
        results.forEach((result, index) => {
          const id = ids[index];
          if (!id) {
            return;
          }
          if (result.status === 'fulfilled' || isConversationMissingError(result.reason)) {
            deletedIds.push(id);
            return;
          }
          failedIds.push(id);
        });
      }

      const failedIdSet = new Set(failedIds);
      const localHistoryIds = history
        .map((item) => item.id)
        .filter((id) => typeof id === 'string' && id.trim().length > 0);
      const localIdsSafeToClear = localHistoryIds.filter((id) => !failedIdSet.has(id));
      deletedIds = Array.from(new Set([...deletedIds, ...localIdsSafeToClear]));
      const failedCount = failedIds.length;

      if (deletedIds.length > 0) {
        const deletedIdSet = new Set(deletedIds);
        if (failedCount === 0) {
          hiddenHistoryIdsRef.current = [];
          setHiddenHistoryIds([]);
        } else {
          appendHiddenHistoryIds(deletedIds);
        }
        setPinnedHistoryOrder((previous) => {
          const next = previous.filter((itemId) => !deletedIdSet.has(itemId));
          pinnedHistoryOrderRef.current = next;
          return next;
        });
        setHistory((previous) => previous.filter((item) => !deletedIdSet.has(item.id)));
        if (editingConversationId && deletedIdSet.has(editingConversationId)) {
          cancelRenameConversation();
        }
        if (conversation?.id && deletedIdSet.has(conversation.id)) {
          setConversation(null);
          setMessages([]);
          setInput('');
          setSelectedAttachmentIds([]);
          setAttachmentListExpanded(false);
        }
      }

      if (failedCount > 0) {
        setError(t('Failed to delete {count} conversations.', { count: failedCount }));
        setNotice(t('History cleared with partial failures.'));
      } else {
        setNotice(t('History cleared.'));
      }

      refreshConversations().catch(() => {
        // Keep local state even when background sync is unavailable.
      });
    } finally {
      setClearingHistory(false);
    }
  }, [
    appendHiddenHistoryIds,
    cancelRenameConversation,
    clearingHistory,
    conversation?.id,
    editingConversationId,
    history,
    refreshConversations,
    t
  ]);

  const sortedHistory = useMemo(
    () => sortHistoryItems(history, pinnedHistoryOrder),
    [history, pinnedHistoryOrder]
  );

  const contextMenuItem = useMemo(
    () => (historyContextMenu ? history.find((item) => item.id === historyContextMenu.id) ?? null : null),
    [history, historyContextMenu]
  );

  const historyContextMenuActions = useMemo<HistoryContextMenuAction[]>(
    () => ['rename', 'pin', 'delete'],
    []
  );

  const getHistoryContextMenuActionLabel = useCallback(
    (action: HistoryContextMenuAction): string => {
      if (action === 'rename') {
        return t('Rename');
      }

      if (action === 'pin') {
        return contextMenuItem?.pinned ? t('Unpin') : t('Pin');
      }

      return t('Delete');
    },
    [contextMenuItem?.pinned, t]
  );

  const getHistoryContextMenuActionShortcut = useCallback(
    (action: HistoryContextMenuAction): string => {
      if (action === 'rename') {
        return 'R';
      }

      if (action === 'pin') {
        return 'P';
      }

      return 'D';
    },
    []
  );

  const getHistoryContextMenuActionIcon = useCallback(
    (action: HistoryContextMenuAction): ReactNode => {
      if (action === 'rename') {
        return (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M3 11.75 4 9l5.9-5.9a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L7 12l-2.75.75Z"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.4"
            />
            <path
              d="M8.8 4.2 11.8 7.2"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.4"
            />
          </svg>
        );
      }

      if (action === 'pin') {
        return (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M5 2.75h6l-1.6 3.1 1.95 2.15H4.65L6.6 5.85 5 2.75Z"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.4"
            />
            <path
              d="M8 8.1v5.15"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.4"
            />
          </svg>
        );
      }

      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M5.25 4.25h5.5m-4.75 0 .35-1.1c.12-.36.45-.6.83-.6h1.64c.38 0 .71.24.83.6l.35 1.1m1.3 0-.45 7.05c-.04.64-.57 1.15-1.21 1.15H6.4c-.64 0-1.17-.5-1.21-1.15l-.45-7.05m2 1.75v4.1m2.5-4.1v4.1"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.4"
          />
        </svg>
      );
    },
    []
  );

  const closeHistoryContextMenu = useCallback(() => {
    setHistoryContextMenu(null);
    setHistoryContextMenuActiveIndex(0);
    setLongPressingConversationId(null);
  }, []);

  const clearHistoryLongPressTimer = useCallback(() => {
    if (historyLongPressTimerRef.current !== null) {
      window.clearTimeout(historyLongPressTimerRef.current);
      historyLongPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!historyContextMenu) {
      historyMenuButtonRefs.current = [];
      return;
    }

    const target = historyMenuButtonRefs.current[historyContextMenuActiveIndex];
    target?.focus();
  }, [historyContextMenu, historyContextMenuActiveIndex]);

  const executeHistoryContextAction = useCallback((action: HistoryContextMenuAction) => {
    if (!contextMenuItem) {
      return;
    }

    if (action === 'rename') {
      beginRenameConversation(contextMenuItem);
    } else if (action === 'pin') {
      toggleHistoryPin(contextMenuItem.id);
    } else if (action === 'delete') {
      void deleteHistoryItem(contextMenuItem.id);
    }

    closeHistoryContextMenu();
  }, [beginRenameConversation, closeHistoryContextMenu, contextMenuItem, deleteHistoryItem, toggleHistoryPin]);

  useEffect(() => {
    if (!historyContextMenu) {
      return;
    }

    const onWindowClick = () => closeHistoryContextMenu();
    const onWindowContext = () => closeHistoryContextMenu();
    const onWindowScroll = () => closeHistoryContextMenu();
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeHistoryContextMenu();
        return;
      }

      if (event.key === 'Tab') {
        closeHistoryContextMenu();
        return;
      }

      if (event.key === 'Home') {
        event.preventDefault();
        setHistoryContextMenuActiveIndex(0);
        return;
      }

      if (event.key === 'End') {
        event.preventDefault();
        setHistoryContextMenuActiveIndex(historyContextMenuActions.length - 1);
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHistoryContextMenuActiveIndex(
          (previous) => (previous + 1) % historyContextMenuActions.length
        );
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHistoryContextMenuActiveIndex(
          (previous) =>
            (previous - 1 + historyContextMenuActions.length) % historyContextMenuActions.length
        );
        return;
      }

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const actionButton = historyMenuButtonRefs.current[historyContextMenuActiveIndex] ?? null;
        actionButton?.click();
        return;
      }

      const shortcutKey = event.key.toLowerCase();
      const shortcutActionMap: Record<string, HistoryContextMenuAction> = {
        r: 'rename',
        p: 'pin',
        d: 'delete'
      };
      const shortcutAction = shortcutActionMap[shortcutKey];
      if (shortcutAction) {
        event.preventDefault();
        const shortcutIndex = historyContextMenuActions.indexOf(shortcutAction);
        if (shortcutIndex >= 0) {
          setHistoryContextMenuActiveIndex(shortcutIndex);
          const shortcutButton = historyMenuButtonRefs.current[shortcutIndex] ?? null;
          shortcutButton?.click();
        }
      }
    };

    window.addEventListener('click', onWindowClick);
    window.addEventListener('contextmenu', onWindowContext);
    window.addEventListener('scroll', onWindowScroll, true);
    window.addEventListener('keydown', onWindowKeyDown);

    return () => {
      window.removeEventListener('click', onWindowClick);
      window.removeEventListener('contextmenu', onWindowContext);
      window.removeEventListener('scroll', onWindowScroll, true);
      window.removeEventListener('keydown', onWindowKeyDown);
    };
  }, [
    closeHistoryContextMenu,
    historyContextMenu,
    historyContextMenuActions,
    historyContextMenuActiveIndex
  ]);

  const openHistoryContextMenuByPoint = useCallback(
    (itemId: string, x: number, y: number) => {
      if (editingConversationId === itemId) {
        return;
      }

      const viewportPadding = 8;
      const menuWidth = Math.max(190, Math.min(232, window.innerWidth - viewportPadding * 2));
      const menuHeight = 188;
      const safeX = Math.max(
        viewportPadding,
        Math.min(x, window.innerWidth - menuWidth - viewportPadding)
      );
      const safeY = Math.max(
        viewportPadding,
        Math.min(y, window.innerHeight - menuHeight - viewportPadding)
      );

      setHistoryContextMenu({
        id: itemId,
        x: safeX,
        y: safeY
      });
      setHistoryContextMenuActiveIndex(0);
      setLongPressingConversationId(null);
    },
    [editingConversationId]
  );

  const openHistoryContextMenu = useCallback((event: ReactMouseEvent<HTMLLIElement>, itemId: string) => {
    event.preventDefault();
    openHistoryContextMenuByPoint(itemId, event.clientX, event.clientY);
  }, [openHistoryContextMenuByPoint]);

  const openHistoryContextMenuFromButton = useCallback((
    event: ReactMouseEvent<HTMLButtonElement>,
    itemId: string
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (historyContextMenu?.id === itemId) {
      closeHistoryContextMenu();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    openHistoryContextMenuByPoint(itemId, rect.right - 4, rect.bottom + 6);
  }, [closeHistoryContextMenu, historyContextMenu?.id, openHistoryContextMenuByPoint]);

  const onHistoryItemKeyDown = useCallback((
    event: ReactKeyboardEvent<HTMLElement>,
    itemId: string
  ) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openHistoryContextMenuByPoint(itemId, rect.left + rect.width / 2, rect.top + 28);
    }
  }, [openHistoryContextMenuByPoint]);

  const onHistoryItemTouchStart = useCallback((event: ReactTouchEvent<HTMLLIElement>, itemId: string) => {
    if (editingConversationId === itemId) {
      return;
    }

    const touch = event.touches[0];
    if (!touch) {
      return;
    }

    const touchX = touch.clientX;
    const touchY = touch.clientY;
    clearHistoryLongPressTimer();
    historyLongPressTriggeredRef.current = false;
    setLongPressingConversationId(itemId);
    historyLongPressTimerRef.current = window.setTimeout(() => {
      historyLongPressTriggeredRef.current = true;
      setLongPressingConversationId(null);
      triggerHapticFeedback();
      openHistoryContextMenuByPoint(itemId, touchX, touchY);
    }, 550);
  }, [clearHistoryLongPressTimer, editingConversationId, openHistoryContextMenuByPoint]);

  const onHistoryItemTouchMove = useCallback(() => {
    clearHistoryLongPressTimer();
    setLongPressingConversationId(null);
  }, [clearHistoryLongPressTimer]);

  const onHistoryItemTouchEnd = useCallback(() => {
    clearHistoryLongPressTimer();
    setLongPressingConversationId(null);
  }, [clearHistoryLongPressTimer]);

  const onHistoryItemTouchCancel = useCallback(() => {
    clearHistoryLongPressTimer();
    setLongPressingConversationId(null);
  }, [clearHistoryLongPressTimer]);

  const consumeHistoryLongPressTrigger = useCallback(() => {
    if (!historyLongPressTriggeredRef.current) {
      return false;
    }

    historyLongPressTriggeredRef.current = false;
    return true;
  }, []);

  const reorderPinnedByDrag = useCallback((draggedId: string, targetId: string) => {
    const currentOrder = pinnedHistoryOrderRef.current;
    const next = reorderPinnedHistoryOrder(currentOrder, draggedId, targetId);
    if (arraysEqual(currentOrder, next)) {
      return;
    }

    setPinnedHistoryOrder(next);
    pinnedHistoryOrderRef.current = next;
    setHistory((previous) => sortHistoryItems(previous, next));
  }, []);

  const onPinnedDragStart = useCallback((event: ReactDragEvent<HTMLLIElement>, itemId: string) => {
    setDraggingPinnedConversationId(itemId);
    setDragOverPinnedConversationId(itemId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', itemId);
  }, []);

  const onPinnedDragOver = useCallback((event: ReactDragEvent<HTMLLIElement>, itemId: string) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverPinnedConversationId(itemId);
  }, []);

  const onPinnedDrop = useCallback((event: ReactDragEvent<HTMLLIElement>, itemId: string) => {
    event.preventDefault();
    const draggedId = event.dataTransfer.getData('text/plain') || draggingPinnedConversationId;
    if (draggedId) {
      reorderPinnedByDrag(draggedId, itemId);
    }
    setDraggingPinnedConversationId(null);
    setDragOverPinnedConversationId(null);
  }, [draggingPinnedConversationId, reorderPinnedByDrag]);

  const onPinnedDragEnd = useCallback(() => {
    setDraggingPinnedConversationId(null);
    setDragOverPinnedConversationId(null);
  }, []);

  const requestSaveConversationTitle = useCallback((conversationId: string) => {
    saveConversationTitle(conversationId).catch(() => {
      // handled by local error state
    });
  }, [saveConversationTitle]);

  const requestRestoreConversation = useCallback((conversationId: string) => {
    restoreConversation(conversationId).catch(() => {
      // handled by local error state
    });
  }, [restoreConversation]);

  const reorderSelectedAttachmentsByDrag = useCallback((draggedId: string, targetId: string) => {
    setSelectedAttachmentIds((previous) => {
      const next = reorderSelectedAttachmentOrder(previous, draggedId, targetId);
      return arraysEqual(previous, next) ? previous : next;
    });
    setNotice(t('Attachment order updated for current message.'));
  }, [t]);

  const onSelectedAttachmentDragStart = useCallback((
    event: ReactDragEvent<HTMLLIElement>,
    attachmentId: string
  ) => {
    setDraggingSelectedAttachmentId(attachmentId);
    setDragOverSelectedAttachmentId(attachmentId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', attachmentId);
  }, []);

  const onSelectedAttachmentDragOver = useCallback((
    event: ReactDragEvent<HTMLLIElement>,
    attachmentId: string
  ) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverSelectedAttachmentId(attachmentId);
  }, []);

  const onSelectedAttachmentDrop = useCallback((
    event: ReactDragEvent<HTMLLIElement>,
    attachmentId: string
  ) => {
    event.preventDefault();
    const draggedId = event.dataTransfer.getData('text/plain') || draggingSelectedAttachmentId;
    if (draggedId) {
      reorderSelectedAttachmentsByDrag(draggedId, attachmentId);
    }
    setDraggingSelectedAttachmentId(null);
    setDragOverSelectedAttachmentId(null);
  }, [draggingSelectedAttachmentId, reorderSelectedAttachmentsByDrag]);

  const onSelectedAttachmentDragEnd = useCallback(() => {
    setDraggingSelectedAttachmentId(null);
    setDragOverSelectedAttachmentId(null);
  }, []);

  const copyMessage = useCallback(async (content: string) => {
    const copied = await copyToClipboard(content);
    setNotice(
      copied
        ? t('Message copied to clipboard.')
        : t('Unable to copy message in this browser.')
    );
  }, [t]);

  const quoteMessage = useCallback((content: string) => {
    setInput(`"${content}"\n\n`);
    setNotice(t('Quoted message into composer.'));
  }, [t]);

  const requestCopyMessage = useCallback((content: string) => {
    copyMessage(content).catch(() => {
      // notice handled by helper
    });
  }, [copyMessage]);

  const requestRemoveAttachment = useCallback((attachmentId: string) => {
    removeAttachment(attachmentId).catch(() => {
      // handled by local error state
    });
  }, [removeAttachment]);

  const armConversationAutoFollowUp = useCallback(() => {
    const latestMessage = resolveLatestAssistantActionMessage(messages);
    autoConversationFollowUpRef.current = {
      armed: true,
      baselineMessageId: latestMessage?.id ?? null,
      inFlight: false
    };
  }, [messages, resolveLatestAssistantActionMessage]);

  const disarmConversationAutoFollowUp = useCallback(() => {
    autoConversationFollowUpRef.current = {
      armed: false,
      baselineMessageId: null,
      inFlight: false
    };
  }, []);

  const extractIdFromSuggestion = useCallback((suggestion: string, pattern: RegExp): string => {
    const match = suggestion.match(pattern);
    if (match && typeof match[1] === 'string') {
      return match[1];
    }
    return '';
  }, []);

  const pickSuggestionForField = useCallback(
    (field: string, suggestions: string[], collectedFields: Record<string, string>): string => {
      if (!Array.isArray(suggestions) || suggestions.length === 0) {
        return '';
      }
      const normalizedCollectedValue = (key: string): string => {
        const value = collectedFields[key];
        return typeof value === 'string' ? value.trim() : '';
      };
      if (field === 'dataset_id' || field === 'dataset_reference') {
        return (
          normalizedCollectedValue('dataset_id') ||
          normalizedCollectedValue('dataset_reference') ||
          suggestions.map((item) => extractIdFromSuggestion(item, /\b(d-\d+)\b/i)).find(Boolean) ||
          ''
        );
      }
      if (field === 'dataset_version_id') {
        return (
          normalizedCollectedValue('dataset_version_id') ||
          suggestions.map((item) => extractIdFromSuggestion(item, /\b(dv-\d+)\b/i)).find(Boolean) ||
          ''
        );
      }
      if (field === 'model_id' || field === 'source_model_id') {
        return (
          normalizedCollectedValue('model_id') ||
          normalizedCollectedValue('source_model_id') ||
          suggestions.map((item) => extractIdFromSuggestion(item, /\b(m-\d+)\b/i)).find(Boolean) ||
          ''
        );
      }
      if (field === 'model_version_id' || field === 'source_model_version_id') {
        return (
          normalizedCollectedValue('model_version_id') ||
          normalizedCollectedValue('source_model_version_id') ||
          suggestions.map((item) => extractIdFromSuggestion(item, /\b(mv-\d+)\b/i)).find(Boolean) ||
          ''
        );
      }
      if (field === 'training_job_id' || field === 'job_id') {
        return (
          normalizedCollectedValue('training_job_id') ||
          normalizedCollectedValue('job_id') ||
          suggestions.map((item) => extractIdFromSuggestion(item, /\b(tj-[a-z0-9-]+)\b/i)).find(Boolean) ||
          ''
        );
      }
      if (field === 'run_id' || field === 'inference_run_id') {
        return (
          normalizedCollectedValue('run_id') ||
          normalizedCollectedValue('inference_run_id') ||
          suggestions.map((item) => extractIdFromSuggestion(item, /\b(ir-\d+)\b/i)).find(Boolean) ||
          ''
        );
      }
      if (field === 'vision_task_id' || field === 'task_id') {
        return (
          normalizedCollectedValue('vision_task_id') ||
          normalizedCollectedValue('task_id') ||
          suggestions.map((item) => extractIdFromSuggestion(item, /\b(vt-[a-z0-9-]+)\b/i)).find(Boolean) ||
          ''
        );
      }
      if (field === 'attachment_id' || field === 'input_attachment_id') {
        return (
          normalizedCollectedValue('attachment_id') ||
          normalizedCollectedValue('input_attachment_id') ||
          suggestions.map((item) => extractIdFromSuggestion(item, /\b(f-\d+)\b/i)).find(Boolean) ||
          ''
        );
      }
      if (field === 'framework') {
        return (
          normalizedCollectedValue('framework') ||
          suggestions
            .map((item) => item.trim().toLowerCase())
            .find((item) => ['paddleocr', 'doctr', 'yolo'].includes(item)) ||
          ''
        );
      }
      if (field === 'task_type' || field === 'model_type') {
        return (
          normalizedCollectedValue('task_type') ||
          normalizedCollectedValue('model_type') ||
          suggestions
            .map((item) => item.trim().toLowerCase())
            .find((item) => ['ocr', 'detection', 'classification', 'segmentation', 'obb'].includes(item)) ||
          ''
        );
      }
      if (field === 'visibility') {
        return (
          normalizedCollectedValue('visibility') ||
          suggestions
            .map((item) => item.trim().toLowerCase())
            .find((item) => ['private', 'workspace', 'public'].includes(item)) ||
          ''
        );
      }
      if (field === 'profile_id') {
        return normalizedCollectedValue('profile_id') || suggestions[0]?.trim() || '';
      }
      if (field === 'status') {
        return (
          normalizedCollectedValue('status') ||
          suggestions
            .map((item) => item.trim().toLowerCase())
            .find((item) => ['approved', 'rejected', 'annotated', 'in_progress'].includes(item)) ||
          ''
        );
      }
      if (field === 'source') {
        return (
          normalizedCollectedValue('source') ||
          suggestions
            .map((item) => item.trim().toLowerCase())
            .find((item) => ['manual', 'import', 'pre_annotation'].includes(item)) ||
          ''
        );
      }
      if (field === 'name' || field === 'version_name') {
        return normalizedCollectedValue(field) || suggestions[0]?.trim() || '';
      }
      return suggestions[0]?.trim() || '';
    },
    [extractIdFromSuggestion]
  );

  const autoFillConversationAction = useCallback(
    (action: ConversationActionMetadata) => {
      const chinese = hasChineseText(action.summary) || action.suggestions?.some((item) => hasChineseText(item)) === true;
      const parts: string[] = [];
      const missingFields = (action.missing_fields ?? []).map((item) => item.trim()).filter(Boolean);
      for (const field of missingFields) {
        if (field.startsWith('dataset_issue:')) {
          continue;
        }
        const value = pickSuggestionForField(field, action.suggestions ?? [], action.collected_fields);
        if (!value) {
          continue;
        }
        if (field === 'dataset_id' || field === 'dataset_reference') {
          parts.push(chinese ? `数据集用 ${value}` : `Use dataset ${value}`);
          continue;
        }
        if (field === 'dataset_version_id') {
          parts.push(chinese ? `数据集版本用 ${value}` : `Use dataset version ${value}`);
          continue;
        }
        if (field === 'task_type' || field === 'model_type') {
          parts.push(chinese ? `任务类型用 ${value}` : `Use task type ${value}`);
          continue;
        }
        if (field === 'framework') {
          parts.push(chinese ? `框架用 ${value}` : `Use framework ${value}`);
          continue;
        }
        if (field === 'model_id' || field === 'source_model_id') {
          parts.push(chinese ? `模型用 ${value}` : `Use model ${value}`);
          continue;
        }
        if (field === 'model_version_id' || field === 'source_model_version_id') {
          parts.push(chinese ? `模型版本用 ${value}` : `Use model version ${value}`);
          continue;
        }
        if (field === 'training_job_id' || field === 'job_id') {
          parts.push(chinese ? `训练任务用 ${value}` : `Use training job ${value}`);
          continue;
        }
        if (field === 'run_id' || field === 'inference_run_id') {
          parts.push(chinese ? `推理运行用 ${value}` : `Use run ${value}`);
          continue;
        }
        if (field === 'vision_task_id' || field === 'task_id') {
          parts.push(chinese ? `视觉任务用 ${value}` : `Use vision task ${value}`);
          continue;
        }
        if (field === 'attachment_id' || field === 'input_attachment_id') {
          parts.push(chinese ? `输入附件用 ${value}` : `Use attachment ${value}`);
          continue;
        }
        if (field === 'visibility') {
          parts.push(chinese ? `可见性设为 ${value}` : `Set visibility to ${value}`);
          continue;
        }
        if (field === 'status') {
          parts.push(chinese ? `状态设为 ${value}` : `Set status to ${value}`);
          continue;
        }
        if (field === 'source') {
          parts.push(chinese ? `来源设为 ${value}` : `Set source to ${value}`);
          continue;
        }
        if (field === 'profile_id') {
          parts.push(chinese ? `运行环境配置用 ${value}` : `Use runtime profile ${value}`);
          continue;
        }
        if (field === 'name' || field === 'version_name') {
          parts.push(chinese ? `${field === 'name' ? '名称' : '版本名'}用 ${value}` : `Set ${field} ${value}`);
          continue;
        }
        parts.push(`${field}=${value}`);
      }

      const nextInput =
        parts.length > 0
          ? parts.join(chinese ? '；' : '; ')
          : (action.suggestions?.[0]?.trim() ?? '');
      if (!nextInput) {
        return;
      }
      const shouldAutoSubmit =
        action.status === 'requires_input' &&
        !sending &&
        !uploading &&
        !authRequired &&
        !hasPendingSelectedAttachments &&
        Boolean(nextInput.trim());
      if (shouldAutoSubmit) {
        armConversationAutoFollowUp();
        setInput('');
        setNotice(t('Auto fill applied. Retrying action...'));
        void sendWithContent(nextInput).catch(() => {
          disarmConversationAutoFollowUp();
          setInput(nextInput);
          window.requestAnimationFrame(() => {
            composerTextareaRef.current?.focus();
          });
        });
        return;
      }
      setInput(nextInput);
      window.requestAnimationFrame(() => {
        composerTextareaRef.current?.focus();
      });
      setNotice(t('Auto fill inserted into composer.'));
    },
    [
      armConversationAutoFollowUp,
      authRequired,
      disarmConversationAutoFollowUp,
      hasPendingSelectedAttachments,
      pickSuggestionForField,
      sending,
      sendWithContent,
      t,
      uploading
    ]
  );

  const applyConversationSuggestion = useCallback(
    (action: ConversationActionMetadata, suggestion: string) => {
      const trimmed = suggestion.trim();
      const primaryMissingField = action.missing_fields[0] ?? '';
      let nextInput = trimmed;

      if (primaryMissingField === 'dataset_id' || primaryMissingField === 'dataset_reference') {
        const datasetId = trimmed.match(datasetIdPattern)?.[1] ?? trimmed;
        nextInput = hasChineseText(trimmed) || hasChineseText(action.summary)
          ? `用数据集 ${datasetId}`
          : `Use dataset ${datasetId}`;
      } else if (primaryMissingField === 'framework') {
        nextInput = hasChineseText(trimmed) || hasChineseText(action.summary)
          ? `框架用 ${trimmed}`
          : `Use framework ${trimmed}`;
      } else if (primaryMissingField === 'task_type') {
        nextInput = hasChineseText(trimmed) || hasChineseText(action.summary)
          ? `任务类型用 ${trimmed}`
          : `Use task type ${trimmed}`;
      } else if (primaryMissingField === 'visibility') {
        nextInput = hasChineseText(trimmed) || hasChineseText(action.summary)
          ? `可见性设为 ${trimmed}`
          : `Set visibility to ${trimmed}`;
      }

      const shouldAutoSubmit =
        action.status === 'requires_input' &&
        !sending &&
        !uploading &&
        !authRequired &&
        !hasPendingSelectedAttachments &&
        Boolean(nextInput.trim());
      if (shouldAutoSubmit) {
        armConversationAutoFollowUp();
        setInput('');
        setNotice(t('Suggestion applied. Retrying action...'));
        void sendWithContent(nextInput).catch(() => {
          disarmConversationAutoFollowUp();
          setInput(nextInput);
          window.requestAnimationFrame(() => {
            composerTextareaRef.current?.focus();
          });
        });
        return;
      }

      setInput(nextInput);
      window.requestAnimationFrame(() => {
        composerTextareaRef.current?.focus();
      });
      setNotice(t('Suggestion inserted into composer.'));
    },
    [
      armConversationAutoFollowUp,
      authRequired,
      disarmConversationAutoFollowUp,
      hasPendingSelectedAttachments,
      sending,
      sendWithContent,
      t,
      uploading
    ]
  );

  const confirmConversationAction = useCallback(
    (action: ConversationActionMetadata) => {
      const phrase = action.confirmation_phrase?.trim() ?? '';
      if (!phrase) {
        return;
      }
      if (sending || uploading || authRequired || hasPendingSelectedAttachments) {
        setInput(phrase);
        window.requestAnimationFrame(() => {
          composerTextareaRef.current?.focus();
        });
        setNotice(t('Confirmation inserted into composer.'));
        return;
      }
      setInput('');
      setNotice(t('Confirmation sent. Executing action...'));
      void sendWithContent(phrase).catch(() => {
        setInput(phrase);
        window.requestAnimationFrame(() => {
          composerTextareaRef.current?.focus();
        });
      });
    },
    [authRequired, hasPendingSelectedAttachments, sending, sendWithContent, t, uploading]
  );

  const runConversationNextStep = useCallback(
    (step: ConversationActionNextStep) => {
      if (step.kind === 'href' && step.href) {
        navigate(step.href);
        return;
      }

      const nextInput = buildConversationActionNextStepInput(step);
      if (!nextInput) {
        return;
      }

      if (sending || uploading || authRequired || hasPendingSelectedAttachments) {
        setInput(nextInput);
        window.requestAnimationFrame(() => {
          composerTextareaRef.current?.focus();
        });
        setNotice(t('Suggested next step inserted into composer.'));
        return;
      }

      setInput('');
      setNotice(t('Suggested next step sent. Confirm if prompted.'));
      void sendWithContent(nextInput).catch(() => {
        setInput(nextInput);
        window.requestAnimationFrame(() => {
          composerTextareaRef.current?.focus();
        });
      });
    },
    [authRequired, hasPendingSelectedAttachments, navigate, sending, sendWithContent, t, uploading]
  );

  useEffect(() => {
    const autoFollowUp = autoConversationFollowUpRef.current;
    if (!autoFollowUp.armed || autoFollowUp.inFlight) {
      return;
    }
    if (sending || uploading || authRequired || hasPendingSelectedAttachments) {
      return;
    }

    const latestActionMessage = resolveLatestAssistantActionMessage(messages);
    if (!latestActionMessage || latestActionMessage.id === autoFollowUp.baselineMessageId) {
      return;
    }

    const latestAction = latestActionMessage.metadata?.conversation_action ?? null;
    autoConversationFollowUpRef.current = {
      ...autoFollowUp,
      baselineMessageId: latestActionMessage.id
    };

    if (!latestAction || latestAction.status !== 'requires_input') {
      disarmConversationAutoFollowUp();
      return;
    }

    const nonConfirmationMissingFields = (latestAction.missing_fields ?? [])
      .map((field) => field.trim())
      .filter((field) => field && field !== 'confirmation');
    const confirmationPhrase = latestAction.confirmation_phrase?.trim() ?? '';
    const shouldAutoConfirm =
      latestAction.requires_confirmation === true &&
      confirmationPhrase.length > 0 &&
      nonConfirmationMissingFields.length === 0;
    if (!shouldAutoConfirm) {
      disarmConversationAutoFollowUp();
      return;
    }

    autoConversationFollowUpRef.current = {
      armed: false,
      baselineMessageId: latestActionMessage.id,
      inFlight: true
    };
    setNotice(t('Confirmation sent. Executing action...'));
    void sendWithContent(confirmationPhrase)
      .catch(() => {
        setInput(confirmationPhrase);
        window.requestAnimationFrame(() => {
          composerTextareaRef.current?.focus();
        });
      })
      .finally(() => {
        autoConversationFollowUpRef.current = {
          armed: false,
          baselineMessageId: null,
          inFlight: false
        };
      });
  }, [
    authRequired,
    disarmConversationAutoFollowUp,
    hasPendingSelectedAttachments,
    messages,
    resolveLatestAssistantActionMessage,
    sending,
    sendWithContent,
    t,
    uploading
  ]);

  const hasActiveConversation = Boolean(conversation);
  const canSend =
    !sending &&
    !loading &&
    !uploading &&
    !authRequired &&
    !hasPendingSelectedAttachments &&
    models.length > 0 &&
    Boolean(input.trim());
  const renderConversationTitle = useCallback(
    (title: string) => (title === 'New conversation' ? t('New conversation') : title),
    [t]
  );
  const isDesktopSidebarCollapsed = sidebarCollapsed && !isCompactViewport;
  const pageClassName = [
    'chat-workspace-page',
    isDesktopSidebarCollapsed ? 'sidebar-collapsed' : '',
    isCompactViewport ? 'sidebar-compact' : '',
    mobileSidebarOpen ? 'mobile-sidebar-open' : ''
  ]
    .filter(Boolean)
    .join(' ');
  const sidebarToggleLabel = isCompactViewport
    ? mobileSidebarOpen
      ? t('Close sidebar')
      : t('Open sidebar')
    : isDesktopSidebarCollapsed
      ? t('Expand sidebar')
      : t('Collapse sidebar');
  const sidebarToggleToken = isCompactViewport ? (mobileSidebarOpen ? 'X' : '=') : isDesktopSidebarCollapsed ? '>' : '<';
  const logout = useCallback(async () => {
    try {
      await api.logout();
      clearWorkspaceForAnonymousSession();
      setAuthRequired(true);
      emitAuthUpdated();
      closeMobileSidebar();
      navigate('/', { replace: true });
    } catch (logoutError) {
      setError((logoutError as Error).message);
    }
  }, [clearWorkspaceForAnonymousSession, closeMobileSidebar, navigate]);
  const sessionMenuItems = useMemo(
    () => [
      { to: scopedSettingsPath, label: t('Settings') },
      { to: scopedConsolePath, label: t('Professional Console') },
      { label: t('Logout'), onSelect: logout, tone: 'danger' as const }
    ],
    [logout, scopedConsolePath, scopedSettingsPath, t]
  );

  return (
    <section className={pageClassName}>
      {isCompactViewport ? (
        <Button
          type="button"
          className={`chat-sidebar-scrim${mobileSidebarOpen ? ' visible' : ''}`}
          unstyled
          onClick={closeMobileSidebar}
          aria-label={t('Close sidebar')}
        />
      ) : null}

      <aside className="chat-workspace-sidebar" aria-hidden={isCompactViewport && !mobileSidebarOpen}>
        <div className="chat-sidebar-content">
          <div className="chat-sidebar-top stack">
            <div className="chat-sidebar-brand-row">
              <div className="chat-sidebar-brand-pill">
                <span className="chat-sidebar-brand-mark" aria-hidden="true">
                  V
                </span>
                <strong>{t('Vistral Chat')}</strong>
              </div>
              <Button
                type="button"
                className="chat-sidebar-new-chat-btn"
                variant="secondary"
                size="icon"
                onClick={startNewConversation}
                disabled={sending || authRequired}
                aria-label={t('New conversation')}
                title={t('New conversation')}
              >
                +
              </Button>
            </div>
            <div className="row gap wrap">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void clearAllHistory();
                }}
                disabled={sending || authRequired || clearingHistory || history.length === 0}
              >
                {clearingHistory ? t('Clearing...') : t('Clear history')}
              </Button>
            </div>
          </div>

          <div className="chat-sidebar-scroll">
            <ConversationHistorySidebarPanel
              t={t}
              historyItems={sortedHistory}
              activeConversationId={conversation?.id ?? null}
              editingConversationId={editingConversationId}
              editingConversationTitle={editingConversationTitle}
              renamingConversationId={renamingConversationId}
              restoringConversationId={restoringConversationId}
              historyContextMenu={historyContextMenu}
              historyContextMenuActiveIndex={historyContextMenuActiveIndex}
              historyContextMenuActions={historyContextMenuActions}
              draggingPinnedConversationId={draggingPinnedConversationId}
              dragOverPinnedConversationId={dragOverPinnedConversationId}
              longPressingConversationId={longPressingConversationId}
              historyMenuButtonRefs={historyMenuButtonRefs}
              contextMenuPinned={Boolean(contextMenuItem?.pinned)}
              renderConversationTitle={renderConversationTitle}
              setEditingConversationTitle={setEditingConversationTitle}
              requestSaveConversationTitle={requestSaveConversationTitle}
              onCancelRenameConversation={cancelRenameConversation}
              requestRestoreConversation={requestRestoreConversation}
              consumeHistoryLongPressTrigger={consumeHistoryLongPressTrigger}
              onSetHistoryContextMenuActiveIndex={setHistoryContextMenuActiveIndex}
              onExecuteHistoryContextAction={executeHistoryContextAction}
              getHistoryContextMenuActionLabel={getHistoryContextMenuActionLabel}
              getHistoryContextMenuActionShortcut={getHistoryContextMenuActionShortcut}
              getHistoryContextMenuActionIcon={getHistoryContextMenuActionIcon}
              onHistoryItemKeyDown={onHistoryItemKeyDown}
              onOpenHistoryContextMenu={openHistoryContextMenu}
              onOpenHistoryContextMenuFromButton={openHistoryContextMenuFromButton}
              onHistoryItemTouchStart={onHistoryItemTouchStart}
              onHistoryItemTouchMove={onHistoryItemTouchMove}
              onHistoryItemTouchEnd={onHistoryItemTouchEnd}
              onHistoryItemTouchCancel={onHistoryItemTouchCancel}
              onPinnedDragStart={onPinnedDragStart}
              onPinnedDragOver={onPinnedDragOver}
              onPinnedDrop={onPinnedDrop}
              onPinnedDragEnd={onPinnedDragEnd}
            />
          </div>

          <div className="chat-sidebar-footer stack">
            {currentUser ? (
              <SessionMenu
                currentUser={currentUser}
                items={sessionMenuItems}
                align="start"
                direction="up"
                variant="sidebar"
                languageControl={{
                  value: language,
                  onChange: (nextLanguage) => setLanguage(nextLanguage)
                }}
              />
            ) : (
              <div className="chat-user-card guest">
                <div className="chat-user-summary">
                  <div className="chat-user-avatar">{getInitials()}</div>
                  <div className="stack tight">
                    <strong>{t('Guest')}</strong>
                    <small className="muted">{t('Login')}</small>
                  </div>
                </div>
                <div className="chat-user-actions">
                  <ButtonLink to={loginPath} variant="ghost" size="sm" className="chat-guest-login-link">
                    {t('Login')}
                  </ButtonLink>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="chat-sidebar-collapsed-rail">
          <Button
            type="button"
            className="chat-sidebar-rail-btn"
            variant="secondary"
            size="icon"
            onClick={startNewConversation}
            disabled={authRequired}
                aria-label={t('New conversation')}
                title={t('New conversation')}
          >
            +
          </Button>
          <div className="chat-sidebar-rail-footer">
            {currentUser ? (
              <SessionMenu
                currentUser={currentUser}
                items={sessionMenuItems}
                align="start"
                direction="up"
                variant="rail"
                languageControl={{
                  value: language,
                  onChange: (nextLanguage) => setLanguage(nextLanguage)
                }}
              />
            ) : (
              <ButtonLink
                className="chat-sidebar-rail-link chat-sidebar-rail-avatar-link"
                to={loginPath}
                variant="ghost"
                size="icon"
                aria-label={t('Login')}
                title={t('Login')}
              >
                {getInitials()}
              </ButtonLink>
            )}
          </div>
        </div>
      </aside>

      <div className="chat-main-area">
        <header className="chat-main-header">
          <div className="chat-main-header-row">
            <div className="chat-main-header-leading">
              <Button
                type="button"
                className="chat-sidebar-toggle"
                variant="secondary"
                size="icon"
                onClick={toggleSidebar}
                aria-label={sidebarToggleLabel}
                title={sidebarToggleLabel}
              >
                {sidebarToggleToken}
              </Button>
              <label className="chat-model-select">
                <span>{t('Model')}</span>
                <Select
                  value={selectedModelId}
                  onChange={(event) => setSelectedModelId(event.target.value)}
                  disabled={sending || hasActiveConversation}
                >
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name} ({model.status})
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <div className="chat-main-header-meta">
              <Badge tone="neutral" className="chat-mode-badge">{t('Mode:')} {llmModeText}</Badge>
              {currentUser && isCompactViewport ? (
                <SessionMenu
                  currentUser={currentUser}
                  items={sessionMenuItems}
                  languageControl={{
                    value: language,
                    onChange: (nextLanguage) => setLanguage(nextLanguage)
                  }}
                />
              ) : null}
              {!currentUser && isCompactViewport ? (
                <div className="chat-header-auth-links">
                  <ButtonLink to={loginPath} variant="ghost" size="sm" className="chat-header-login-link">
                    {t('Login')}
                  </ButtonLink>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <ConversationMessageViewport
          t={t}
          loading={loading}
          error={error}
          authRequired={authRequired}
          modelCount={models.length}
          visibleMessages={visibleMessages}
          hiddenMessageCount={hiddenMessageCount}
          currentUsername={currentUser?.username ?? null}
          onLoadEarlierMessages={loadEarlierMessages}
          onCopyMessage={requestCopyMessage}
          onQuoteMessage={quoteMessage}
          onConfirmConversationAction={confirmConversationAction}
          onAutoFillConversationAction={autoFillConversationAction}
          onApplyConversationSuggestion={applyConversationSuggestion}
          onRunConversationNextStep={runConversationNextStep}
          formatConversationActionLabel={formatConversationActionLabel}
          formatConversationActionStatusLabel={formatConversationActionStatusLabel}
          formatConversationActionFieldLabel={formatConversationActionFieldLabel}
          formatConversationActionFieldValue={formatConversationActionFieldValue}
          resolveConversationActionFieldHref={resolveConversationActionFieldHref}
          resolveConversationActionHref={resolveConversationActionHref}
          resolveConversationActionLinks={resolveConversationActionLinks}
          resolveMessageAttachmentNames={resolveMessageAttachmentNames}
          loginPath={loginPath}
        />

        <footer className="chat-composer-wrap">
          {authRequired ? (
            <section className="chat-composer-panel chat-guest-panel">
              <strong>{t('Signing out disables conversation actions.')}</strong>
              <small className="muted">
                {t('Use Login to reopen the workspace. Ask an admin to create another account if needed.')}
              </small>
            </section>
          ) : (
          <section className="chat-composer-panel chat-simple-composer-panel">
            <ConversationDraftAttachmentPanel
              t={t}
              selectedAttachments={selectedAttachments}
              hasPendingSelectedAttachments={hasPendingSelectedAttachments}
              sending={sending}
              uploading={uploading}
              attachmentListExpanded={attachmentListExpanded}
              attachments={attachments}
              selectedAttachmentCount={selectedAttachmentIds.length}
              readyAttachmentCount={readyAttachmentIds.length}
              attachmentStatusSummary={attachmentStatusSummary}
              selectedAttachmentIdSet={selectedAttachmentIdSet}
              draggingSelectedAttachmentId={draggingSelectedAttachmentId}
              dragOverSelectedAttachmentId={dragOverSelectedAttachmentId}
              onOpenUploadFileDialog={openUploadFileDialog}
              onUploadFilenameReference={uploadAttachmentByFilenameReference}
              onIncludeAllReadyAttachments={includeAllReadyAttachments}
              onClearCurrentAttachmentContext={clearCurrentAttachmentContext}
              onOpenAttachment={openAttachment}
              onExcludeAttachmentFromCurrentMessage={excludeAttachmentFromCurrentMessage}
              onIncludeAttachmentInCurrentMessage={includeAttachmentInCurrentMessage}
              onRemoveAttachment={requestRemoveAttachment}
              onSelectedAttachmentDragStart={onSelectedAttachmentDragStart}
              onSelectedAttachmentDragOver={onSelectedAttachmentDragOver}
              onSelectedAttachmentDrop={onSelectedAttachmentDrop}
              onSelectedAttachmentDragEnd={onSelectedAttachmentDragEnd}
            />
            <ChatInput
              className="chat-simple-composer"
              leading={
                <Button
                  type="button"
                  className={`chat-attachment-plus-btn chat-simple-plus-btn${
                    attachmentListExpanded || selectedAttachments.length > 0 ? ' active' : ''
                  }`}
                  variant="ghost"
                  size="icon"
                  onClick={toggleAttachmentTray}
                  disabled={sending || loading || authRequired}
                  aria-label={attachmentListExpanded ? t('Collapse') : t('Attachments')}
                  title={attachmentListExpanded ? t('Collapse') : t('Attachments')}
                  aria-expanded={attachmentListExpanded}
                  >
                    <span className="chat-simple-plus-icon" aria-hidden="true">
                      +
                    </span>
                </Button>
              }
              trailing={
                <Button
                  className={`chat-simple-send-btn${canSend ? ' active' : ''}`}
                  variant={canSend ? 'primary' : 'secondary'}
                  size="icon"
                  onClick={send}
                  disabled={!canSend}
                  aria-label={hasActiveConversation ? t('Send') : t('Start')}
                  title={hasActiveConversation ? t('Send') : t('Start')}
                  >
                    <span className="chat-simple-send-icon" aria-hidden="true">
                      ↑
                    </span>
                </Button>
              }
              meta={
                <>
                  {notice ? <small className="muted">{notice}</small> : null}
                  <HiddenFileInput
                    ref={uploadFileInputRef}
                    multiple
                    onChange={onUploadFileInputChange}
                    disabled={uploading || sending || authRequired}
                  />
                </>
              }
            >
              <Textarea
                className="chat-simple-input"
                ref={composerTextareaRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                rows={1}
                placeholder={t('Message Vistral...')}
                disabled={sending || loading || authRequired || models.length === 0}
              />
            </ChatInput>
          </section>
          )}
        </footer>
      </div>
    </section>
  );
}
