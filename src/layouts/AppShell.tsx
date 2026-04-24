import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type ReactNode
} from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import type {
  ConversationActionMetadata,
  ConversationRecord,
  FileAttachment,
  MessageRecord,
  ModelRecord,
  User
} from '../../shared/domain';
import Sidebar from '../components/layout/Sidebar';
import SessionMenu from '../components/SessionMenu';
import { ButtonLink } from '../components/ui/Button';
import useCompactViewport from '../hooks/useCompactViewport';
import { useI18n } from '../i18n/I18nProvider';
import {
  buildConversationActionNextStepInput,
  deriveConversationActionNextSteps,
  type ConversationActionNextStep
} from '../features/conversationActionNextSteps';
import { api } from '../services/api';
import { AUTH_UPDATED_EVENT, emitAuthUpdated } from '../services/authSession';

interface AppNavItem {
  to: string;
  label: string;
  shortLabel: string;
  matchPrefixes: string[];
  end?: boolean;
}

type AppNavGroupKey = 'workspaces' | 'model_build' | 'data_run' | 'governance' | 'settings';

interface AppNavGroup {
  key: AppNavGroupKey;
  label: string;
  items: AppNavItem[];
}

interface AppQuickContextLink {
  to: string;
  label: string;
}

const appSidebarCollapsedStorageKey = 'vistral-app-sidebar-collapsed';
const appCollapsedNavGroupsStorageKey = 'vistral-app-collapsed-nav-groups';
const appChatDockCollapsedStorageKey = 'vistral-app-chat-dock-collapsed';
const appNavGroupKeys: AppNavGroupKey[] = [
  'workspaces',
  'model_build',
  'data_run',
  'governance',
  'settings'
];
const defaultCollapsedNavGroups: AppNavGroupKey[] = ['governance', 'settings'];
const readAppSidebarCollapsedFromStorage = (): boolean => {
  try {
    return localStorage.getItem(appSidebarCollapsedStorageKey) === 'true';
  } catch {
    return false;
  }
};

const writeAppSidebarCollapsedToStorage = (collapsed: boolean) => {
  try {
    localStorage.setItem(appSidebarCollapsedStorageKey, String(collapsed));
  } catch {
    // Ignore storage errors in local client mode.
  }
};

const readAppChatDockCollapsedFromStorage = (): boolean => {
  try {
    return localStorage.getItem(appChatDockCollapsedStorageKey) === 'true';
  } catch {
    return false;
  }
};

const writeAppChatDockCollapsedToStorage = (collapsed: boolean) => {
  try {
    localStorage.setItem(appChatDockCollapsedStorageKey, String(collapsed));
  } catch {
    // Ignore storage errors in local client mode.
  }
};

const readCollapsedNavGroupsFromStorage = (): AppNavGroupKey[] => {
  try {
    const raw = localStorage.getItem(appCollapsedNavGroupsStorageKey);
    if (!raw) {
      return defaultCollapsedNavGroups;
    }

    const parsed = JSON.parse(raw) as string[];
    if (!Array.isArray(parsed)) {
      return defaultCollapsedNavGroups;
    }

    const parsedSet = new Set(parsed);
    return appNavGroupKeys.filter((key) => parsedSet.has(key));
  } catch {
    return defaultCollapsedNavGroups;
  }
};

const writeCollapsedNavGroupsToStorage = (groupKeys: AppNavGroupKey[]) => {
  try {
    const unique = Array.from(new Set(groupKeys)).filter((key): key is AppNavGroupKey =>
      appNavGroupKeys.includes(key as AppNavGroupKey)
    );
    localStorage.setItem(appCollapsedNavGroupsStorageKey, JSON.stringify(unique));
  } catch {
    // Ignore storage errors in local client mode.
  }
};

const getInitials = (username?: string): string => {
  if (!username) {
    return 'U';
  }

  return username.slice(0, 2).toUpperCase();
};

const isAuthenticationRequiredMessage = (message: string): boolean =>
  /401|unauthorized|not authenticated|登录|未认证|未登录/i.test(message);

const scopedNavContextKeys = [
  'dataset',
  'version',
  'task_type',
  'framework',
  'profile',
  'execution_target',
  'worker'
] as const;
const dockContextQueryKeys = [
  'dataset',
  'version',
  'task_type',
  'framework',
  'execution_target',
  'worker',
  'job',
  'modelVersion',
  'selectedVersion',
  'focus',
  'task_id',
  'vision_task_id'
] as const;

type ScopedNavContext = Partial<Record<(typeof scopedNavContextKeys)[number], string>>;

const readScopedNavContext = (search: string): ScopedNavContext => {
  const searchParams = new URLSearchParams(search);
  const context: ScopedNavContext = {};
  scopedNavContextKeys.forEach((key) => {
    const value = searchParams.get(key)?.trim();
    if (value) {
      context[key] = value;
    }
  });
  return context;
};

const appendScopedNavContextPath = (base: string, context: ScopedNavContext): string => {
  const [pathname, query = ''] = base.split('?');
  const searchParams = new URLSearchParams(query);
  scopedNavContextKeys.forEach((key) => {
    const value = context[key];
    if (value && !searchParams.has(key)) {
      searchParams.set(key, value);
    }
  });
  const nextQuery = searchParams.toString();
  return nextQuery ? `${pathname}?${nextQuery}` : pathname;
};

const appendReturnToPath = (
  base: string,
  returnTo?: string | null,
  options?: { currentPathname?: string }
): string => {
  const normalized = returnTo?.trim() ?? '';
  if (!normalized || !normalized.startsWith('/') || normalized.startsWith('//') || normalized.includes('://')) {
    return base;
  }
  const [pathname, query = ''] = base.split('?');
  if (options?.currentPathname && pathname === options.currentPathname) {
    return base;
  }
  const searchParams = new URLSearchParams(query);
  if (!searchParams.has('return_to')) {
    searchParams.set('return_to', normalized);
  }
  const nextQuery = searchParams.toString();
  return nextQuery ? `${pathname}?${nextQuery}` : pathname;
};

const matchesRailItem = (pathname: string, item: AppNavItem): boolean => {
  if (item.end) {
    return pathname === item.to;
  }

  return item.matchPrefixes.some((prefix) =>
    prefix === '/' ? pathname === '/' : pathname.startsWith(prefix)
  );
};

interface WorkbenchChatDockProps {
  collapsed: boolean;
  currentUser: User | null;
  loginPath: string;
  openWorkspacePath: string;
  pageContextPrompt: string;
  onToggleCollapsed: () => void;
  t: (key: string, replacements?: Record<string, string | number>) => string;
}

