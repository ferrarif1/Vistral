import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent
} from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
import { useI18n } from '../i18n/I18nProvider';
import StateBlock from '../components/StateBlock';
import StatusBadge from '../components/StatusBadge';
import { api } from '../services/api';
import { AUTH_UPDATED_EVENT, emitAuthUpdated } from '../services/authSession';
import { LLM_CONFIG_UPDATED_EVENT } from '../services/llmConfig';

interface LocalChatHistoryItem {
  id: string;
  title: string;
  updated_at: string;
  pinned: boolean;
}

type HistoryGroupKey = 'pinned' | 'today' | 'yesterday' | 'previous_7_days' | 'older';
type SidebarSectionKey = 'controls' | 'history' | 'quick' | 'preferences';

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
const sidebarCollapsedStorageKey = 'vistral-chat-sidebar-collapsed';
const collapsedSidebarSectionsStorageKey = 'vistral-chat-collapsed-sidebar-sections';
const historyGroupKeys: HistoryGroupKey[] = [
  'pinned',
  'today',
  'yesterday',
  'previous_7_days',
  'older'
];
const sidebarSectionKeys: SidebarSectionKey[] = ['controls', 'history', 'quick', 'preferences'];
const defaultCollapsedSidebarSections: SidebarSectionKey[] = ['quick', 'preferences'];
const compactViewportMaxWidth = 960;
const backgroundRefreshIntervalMs = 5000;

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

const readCollapsedSidebarSectionsFromStorage = (): SidebarSectionKey[] => {
  try {
    const raw = localStorage.getItem(collapsedSidebarSectionsStorageKey);
    if (!raw) {
      return defaultCollapsedSidebarSections;
    }

    const parsed = JSON.parse(raw) as string[];
    if (!Array.isArray(parsed)) {
      return defaultCollapsedSidebarSections;
    }

    const parsedSet = new Set(parsed);
    return sidebarSectionKeys.filter((key) => parsedSet.has(key));
  } catch {
    return defaultCollapsedSidebarSections;
  }
};

const writeCollapsedSidebarSectionsToStorage = (sectionKeys: SidebarSectionKey[]) => {
  try {
    const unique = Array.from(new Set(sectionKeys)).filter((key): key is SidebarSectionKey =>
      sidebarSectionKeys.includes(key as SidebarSectionKey)
    );
    localStorage.setItem(collapsedSidebarSectionsStorageKey, JSON.stringify(unique));
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
    // Ignore storage errors in prototype mode.
  }
};

const detectCompactViewport = (): boolean =>
  typeof window !== 'undefined' ? window.innerWidth <= compactViewportMaxWidth : false;

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

const formatMessageParagraphs = (content: string): string[] =>
  content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const hasChineseText = (value: string): boolean => /[\u4e00-\u9fff]/.test(value);

const actionRouteByEntityType: Record<'Dataset' | 'TrainingJob' | 'Model', string> = {
  Dataset: '/datasets',
  TrainingJob: '/training/jobs',
  Model: '/models/my-models'
};

const datasetIdPattern = /\((d-\d+)\)$/i;
const isAuthenticationRequiredMessage = (message: string): boolean => message === 'Authentication required.';

