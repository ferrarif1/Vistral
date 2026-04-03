import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent
} from 'react';
import { Link } from 'react-router-dom';
import type {
  ConversationRecord,
  FileAttachment,
  LlmConfigView,
  MessageRecord,
  ModelRecord,
  User
} from '../../shared/domain';
import { useI18n } from '../i18n/I18nProvider';
import StateBlock from '../components/StateBlock';
import StatusBadge from '../components/StatusBadge';
import { api } from '../services/api';
import { LLM_CONFIG_UPDATED_EVENT } from '../services/llmConfig';

interface LocalChatHistoryItem {
  id: string;
  title: string;
  updated_at: string;
  pinned: boolean;
}

type HistoryGroupKey = 'pinned' | 'today' | 'yesterday' | 'previous_7_days' | 'older';

interface HistoryGroup {
  key: HistoryGroupKey;
  label: string;
  items: LocalChatHistoryItem[];
}

interface HistoryContextMenuState {
  id: string;
  x: number;
  y: number;
}

type HistoryContextMenuAction = 'open' | 'rename' | 'pin' | 'delete';

const historyStorageKey = 'vistral-conversation-history';
const hiddenHistoryStorageKey = 'vistral-hidden-conversations';
const collapsedHistoryGroupStorageKey = 'vistral-collapsed-history-groups';
const pinnedOrderStorageKey = 'vistral-pinned-history-order';
const historyGroupKeys: HistoryGroupKey[] = [
  'pinned',
  'today',
  'yesterday',
  'previous_7_days',
  'older'
];

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
    // Ignore storage errors in prototype mode.
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
    // Ignore storage errors in prototype mode.
  }
};

const readCollapsedHistoryGroupsFromStorage = (): HistoryGroupKey[] => {
  try {
    const raw = localStorage.getItem(collapsedHistoryGroupStorageKey);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as string[];
    if (!Array.isArray(parsed)) {
      return [];
    }

    const parsedSet = new Set(parsed);
    return historyGroupKeys.filter((key) => parsedSet.has(key));
  } catch {
    return [];
  }
};

const writeCollapsedHistoryGroupsToStorage = (groupKeys: HistoryGroupKey[]) => {
  try {
    const unique = Array.from(new Set(groupKeys)).filter((key): key is HistoryGroupKey =>
      historyGroupKeys.includes(key as HistoryGroupKey)
    );
    localStorage.setItem(collapsedHistoryGroupStorageKey, JSON.stringify(unique));
  } catch {
    // Ignore storage errors in prototype mode.
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
    // Ignore storage errors in prototype mode.
  }
};

const arraysEqual = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

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

const daysDiffFromNow = (iso: string): number => {
  const targetTime = Date.parse(iso);
  if (Number.isNaN(targetTime)) {
    return 999;
  }

  const nowDate = new Date();
  const todayStart = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    nowDate.getDate()
  ).getTime();
  const targetDate = new Date(targetTime);
  const targetStart = new Date(
    targetDate.getFullYear(),
    targetDate.getMonth(),
    targetDate.getDate()
  ).getTime();

  return Math.floor((todayStart - targetStart) / (1000 * 60 * 60 * 24));
};