function WorkbenchChatDock({
  collapsed,
  currentUser,
  loginPath,
  openWorkspacePath,
  pageContextPrompt,
  onToggleCollapsed,
  t
}: WorkbenchChatDockProps) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [removingAttachmentIds, setRemovingAttachmentIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [activeConversationId, setActiveConversationId] = useState('');
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [input, setInput] = useState('');
  const messagesViewportRef = useRef<HTMLDivElement | null>(null);
  const uploadFileInputRef = useRef<HTMLInputElement | null>(null);

  const formatActionLabel = useCallback((action: ConversationActionMetadata['action']): string => {
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
      return t('Professional Console');
    }
    return t('Create Model');
  }, [t]);

  const formatActionStatus = useCallback((status: ConversationActionMetadata['status']): string => {
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
  }, [t]);

  const formatActionFieldLabel = useCallback((field: string): string => {
    if (field === 'dataset_id' || field === 'dataset_name' || field === 'dataset_reference') {
      return t('Dataset');
    }
    if (field === 'dataset_version_id') {
      return t('Dataset Version');
    }
    if (field === 'task_type' || field === 'model_type') {
      return t('Task Type');
    }
    if (field === 'framework') {
      return t('Framework');
    }
    if (field === 'model_id') {
      return t('Model Name');
    }
    if (field === 'model_version_id') {
      return t('Model Versions');
    }
    if (field === 'training_job_id' || field === 'job_id') {
      return t('Training Jobs');
    }
    if (field === 'inference_run_id' || field === 'run_id') {
      return t('Run Inference');
    }
    if (field === 'visibility') {
      return t('Visibility');
    }
    if (field === 'name' || field === 'version_name') {
      return t('Name');
    }
    return field;
  }, [t]);

  const formatAttachmentStatus = useCallback((status: FileAttachment['status']): string => {
    if (status === 'uploading') {
      return t('Uploading');
    }
    if (status === 'processing') {
      return t('Processing');
    }
    if (status === 'ready') {
      return t('Ready');
    }
    return t('Error');
  }, [t]);

  const buildSuggestionInput = useCallback((action: ConversationActionMetadata, suggestion: string): string => {
    const trimmed = suggestion.trim();
    if (!trimmed) {
      return '';
    }
    const primaryMissingField = action.missing_fields[0] ?? '';
    if (primaryMissingField === 'dataset_id' || primaryMissingField === 'dataset_reference') {
      const datasetId = trimmed.match(/\b(d-\d+)\b/i)?.[1] ?? trimmed;
      return `Use dataset ${datasetId}`;
    }
    if (primaryMissingField === 'framework') {
      return `Use framework ${trimmed}`;
    }
    if (primaryMissingField === 'task_type') {
      return `Use task type ${trimmed}`;
    }
    if (primaryMissingField === 'visibility') {
      return `Set visibility to ${trimmed}`;
    }
    return trimmed;
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
      const pickCollected = (key: string): string => {
        const value = collectedFields[key];
        return typeof value === 'string' ? value.trim() : '';
      };
      if (field === 'dataset_id' || field === 'dataset_reference') {
        return (
          pickCollected('dataset_id') ||
          pickCollected('dataset_reference') ||
          suggestions.map((item) => extractIdFromSuggestion(item, /\b(d-\d+)\b/i)).find(Boolean) ||
          ''
        );
      }
      if (field === 'dataset_version_id') {
        return (
          pickCollected('dataset_version_id') ||
          suggestions.map((item) => extractIdFromSuggestion(item, /\b(dv-\d+)\b/i)).find(Boolean) ||
          ''
        );
      }
      if (field === 'task_type' || field === 'model_type') {
        return (
          pickCollected('task_type') ||
          pickCollected('model_type') ||
          suggestions
            .map((item) => item.trim().toLowerCase())
            .find((item) => ['ocr', 'detection', 'classification', 'segmentation', 'obb'].includes(item)) ||
          ''
        );
      }
      if (field === 'framework') {
        return (
          pickCollected('framework') ||
          suggestions
            .map((item) => item.trim().toLowerCase())
            .find((item) => ['paddleocr', 'doctr', 'yolo'].includes(item)) ||
          ''
        );
      }
      if (field === 'model_id') {
        return (
          pickCollected('model_id') ||
          suggestions.map((item) => extractIdFromSuggestion(item, /\b(m-\d+)\b/i)).find(Boolean) ||
          ''
        );
      }
      if (field === 'model_version_id') {
        return (
          pickCollected('model_version_id') ||
          suggestions.map((item) => extractIdFromSuggestion(item, /\b(mv-\d+)\b/i)).find(Boolean) ||
          ''
        );
      }
      if (field === 'training_job_id' || field === 'job_id') {
        return (
          pickCollected('training_job_id') ||
          pickCollected('job_id') ||
          suggestions.map((item) => extractIdFromSuggestion(item, /\b(tj-[a-z0-9-]+)\b/i)).find(Boolean) ||
          ''
        );
      }
      if (field === 'run_id' || field === 'inference_run_id') {
        return (
          pickCollected('run_id') ||
          pickCollected('inference_run_id') ||
          suggestions.map((item) => extractIdFromSuggestion(item, /\b(ir-\d+)\b/i)).find(Boolean) ||
          ''
        );
      }
      if (field === 'visibility') {
        return (
          pickCollected('visibility') ||
          suggestions
            .map((item) => item.trim().toLowerCase())
            .find((item) => ['private', 'workspace', 'public'].includes(item)) ||
          ''
        );
      }
      if (field === 'name' || field === 'version_name') {
        return pickCollected(field) || suggestions[0]?.trim() || '';
      }
      return suggestions[0]?.trim() || '';
    },
    [extractIdFromSuggestion]
  );

  const buildAutoFillInput = useCallback((action: ConversationActionMetadata): string => {
    const missingFields = (action.missing_fields ?? []).map((field) => field.trim()).filter(Boolean);
    const suggestions = action.suggestions ?? [];
    const parts: string[] = [];
    for (const field of missingFields) {
      if (field.startsWith('dataset_issue:') || field === 'confirmation') {
        continue;
      }
      const value = pickSuggestionForField(field, suggestions, action.collected_fields);
      if (!value) {
        continue;
      }
      if (field === 'dataset_id' || field === 'dataset_reference') {
        parts.push(`Use dataset ${value}`);
        continue;
      }
      if (field === 'dataset_version_id') {
        parts.push(`Use dataset version ${value}`);
        continue;
      }
      if (field === 'task_type' || field === 'model_type') {
        parts.push(`Use task type ${value}`);
        continue;
      }
      if (field === 'framework') {
        parts.push(`Use framework ${value}`);
        continue;
      }
      if (field === 'model_id') {
        parts.push(`Use model ${value}`);
        continue;
      }
      if (field === 'model_version_id') {
        parts.push(`Use model version ${value}`);
        continue;
      }
      if (field === 'training_job_id' || field === 'job_id') {
        parts.push(`Use training job ${value}`);
        continue;
      }
      if (field === 'run_id' || field === 'inference_run_id') {
        parts.push(`Use run ${value}`);
        continue;
      }
      if (field === 'visibility') {
        parts.push(`Set visibility to ${value}`);
        continue;
      }
      if (field === 'name' || field === 'version_name') {
        parts.push(`Set ${field} ${value}`);
        continue;
      }
      parts.push(`${field}=${value}`);
    }
    if (parts.length > 0) {
      return parts.join('; ');
    }
    return suggestions[0]?.trim() ?? '';
  }, [pickSuggestionForField]);

  const loadConversationDetail = useCallback(async (conversationId: string) => {
    const detail = await api.getConversationDetail(conversationId);
    setMessages(detail.messages);
    setActiveConversationId(conversationId);
  }, []);

  const attachmentById = useMemo(
    () => new Map(attachments.map((item) => [item.id, item])),
    [attachments]
  );

  const readyAttachments = useMemo(
    () => attachments.filter((item) => item.status === 'ready'),
    [attachments]
  );
  const pendingAttachmentCount = useMemo(
    () =>
      attachments.filter(
        (item) => item.status === 'uploading' || item.status === 'processing'
      ).length,
    [attachments]
  );
  const failedAttachments = useMemo(
    () => attachments.filter((item) => item.status === 'error'),
    [attachments]
  );
  const failedAttachmentCount = failedAttachments.length;
  const recentAttachments = useMemo(
    () =>
      [...attachments]
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .slice(0, 10),
    [attachments]
  );

  const selectedReadyAttachmentIds = useMemo(
    () =>
      selectedAttachmentIds.filter((attachmentId) => attachmentById.get(attachmentId)?.status === 'ready'),
    [attachmentById, selectedAttachmentIds]
  );

  const refreshDockAttachments = useCallback(async () => {
    if (!currentUser) {
      setAttachments([]);
      return [];
    }
    const result = await api.listConversationAttachments();
    setAttachments(result);
    return result;
  }, [currentUser]);

  const refreshDockData = useCallback(async (preferredConversationId?: string) => {
    if (!currentUser) {
      setAuthRequired(true);
      setConversations([]);
      setModels([]);
      setAttachments([]);
      setSelectedAttachmentIds([]);
      setMessages([]);
      setActiveConversationId('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [conversationResults, modelResults, attachmentResults] = await Promise.all([
        api.listConversations(),
        api.listModels(),
        api.listConversationAttachments()
      ]);
      setConversations(conversationResults);
      setModels(modelResults);
      setAttachments(attachmentResults);
      setSelectedModelId((previous) => {
        if (modelResults.length === 0) {
          return '';
        }
        if (previous && modelResults.some((item) => item.id === previous)) {
          return previous;
        }
        return modelResults[0].id;
      });
      setAuthRequired(false);

      const nextConversationId = (() => {
        if (
          preferredConversationId &&
          conversationResults.some((item) => item.id === preferredConversationId)
        ) {
          return preferredConversationId;
        }
        if (
          activeConversationId &&
          conversationResults.some((item) => item.id === activeConversationId)
        ) {
          return activeConversationId;
        }
        return conversationResults[0]?.id ?? '';
      })();

      if (!nextConversationId) {
        setMessages([]);
        setActiveConversationId('');
        return;
      }

      await loadConversationDetail(nextConversationId);
    } catch (dockError) {
      const message = (dockError as Error).message;
      if (isAuthenticationRequiredMessage(message)) {
        setAuthRequired(true);
        setConversations([]);
        setModels([]);
        setAttachments([]);
        setSelectedAttachmentIds([]);
        setMessages([]);
        setActiveConversationId('');
        setError('');
        return;
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [activeConversationId, currentUser, loadConversationDetail]);

  useEffect(() => {
    refreshDockData().catch(() => {
      // handled by state setters
    });
  }, [refreshDockData]);

  useEffect(() => {
    const availableIdSet = new Set(attachments.map((item) => item.id));
    setSelectedAttachmentIds((previous) => previous.filter((id) => availableIdSet.has(id)));
  }, [attachments]);

  useEffect(() => {
    setSelectedAttachmentIds((previous) =>
      previous.filter((id) => attachmentById.get(id)?.status === 'ready')
    );
  }, [attachmentById]);

  useEffect(() => {
    if (!currentUser) {
      return;
    }
    const hasPendingAttachment = attachments.some(
      (attachment) => attachment.status === 'uploading' || attachment.status === 'processing'
    );
    if (!hasPendingAttachment) {
      return;
    }
    const timer = window.setTimeout(() => {
      refreshDockAttachments().catch(() => {
        // keep dock usable on transient polling failures
      });
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [attachments, currentUser, refreshDockAttachments]);

  useEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }
    viewport.scrollTop = viewport.scrollHeight;
  }, [messages]);

  const handleOpenConversation = useCallback((conversationId: string) => {
    setLoading(true);
    setError('');
    loadConversationDetail(conversationId)
      .catch((dockError) => {
        setError((dockError as Error).message);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [loadConversationDetail]);

  const handleStartFreshConversation = useCallback(() => {
    setActiveConversationId('');
    setMessages([]);
    setError('');
  }, []);

  const toggleAttachmentSelection = useCallback((attachmentId: string) => {
    setSelectedAttachmentIds((previous) =>
      previous.includes(attachmentId)
        ? previous.filter((item) => item !== attachmentId)
        : [...previous, attachmentId]
    );
  }, []);

  const includeAllReadyAttachments = useCallback(() => {
    setSelectedAttachmentIds(readyAttachments.map((item) => item.id));
  }, [readyAttachments]);

  const clearAttachmentContext = useCallback(() => {
    setSelectedAttachmentIds([]);
  }, []);

  const openAttachmentFile = useCallback((attachmentId: string) => {
    const href = api.attachmentContentUrl(attachmentId);
    window.open(href, '_blank', 'noopener,noreferrer');
  }, []);

  const removeAttachment = useCallback(async (attachmentId: string) => {
    if (!attachmentId) {
      return;
    }
    setRemovingAttachmentIds((previous) =>
      previous.includes(attachmentId) ? previous : [...previous, attachmentId]
    );
    try {
      await api.removeAttachment(attachmentId);
      await refreshDockAttachments();
      setSelectedAttachmentIds((previous) => previous.filter((id) => id !== attachmentId));
    } catch (dockError) {
      setError((dockError as Error).message);
    } finally {
      setRemovingAttachmentIds((previous) => previous.filter((id) => id !== attachmentId));
    }
  }, [refreshDockAttachments]);

  const clearFailedAttachments = useCallback(async () => {
    if (failedAttachments.length === 0) {
      return;
    }
    const targetIds = failedAttachments.map((item) => item.id);
    setRemovingAttachmentIds((previous) => Array.from(new Set([...previous, ...targetIds])));
    try {
      await Promise.all(targetIds.map((attachmentId) => api.removeAttachment(attachmentId)));
      await refreshDockAttachments();
      const targetSet = new Set(targetIds);
      setSelectedAttachmentIds((previous) => previous.filter((id) => !targetSet.has(id)));
    } catch (dockError) {
      setError((dockError as Error).message);
    } finally {
      setRemovingAttachmentIds((previous) => previous.filter((id) => !targetIds.includes(id)));
    }
  }, [failedAttachments, refreshDockAttachments]);

  const openUploadFileDialog = useCallback(() => {
    uploadFileInputRef.current?.click();
  }, []);

  const uploadAttachmentsByFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      return;
    }
    setUploadingAttachment(true);
    setError('');
    const createdIds: string[] = [];
    try {
      for (const file of files) {
        const created = await api.uploadConversationFile(file);
        createdIds.push(created.id);
      }
      const latest = await refreshDockAttachments();
      const readyCreatedIds = latest
        .filter((item) => createdIds.includes(item.id) && item.status === 'ready')
        .map((item) => item.id);
      if (readyCreatedIds.length > 0) {
        setSelectedAttachmentIds((previous) => Array.from(new Set([...previous, ...readyCreatedIds])));
      }
    } catch (dockError) {
      setError((dockError as Error).message);
    } finally {
      setUploadingAttachment(false);
    }
  }, [refreshDockAttachments]);

  const onUploadFileInputChange = useCallback(async (event: ReactChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    await uploadAttachmentsByFiles(selected);
  }, [uploadAttachmentsByFiles]);

  const sendDockContent = useCallback(async (content: string) => {
    const normalizedContent = content.trim();
    if (!normalizedContent || sending || loading || uploadingAttachment || authRequired) {
      return false;
    }
    setSending(true);
    setError('');
    try {
      if (activeConversationId) {
        const response = await api.sendConversationMessage({
          conversation_id: activeConversationId,
          content: normalizedContent,
          attachment_ids: selectedReadyAttachmentIds
        });
        setMessages(response.messages);
        await refreshDockData(activeConversationId);
      } else {
        const modelId =
          (selectedModelId && models.some((item) => item.id === selectedModelId) ? selectedModelId : models[0]?.id) ??
          '';
        if (!modelId) {
          throw new Error(t('No available model found for this account.'));
        }
        const started = await api.startConversation({
          model_id: modelId,
          initial_message: normalizedContent,
          attachment_ids: selectedReadyAttachmentIds
        });
        setMessages(started.messages);
        setActiveConversationId(started.conversation.id);
        await refreshDockData(started.conversation.id);
      }
      setSelectedAttachmentIds([]);
      return true;
    } catch (dockError) {
      setError((dockError as Error).message);
      return false;
    } finally {
      setSending(false);
    }
  }, [
    activeConversationId,
    authRequired,
    loading,
    models,
    refreshDockData,
    selectedModelId,
    selectedReadyAttachmentIds,
    uploadingAttachment,
    sending,
    t
  ]);

  const handleSend = useCallback(async () => {
    const ok = await sendDockContent(input.trim());
    if (ok) {
      setInput('');
    }
  }, [input, sendDockContent]);

  const applyPageContextToInput = useCallback(() => {
    const trimmed = pageContextPrompt.trim();
    if (!trimmed) {
      return;
    }
    setInput((previous) => {
      const normalizedPrevious = previous.trim();
      if (!normalizedPrevious) {
        return trimmed;
      }
      return `${normalizedPrevious}\n\n${trimmed}`;
    });
  }, [pageContextPrompt]);

  const askNextStepFromPageContext = useCallback(async () => {
    const trimmed = pageContextPrompt.trim();
    if (!trimmed || sending || loading || uploadingAttachment || authRequired) {
      return;
    }
    const request = `${trimmed}\n\n${t('Please guide me through the next best action in this page context.')}`;
    const ok = await sendDockContent(request);
    if (ok) {
      setInput('');
    }
  }, [authRequired, loading, pageContextPrompt, sendDockContent, sending, t, uploadingAttachment]);

  const applyDockSuggestion = useCallback(async (action: ConversationActionMetadata, suggestion: string) => {
    const nextInput = buildSuggestionInput(action, suggestion);
    if (!nextInput) {
      return;
    }
    const shouldAutoSubmit =
      action.status === 'requires_input' && !sending && !loading && !uploadingAttachment && !authRequired;
    if (shouldAutoSubmit) {
      const ok = await sendDockContent(nextInput);
      if (ok) {
        setInput('');
        return;
      }
    }
    setInput(nextInput);
  }, [authRequired, buildSuggestionInput, loading, sendDockContent, sending, uploadingAttachment]);

  const autoFillDockAction = useCallback(async (action: ConversationActionMetadata) => {
    const nextInput = buildAutoFillInput(action);
    if (!nextInput) {
      return;
    }
    const shouldAutoSubmit =
      action.status === 'requires_input' && !sending && !loading && !uploadingAttachment && !authRequired;
    if (shouldAutoSubmit) {
      const ok = await sendDockContent(nextInput);
      if (ok) {
        setInput('');
        return;
      }
    }
    setInput(nextInput);
  }, [authRequired, buildAutoFillInput, loading, sendDockContent, sending, uploadingAttachment]);

  const confirmDockAction = useCallback(async (action: ConversationActionMetadata) => {
    const phrase = action.confirmation_phrase?.trim() ?? '';
    if (!phrase) {
      return;
    }
    const shouldAutoSubmit = !sending && !loading && !uploadingAttachment && !authRequired;
    if (shouldAutoSubmit) {
      const ok = await sendDockContent(phrase);
      if (ok) {
        setInput('');
        return;
      }
    }
    setInput(phrase);
  }, [authRequired, loading, sendDockContent, sending, uploadingAttachment]);

  const runDockNextStep = useCallback(async (step: ConversationActionNextStep) => {
    if (step.kind === 'href' && step.href) {
      navigate(step.href);
      return;
    }
    const nextInput = buildConversationActionNextStepInput(step);
    if (!nextInput) {
      return;
    }
    const shouldAutoSubmit = !sending && !loading && !uploadingAttachment && !authRequired;
    if (shouldAutoSubmit) {
      const ok = await sendDockContent(nextInput);
      if (ok) {
        setInput('');
        return;
      }
    }
    setInput(nextInput);
  }, [authRequired, loading, navigate, sendDockContent, sending, uploadingAttachment]);

  const actionLinkCount = useMemo(
    () =>
      messages.reduce((count, message) => {
        const links = message.metadata?.conversation_action?.action_links ?? [];
        return count + links.filter((item) => item.href.startsWith('/')).length;
      }, 0),
    [messages]
  );

  return (
    <aside className={`app-chat-dock${collapsed ? ' collapsed' : ''}`} aria-label={t('Conversation Workspace')}>
      <header className="app-chat-dock-header">
        <strong>{collapsed ? 'AI' : t('Conversation Workspace')}</strong>
        <div className="app-chat-dock-header-actions">
          {!collapsed ? (
            <ButtonLink to={openWorkspacePath} variant="ghost" size="sm" className="app-chat-dock-link">
              {t('Open Conversation Workspace')}
            </ButtonLink>
          ) : null}
          <button
            type="button"
            className="app-chat-dock-toggle"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? t('Open sidebar') : t('Close sidebar')}
            title={collapsed ? t('Open sidebar') : t('Close sidebar')}
          >
            {collapsed ? '<' : '>'}
          </button>
        </div>
      </header>

      {collapsed ? (
        <div className="app-chat-dock-collapsed-body">
          <ButtonLink to={openWorkspacePath} variant="ghost" size="icon" className="app-chat-dock-collapsed-link">
            AI
          </ButtonLink>
        </div>
      ) : authRequired ? (
        <div className="app-chat-dock-state stack">
          <strong>{t('Login to use conversation workspace')}</strong>
          <small className="muted">
            {t('Use Login to reopen your chat workspace. Ask an administrator to provision another account if needed.')}
          </small>
          <div className="row gap wrap">
            <ButtonLink to={loginPath} variant="secondary" size="sm">
              {t('Login')}
            </ButtonLink>
            <ButtonLink to={openWorkspacePath} variant="ghost" size="sm">
              {t('Open Conversation Workspace')}
            </ButtonLink>
          </div>
        </div>
      ) : (
        <div className="app-chat-dock-body">
          <div className="app-chat-dock-controls">
            <label className="app-chat-dock-model-select">
              <small className="muted">{t('Model Name')}</small>
              <select
                value={selectedModelId}
                onChange={(event) => setSelectedModelId(event.target.value)}
                disabled={models.length === 0 || loading || sending}
              >
                {models.length === 0 ? (
                  <option value="">{t('No Available Models')}</option>
                ) : (
                  models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))
                )}
              </select>
            </label>
            <div className="app-chat-dock-context-actions">
              <button
                type="button"
                className="app-chat-dock-inline-action"
                onClick={applyPageContextToInput}
                disabled={!pageContextPrompt.trim() || loading || sending || uploadingAttachment}
              >
                {t('Use page context')}
              </button>
              <button
                type="button"
                className="app-chat-dock-inline-action"
                onClick={() => void askNextStepFromPageContext()}
                disabled={!pageContextPrompt.trim() || loading || sending || uploadingAttachment}
              >
                {t('Ask next step')}
              </button>
            </div>
            {pageContextPrompt.trim() ? (
              <small className="muted app-chat-dock-context-hint">
                {t('Page context is ready for guided next-step orchestration.')}
              </small>
            ) : null}
            <div className="app-chat-dock-attachment-toolbar">
              <small className="muted">
                {t('Attachments:')} {attachments.length} · {t('Ready: {count}', { count: readyAttachments.length })} ·{' '}
                {t('Pending: {count}', { count: pendingAttachmentCount })} ·{' '}
                {t('Failed: {count}', { count: failedAttachmentCount })} ·{' '}
                {t('{count} selected', { count: selectedReadyAttachmentIds.length })}
              </small>
              <input
                ref={uploadFileInputRef}
                type="file"
                className="app-chat-dock-file-input"
                multiple
                onChange={(event) => {
                  void onUploadFileInputChange(event);
                }}
              />
              <div className="app-chat-dock-attachment-actions">
                <button
                  type="button"
                  className="app-chat-dock-inline-action"
                  onClick={openUploadFileDialog}
                  disabled={uploadingAttachment || loading || sending}
                >
                  {uploadingAttachment ? t('Working...') : t('Upload files')}
                </button>
                <button
                  type="button"
                  className="app-chat-dock-inline-action"
                  onClick={includeAllReadyAttachments}
                  disabled={uploadingAttachment || readyAttachments.length === 0}
                >
                  {t('Use all ready files')}
                </button>
                <button
                  type="button"
                  className="app-chat-dock-inline-action"
                  onClick={clearAttachmentContext}
                  disabled={uploadingAttachment || removingAttachmentIds.length > 0 || selectedReadyAttachmentIds.length === 0}
                >
                  {t('Clear current context')}
                </button>
                <button
                  type="button"
                  className="app-chat-dock-inline-action"
                  onClick={() => void clearFailedAttachments()}
                  disabled={uploadingAttachment || removingAttachmentIds.length > 0 || failedAttachmentCount === 0}
                >
                  {removingAttachmentIds.length > 0 ? t('Working...') : t('Clear failed files')}
                </button>
              </div>
              {recentAttachments.length > 0 ? (
                <div className="app-chat-dock-attachment-list">
                  {recentAttachments.map((attachment) => {
                    const selected = selectedAttachmentIds.includes(attachment.id);
                    const isReady = attachment.status === 'ready';
                    const removing = removingAttachmentIds.includes(attachment.id);
                    return (
                      <div key={attachment.id} className="app-chat-dock-attachment-item">
                        <div className="app-chat-dock-attachment-main">
                          <button
                            type="button"
                            className={`app-chat-dock-action-chip app-chat-dock-action-chip-btn app-chat-dock-attachment-chip${selected ? ' active' : ''}${isReady ? '' : ' disabled'}`}
                            onClick={() => toggleAttachmentSelection(attachment.id)}
                            title={attachment.filename}
                            disabled={!isReady || removing}
                          >
                            <span className="app-chat-dock-attachment-filename">{attachment.filename}</span>
                            <span className={`app-chat-dock-attachment-status-badge ${attachment.status}`}>
                              {formatAttachmentStatus(attachment.status)}
                            </span>
                          </button>
                          {attachment.status === 'error' && attachment.upload_error ? (
                            <small className="app-chat-dock-attachment-error">{attachment.upload_error}</small>
                          ) : null}
                        </div>
                        <div className="app-chat-dock-attachment-item-actions">
                          <button
                            type="button"
                            className="app-chat-dock-inline-action"
                            onClick={() => openAttachmentFile(attachment.id)}
                            disabled={!isReady || removing}
                          >
                            {t('Open file')}
                          </button>
                          <button
                            type="button"
                            className="app-chat-dock-inline-action"
                            onClick={() => void removeAttachment(attachment.id)}
                            disabled={removing || uploadingAttachment}
                          >
                            {removing ? t('Working...') : t('Remove file')}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <small className="muted">{t('No recent files available.')}</small>
              )}
            </div>
          </div>

          <div className="app-chat-dock-conversations">
            <button
              type="button"
              className={`app-chat-dock-conversation-chip${activeConversationId ? '' : ' active'}`}
              onClick={handleStartFreshConversation}
            >
              {t('New conversation')}
            </button>
            {conversations.slice(0, 8).map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                className={`app-chat-dock-conversation-chip${conversation.id === activeConversationId ? ' active' : ''}`}
                onClick={() => void handleOpenConversation(conversation.id)}
              >
                {conversation.title}
              </button>
            ))}
          </div>

          <div className="app-chat-dock-messages" ref={messagesViewportRef}>
            {loading ? (
              <small className="muted">{t('Loading')}</small>
            ) : messages.length === 0 ? (
              <small className="muted">{t('How can I help you today?')}</small>
            ) : (
              messages.map((message) => {
                const actionLinks = message.metadata?.conversation_action?.action_links ?? [];
                const actionMetadata = message.metadata?.conversation_action ?? null;
                const actionNextSteps = actionMetadata ? deriveConversationActionNextSteps(actionMetadata, t) : [];
                return (
                  <article key={message.id} className={`app-chat-dock-message ${message.sender}`}>
                    <small className="app-chat-dock-message-role">
                      {message.sender === 'assistant' ? 'Vistral' : t('you')}
                    </small>
                    <p>{message.content}</p>
                    {actionMetadata ? (
                      <div className="app-chat-dock-action-card">
                        <div className="app-chat-dock-action-card-header">
                          <strong>{formatActionLabel(actionMetadata.action)}</strong>
                          <small className="muted">{formatActionStatus(actionMetadata.status)}</small>
                        </div>
                        {actionMetadata.missing_fields.length > 0 ? (
                          <div className="app-chat-dock-action-chip-row">
                            {actionMetadata.missing_fields.map((field) => (
                              <span key={`${message.id}-missing-${field}`} className="app-chat-dock-action-chip">
                                {formatActionFieldLabel(field)}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {Object.keys(actionMetadata.collected_fields).length > 0 ? (
                          <div className="app-chat-dock-collected-list">
                            {Object.entries(actionMetadata.collected_fields)
                              .slice(0, 4)
                              .map(([field, value]) => (
                                <small key={`${message.id}-field-${field}`}>
                                  {formatActionFieldLabel(field)}: {String(value)}
                                </small>
                              ))}
                          </div>
                        ) : null}
                        {actionMetadata.status === 'requires_input' && (actionMetadata.suggestions ?? []).length > 0 ? (
                          <div className="app-chat-dock-action-inline-actions">
                            <button
                              type="button"
                              className="app-chat-dock-inline-action"
                              onClick={() => void autoFillDockAction(actionMetadata)}
                            >
                              {t('Auto fill all')}
                            </button>
                            <button
                              type="button"
                              className="app-chat-dock-inline-action"
                              onClick={() => void applyDockSuggestion(actionMetadata, (actionMetadata.suggestions ?? [])[0] ?? '')}
                            >
                              {t('Auto apply top suggestion')}
                            </button>
                          </div>
                        ) : null}
                        {(actionMetadata.suggestions ?? []).length > 0 ? (
                          <div className="app-chat-dock-action-chip-row">
                            {(actionMetadata.suggestions ?? []).slice(0, 6).map((suggestion) => (
                              <button
                                key={`${message.id}-suggestion-${suggestion}`}
                                type="button"
                                className="app-chat-dock-action-chip app-chat-dock-action-chip-btn"
                                onClick={() => void applyDockSuggestion(actionMetadata, suggestion)}
                              >
                                {suggestion}
                              </button>
                            ))}
                          </div>
                        ) : null}
                        {actionMetadata.requires_confirmation && actionMetadata.confirmation_phrase ? (
                          <div className="app-chat-dock-action-inline-actions">
                            <button
                              type="button"
                              className="app-chat-dock-inline-action primary"
                              onClick={() => void confirmDockAction(actionMetadata)}
                            >
                              {t('Confirm now')}
                            </button>
                          </div>
                        ) : null}
                        {actionNextSteps.length > 0 ? (
                          <div className="app-chat-dock-action-next-steps">
                            <small className="muted">{t('Suggested next steps')}</small>
                            <div className="app-chat-dock-action-inline-actions">
                              {actionNextSteps.slice(0, 2).map((step) => (
                                <button
                                  key={`${message.id}-next-step-${step.id}`}
                                  type="button"
                                  className="app-chat-dock-inline-action"
                                  onClick={() => void runDockNextStep(step)}
                                  disabled={step.kind === 'none'}
                                >
                                  {step.title}
                                </button>
                              ))}
                            </div>
                            <small className="muted">{actionNextSteps[0]?.detail}</small>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {actionLinks.length > 0 ? (
                      <div className="app-chat-dock-action-links">
                        {actionLinks
                          .filter((item) => item.href.startsWith('/'))
                          .slice(0, 3)
                          .map((item) => (
                            <ButtonLink
                              key={`${message.id}-${item.href}-${item.label}`}
                              to={item.href}
                              variant="ghost"
                              size="sm"
                              className="app-chat-dock-link"
                            >
                              {item.label || t('Open')}
                            </ButtonLink>
                          ))}
                      </div>
                    ) : null}
                  </article>
                );
              })
            )}
          </div>

          {error ? <small className="error-text">{error}</small> : null}
          {actionLinkCount > 0 ? (
            <small className="muted">
              {t('Open result')} · {actionLinkCount}
            </small>
          ) : null}

          <div className="app-chat-dock-composer">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={t('Message Vistral...')}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void handleSend();
                }
              }}
            />
            <button
              type="button"
              className="app-chat-dock-send"
              disabled={sending || loading || uploadingAttachment || authRequired || !input.trim()}
              onClick={() => void handleSend()}
            >
              {sending ? t('Sending') : t('Send')}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { language, setLanguage, t } = useI18n();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() =>
    readAppSidebarCollapsedFromStorage()
  );
  const [collapsedNavGroups, setCollapsedNavGroups] = useState<AppNavGroupKey[]>(() =>
    readCollapsedNavGroupsFromStorage()
  );
  const [chatDockCollapsed, setChatDockCollapsed] = useState<boolean>(() =>
    readAppChatDockCollapsedFromStorage()
  );
  const isCompactViewport = useCompactViewport(960);
  const isNarrowWorkbenchViewport = useCompactViewport(1360);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const isImmersiveWorkspace = location.pathname === '/workspace/chat';
  const isAnnotationFocusRoute = /^\/datasets\/[^/]+\/annotate$/.test(location.pathname);

  const refreshUser = useCallback(() => {
    api.me().then(setCurrentUser).catch(() => setCurrentUser(null));
  }, []);

  useEffect(() => {
    refreshUser();

    window.addEventListener(AUTH_UPDATED_EVENT, refreshUser as EventListener);
    return () => {
      window.removeEventListener(AUTH_UPDATED_EVENT, refreshUser as EventListener);
    };
  }, [refreshUser]);

  useEffect(() => {
    writeAppSidebarCollapsedToStorage(sidebarCollapsed);
  }, [sidebarCollapsed]);

  useEffect(() => {
    writeCollapsedNavGroupsToStorage(collapsedNavGroups);
  }, [collapsedNavGroups]);

  useEffect(() => {
    writeAppChatDockCollapsedToStorage(chatDockCollapsed);
  }, [chatDockCollapsed]);

  useEffect(() => {
    if (!isCompactViewport) {
      setMobileSidebarOpen(false);
    }
  }, [isCompactViewport]);

  useEffect(() => {
    if (!isCompactViewport) {
      return;
    }

    setMobileSidebarOpen(false);
  }, [isCompactViewport, location.pathname]);

  useEffect(() => {
    if (isCompactViewport || !isAnnotationFocusRoute || sidebarCollapsed) {
      return;
    }

    setSidebarCollapsed(true);
  }, [isAnnotationFocusRoute, isCompactViewport, sidebarCollapsed]);

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

  const logout = useCallback(async () => {
    try {
      await api.logout();
      setCurrentUser(null);
      emitAuthUpdated();
      closeMobileSidebar();
      navigate('/', { replace: true });
    } catch {
      // Keep current user visible if logout fails in local client mode.
    }
  }, [closeMobileSidebar, navigate]);

  const currentTaskPath = useMemo(() => {
    const params = new URLSearchParams(location.search || '');
    params.delete('return_to');
    const query = params.toString();
    return `${location.pathname}${query ? `?${query}` : ''}`;
  }, [location.pathname, location.search]);
  const scopedNavContext = useMemo(
    () => readScopedNavContext(location.search || ''),
    [location.search]
  );
  const scopedNavTo = useCallback(
    (basePath: string) => {
      const withContext = appendScopedNavContextPath(basePath, scopedNavContext);
      return appendReturnToPath(withContext, currentTaskPath, {
        currentPathname: location.pathname
      });
    },
    [currentTaskPath, location.pathname, scopedNavContext]
  );
  const scopedDatasetId = (scopedNavContext.dataset ?? '').trim();
  const scopedVersionId = (scopedNavContext.version ?? '').trim();
  const scopedTaskType = (scopedNavContext.task_type ?? '').trim();
  const scopedFramework = (scopedNavContext.framework ?? scopedNavContext.profile ?? '').trim();
  const scopedExecutionTarget = (scopedNavContext.execution_target ?? '').trim();
  const scopedWorkerId = (scopedNavContext.worker ?? '').trim();
  const hasScopedTaskContext = Boolean(
    scopedDatasetId ||
      scopedVersionId ||
      scopedTaskType ||
      scopedFramework ||
      (scopedExecutionTarget && scopedExecutionTarget !== 'auto') ||
      scopedWorkerId
  );
  const dockPageContextPrompt = useMemo(() => {
    const searchParams = new URLSearchParams(location.search || '');
    const queryTokens: string[] = [];
    dockContextQueryKeys.forEach((key) => {
      const value = searchParams.get(key)?.trim();
      if (value) {
        queryTokens.push(`${key}=${value}`);
      }
    });

    const scopeTokens: string[] = [];
    if (scopedDatasetId) {
      scopeTokens.push(`dataset=${scopedDatasetId}`);
    }
    if (scopedVersionId) {
      scopeTokens.push(`version=${scopedVersionId}`);
    }
    if (scopedTaskType) {
      scopeTokens.push(`task_type=${scopedTaskType}`);
    }
    if (scopedFramework) {
      scopeTokens.push(`framework=${scopedFramework}`);
    }
    if (scopedExecutionTarget && scopedExecutionTarget !== 'auto') {
      scopeTokens.push(`execution_target=${scopedExecutionTarget}`);
    }
    if (scopedWorkerId) {
      scopeTokens.push(`worker=${scopedWorkerId}`);
    }

    const lines = ['Console context snapshot:', `route=${location.pathname}`];
    if (queryTokens.length > 0) {
      lines.push(`query=${queryTokens.join(', ')}`);
    }
    if (scopeTokens.length > 0) {
      lines.push(`scope=${scopeTokens.join(', ')}`);
    }
    lines.push('Please continue from this context and propose the next best concrete operation.');
    return lines.join('\n');
  }, [
    location.pathname,
    location.search,
    scopedDatasetId,
    scopedExecutionTarget,
    scopedFramework,
    scopedTaskType,
    scopedVersionId,
    scopedWorkerId
  ]);
  const appQuickContextLinks = useMemo<AppQuickContextLink[]>(() => {
    if (!hasScopedTaskContext) {
      return [];
    }

    const links: AppQuickContextLink[] = [];
    if (scopedDatasetId) {
      const encodedDatasetId = encodeURIComponent(scopedDatasetId);
      links.push({
        to: scopedNavTo(`/datasets/${encodedDatasetId}`),
        label: t('Open dataset detail')
      });
      links.push({
        to: scopedNavTo(`/datasets/${encodedDatasetId}/annotate`),
        label: t('Open annotation workspace')
      });
    }

    links.push({
      to: scopedNavTo('/training/jobs'),
      label: t('Open Training Jobs')
    });

    const createTrainingSearch = new URLSearchParams();
    if (scopedDatasetId) {
      createTrainingSearch.set('dataset', scopedDatasetId);
    }
    if (scopedVersionId) {
      createTrainingSearch.set('version', scopedVersionId);
    }
    const createTrainingBasePath = createTrainingSearch.toString()
      ? `/training/jobs/new?${createTrainingSearch.toString()}`
      : '/training/jobs/new';
    links.push({
      to: scopedNavTo(createTrainingBasePath),
      label: t('Create training job')
    });

    links.push({
      to: scopedNavTo('/workflow/closure'),
      label: t('Training Closure Wizard')
    });
    links.push({
      to: scopedNavTo('/inference/validate'),
      label: t('Inference Validate')
    });
    return links;
  }, [hasScopedTaskContext, scopedDatasetId, scopedNavTo, scopedVersionId, t]);
  const scopedExecutionTargetLabel = useMemo(() => {
    if (!scopedExecutionTarget || scopedExecutionTarget === 'auto') {
      return '';
    }
    if (scopedExecutionTarget === 'control_plane') {
      return t('control_plane');
    }
    return t(scopedExecutionTarget);
  }, [scopedExecutionTarget, t]);
  const sessionMenuItems = useMemo(
    () => [
      { to: scopedNavTo('/workspace/chat'), label: t('Conversation Workspace') },
      { to: scopedNavTo('/settings/account'), label: t('Settings') },
      { label: t('Logout'), onSelect: logout, tone: 'danger' as const }
    ],
    [logout, scopedNavTo, t]
  );
  const loginPath = useMemo(() => {
    if (currentTaskPath.startsWith('/auth/login') || currentTaskPath.startsWith('/auth/register')) {
      return '/auth/login';
    }
    return appendReturnToPath('/auth/login', currentTaskPath, {
      currentPathname: location.pathname
    });
  }, [currentTaskPath, location.pathname]);

  const navigationGroups = useMemo<AppNavGroup[]>(
    () => [
      {
        key: 'workspaces',
        label: t('Workspaces'),
        items: [
          {
            to: scopedNavTo('/workspace/chat'),
            label: t('Conversation Workspace'),
            shortLabel: 'AI',
            matchPrefixes: ['/workspace/chat']
          },
          {
            to: scopedNavTo('/workspace/console'),
            label: t('Professional Console'),
            shortLabel: 'PC',
            matchPrefixes: ['/workspace/console']
          }
        ]
      },
      {
        key: 'model_build',
        label: t('Model Build'),
        items: [
          {
            to: scopedNavTo('/models/explore'),
            label: t('Models Explore'),
            shortLabel: 'M',
            matchPrefixes: ['/models/explore']
          },
          {
            to: scopedNavTo('/models/my-models'),
            label: t('My Models'),
            shortLabel: 'MY',
            matchPrefixes: ['/models/my-models']
          },
          {
            to: scopedNavTo('/models/create'),
            label: t('Create Model'),
            shortLabel: 'N',
            matchPrefixes: ['/models/create']
          },
          {
            to: scopedNavTo('/models/versions'),
            label: t('Model Versions'),
            shortLabel: 'V',
            matchPrefixes: ['/models/versions']
          }
        ]
      },
      {
        key: 'data_run',
        label: t('Data & Run'),
        items: [
          {
            to: scopedNavTo('/workflow/closure'),
            label: t('Training Closure Wizard'),
            shortLabel: 'WF',
            matchPrefixes: ['/workflow/closure']
          },
          {
            to: scopedNavTo('/datasets'),
            label: t('Datasets'),
            shortLabel: 'D',
            matchPrefixes: ['/datasets']
          },
          {
            to: scopedNavTo('/training/jobs'),
            label: t('Training Jobs'),
            shortLabel: 'T',
            matchPrefixes: ['/training/jobs']
          },
          {
            to: scopedNavTo('/vision/tasks'),
            label: t('Vision Modeling Tasks'),
            shortLabel: 'VT',
            matchPrefixes: ['/vision/tasks']
          },
          {
            to: scopedNavTo('/inference/validate'),
            label: t('Inference Validate'),
            shortLabel: 'I',
            matchPrefixes: ['/inference/validate']
          }
        ]
      },
      {
        key: 'governance',
        label: t('Governance'),
        items: [
          {
            to: scopedNavTo('/admin/models/pending'),
            label: t('Admin Approvals'),
            shortLabel: 'AP',
            matchPrefixes: ['/admin/models/pending']
          },
          {
            to: scopedNavTo('/admin/audit'),
            label: t('Admin Audit'),
            shortLabel: 'AU',
            matchPrefixes: ['/admin/audit']
          },
          {
            to: scopedNavTo('/admin/verification-reports'),
            label: t('Admin Verify Reports'),
            shortLabel: 'VR',
            matchPrefixes: ['/admin/verification-reports']
          }
        ]
      },
      {
        key: 'settings',
        label: t('Settings'),
        items: [
          {
            to: scopedNavTo('/settings/account'),
            label: t('Settings'),
            shortLabel: 'S',
            matchPrefixes: ['/settings']
          }
        ]
      }
    ],
    [scopedNavTo, t]
  );

  const railItems = useMemo<AppNavItem[]>(
    () => [
      {
        to: scopedNavTo('/workspace/chat'),
        label: t('Conversation Workspace'),
        shortLabel: 'AI',
        matchPrefixes: ['/workspace/chat']
      },
      {
        to: scopedNavTo('/workspace/console'),
        label: t('Professional Console'),
        shortLabel: 'PC',
        matchPrefixes: ['/workspace/console']
      },
      {
        to: scopedNavTo('/models/explore'),
        label: t('Models Explore'),
        shortLabel: 'M',
        matchPrefixes: ['/models']
      },
      {
        to: scopedNavTo('/workflow/closure'),
        label: t('Training Closure Wizard'),
        shortLabel: 'WF',
        matchPrefixes: ['/workflow/closure']
      },
      {
        to: scopedNavTo('/datasets'),
        label: t('Datasets'),
        shortLabel: 'D',
        matchPrefixes: ['/datasets']
      },
      {
        to: scopedNavTo('/training/jobs'),
        label: t('Training Jobs'),
        shortLabel: 'T',
        matchPrefixes: ['/training/jobs']
      },
      {
        to: scopedNavTo('/admin/verification-reports'),
        label: t('Admin Verify Reports'),
        shortLabel: 'G',
        matchPrefixes: ['/admin']
      },
      {
        to: scopedNavTo('/settings/account'),
        label: t('Settings'),
        shortLabel: 'S',
        matchPrefixes: ['/settings']
      }
    ],
    [scopedNavTo, t]
  );

  const toggleNavGroup = useCallback((groupKey: AppNavGroupKey) => {
    setCollapsedNavGroups((previous) =>
      previous.includes(groupKey)
        ? previous.filter((item) => item !== groupKey)
        : [...previous, groupKey]
    );
  }, []);

  const isDesktopSidebarCollapsed = sidebarCollapsed && !isCompactViewport;
  const showWorkbenchChatDock =
    !isCompactViewport &&
    !isNarrowWorkbenchViewport &&
    !isImmersiveWorkspace &&
    !location.pathname.startsWith('/auth/');
  const shellClassName = [
    'app-shell',
    'no-topbar',
    isDesktopSidebarCollapsed ? 'sidebar-collapsed' : '',
    isCompactViewport ? 'sidebar-compact' : '',
    mobileSidebarOpen ? 'mobile-sidebar-open' : ''
  ]
    .filter(Boolean)
    .join(' ');
  const sidebarToggleLabel = isCompactViewport
    ? mobileSidebarOpen
      ? t('Close navigation')
      : t('Open navigation')
    : isDesktopSidebarCollapsed
      ? t('Expand sidebar')
      : t('Collapse sidebar');
  const sidebarToggleToken = isCompactViewport ? (mobileSidebarOpen ? 'X' : '=') : isDesktopSidebarCollapsed ? '>' : '<';

  if (isImmersiveWorkspace) {
    return <main className="chat-route-main">{children}</main>;
  }

  return (
    <div className={shellClassName}>
      {isCompactViewport && !mobileSidebarOpen ? (
        <button
          type="button"
          className="app-mobile-sidebar-trigger"
          onClick={toggleSidebar}
          aria-label={t('Open navigation')}
          title={t('Open navigation')}
        >
          =
        </button>
      ) : null}

      {isCompactViewport ? (
        <button
          type="button"
          className={`app-sidebar-scrim${mobileSidebarOpen ? ' visible' : ''}`}
          onClick={closeMobileSidebar}
          aria-label={t('Close navigation')}
        />
      ) : null}

      <Sidebar className="sidebar" ariaHidden={isCompactViewport && !mobileSidebarOpen} rail={
        <div className="sidebar-collapsed-rail">
          <button
            type="button"
            className="sidebar-rail-btn sidebar-rail-control"
            onClick={toggleSidebar}
            aria-label={t('Expand sidebar')}
            title={t('Expand sidebar')}
          >
            &gt;
          </button>

          {railItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={matchesRailItem(location.pathname, item) ? 'sidebar-rail-btn active' : 'sidebar-rail-btn'}
              onClick={closeMobileSidebar}
              aria-label={item.label}
              title={item.label}
            >
              {item.shortLabel}
            </NavLink>
          ))}

          <div className="sidebar-rail-footer">
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
                to={loginPath}
                variant="ghost"
                size="icon"
                className="sidebar-rail-avatar-link"
                title={t('Login')}
                aria-label={t('Login')}
              >
                {getInitials()}
              </ButtonLink>
            )}
          </div>
        </div>
      }>
        <div className="sidebar-content">
          <div className="sidebar-brand-row">
            <Link to={scopedNavTo('/workspace/chat')} className="sidebar-brand-link" onClick={closeMobileSidebar}>
              <span className="sidebar-brand-mark" aria-hidden="true">
                V
              </span>
              <div className="stack tight">
                <strong>Vistral</strong>
                <small className="muted">{t('AI-native workspace')}</small>
              </div>
            </Link>
            <button
              type="button"
              className="app-sidebar-toggle"
              onClick={toggleSidebar}
              aria-label={sidebarToggleLabel}
              title={sidebarToggleLabel}
            >
              {sidebarToggleToken}
            </button>
          </div>

          <nav className="sidebar-nav" aria-label={t('Navigation')}>
            {navigationGroups.map((group) => (
              <section key={group.label} className="sidebar-nav-group">
                {(() => {
                  const groupIsActive = group.items.some((item) =>
                    matchesRailItem(location.pathname, item)
                  );
                  const groupIsCollapsed =
                    collapsedNavGroups.includes(group.key) && !groupIsActive;

                  return (
                    <>
                      <button
                        type="button"
                        className={`sidebar-nav-group-title${groupIsActive ? ' active' : ''}`}
                        onClick={() => toggleNavGroup(group.key)}
                        aria-label={groupIsCollapsed ? t('Expand section') : t('Collapse section')}
                      >
                        <span className="sidebar-nav-group-title-copy">
                          <span>{group.label}</span>
                          <span className="sidebar-nav-group-count">{group.items.length}</span>
                        </span>
                        <span className="sidebar-nav-group-chevron" aria-hidden="true">
                          {groupIsCollapsed ? '▸' : '▾'}
                        </span>
                      </button>

                      {groupIsCollapsed ? null : (
                        <div className="sidebar-nav-list">
                          {group.items.map((item) => (
                            <NavLink
                              key={item.to}
                              to={item.to}
                              end={item.end}
                              className={({ isActive }) =>
                                isActive ? 'sidebar-nav-link active' : 'sidebar-nav-link'
                              }
                              onClick={closeMobileSidebar}
                            >
                              {item.label}
                            </NavLink>
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
              </section>
            ))}
          </nav>

          <div className="sidebar-footer">
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
              <div className="sidebar-session-card guest">
                <div className="sidebar-session-summary">
                  <div className="sidebar-session-avatar">{getInitials()}</div>
                  <div className="stack tight">
                    <strong>{t('guest')}</strong>
                    <small className="muted">{t('Login')}</small>
                  </div>
                </div>
                <div className="sidebar-session-actions">
                  <ButtonLink to={loginPath} variant="ghost" size="sm" className="sidebar-guest-login-link">
                    {t('Login')}
                  </ButtonLink>
                </div>
              </div>
            )}
          </div>
        </div>
      </Sidebar>

      <main className="main">
        <div className={`main-workbench${showWorkbenchChatDock ? ' with-chat-dock' : ''}`}>
          <div className="main-workbench-primary">
            <div className="main-content-stack">
              {hasScopedTaskContext ? (
                <section className="workspace-context-bar app-shell-context-bar" aria-label={t('Current context')}>
                  <div className="workspace-context-bar-row">
                    <div className="workspace-context-leading app-shell-context-leading">
                      <strong>{t('Current context')}</strong>
                      <div className="app-shell-context-chips">
                        {scopedDatasetId ? (
                          <span className="app-shell-context-chip">
                            <small>{t('Dataset')}</small>
                            <strong>{scopedDatasetId}</strong>
                          </span>
                        ) : null}
                        {scopedVersionId ? (
                          <span className="app-shell-context-chip">
                            <small>{t('Version')}</small>
                            <strong>{scopedVersionId}</strong>
                          </span>
                        ) : null}
                        {scopedTaskType ? (
                          <span className="app-shell-context-chip">
                            <small>{t('Task')}</small>
                            <strong>{t(scopedTaskType)}</strong>
                          </span>
                        ) : null}
                        {scopedFramework ? (
                          <span className="app-shell-context-chip">
                            <small>{t('Framework')}</small>
                            <strong>{t(scopedFramework)}</strong>
                          </span>
                        ) : null}
                        {scopedExecutionTargetLabel ? (
                          <span className="app-shell-context-chip">
                            <small>{t('Dispatch')}</small>
                            <strong>{scopedExecutionTargetLabel}</strong>
                          </span>
                        ) : null}
                        {scopedWorkerId ? (
                          <span className="app-shell-context-chip">
                            <small>{t('Worker')}</small>
                            <strong>{scopedWorkerId}</strong>
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="workspace-context-trailing app-shell-context-actions">
                      {appQuickContextLinks.map((link) => (
                        <ButtonLink key={link.label} to={link.to} variant="ghost" size="sm">
                          {link.label}
                        </ButtonLink>
                      ))}
                    </div>
                  </div>
                </section>
              ) : null}
              {children}
            </div>
          </div>
          {showWorkbenchChatDock ? (
            <WorkbenchChatDock
              collapsed={chatDockCollapsed}
              currentUser={currentUser}
              loginPath={loginPath}
              openWorkspacePath={scopedNavTo('/workspace/chat')}
              pageContextPrompt={dockPageContextPrompt}
              onToggleCollapsed={() => setChatDockCollapsed((previous) => !previous)}
              t={t}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}