export default function ConversationPage() {
  const navigate = useNavigate();
  const { language, setLanguage, t } = useI18n();
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() =>
    readSidebarCollapsedFromStorage()
  );
  const [isCompactViewport, setIsCompactViewport] = useState<boolean>(() => detectCompactViewport());
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [collapsedHistoryGroups, setCollapsedHistoryGroups] = useState<HistoryGroupKey[]>(() =>
    readCollapsedHistoryGroupsFromStorage()
  );
  const [collapsedSidebarSections, setCollapsedSidebarSections] = useState<SidebarSectionKey[]>(() =>
    readCollapsedSidebarSectionsFromStorage()
  );
  const [pinnedHistoryOrder, setPinnedHistoryOrder] = useState<string[]>(() =>
    readPinnedHistoryOrderFromStorage()
  );
  const [historySearch, setHistorySearch] = useState('');
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [editingConversationTitle, setEditingConversationTitle] = useState('');
  const [input, setInput] = useState('');
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
  const [attachmentListExpanded, setAttachmentListExpanded] = useState(false);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [draggingSelectedAttachmentId, setDraggingSelectedAttachmentId] = useState<string | null>(null);
  const [dragOverSelectedAttachmentId, setDragOverSelectedAttachmentId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
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

  const clearWorkspaceForAnonymousSession = useCallback(() => {
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
    if (!currentUser) {
      return;
    }

    const timer = window.setInterval(() => {
      refreshAttachments().catch(() => {
        // Keep UI stable in polling loop; explicit errors are reported by direct actions.
      });
    }, backgroundRefreshIntervalMs);

    return () => window.clearInterval(timer);
  }, [currentUser, refreshAttachments]);

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
    writeCollapsedHistoryGroupsToStorage(collapsedHistoryGroups);
  }, [collapsedHistoryGroups]);

  useEffect(() => {
    writeCollapsedSidebarSectionsToStorage(collapsedSidebarSections);
  }, [collapsedSidebarSections]);

  useEffect(() => {
    pinnedHistoryOrderRef.current = pinnedHistoryOrder;
    writePinnedHistoryOrderToStorage(pinnedHistoryOrder);
  }, [pinnedHistoryOrder]);

  useEffect(() => {
    const syncViewport = () => {
      setIsCompactViewport(detectCompactViewport());
    };

    syncViewport();
    window.addEventListener('resize', syncViewport);
    return () => {
      window.removeEventListener('resize', syncViewport);
    };
  }, []);

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
    const nextHeight = Math.max(44, Math.min(textarea.scrollHeight, 180));
    textarea.style.height = `${nextHeight}px`;
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

  const attachmentStatusSummary = useMemo(() => {
    const summary = {
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

  useEffect(() => {
    setSelectedAttachmentIds((previous) => {
      const availableIdSet = new Set(attachments.map((item) => item.id));
      const next = previous.filter((itemId) => availableIdSet.has(itemId));
      return arraysEqual(previous, next) ? previous : next;
    });
  }, [attachments]);

  const llmModeText = useMemo(() => {
    if (!llmView || !llmView.enabled || !llmView.has_api_key) {
      return t('Mock mode');
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
      return field;
    },
    [t]
  );

  const resolveMessageAttachmentNames = useCallback(
    (message: MessageRecord) =>
      message.attachment_ids.map((attachmentId) => attachmentById.get(attachmentId)?.filename ?? attachmentId),
    [attachmentById]
  );

  const resolveConversationActionHref = useCallback((action: ConversationActionMetadata) => {
    if (!action.created_entity_type || !action.created_entity_id) {
      return null;
    }

    if (action.created_entity_type === 'Dataset') {
      return `${actionRouteByEntityType.Dataset}/${action.created_entity_id}`;
    }

    if (action.created_entity_type === 'TrainingJob') {
      return `${actionRouteByEntityType.TrainingJob}/${action.created_entity_id}`;
    }

    return actionRouteByEntityType.Model;
  }, []);

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

  const openUploadFileDialog = () => {
    uploadFileInputRef.current?.click();
  };

  const toggleAttachmentTray = () => {
    setAttachmentListExpanded((previous) => !previous);
  };

  const onUploadFileInputChange = async (event: ReactChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    if (selected.length === 0) {
      return;
    }

    await uploadAttachmentsByFiles(selected);
  };

  const removeAttachment = async (attachmentId: string) => {
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
  };

  const openAttachment = (attachmentId: string) => {
    window.open(api.attachmentContentUrl(attachmentId), '_blank', 'noopener,noreferrer');
  };

  const includeAttachmentInCurrentMessage = (attachment: FileAttachment) => {
    if (attachment.status !== 'ready') {
      return;
    }

    if (selectedAttachmentIdSet.has(attachment.id)) {
      setNotice(t('Attachment {filename} already in context.', { filename: attachment.filename }));
      return;
    }

    setSelectedAttachmentIds((previous) => [...previous, attachment.id]);
    setNotice(t('Attachment {filename} included in current message.', { filename: attachment.filename }));
  };

  const excludeAttachmentFromCurrentMessage = (attachment: FileAttachment) => {
    if (!selectedAttachmentIdSet.has(attachment.id)) {
      return;
    }

    setSelectedAttachmentIds((previous) => previous.filter((itemId) => itemId !== attachment.id));
    setNotice(t('Attachment {filename} removed from current message.', { filename: attachment.filename }));
  };

  const includeAllReadyAttachments = () => {
    setSelectedAttachmentIds(readyAttachmentIds);
    setAttachmentListExpanded(false);
    setNotice(t('All ready files are now included in current message.'));
  };

  const clearCurrentAttachmentContext = () => {
    setSelectedAttachmentIds([]);
    setNotice(t('Current attachment context has been cleared.'));
  };

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
          throw new Error('No available model found for this account.');
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

  const startNewConversation = () => {
    setConversation(null);
    setMessages([]);
    cancelRenameConversation();
    setInput('');
    setSelectedAttachmentIds([]);
    setAttachmentListExpanded(false);
    setError('');
    setNotice(t('Started a fresh conversation.'));
    closeMobileSidebar();
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

  const toggleSidebarSection = (sectionKey: SidebarSectionKey) => {
    setCollapsedSidebarSections((previous) =>
      previous.includes(sectionKey)
        ? previous.filter((item) => item !== sectionKey)
        : [...previous, sectionKey]
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
      setSelectedAttachmentIds([]);
      setAttachmentListExpanded(false);
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
      closeMobileSidebar();
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
      setSelectedAttachmentIds([]);
      setAttachmentListExpanded(false);
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
      setSelectedAttachmentIds([]);
      setAttachmentListExpanded(false);
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

  const openHistoryContextMenuFromButton = (
    event: ReactMouseEvent<HTMLButtonElement>,
    itemId: string
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    openHistoryContextMenuByPoint(itemId, rect.right - 4, rect.bottom + 6);
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

  const reorderSelectedAttachmentsByDrag = (draggedId: string, targetId: string) => {
    setSelectedAttachmentIds((previous) => {
      const next = reorderSelectedAttachmentOrder(previous, draggedId, targetId);
      return arraysEqual(previous, next) ? previous : next;
    });
    setNotice(t('Attachment order updated for current message.'));
  };

  const onSelectedAttachmentDragStart = (
    event: ReactDragEvent<HTMLLIElement>,
    attachmentId: string
  ) => {
    setDraggingSelectedAttachmentId(attachmentId);
    setDragOverSelectedAttachmentId(attachmentId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', attachmentId);
  };

  const onSelectedAttachmentDragOver = (
    event: ReactDragEvent<HTMLLIElement>,
    attachmentId: string
  ) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverSelectedAttachmentId(attachmentId);
  };

  const onSelectedAttachmentDrop = (
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
  };

  const onSelectedAttachmentDragEnd = () => {
    setDraggingSelectedAttachmentId(null);
    setDragOverSelectedAttachmentId(null);
  };

  const onTextareaKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSend) {
        send().catch(() => {
          // handled by local state
        });
      }
    }
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

      setInput(nextInput);
      window.requestAnimationFrame(() => {
        composerTextareaRef.current?.focus();
      });
      setNotice(t('Suggestion inserted into composer.'));
    },
    [t]
  );

  const messageCount = messages.length;
  const hasActiveConversation = Boolean(conversation);
  const canSend =
    !sending &&
    !loading &&
    !uploading &&
    !authRequired &&
    !hasPendingSelectedAttachments &&
    models.length > 0 &&
    Boolean(input.trim());
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
    ? renderConversationTitle(conversation.title)
    : t('not started');
  const hasHistorySearch = historySearch.trim().length > 0;
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
  const historyEmptyLabel = historyLoading
    ? t('Syncing conversation history...')
    : filteredHistory.length === 0
      ? hasHistorySearch
        ? t('No chats match this search.')
        : t('No visible chats yet.')
      : '';
  const controlsSectionCollapsed = collapsedSidebarSections.includes('controls');
  const historySectionCollapsed = collapsedSidebarSections.includes('history');
  const quickSectionCollapsed = collapsedSidebarSections.includes('quick');
  const preferencesSectionCollapsed = collapsedSidebarSections.includes('preferences');

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
      { to: '/settings', label: t('Settings') },
      { to: '/workspace/console', label: t('Professional Console') },
      { label: t('Logout'), onSelect: logout, tone: 'danger' as const }
    ],
    [logout, t]
  );

  return (
    <section className={pageClassName}>
      {isCompactViewport ? (
        <button
          type="button"
          className={`chat-sidebar-scrim${mobileSidebarOpen ? ' visible' : ''}`}
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
                <div className="stack tight">
                  <strong>{t('Vistral Chat')}</strong>
                  <small className="muted">{t('Conversation Workspace')}</small>
                </div>
              </div>
              <div className="chat-sidebar-brand-actions">
                <Link to="/workspace/console" className="chat-sidebar-console-chip">
                  {t('Console')}
                </Link>
                <button
                  type="button"
                  className="chat-sidebar-toggle-inline"
                  onClick={toggleSidebar}
                  aria-label={sidebarToggleLabel}
                  title={sidebarToggleLabel}
                >
                  {sidebarToggleToken}
                </button>
              </div>
            </div>
          </div>

          <div className="chat-sidebar-scroll">
            <section className="chat-sidebar-section">
              <button
                type="button"
                className="chat-sidebar-section-toggle"
                onClick={() => toggleSidebarSection('controls')}
                aria-label={controlsSectionCollapsed ? t('Expand section') : t('Collapse section')}
              >
                <span className="chat-sidebar-section-heading">
                  <strong>{t('Chat controls')}</strong>
                </span>
                <span className="chat-sidebar-section-chevron" aria-hidden="true">
                  {controlsSectionCollapsed ? '▸' : '▾'}
                </span>
              </button>

              {controlsSectionCollapsed ? null : (
                <div className="chat-sidebar-section-body stack">
                  <button
                    className="chat-new-btn"
                    onClick={startNewConversation}
                    disabled={sending || authRequired}
                    type="button"
                  >
                    {t('+ New chat')}
                  </button>
                  <label className="chat-search-shell" aria-label={t('Search chats')}>
                    <span className="chat-search-prefix" aria-hidden="true">
                      /
                    </span>
                    <input
                      className="chat-search-input"
                      value={historySearch}
                      onChange={(event) => setHistorySearch(event.target.value)}
                      placeholder={t('Search chats')}
                      disabled={authRequired}
                    />
                  </label>
                </div>
              )}
            </section>

            <section className="chat-sidebar-section">
              <button
                type="button"
                className="chat-sidebar-section-toggle"
                onClick={() => toggleSidebarSection('history')}
                aria-label={historySectionCollapsed ? t('Expand section') : t('Collapse section')}
              >
                <span className="chat-sidebar-section-heading">
                  <strong>{t('Recent chats')}</strong>
                  <small>{filteredHistory.length}</small>
                </span>
                <span className="chat-sidebar-section-chevron" aria-hidden="true">
                  {historySectionCollapsed ? '▸' : '▾'}
                </span>
              </button>

              {historySectionCollapsed ? null : (
                <div className="chat-history-wrap">
                  <div className="chat-history-toolbar">
                    <div className="chat-history-toolbar-copy">
                      <small className="muted">{t('Recent chats')}</small>
                      <span className="chat-history-count">{filteredHistory.length}</span>
                    </div>
                    <div className="row gap wrap">
                      <button
                        className="small-btn chat-history-refresh"
                        type="button"
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
                        <button className="small-btn chat-history-clear" onClick={clearHistory} type="button">
                          {t('Clear')}
                        </button>
                      ) : null}
                      {hiddenHistoryIds.length > 0 ? (
                        <button className="small-btn chat-history-clear" onClick={showHiddenHistory} type="button">
                          {t('Show hidden')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <ul className="chat-history-list">
                    {historyLoading || filteredHistory.length === 0 ? (
                      <li className="chat-history-empty">{historyEmptyLabel}</li>
                    ) : (
                      groupedHistory.map((group) => (
                        <li key={group.key} className="chat-history-group">
                          <button
                            className="chat-history-group-title"
                            type="button"
                            onClick={() => toggleHistoryGroup(group.key)}
                          >
                            <span className="chat-history-group-heading">
                              <span>{historyGroupLabels[group.key]}</span>
                              <small>{group.items.length}</small>
                            </span>
                            <span className="chat-history-group-chevron" aria-hidden="true">
                              {collapsedHistoryGroups.includes(group.key) ? '▸' : '▾'}
                            </span>
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
                                      <div className="chat-history-item-shell">
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
                                          type="button"
                                        >
                                          <span className="chat-history-title-row">
                                            {isPinnedItem ? (
                                              <span className="chat-history-drag-handle" aria-hidden="true">
                                                ::
                                              </span>
                                            ) : null}
                                            <span className="chat-history-title-text">
                                              {renderConversationTitle(item.title)}
                                            </span>
                                          </span>
                                          <small>{formatHistoryTimestamp(item.updated_at)}</small>
                                        </button>
                                        <button
                                          className="chat-history-more"
                                          type="button"
                                          onClick={(event) => openHistoryContextMenuFromButton(event, item.id)}
                                          title={t('Conversation actions')}
                                          aria-label={t('Conversation actions')}
                                        >
                                          ...
                                        </button>
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
              )}
            </section>

            <section className="chat-sidebar-section">
              <button
                type="button"
                className="chat-sidebar-section-toggle"
                onClick={() => toggleSidebarSection('quick')}
                aria-label={quickSectionCollapsed ? t('Expand section') : t('Collapse section')}
              >
                <span className="chat-sidebar-section-heading">
                  <strong>{t('Quick access')}</strong>
                  <small>3</small>
                </span>
                <span className="chat-sidebar-section-chevron" aria-hidden="true">
                  {quickSectionCollapsed ? '▸' : '▾'}
                </span>
              </button>

              {quickSectionCollapsed ? null : (
                <div className="chat-sidebar-section-body chat-sidebar-quick stack tight">
                  <div className="chat-sidebar-quick-links">
                    <Link to="/models/explore" className="chat-sidebar-quick-link">
                      {t('Models')}
                    </Link>
                    <Link to="/datasets" className="chat-sidebar-quick-link">
                      {t('Datasets')}
                    </Link>
                    <Link to="/training/jobs" className="chat-sidebar-quick-link">
                      {t('Training')}
                    </Link>
                  </div>
                </div>
              )}
            </section>

            <section className="chat-sidebar-section">
              <button
                type="button"
                className="chat-sidebar-section-toggle"
                onClick={() => toggleSidebarSection('preferences')}
                aria-label={preferencesSectionCollapsed ? t('Expand section') : t('Collapse section')}
              >
                <span className="chat-sidebar-section-heading">
                  <strong>{t('Workspace settings')}</strong>
                  <small>{currentUser ? '2' : '3'}</small>
                </span>
                <span className="chat-sidebar-section-chevron" aria-hidden="true">
                  {preferencesSectionCollapsed ? '▸' : '▾'}
                </span>
              </button>

              {preferencesSectionCollapsed ? null : (
                <div className="chat-sidebar-section-body chat-sidebar-footer stack">
                  <label className="language-switch-inline chat-language-switch chat-language-switch-sidebar">
                    <span>{t('Language')}</span>
                    <select
                      value={language}
                      onChange={(event) => setLanguage(event.target.value as 'zh-CN' | 'en-US')}
                    >
                      <option value="zh-CN">{t('Chinese')}</option>
                      <option value="en-US">{t('English')}</option>
                    </select>
                  </label>
                  {currentUser ? (
                    <SessionMenu
                      currentUser={currentUser}
                      items={sessionMenuItems}
                      align="start"
                      direction="up"
                      variant="sidebar"
                    />
                  ) : (
                    <div className="chat-user-card guest">
                      <div className="chat-user-summary">
                        <div className="chat-user-avatar">{getInitials()}</div>
                        <div className="stack tight">
                          <strong>{t('guest')}</strong>
                          <small className="muted">{t('Login')}</small>
                        </div>
                      </div>
                      <div className="chat-user-actions">
                        <Link to="/auth/login">{t('Login')}</Link>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>

        <div className="chat-sidebar-collapsed-rail">
          <button
            type="button"
            className="chat-sidebar-rail-btn chat-sidebar-rail-control"
            onClick={toggleSidebar}
            aria-label={t('Expand sidebar')}
            title={t('Expand sidebar')}
          >
            &gt;
          </button>
          <button
            type="button"
            className="chat-sidebar-rail-btn"
            onClick={startNewConversation}
            disabled={authRequired}
            aria-label={t('+ New chat')}
            title={t('+ New chat')}
          >
            +
          </button>
          <Link className="chat-sidebar-rail-link" to="/workspace/console" aria-label={t('Console')} title={t('Console')}>
            C
          </Link>
          <Link className="chat-sidebar-rail-link" to="/models/explore" aria-label={t('Models')} title={t('Models')}>
            M
          </Link>
          <Link className="chat-sidebar-rail-link" to="/datasets" aria-label={t('Datasets')} title={t('Datasets')}>
            D
          </Link>
          <Link className="chat-sidebar-rail-link" to="/training/jobs" aria-label={t('Training')} title={t('Training')}>
            T
          </Link>
          <Link
            className="chat-sidebar-rail-link"
            to="/settings"
            aria-label={t('Settings')}
            title={t('Settings')}
          >
            S
          </Link>
          <div className="chat-sidebar-rail-footer">
            {currentUser ? (
              <SessionMenu
                currentUser={currentUser}
                items={sessionMenuItems}
                align="start"
                direction="up"
                variant="rail"
              />
            ) : (
              <div className="chat-sidebar-rail-avatar" title={t('guest')}>
                {getInitials()}
              </div>
            )}
          </div>
        </div>
      </aside>

      <div className="chat-main-area">
        <header className="chat-main-header">
          <div className="chat-main-header-row">
            <div className="chat-main-header-leading">
              <button
                type="button"
                className="chat-sidebar-toggle"
                onClick={toggleSidebar}
                aria-label={sidebarToggleLabel}
                title={sidebarToggleLabel}
              >
                {sidebarToggleToken}
              </button>
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
            </div>
            <div className="chat-main-header-meta">
              <div className="chat-mode-chip">{t('Mode:')} {llmModeText}</div>
              <small className="chat-main-header-summary muted">
                {t('Conversation {conversationInfo} · messages {messageCount}', {
                  conversationInfo,
                  messageCount
                })}
              </small>
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
              {currentUser && isCompactViewport ? (
                <SessionMenu currentUser={currentUser} items={sessionMenuItems} />
              ) : null}
              {currentUser ? null : (
                <div className="chat-header-auth-links">
                  <Link to="/auth/login">{t('Login')}</Link>
                </div>
              )}
            </div>
          </div>
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

          {!loading && !error && authRequired ? (
            <StateBlock
              variant="empty"
              title={t('Login to use conversation workspace')}
              description={t('Sign in to access chat history, settings, attachments, and real conversation actions.')}
              extra={
                <div className="chat-auth-state-actions">
                  <Link to="/auth/login" className="entry-cta">
                    {t('Login')}
                  </Link>
                </div>
              }
            />
          ) : null}

          {!loading && !error && !authRequired && models.length === 0 ? (
            <StateBlock
              variant="empty"
              title={t('No Available Models')}
              description={t('No model is visible for this account. Publish or authorize one first.')}
            />
          ) : null}

          {!loading && !error && !authRequired && models.length > 0 ? (
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
                  {messages.map((message) => {
                    const actionMetadata = message.metadata?.conversation_action ?? null;
                    const actionHref = actionMetadata ? resolveConversationActionHref(actionMetadata) : null;
                    const attachmentNames = resolveMessageAttachmentNames(message);
                    const contentParagraphs = formatMessageParagraphs(message.content);

                    return (
                      <li
                        key={message.id}
                        className={message.sender === 'user' ? 'chat-message-row user' : 'chat-message-row assistant'}
                      >
                        <div className="chat-message-meta">
                          <span>{message.sender === 'user' ? currentUser?.username || t('you') : t('Vistral')}</span>
                          <small>{new Date(message.created_at).toLocaleTimeString()}</small>
                        </div>
                        <div className="chat-message-bubble">
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
                            <div className={`chat-message-action-card ${actionMetadata.status}`}>
                              <div className="chat-message-action-card-header">
                                <strong>{formatConversationActionLabel(actionMetadata.action)}</strong>
                                <span className={`chat-message-action-status ${actionMetadata.status}`}>
                                  {formatConversationActionStatusLabel(actionMetadata.status)}
                                </span>
                              </div>
                              {actionMetadata.missing_fields.length > 0 ? (
                                <div className="stack tight">
                                  <small className="muted">{t('Missing Information')}</small>
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
                                  <small className="muted">{t('Collected Information')}</small>
                                  <ul className="chat-message-action-details">
                                    {Object.entries(actionMetadata.collected_fields).map(([field, value]) => (
                                      <li key={`${message.id}-collected-${field}`}>
                                        <strong>{formatConversationActionFieldLabel(field)}:</strong> {value}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              ) : null}
                              {actionMetadata.suggestions && actionMetadata.suggestions.length > 0 ? (
                                <div className="stack tight">
                                  <small className="muted">{t('Suggestions')}</small>
                                  <div className="chat-message-action-tags">
                                    {actionMetadata.suggestions.map((suggestion) => (
                                      <button
                                        key={`${message.id}-suggestion-${suggestion}`}
                                        type="button"
                                        className="chat-message-action-tag chat-message-action-tag-button muted"
                                        onClick={() => applyConversationSuggestion(actionMetadata, suggestion)}
                                      >
                                        {suggestion}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                              {actionHref ? (
                                <div className="row gap wrap">
                                  <Link className="small-btn chat-action-btn" to={actionHref}>
                                    {t('Open Result')}
                                  </Link>
                                </div>
                              ) : null}
                            </div>
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
                    );
                  })}
                </ul>
              )}
            </div>
          ) : null}
        </section>

        <footer className="chat-composer-wrap">
          {authRequired ? (
            <section className="chat-composer-panel chat-guest-panel">
              <strong>{t('Conversation actions are unavailable after logout.')}</strong>
              <small className="muted">
                {t('Use Login to reopen your chat workspace. Ask an administrator to provision another account if needed.')}
              </small>
            </section>
          ) : (
          <section className="chat-composer-panel chat-simple-composer-panel">
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
                        {attachment.status === 'ready' ? (
                          <button
                            type="button"
                            className="chat-simple-selected-chip-main"
                            onClick={() => openAttachment(attachment.id)}
                            disabled={sending}
                            title={attachment.filename}
                          >
                            <span className="chat-simple-selected-chip-handle" aria-hidden="true">
                              ≡
                            </span>
                            <span className="chat-simple-selected-chip-name">{attachment.filename}</span>
                          </button>
                        ) : (
                          <span className="chat-simple-selected-chip-main" title={attachment.filename}>
                            <span className="chat-simple-selected-chip-handle" aria-hidden="true">
                              ≡
                            </span>
                            <span className="chat-simple-selected-chip-name">{attachment.filename}</span>
                          </span>
                        )}
                        <StatusBadge status={attachment.status} />
                        <button
                          type="button"
                          className="chat-simple-selected-chip-remove"
                          onClick={() => excludeAttachmentFromCurrentMessage(attachment)}
                          disabled={sending}
                          title={t('Exclude')}
                          aria-label={t('Exclude')}
                        >
                          ×
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <div className="chat-simple-selected-inline-meta">
                  <small className="muted">{t('Draft attachments are shown only while composing this message.')}</small>
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
                    <button
                      type="button"
                      className="small-btn chat-simple-attachment-action-btn"
                      onClick={openUploadFileDialog}
                      disabled={uploading || sending}
                    >
                      {uploading ? t('Working...') : t('Upload photos and files')}
                    </button>
                    <button
                      type="button"
                      className="small-btn chat-simple-attachment-action-btn"
                      onClick={includeAllReadyAttachments}
                      disabled={uploading || sending || readyAttachmentIds.length === 0}
                    >
                      {t('Use all ready files')}
                    </button>
                    <button
                      type="button"
                      className="small-btn chat-simple-attachment-action-btn"
                      onClick={clearCurrentAttachmentContext}
                      disabled={uploading || sending || selectedAttachmentIds.length === 0}
                    >
                      {t('Clear current context')}
                    </button>
                  </div>
                  <small className="muted chat-simple-attachment-toolbar-summary">
                    {t('Attachments:')} {attachments.length} · {t('{count} selected', { count: selectedAttachmentIds.length })} ·{' '}
                    {t('Ready: {count}', { count: attachmentStatusSummary.ready })}
                  </small>
                </div>
                <small className="muted chat-simple-attachment-toolbar-summary">
                  {t('BMP and common image/document files are supported. Keep each file under {limit}.', {
                    limit: UPLOAD_SOFT_LIMIT_LABEL
                  })}
                </small>
                {attachments.length > 0 ? (
                  <ul className="chat-simple-attachment-list">
                    {attachments.map((item) => {
                      const isSelected = selectedAttachmentIdSet.has(item.id);

                      return (
                        <li
                          key={item.id}
                          className={`chat-simple-attachment-item${isSelected ? ' selected' : ''}`}
                        >
                          {item.status === 'ready' ? (
                            <button
                              className="chat-simple-attachment-open"
                              onClick={() => openAttachment(item.id)}
                              disabled={uploading || sending}
                              title={item.filename}
                            >
                              {item.filename}
                            </button>
                          ) : (
                            <span className="chat-simple-attachment-name" title={item.filename}>
                              {item.filename}
                            </span>
                          )}
                          <StatusBadge status={item.status} />
                          {isSelected || item.status === 'ready' ? (
                            <button
                              type="button"
                              className={`small-btn chat-simple-attachment-item-action${isSelected ? ' active' : ''}`}
                              onClick={() =>
                                isSelected
                                  ? excludeAttachmentFromCurrentMessage(item)
                                  : includeAttachmentInCurrentMessage(item)
                              }
                              disabled={uploading || sending || (!isSelected && item.status !== 'ready')}
                            >
                              {isSelected ? t('Exclude') : t('Include')}
                            </button>
                          ) : null}
                          <button
                            className="chat-simple-attachment-delete"
                            onClick={() => removeAttachment(item.id)}
                            disabled={uploading || sending}
                            title={t('Delete')}
                            aria-label={t('Delete')}
                          >
                            ×
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <small className="muted chat-simple-selected-empty">
                    {t('No files yet. Use + to upload files for this draft or reopen recent conversation files.')}
                  </small>
                )}
              </div>
            ) : null}
            <div className="chat-simple-composer-row">
              <button
                type="button"
                className={`chat-attachment-plus-btn chat-simple-plus-btn${
                  attachmentListExpanded || selectedAttachments.length > 0 ? ' active' : ''
                }`}
                onClick={toggleAttachmentTray}
                disabled={sending || loading || authRequired}
                aria-label={attachmentListExpanded ? t('Hide') : t('Attachment options')}
                title={attachmentListExpanded ? t('Hide') : t('Attachment options')}
                aria-expanded={attachmentListExpanded}
              >
                <span className="chat-simple-plus-icon" aria-hidden="true">
                  +
                </span>
              </button>
              <textarea
                className="chat-simple-input"
                ref={composerTextareaRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={onTextareaKeyDown}
                rows={1}
                placeholder={t('Message Vistral...')}
                disabled={sending || loading || authRequired || models.length === 0}
              />
              <button
                className={`chat-simple-send-btn${canSend ? ' active' : ''}`}
                onClick={send}
                disabled={!canSend}
                aria-label={hasActiveConversation ? t('Send') : t('Start')}
                title={hasActiveConversation ? t('Send') : t('Start')}
              >
                <span className="chat-simple-send-icon" aria-hidden="true">
                  ↑
                </span>
              </button>
              <input
                ref={uploadFileInputRef}
                type="file"
                multiple
                className="chat-hidden-file-input"
                onChange={onUploadFileInputChange}
                disabled={uploading || sending || authRequired}
              />
            </div>
            {notice ? (
              <div className="chat-simple-meta">
                <small className="muted">{notice}</small>
              </div>
            ) : null}
          </section>
          )}
        </footer>
      </div>
    </section>
  );
}