const toHistoryGroups = (items: LocalChatHistoryItem[]): HistoryGroup[] => {
  const groupBuckets: HistoryGroup[] = [
    { key: 'pinned', label: 'Pinned', items: [] },
    { key: 'today', label: 'Today', items: [] },
    { key: 'yesterday', label: 'Yesterday', items: [] },
    { key: 'previous_7_days', label: 'Previous 7 Days', items: [] },
    { key: 'older', label: 'Older', items: [] }
  ];

  for (const item of items) {
    if (item.pinned) {
      groupBuckets[0].items.push(item);
      continue;
    }

    const dayDiff = daysDiffFromNow(item.updated_at);
    if (dayDiff <= 0) {
      groupBuckets[1].items.push(item);
      continue;
    }

    if (dayDiff === 1) {
      groupBuckets[2].items.push(item);
      continue;
    }

    if (dayDiff <= 7) {
      groupBuckets[3].items.push(item);
      continue;
    }

    groupBuckets[4].items.push(item);
  }

  return groupBuckets.filter((group) => group.items.length > 0);
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
        title: item.title || existing?.title || 'New chat',
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
    return 'New chat';
  }
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}...` : trimmed;
};

const getInitials = (username?: string): string => {
  if (!username) {
    return 'U';
  }

  return username.slice(0, 2).toUpperCase();
};

const formatHistoryTimestamp = (iso: string): string => {
  const raw = Date.parse(iso);
  if (Number.isNaN(raw)) {
    return 'Unknown time';
  }

  const diff = daysDiffFromNow(iso);
  const date = new Date(raw);
  if (diff <= 0) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  if (diff <= 7) {
    return date.toLocaleDateString([], { weekday: 'short' });
  }

  return date.toLocaleDateString();
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

export default function ConversationPage() {
  const { language, setLanguage, t, roleLabel } = useI18n();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [conversation, setConversation] = useState<ConversationRecord | null>(null);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [history, setHistory] = useState<LocalChatHistoryItem[]>(() => readHistoryFromStorage());
  const [hiddenHistoryIds, setHiddenHistoryIds] = useState<string[]>(() =>
    readHiddenConversationIdsFromStorage()
  );
  const [collapsedHistoryGroups, setCollapsedHistoryGroups] = useState<HistoryGroupKey[]>(() =>
    readCollapsedHistoryGroupsFromStorage()
  );
  const [pinnedHistoryOrder, setPinnedHistoryOrder] = useState<string[]>(() =>
    readPinnedHistoryOrderFromStorage()
  );
  const [historySearch, setHistorySearch] = useState('');
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [editingConversationTitle, setEditingConversationTitle] = useState('');
  const [input, setInput] = useState('');
  const [uploadFilename, setUploadFilename] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [restoringConversationId, setRestoringConversationId] = useState<string | null>(null);
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [historyContextMenu, setHistoryContextMenu] = useState<HistoryContextMenuState | null>(null);
  const [historyContextMenuActiveIndex, setHistoryContextMenuActiveIndex] = useState(0);
  const [longPressingConversationId, setLongPressingConversationId] = useState<string | null>(null);
  const [draggingPinnedConversationId, setDraggingPinnedConversationId] = useState<string | null>(null);
  const [dragOverPinnedConversationId, setDragOverPinnedConversationId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [llmView, setLlmView] = useState<LlmConfigView | null>(null);
  const [notice, setNotice] = useState('');
  const hiddenHistoryIdsRef = useRef<string[]>(hiddenHistoryIds);
  const pinnedHistoryOrderRef = useRef<string[]>(pinnedHistoryOrder);
  const historyMenuButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const historyLongPressTimerRef = useRef<number | null>(null);
  const historyLongPressTriggeredRef = useRef(false);

  const refreshLlmConfig = useCallback(async () => {
    const config = await api.getLlmConfig();
    setLlmView(config);
  }, []);

  const refreshAttachments = useCallback(async () => {
    const result = await api.listConversationAttachments();
    setAttachments(result);
  }, []);

  const refreshConversations = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const conversationResults = await api.listConversations();
      setHistory((previous) =>
        mergeHistoryWithConversations(
          conversationResults,
          previous,
          hiddenHistoryIdsRef.current,
          pinnedHistoryOrderRef.current
        )
      );
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);

    Promise.all([api.me(), api.listModels(), refreshAttachments(), refreshLlmConfig(), refreshConversations()])
      .then(([user, modelResults]) => {
        setCurrentUser(user);
        setModels(modelResults);
        if (modelResults.length > 0) {
          setSelectedModelId((current) => current || modelResults[0].id);
        }
        setError('');
      })
      .catch((loadError) => setError((loadError as Error).message))
      .finally(() => setLoading(false));
  }, [refreshAttachments, refreshConversations, refreshLlmConfig]);

  useEffect(() => {
    const handleConfigChange = () => {
      refreshLlmConfig().catch(() => {
        // Keep current state on transient errors.
      });
    };

    window.addEventListener(LLM_CONFIG_UPDATED_EVENT, handleConfigChange as EventListener);

    return () => {
      window.removeEventListener(LLM_CONFIG_UPDATED_EVENT, handleConfigChange as EventListener);
    };
  }, [refreshLlmConfig]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      refreshAttachments().catch(() => {
        // Keep UI stable in polling loop; explicit errors are reported by direct actions.
      });
    }, 500);

    return () => window.clearInterval(timer);
  }, [refreshAttachments]);

  useEffect(() => {
    writeHistoryToStorage(history);
  }, [history]);

  useEffect(() => {
    hiddenHistoryIdsRef.current = hiddenHistoryIds;
    writeHiddenConversationIdsToStorage(hiddenHistoryIds);
  }, [hiddenHistoryIds]);

  useEffect(() => {
    writeCollapsedHistoryGroupsToStorage(collapsedHistoryGroups);
  }, [collapsedHistoryGroups]);

  useEffect(() => {
    pinnedHistoryOrderRef.current = pinnedHistoryOrder;
    writePinnedHistoryOrderToStorage(pinnedHistoryOrder);
  }, [pinnedHistoryOrder]);

  useEffect(() => {
    setPinnedHistoryOrder((previous) => {
      const next = reconcilePinnedHistoryOrder(history, previous);
      return arraysEqual(previous, next) ? previous : next;
    });
  }, [history]);

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

  const readyAttachmentIds = useMemo(
    () => attachments.filter((item) => item.status === 'ready').map((item) => item.id),
    [attachments]
  );

  const llmModeText = useMemo(() => {
    if (!llmView || !llmView.enabled || !llmView.has_api_key) {
      return t('Mock mode');
    }

    return `${llmView.provider} · ${llmView.model} · ${llmView.api_key_masked}`;
  }, [llmView, t]);

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

  const uploadAttachment = async () => {
    const finalName = uploadFilename.trim() || `file-${Date.now()}.bin`;
    setUploading(true);
    setError('');

    try {
      await api.uploadConversationAttachment(finalName);
      setUploadFilename('');
      await refreshAttachments();
    } catch (uploadError) {
      setError((uploadError as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = async (attachmentId: string) => {
    setUploading(true);
    setError('');

    try {
      await api.removeAttachment(attachmentId);
      await refreshAttachments();
    } catch (removeError) {
      setError((removeError as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const sendWithContent = async (content: string) => {
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
          initial_message: content,
          attachment_ids: readyAttachmentIds
        });

        setConversation(started.conversation);
        setMessages(started.messages);
        upsertHistoryItem(started.conversation.id, content);
      } else {
        const response = await api.sendConversationMessage({
          conversation_id: conversation.id,
          content,
          attachment_ids: readyAttachmentIds
        });

        setMessages(response.messages);
        upsertHistoryItem(conversation.id, content);
      }

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

  const startNewConversation = () => {
    setConversation(null);
    setMessages([]);
    cancelRenameConversation();
    setInput('');
    setError('');
    setNotice(t('Started a fresh conversation.'));
  };

  const toggleHistoryPin = (id: string) => {
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
  };

  const toggleHistoryGroup = (groupKey: HistoryGroupKey) => {
    setCollapsedHistoryGroups((previous) =>
      previous.includes(groupKey)
        ? previous.filter((item) => item !== groupKey)
        : [...previous, groupKey]
    );
  };

  const beginRenameConversation = (item: LocalChatHistoryItem) => {
    setEditingConversationId(item.id);
    setEditingConversationTitle(item.title);
    setNotice('');
  };

  const cancelRenameConversation = () => {
    setEditingConversationId(null);
    setEditingConversationTitle('');
  };

  const saveConversationTitleLocal = (conversationId: string, nextTitle: string) => {
    setHistory((previous) =>
      sortHistoryItems(
        previous.map((item) =>
          item.id === conversationId ? { ...item, title: nextTitle, updated_at: new Date().toISOString() } : item
        ),
        pinnedHistoryOrderRef.current
      )
    );
  };

  const saveConversationTitle = async (conversationId: string) => {
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
  };

  const appendHiddenHistoryIds = useCallback((ids: string[]) => {
    if (ids.length === 0) {
      return;
    }

    setHiddenHistoryIds((previous) => normalizeHiddenConversationIds([...previous, ...ids]));
  }, []);

  const restoreConversation = async (conversationId: string) => {
    if (conversation?.id === conversationId) {
      return;
    }

    setRestoringConversationId(conversationId);
    setError('');

    try {
      const detail = await api.getConversationDetail(conversationId);
      setConversation(detail.conversation);
      setMessages(detail.messages);
      setSelectedModelId(detail.conversation.model_id);
      setHistory((previous) => {
        const existing = previous.find((item) => item.id === detail.conversation.id);
        const next: LocalChatHistoryItem = {
          id: detail.conversation.id,
          title: detail.conversation.title || existing?.title || 'New chat',
          updated_at: detail.conversation.updated_at || detail.conversation.created_at,
          pinned: existing?.pinned ?? false
        };

        return sortHistoryItems([
          next,
          ...previous.filter((item) => item.id !== detail.conversation.id)
        ], pinnedHistoryOrderRef.current).slice(0, 40);
      });
      setNotice(t('Conversation restored.'));
    } catch (restoreError) {
      setError((restoreError as Error).message);
    } finally {
      setRestoringConversationId(null);
    }
  };

  const deleteHistoryItem = (id: string) => {
    appendHiddenHistoryIds([id]);
    setHistory((previous) => previous.filter((item) => item.id !== id));
    if (editingConversationId === id) {
      cancelRenameConversation();
    }
    if (conversation?.id === id) {
      setConversation(null);
      setMessages([]);
      setInput('');
    }
    setNotice(t('Removed from sidebar (local).'));
  };

  const clearHistory = () => {
    appendHiddenHistoryIds(history.map((item) => item.id));
    setHistory([]);
    cancelRenameConversation();
    if (conversation && history.some((item) => item.id === conversation.id)) {
      setConversation(null);
      setMessages([]);
      setInput('');
    }
    setNotice(t('Cleared local chat sidebar.'));
  };

  const showHiddenHistory = async () => {
    setHiddenHistoryIds([]);
    hiddenHistoryIdsRef.current = [];
    try {
      await refreshConversations();
      setNotice(t('Hidden chats are visible again.'));
    } catch (refreshError) {
      setError((refreshError as Error).message);
    }
  };

  const sortedHistory = useMemo(
    () => sortHistoryItems(history, pinnedHistoryOrder),
    [history, pinnedHistoryOrder]
  );

  const filteredHistory = useMemo(() => {
    const keyword = historySearch.trim().toLowerCase();
    if (!keyword) {
      return sortedHistory;
    }

    return sortedHistory.filter((item) => item.title.toLowerCase().includes(keyword));
  }, [historySearch, sortedHistory]);

  const groupedHistory = useMemo(() => toHistoryGroups(filteredHistory), [filteredHistory]);

  const contextMenuItem = useMemo(
    () => (historyContextMenu ? history.find((item) => item.id === historyContextMenu.id) ?? null : null),
    [history, historyContextMenu]
  );

  const historyContextMenuActions = useMemo<HistoryContextMenuAction[]>(
    () => ['open', 'rename', 'pin', 'delete'],
    []
  );

  const getHistoryContextMenuActionLabel = useCallback(
    (action: HistoryContextMenuAction): string => {
      if (action === 'open') {
        return t('Open');
      }

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

  const executeHistoryContextAction = (action: HistoryContextMenuAction) => {
    if (!contextMenuItem) {
      return;
    }

    if (action === 'open') {
      restoreConversation(contextMenuItem.id).catch(() => {
        // handled by local error state
      });
    } else if (action === 'rename') {
      beginRenameConversation(contextMenuItem);
    } else if (action === 'pin') {
      toggleHistoryPin(contextMenuItem.id);
    } else if (action === 'delete') {
      deleteHistoryItem(contextMenuItem.id);
    }

    closeHistoryContextMenu();
  };

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
        o: 'open',
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
      const menuWidth = Math.max(170, Math.min(220, window.innerWidth - viewportPadding * 2));
      const menuHeight = 230;
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

  const openHistoryContextMenu = (event: ReactMouseEvent<HTMLLIElement>, itemId: string) => {
    event.preventDefault();
    openHistoryContextMenuByPoint(itemId, event.clientX, event.clientY);
  };

  const onHistoryItemKeyDown = (
    event: ReactKeyboardEvent<HTMLElement>,
    itemId: string
  ) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openHistoryContextMenuByPoint(itemId, rect.left + rect.width / 2, rect.top + 28);
    }
  };

  const onHistoryItemTouchStart = (event: ReactTouchEvent<HTMLLIElement>, itemId: string) => {
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
  };

  const onHistoryItemTouchMove = () => {
    clearHistoryLongPressTimer();
    setLongPressingConversationId(null);
  };

  const onHistoryItemTouchEnd = () => {
    clearHistoryLongPressTimer();
    setLongPressingConversationId(null);
  };

  const onHistoryItemTouchCancel = () => {
    clearHistoryLongPressTimer();
    setLongPressingConversationId(null);
  };

  const reorderPinnedByDrag = (draggedId: string, targetId: string) => {
    const currentOrder = pinnedHistoryOrderRef.current;
    const next = reorderPinnedHistoryOrder(currentOrder, draggedId, targetId);
    if (arraysEqual(currentOrder, next)) {
      return;
    }

    setPinnedHistoryOrder(next);
    pinnedHistoryOrderRef.current = next;
    setHistory((previous) => sortHistoryItems(previous, next));
  };

  const onPinnedDragStart = (event: ReactDragEvent<HTMLLIElement>, itemId: string) => {
    setDraggingPinnedConversationId(itemId);
    setDragOverPinnedConversationId(itemId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', itemId);
  };

  const onPinnedDragOver = (event: ReactDragEvent<HTMLLIElement>, itemId: string) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverPinnedConversationId(itemId);
  };

  const onPinnedDrop = (event: ReactDragEvent<HTMLLIElement>, itemId: string) => {
    event.preventDefault();
    const draggedId = event.dataTransfer.getData('text/plain') || draggingPinnedConversationId;
    if (draggedId) {
      reorderPinnedByDrag(draggedId, itemId);
    }
    setDraggingPinnedConversationId(null);
    setDragOverPinnedConversationId(null);
  };

  const onPinnedDragEnd = () => {
    setDraggingPinnedConversationId(null);
    setDragOverPinnedConversationId(null);
  };

  const onTextareaKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!sending) {
        send().catch(() => {
          // handled by local state
        });
      }
    }
  };

  const applyQuickPrompt = (prompt: string) => {
    setInput(prompt);
  };

  const copyMessage = async (content: string) => {
    const copied = await copyToClipboard(content);
    setNotice(
      copied
        ? t('Message copied to clipboard.')
        : t('Unable to copy message in this browser.')
    );
  };

  const quoteMessage = (content: string) => {
    setInput(`"${content}"\n\n`);
    setNotice(t('Quoted message into composer.'));
  };

  const messageCount = messages.length;
  const hasActiveConversation = Boolean(conversation);
  const historyGroupLabels: Record<HistoryGroupKey, string> = useMemo(
    () => ({
      pinned: t('Pinned'),
      today: t('Today'),
      yesterday: t('Yesterday'),
      previous_7_days: t('Previous 7 Days'),
      older: t('Older')
    }),
    [t]
  );
  const renderConversationTitle = useCallback(
    (title: string) => (title === 'New chat' ? t('New chat') : title),
    [t]
  );
  const conversationInfo = conversation
    ? `${renderConversationTitle(conversation.title)} (${conversation.id})`
    : t('not started');

  return (
    <section className="chat-workspace-page">
      <aside className="chat-workspace-sidebar">
        <div className="chat-sidebar-top stack">
          <div className="row between align-center">
            <strong>{t('Vistral Chat')}</strong>
            <Link to="/workspace/console" className="chat-sidebar-link">
              {t('Console')}
            </Link>
          </div>
          <label className="language-switch-inline chat-language-switch">
            <span>{t('Language')}</span>
            <select
              value={language}
              onChange={(event) => setLanguage(event.target.value as 'zh-CN' | 'en-US')}
            >
              <option value="zh-CN">{t('Chinese')}</option>
              <option value="en-US">{t('English')}</option>
            </select>
          </label>
          <button className="chat-new-btn" onClick={startNewConversation} disabled={sending}>
            {t('+ New chat')}
          </button>
          <input
            className="chat-search-input"
            value={historySearch}
            onChange={(event) => setHistorySearch(event.target.value)}
            placeholder={t('Search chats')}
          />
          <div className="chat-shortcuts stack tight">
            <small className="muted">{t('Quick access')}</small>
            <Link to="/models/explore" className="chat-sidebar-link">
              {t('Models')}
            </Link>
            <Link to="/datasets" className="chat-sidebar-link">
              {t('Datasets')}
            </Link>
            <Link to="/training/jobs" className="chat-sidebar-link">
              {t('Training')}
            </Link>
            <Link to="/settings/llm" className="chat-sidebar-link">
              {t('LLM settings')}
            </Link>
          </div>
        </div>

        <div className="chat-history-wrap">
          <div className="row between align-center">
            <small className="muted">{t('Recent chats')}</small>
            <div className="row gap">
              <button
                className="small-btn chat-history-refresh"
                onClick={() => {
                  refreshConversations().catch((refreshError) => {
                    setError((refreshError as Error).message);
                  });
                }}
                disabled={historyLoading}
              >
                {historyLoading ? t('Syncing...') : t('Sync')}
              </button>
              {history.length > 0 ? (
                <button className="small-btn chat-history-clear" onClick={clearHistory}>
                  {t('Clear')}
                </button>
              ) : null}
              {hiddenHistoryIds.length > 0 ? (
                <button className="small-btn chat-history-clear" onClick={showHiddenHistory}>
                  {t('Show hidden')}
                </button>
              ) : null}
            </div>
          </div>
          <ul className="chat-history-list">
            {historyLoading ? (
              <li className="chat-history-empty">{t('Syncing conversation history...')}</li>
            ) : filteredHistory.length === 0 ? (
              <li className="chat-history-empty">{t('No visible chats yet.')}</li>
            ) : (
              groupedHistory.map((group) => (
                <li key={group.key} className="chat-history-group">
                  <button
                    className="chat-history-group-title"
                    onClick={() => toggleHistoryGroup(group.key)}
                  >
                    <span>{collapsedHistoryGroups.includes(group.key) ? '▸' : '▾'}</span>
                    <span>{historyGroupLabels[group.key]}</span>
                  </button>
                  {collapsedHistoryGroups.includes(group.key) ? null : (
                    <ul className="chat-history-sublist">
                      {group.items.map((item) => {
                        const isPinnedItem = group.key === 'pinned';
                        const isDragging = draggingPinnedConversationId === item.id;
                        const isDragOver =
                          dragOverPinnedConversationId === item.id &&
                          draggingPinnedConversationId !== item.id;
                        const isLongPressing = longPressingConversationId === item.id;

                        const itemClasses = [
                          item.id === conversation?.id ? 'chat-history-item active' : 'chat-history-item',
                          isPinnedItem ? 'chat-history-item-draggable' : '',
                          isDragging ? 'dragging' : '',
                          isDragOver ? 'drag-over' : '',
                          isLongPressing ? 'long-pressing' : ''
                        ]
                          .filter(Boolean)
                          .join(' ');

                        return (
                          <li
                            key={item.id}
                            className={itemClasses}
                            draggable={isPinnedItem && editingConversationId !== item.id}
                            onDragStart={(event) => onPinnedDragStart(event, item.id)}
                            onDragOver={(event) => {
                              if (isPinnedItem) {
                                onPinnedDragOver(event, item.id);
                              }
                            }}
                            onDrop={(event) => {
                              if (isPinnedItem) {
                                onPinnedDrop(event, item.id);
                              }
                            }}
                            onDragEnd={onPinnedDragEnd}
                            onContextMenu={(event) => openHistoryContextMenu(event, item.id)}
                            onTouchStart={(event) => onHistoryItemTouchStart(event, item.id)}
                            onTouchMove={onHistoryItemTouchMove}
                            onTouchEnd={onHistoryItemTouchEnd}
                            onTouchCancel={onHistoryItemTouchCancel}
                          >
                            {editingConversationId === item.id ? (
                              <div className="chat-history-edit stack tight">
                                <input
                                  value={editingConversationTitle}
                                  onChange={(event) => setEditingConversationTitle(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                      event.preventDefault();
                                      saveConversationTitle(item.id).catch(() => {
                                        // handled by local error state
                                      });
                                    }

                                    if (event.key === 'Escape') {
                                      event.preventDefault();
                                      cancelRenameConversation();
                                    }
                                  }}
                                  placeholder={t('Conversation title')}
                                  autoFocus
                                  disabled={renamingConversationId === item.id}
                                />
                                <div className="row gap">
                                  <button
                                    className="small-btn chat-history-action"
                                    onClick={() => {
                                      saveConversationTitle(item.id).catch(() => {
                                        // handled by local error state
                                      });
                                    }}
                                    disabled={renamingConversationId === item.id}
                                  >
                                    {renamingConversationId === item.id ? t('Saving...') : t('Save')}
                                  </button>
                                  <button
                                    className="small-btn chat-history-action"
                                    onClick={cancelRenameConversation}
                                    disabled={renamingConversationId === item.id}
                                  >
                                    {t('Cancel')}
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="row between gap align-center">
                                <button
                                  className="chat-history-open"
                                  onClick={() => {
                                    if (historyLongPressTriggeredRef.current) {
                                      historyLongPressTriggeredRef.current = false;
                                      return;
                                    }
                                    restoreConversation(item.id).catch(() => {
                                      // handled by local error state
                                    });
                                  }}
                                  onKeyDown={(event) => onHistoryItemKeyDown(event, item.id)}
                                  disabled={restoringConversationId === item.id}
                                >
                                  <span>{renderConversationTitle(item.title)}</span>
                                  <small>{formatHistoryTimestamp(item.updated_at)}</small>
                                </button>
                                <div className="row gap">
                                  <button className="small-btn chat-history-action" onClick={() => beginRenameConversation(item)}>
                                    {t('Rename')}
                                  </button>
                                  <button className="small-btn chat-history-action" onClick={() => toggleHistoryPin(item.id)}>
                                    {item.pinned ? t('Unpin') : t('Pin')}
                                  </button>
                                  <button className="small-btn chat-history-action" onClick={() => deleteHistoryItem(item.id)}>
                                    {t('Del')}
                                  </button>
                                </div>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              ))
            )}
          </ul>
          {historyContextMenu && contextMenuItem ? (
            <div
              className="chat-history-menu"
              style={{ left: historyContextMenu.x, top: historyContextMenu.y }}
              onClick={(event) => event.stopPropagation()}
              role="menu"
              aria-label={t('Conversation actions')}
            >
              {historyContextMenuActions.map((action, index) => (
                <button
                  key={action}
                  className={`chat-history-menu-item${action === 'delete' ? ' danger' : ''}${historyContextMenuActiveIndex === index ? ' active' : ''}`}
                  onMouseEnter={() => setHistoryContextMenuActiveIndex(index)}
                  onClick={() => executeHistoryContextAction(action)}
                  ref={(element) => {
                    historyMenuButtonRefs.current[index] = element;
                  }}
                  tabIndex={historyContextMenuActiveIndex === index ? 0 : -1}
                  aria-selected={historyContextMenuActiveIndex === index}
                  role="menuitem"
                >
                  {getHistoryContextMenuActionLabel(action)}
                </button>
              ))}
              <small className="chat-history-menu-hint">{t('Keys: ↑/↓ · Enter · Esc · O/R/P/D')}</small>
            </div>
          ) : null}
        </div>

        <div className="chat-user-card">
          <div className="chat-user-avatar">{getInitials(currentUser?.username)}</div>
          <div className="stack tight">
            <strong>{currentUser?.username || t('guest')}</strong>
            <small className="muted">{roleLabel(currentUser?.role)}</small>
          </div>
        </div>
      </aside>

      <div className="chat-main-area">
        <header className="chat-main-header">
          <div className="row between align-center gap wrap">
            <div className="row gap align-center wrap">
              <label className="chat-model-select">
                <span>{t('Model')}</span>
                <select
                  value={selectedModelId}
                  onChange={(event) => setSelectedModelId(event.target.value)}
                  disabled={sending || hasActiveConversation}
                >
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name} ({model.status})
                    </option>
                  ))}
                </select>
              </label>
              <div className="chat-mode-chip">{t('Mode:')} {llmModeText}</div>
            </div>
            <div className="chat-header-user-badge">
              <div className="chat-user-avatar">{getInitials(currentUser?.username)}</div>
              <span>{currentUser?.username || t('guest')}</span>
            </div>
          </div>
          <small className="muted">
            {t('Conversation {conversationInfo} · messages {messageCount}', {
              conversationInfo,
              messageCount
            })}
          </small>
        </header>

        <section className="chat-message-stage">
          {loading ? (
            <StateBlock
              variant="loading"
              title={t('Preparing Workspace')}
              description={t('Loading models and attachment context.')}
            />
          ) : null}

          {error ? <StateBlock variant="error" title={t('Conversation Error')} description={error} /> : null}

          {!loading && !error && models.length === 0 ? (
            <StateBlock
              variant="empty"
              title={t('No Available Models')}
              description={t('No model is visible for this account. Publish or authorize one first.')}
            />
          ) : null}

          {!loading && !error && models.length > 0 ? (
            <div className="chat-message-scroll">
              {messages.length === 0 ? (
                <div className="chat-empty-center">
                  <h2>{t('How can I help you today?')}</h2>
                  <small className="muted">
                    {t('Upload files, ask a question, then iterate in this chat-style workspace.')}
                  </small>
                </div>
              ) : (
                <ul className="chat-message-list">
                  {messages.map((message) => (
                    <li
                      key={message.id}
                      className={message.sender === 'user' ? 'chat-message-row user' : 'chat-message-row assistant'}
                    >
                      <div className="chat-message-meta">
                        <span>{message.sender === 'user' ? currentUser?.username || t('you') : t('Vistral')}</span>
                        <small>{new Date(message.created_at).toLocaleTimeString()}</small>
                      </div>
                      <div className="chat-message-bubble">
                        <p>{message.content}</p>
                        {message.attachment_ids.length > 0 ? (
                          <small className="muted">{t('Attachments:')} {message.attachment_ids.join(', ')}</small>
                        ) : null}
                        <div className="chat-message-actions row gap wrap">
                          <button
                            className="small-btn chat-action-btn"
                            onClick={() => {
                              copyMessage(message.content).catch(() => {
                                // notice handled by helper
                              });
                            }}
                          >
                            {t('Copy')}
                          </button>
                          <button className="small-btn chat-action-btn" onClick={() => quoteMessage(message.content)}>
                            {t('Reuse')}
                          </button>
                          {message.sender === 'assistant' ? (
                            <button
                              className="small-btn chat-action-btn"
                              onClick={() => quoteMessage(`Analyze further: ${message.content}`)}
                            >
                              {t('Quote')}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </section>

        <footer className="chat-composer-wrap">
          <section className="chat-attachment-strip">
            <div className="row between align-center">
              <small className="muted">{t('Attachments in current context')}</small>
              <small className="muted">{t('Ready: {count}', { count: readyAttachmentIds.length })}</small>
            </div>

            <div className="chat-upload-row">
              <input
                value={uploadFilename}
                onChange={(event) => setUploadFilename(event.target.value)}
                placeholder={t('Enter filename, for example: invoice-sample.jpg')}
                disabled={uploading || sending}
              />
              <button onClick={uploadAttachment} disabled={uploading || sending}>
                {uploading ? t('Working...') : t('Attach')}
              </button>
            </div>

            {attachments.length === 0 ? (
              <small className="muted">{t('No files yet. Uploaded files stay visible and deletable here.')}</small>
            ) : (
              <ul className="chat-attachment-list">
                {attachments.map((item) => (
                  <li key={item.id} className="chat-attachment-item">
                    <span className="chat-attachment-name" title={item.filename}>
                      {item.filename}
                    </span>
                    <StatusBadge status={item.status} />
                    <button
                      className="small-btn chat-delete-btn"
                      onClick={() => removeAttachment(item.id)}
                      disabled={uploading || sending}
                    >
                      {t('Delete')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="chat-composer-panel">
            <div className="chat-composer-toolbar row gap wrap">
              <button
                className="small-btn chat-action-btn"
                onClick={() => applyQuickPrompt('Please summarize the ready attachments.')}
                disabled={sending || loading || models.length === 0}
              >
                {t('Summarize files')}
              </button>
              <button
                className="small-btn chat-action-btn"
                onClick={() => applyQuickPrompt('Please extract key visual findings with confidence scores.')}
                disabled={sending || loading || models.length === 0}
              >
                {t('Key findings')}
              </button>
              <button
                className="small-btn chat-action-btn"
                onClick={() => applyQuickPrompt('Please provide a concise risk assessment and next steps.')}
                disabled={sending || loading || models.length === 0}
              >
                {t('Risk assessment')}
              </button>
            </div>

            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onTextareaKeyDown}
              rows={3}
              placeholder={t('Message Vistral...')}
              disabled={sending || loading || models.length === 0}
            />
            <div className="row between align-center gap wrap">
              <small className="muted">{notice || t('Press Enter to send, Shift + Enter for newline.')}</small>
              <button onClick={send} disabled={sending || loading || models.length === 0 || !input.trim()}>
                {sending ? `${t('Sending')}...` : hasActiveConversation ? t('Send') : t('Start')}
              </button>
            </div>
          </section>
        </footer>
      </div>
    </section>
  );
}
