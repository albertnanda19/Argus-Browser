import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArgusApiError } from "../shared/client";
import type { Conversation, Message } from "../shared/conversation";
import type { AgentStep } from "../shared/agent-step";
import type { Profile } from "../shared/profile";
import type { Session } from "../shared/session";
import type { Task, TaskStatus } from "../shared/task";
import { mapWithConcurrency } from "./approval-queue-state";
import type { ArgusRuntime } from "./api-runtime";
import { isAbortError, toDisplayError } from "./cockpit-state";
import { ConversationList } from "./ConversationList";
import {
  CONVERSATION_PAGE_SIZE,
  MAX_TASK_LOOKUP_CONCURRENCY,
  MESSAGE_PAGE_SIZE,
  TERMINAL_REFETCH_DEBOUNCE_MS,
  buildTaskIdSet,
  hasNonTerminalTaskForConversation,
  lastTaskIdForConversation,
  mergeConversations,
  mergeMessages,
  terminalTaskIdsFromOverlayChange,
  type ConversationTaskLookup,
} from "./conversation-state";
import {
  createIdempotencyKey,
  effectiveTaskStatus,
  formatStepLine,
  isTerminalTaskStatus,
  taskStatusLabel,
  type TaskEventOverlay,
} from "./task-chat-state";
import { TaskStatusPanel } from "./TaskStatusPanel";
import { texts } from "./texts";

const CONVERSATION_LIST_TIMEOUT_MS = 5000;
const CONVERSATION_CREATE_TIMEOUT_MS = 10000;
const MESSAGE_LIST_TIMEOUT_MS = 5000;
const MESSAGE_SEND_TIMEOUT_MS = 40000;
const TASK_READ_TIMEOUT_MS = 5000;
const TASK_STEPS_TIMEOUT_MS = 5000;
const TASK_CANCEL_TIMEOUT_MS = 10000;
const SLOW_SEND_HINT_MS = 2000;
const MAX_MESSAGE_LENGTH = 2000;

type ConversationChatProps = {
  readonly runtime: ArgusRuntime;
  readonly profile: Profile | null;
  readonly session: Session | null;
  readonly taskEvents: ReadonlyMap<string, TaskEventOverlay>;
  readonly reconnectVersion: number;
  readonly onSessionChanged: () => void;
};

type DraftKey = {
  readonly text: string;
  readonly key: string;
};

type CancelError = {
  readonly taskId: string;
  readonly message: string;
};

function lastCachedStep(steps: readonly AgentStep[]): AgentStep | null {
  let latest: AgentStep | null = null;

  for (const step of steps) {
    if (latest === null || step.index > latest.index) {
      latest = step;
    }
  }

  return latest;
}

export function ConversationChat({
  runtime,
  profile,
  session,
  taskEvents,
  reconnectVersion,
  onSessionChanged,
}: ConversationChatProps) {
  const profileId = profile?.id ?? null;
  const [conversations, setConversations] = useState<readonly Conversation[]>([]);
  const [conversationTotal, setConversationTotal] = useState(0);
  const [isConversationsLoading, setIsConversationsLoading] = useState(false);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [isConversationsLoadingMore, setIsConversationsLoadingMore] =
    useState(false);
  const [isCreatingConversation, setIsCreatingConversation] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [conversationReloadKey, setConversationReloadKey] = useState(0);
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(null);
  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [messageTotal, setMessageTotal] = useState(0);
  const [isThreadLoading, setIsThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [isThreadLoadingMore, setIsThreadLoadingMore] = useState(false);
  const [threadReloadKey, setThreadReloadKey] = useState(0);
  const [taskLookups, setTaskLookups] = useState<
    Readonly<Record<string, ConversationTaskLookup>>
  >({});
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [stepsByTask, setStepsByTask] = useState<
    Readonly<Record<string, readonly AgentStep[]>>
  >({});
  const [stepsLoadedStatus, setStepsLoadedStatus] = useState<
    Readonly<Record<string, TaskStatus>>
  >({});
  const [draft, setDraft] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPreparingSlow, setIsPreparingSlow] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [cancelPendingTaskId, setCancelPendingTaskId] = useState<string | null>(
    null,
  );
  const [cancelError, setCancelError] = useState<CancelError | null>(null);
  const isMountedRef = useRef(true);
  const conversationsRef = useRef<readonly Conversation[]>([]);
  const conversationNextPageRef = useRef(1);
  const conversationSequenceRef = useRef(0);
  const isLoadingMoreConversationsRef = useRef(false);
  const isCreatingConversationRef = useRef(false);
  const messagesRef = useRef<readonly Message[]>([]);
  const messageNextPageRef = useRef(1);
  const messageSequenceRef = useRef(0);
  const isLoadingMoreMessagesRef = useRef(false);
  const selectedConversationRef = useRef<string | null>(null);
  const selectedTaskRef = useRef<string | null>(null);
  const taskInFlightRef = useRef<Set<string>>(new Set());
  const taskLookupVersionRef = useRef<Map<string, number>>(new Map());
  const loadingStepsRef = useRef<Set<string>>(new Set());
  const draftKeyRef = useRef<DraftKey | null>(null);
  const submitPendingRef = useRef(false);
  const cancelPendingRef = useRef(false);
  const previousOverlaysRef = useRef(taskEvents);
  const pendingTerminalTaskIdsRef = useRef<Set<string>>(new Set());
  const terminalTimerRef = useRef<number | null>(null);
  const previousReconnectVersionRef = useRef(reconnectVersion);
  const threadEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(
    () => () => {
      if (terminalTimerRef.current !== null) {
        window.clearTimeout(terminalTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (profileId === null) {
      conversationsRef.current = [];
      conversationNextPageRef.current = 1;
      conversationSequenceRef.current += 1;
      setConversations([]);
      setConversationTotal(0);
      setConversationsError(null);
      setIsConversationsLoading(false);
      return;
    }

    let isActive = true;
    const sequence = conversationSequenceRef.current + 1;
    conversationSequenceRef.current = sequence;
    setIsConversationsLoading(true);
    setConversationsError(null);

    void (async () => {
      try {
        const response = await runtime.run(CONVERSATION_LIST_TIMEOUT_MS, (client) =>
          client.conversations.list(profileId, {
            page: 1,
            page_size: CONVERSATION_PAGE_SIZE,
          }),
        );

        if (!isActive || sequence !== conversationSequenceRef.current) {
          return;
        }

        const merged = mergeConversations(conversationsRef.current, response.data);
        conversationsRef.current = merged;
        conversationNextPageRef.current = Math.max(
          conversationNextPageRef.current,
          2,
        );
        setConversations(merged);
        setConversationTotal(Math.max(response.total, merged.length));
        setConversationsError(null);
      } catch (error: unknown) {
        if (
          isActive &&
          sequence === conversationSequenceRef.current &&
          !isAbortError(error)
        ) {
          console.error("Conversation list load failed:", error);
          setConversationsError(toDisplayError(error));
        }
      } finally {
        if (isActive && sequence === conversationSequenceRef.current) {
          setIsConversationsLoading(false);
        }
      }
    })();

    return () => {
      isActive = false;
    };
  }, [runtime, profileId, reconnectVersion, conversationReloadKey]);

  useEffect(() => {
    if (profileId === null || selectedConversationId === null) {
      messageSequenceRef.current += 1;
      messagesRef.current = [];
      messageNextPageRef.current = 1;
      setMessages([]);
      setMessageTotal(0);
      setThreadError(null);
      setIsThreadLoading(false);
      return;
    }

    let isActive = true;
    const sequence = messageSequenceRef.current + 1;
    messageSequenceRef.current = sequence;
    setIsThreadLoading(true);
    setThreadError(null);

    void (async () => {
      try {
        const response = await runtime.run(MESSAGE_LIST_TIMEOUT_MS, (client) =>
          client.conversations.listMessages(profileId, selectedConversationId, {
            page: 1,
            page_size: MESSAGE_PAGE_SIZE,
          }),
        );

        if (!isActive || sequence !== messageSequenceRef.current) {
          return;
        }

        const merged = mergeMessages(
          messagesRef.current,
          [...response.data].reverse(),
        );
        messagesRef.current = merged;
        messageNextPageRef.current = Math.max(messageNextPageRef.current, 2);
        setMessages(merged);
        setMessageTotal(Math.max(response.total, merged.length));
        setThreadError(null);

        const latestTaskId = lastTaskIdForConversation(merged);
        if (
          latestTaskId !== null &&
          (selectedTaskRef.current === null ||
            !buildTaskIdSet(merged).has(selectedTaskRef.current))
        ) {
          selectedTaskRef.current = latestTaskId;
          setSelectedTaskId(latestTaskId);
        }
      } catch (error: unknown) {
        if (
          isActive &&
          sequence === messageSequenceRef.current &&
          !isAbortError(error)
        ) {
          console.error("Conversation thread load failed:", error);
          setThreadError(toDisplayError(error));
        }
      } finally {
        if (isActive && sequence === messageSequenceRef.current) {
          setIsThreadLoading(false);
        }
      }
    })();

    return () => {
      isActive = false;
    };
  }, [
    runtime,
    profileId,
    selectedConversationId,
    reconnectVersion,
    threadReloadKey,
  ]);

  function beginTaskLookup(taskId: string): number {
    const version = (taskLookupVersionRef.current.get(taskId) ?? 0) + 1;
    taskLookupVersionRef.current.set(taskId, version);
    return version;
  }

  function scheduleThreadRefresh(taskIds: readonly string[]): void {
    for (const taskId of taskIds) {
      pendingTerminalTaskIdsRef.current.add(taskId);
    }

    if (terminalTimerRef.current !== null) {
      window.clearTimeout(terminalTimerRef.current);
    }

    terminalTimerRef.current = window.setTimeout(() => {
      terminalTimerRef.current = null;
      const pendingTaskIds = Array.from(pendingTerminalTaskIdsRef.current);
      pendingTerminalTaskIdsRef.current.clear();
      void refreshAfterTerminal(pendingTaskIds);
    }, TERMINAL_REFETCH_DEBOUNCE_MS);
  }

  useEffect(() => {
    const taskIds = Array.from(buildTaskIdSet(messages));
    const missing = taskIds.filter(
      (taskId) =>
        taskLookups[taskId] === undefined &&
        !taskInFlightRef.current.has(taskId),
    );

    if (missing.length === 0) {
      return;
    }

    for (const taskId of missing) {
      taskInFlightRef.current.add(taskId);
    }

    void mapWithConcurrency(
      missing,
      MAX_TASK_LOOKUP_CONCURRENCY,
      async (taskId) => {
        const version = beginTaskLookup(taskId);

        try {
          const response = await runtime.run(TASK_READ_TIMEOUT_MS, (client) =>
            client.tasks.get(taskId),
          );

          if (
            !isMountedRef.current ||
            taskLookupVersionRef.current.get(taskId) !== version
          ) {
            return;
          }

          setTaskLookups((current) => ({
            ...current,
            [taskId]: { kind: "ready", task: response.data },
          }));
        } catch (error: unknown) {
          if (
            !isMountedRef.current ||
            isAbortError(error) ||
            taskLookupVersionRef.current.get(taskId) !== version
          ) {
            return;
          }

          if (!(error instanceof ArgusApiError) || error.status !== 404) {
            console.error("Task lookup failed:", error);
          }

          setTaskLookups((current) => ({
            ...current,
            [taskId]: { kind: "unavailable" },
          }));
        } finally {
          taskInFlightRef.current.delete(taskId);
        }
      },
    );
  }, [runtime, messages, taskLookups]);

  useEffect(() => {
    if (selectedTaskId === null) {
      return;
    }

    const lookup = taskLookups[selectedTaskId];
    if (lookup?.kind !== "ready") {
      return;
    }

    const status = effectiveTaskStatus(
      lookup.task.status,
      taskEvents.get(selectedTaskId)?.status,
    );
    const hasSteps = stepsByTask[selectedTaskId] !== undefined;
    const isStaleTerminalLoad =
      isTerminalTaskStatus(status) &&
      stepsLoadedStatus[selectedTaskId] !== status;

    if (hasSteps && !isStaleTerminalLoad) {
      return;
    }
    if (loadingStepsRef.current.has(selectedTaskId)) {
      return;
    }

    const taskId = selectedTaskId;
    loadingStepsRef.current.add(taskId);
    let isActive = true;

    runtime
      .run(TASK_STEPS_TIMEOUT_MS, (client) =>
        client.tasks.listSteps(taskId, { page_size: 100 }),
      )
      .then((response) => {
        if (!isActive || !isMountedRef.current) {
          return;
        }

        setStepsByTask((current) => ({ ...current, [taskId]: response.data }));
        setStepsLoadedStatus((current) => ({ ...current, [taskId]: status }));
      })
      .catch((error: unknown) => {
        if (!isActive || !isMountedRef.current || isAbortError(error)) {
          return;
        }

        console.error("Task steps load failed:", error);
        setStepsByTask((current) => ({ ...current, [taskId]: [] }));
        setStepsLoadedStatus((current) => ({ ...current, [taskId]: status }));
      })
      .finally(() => {
        loadingStepsRef.current.delete(taskId);
      });

    return () => {
      isActive = false;
    };
  }, [
    runtime,
    selectedTaskId,
    taskLookups,
    taskEvents,
    stepsByTask,
    stepsLoadedStatus,
  ]);

  useEffect(() => {
    const previous = previousOverlaysRef.current;
    previousOverlaysRef.current = taskEvents;
    const knownTaskIds = buildTaskIdSet(messagesRef.current);
    const changedTaskIds = terminalTaskIdsFromOverlayChange(
      previous,
      taskEvents,
      knownTaskIds,
    );

    if (changedTaskIds.length === 0) {
      return;
    }

    scheduleThreadRefresh(changedTaskIds);
  }, [taskEvents]);

  useEffect(() => {
    if (reconnectVersion === previousReconnectVersionRef.current) {
      return;
    }

    previousReconnectVersionRef.current = reconnectVersion;
    const taskIds = Array.from(buildTaskIdSet(messagesRef.current)).filter(
      (taskId) => {
        const lookup = taskLookups[taskId];

        if (lookup === undefined) {
          return false;
        }
        if (lookup.kind === "unavailable") {
          return true;
        }

        return !isTerminalTaskStatus(
          effectiveTaskStatus(
            lookup.task.status,
            taskEvents.get(taskId)?.status,
          ),
        );
      },
    );

    if (taskIds.length === 0) {
      return;
    }

    void mapWithConcurrency(taskIds, MAX_TASK_LOOKUP_CONCURRENCY, refreshTaskLookup);
  }, [reconnectVersion]);

  useEffect(() => {
    if (!isSubmitting) {
      setIsPreparingSlow(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setIsPreparingSlow(true);
    }, SLOW_SEND_HINT_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [isSubmitting]);

  const lastMessageId =
    messages.length === 0 ? null : (messages[messages.length - 1]?.id ?? null);

  useEffect(() => {
    if (lastMessageId === null) {
      return;
    }

    threadEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [lastMessageId]);

  async function refreshTaskLookup(taskId: string): Promise<void> {
    const version = beginTaskLookup(taskId);

    try {
      const response = await runtime.run(TASK_READ_TIMEOUT_MS, (client) =>
        client.tasks.get(taskId),
      );

      if (
        !isMountedRef.current ||
        taskLookupVersionRef.current.get(taskId) !== version
      ) {
        return;
      }

      setTaskLookups((current) => ({
        ...current,
        [taskId]: { kind: "ready", task: response.data },
      }));
    } catch (error: unknown) {
      if (
        !isMountedRef.current ||
        isAbortError(error) ||
        taskLookupVersionRef.current.get(taskId) !== version
      ) {
        return;
      }

      if (!(error instanceof ArgusApiError) || error.status !== 404) {
        console.error("Task refresh failed:", error);
      }

      setTaskLookups((current) => ({
        ...current,
        [taskId]: { kind: "unavailable" },
      }));
    }
  }

  async function refreshThreadPageOne(conversationId: string): Promise<void> {
    if (profileId === null) {
      return;
    }

    const response = await runtime.run(MESSAGE_LIST_TIMEOUT_MS, (client) =>
      client.conversations.listMessages(profileId, conversationId, {
        page: 1,
        page_size: MESSAGE_PAGE_SIZE,
      }),
    );

    if (!isMountedRef.current || selectedConversationRef.current !== conversationId) {
      return;
    }

    const merged = mergeMessages(messagesRef.current, [...response.data].reverse());
    messagesRef.current = merged;
    messageNextPageRef.current = Math.max(messageNextPageRef.current, 2);
    setMessages(merged);
    setMessageTotal(Math.max(response.total, merged.length));
    setThreadError(null);

    const latestTaskId = lastTaskIdForConversation(merged);
    if (
      latestTaskId !== null &&
      (selectedTaskRef.current === null ||
        !buildTaskIdSet(merged).has(selectedTaskRef.current))
    ) {
      selectedTaskRef.current = latestTaskId;
      setSelectedTaskId(latestTaskId);
    }
  }

  async function refreshAfterTerminal(taskIds: readonly string[]): Promise<void> {
    const conversationId = selectedConversationRef.current;

    if (conversationId !== null) {
      try {
        await refreshThreadPageOne(conversationId);
      } catch (error: unknown) {
        if (!isAbortError(error)) {
          console.error("Conversation thread refresh failed:", error);
        }
      }
    }

    await mapWithConcurrency(taskIds, MAX_TASK_LOOKUP_CONCURRENCY, refreshTaskLookup);
  }

  function selectConversation(conversationId: string): void {
    if (submitPendingRef.current || conversationId === selectedConversationRef.current) {
      return;
    }

    selectedConversationRef.current = conversationId;
    setSelectedConversationId(conversationId);
    messagesRef.current = [];
    messageNextPageRef.current = 1;
    setMessages([]);
    setMessageTotal(0);
    setThreadError(null);
    setSelectedTaskId(null);
    selectedTaskRef.current = null;
    setDraft("");
    draftKeyRef.current = null;
    setSubmitError(null);
    setCancelError(null);
    setCancelPendingTaskId(null);
    setCreateError(null);
  }

  const handleSelectConversation = (conversationId: string): void => {
    selectConversation(conversationId);
  };

  const handleCreateConversation = async (): Promise<void> => {
    if (
      profileId === null ||
      isCreatingConversationRef.current ||
      submitPendingRef.current
    ) {
      return;
    }

    isCreatingConversationRef.current = true;
    setIsCreatingConversation(true);
    setCreateError(null);

    try {
      const response = await runtime.run(CONVERSATION_CREATE_TIMEOUT_MS, (client) =>
        client.conversations.create(profileId),
      );

      if (!isMountedRef.current) {
        return;
      }

      const merged = mergeConversations(conversationsRef.current, [
        response.data,
      ]);
      conversationsRef.current = merged;
      setConversations(merged);
      setConversationTotal((current) => Math.max(current + 1, merged.length));
      selectConversation(response.data.id);
    } catch (error: unknown) {
      if (!isMountedRef.current || isAbortError(error)) {
        return;
      }

      console.error("Conversation create failed:", error);
      setCreateError(toDisplayError(error));
    } finally {
      isCreatingConversationRef.current = false;

      if (isMountedRef.current) {
        setIsCreatingConversation(false);
      }
    }
  };

  const handleLoadMoreConversations = async (): Promise<void> => {
    if (
      profileId === null ||
      isLoadingMoreConversationsRef.current ||
      isConversationsLoading
    ) {
      return;
    }

    const page = conversationNextPageRef.current;
    isLoadingMoreConversationsRef.current = true;
    setIsConversationsLoadingMore(true);

    try {
      const response = await runtime.run(CONVERSATION_LIST_TIMEOUT_MS, (client) =>
        client.conversations.list(profileId, {
          page,
          page_size: CONVERSATION_PAGE_SIZE,
        }),
      );

      if (!isMountedRef.current) {
        return;
      }

      const merged = mergeConversations(conversationsRef.current, response.data);
      conversationsRef.current = merged;
      conversationNextPageRef.current = page + 1;
      setConversations(merged);
      setConversationTotal(Math.max(response.total, merged.length));
      setConversationsError(null);
    } catch (error: unknown) {
      if (!isMountedRef.current || isAbortError(error)) {
        return;
      }

      console.error("Conversation page load failed:", error);
      setConversationsError(toDisplayError(error));
    } finally {
      isLoadingMoreConversationsRef.current = false;

      if (isMountedRef.current) {
        setIsConversationsLoadingMore(false);
      }
    }
  };

  const handleLoadMoreMessages = async (): Promise<void> => {
    if (
      profileId === null ||
      selectedConversationId === null ||
      isLoadingMoreMessagesRef.current ||
      isThreadLoading
    ) {
      return;
    }

    const page = messageNextPageRef.current;
    const conversationId = selectedConversationId;
    isLoadingMoreMessagesRef.current = true;
    setIsThreadLoadingMore(true);

    try {
      const response = await runtime.run(MESSAGE_LIST_TIMEOUT_MS, (client) =>
        client.conversations.listMessages(profileId, conversationId, {
          page,
          page_size: MESSAGE_PAGE_SIZE,
        }),
      );

      if (
        !isMountedRef.current ||
        selectedConversationRef.current !== conversationId
      ) {
        return;
      }

      const merged = mergeMessages(messagesRef.current, [...response.data].reverse());
      messagesRef.current = merged;
      messageNextPageRef.current = page + 1;
      setMessages(merged);
      setMessageTotal(Math.max(response.total, merged.length));
      setThreadError(null);
    } catch (error: unknown) {
      if (
        !isMountedRef.current ||
        selectedConversationRef.current !== conversationId ||
        isAbortError(error)
      ) {
        return;
      }

      console.error("Conversation message page load failed:", error);
      setThreadError(toDisplayError(error));
    } finally {
      isLoadingMoreMessagesRef.current = false;

      if (isMountedRef.current) {
        setIsThreadLoadingMore(false);
      }
    }
  };

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (
      profileId === null ||
      submitPendingRef.current ||
      !canSend
    ) {
      return;
    }

    const text = draft.trim();
    const stored = draftKeyRef.current;
    const entry: DraftKey =
      stored !== null && stored.text === text
        ? stored
        : { text, key: createIdempotencyKey() };
    draftKeyRef.current = entry;
    submitPendingRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);

    let conversationId = selectedConversationRef.current;

    try {
      if (conversationId === null) {
        const created = await runtime.run(CONVERSATION_CREATE_TIMEOUT_MS, (client) =>
          client.conversations.create(profileId),
        );

        if (!isMountedRef.current) {
          return;
        }

        conversationId = created.data.id;
        const mergedConversations = mergeConversations(conversationsRef.current, [
          created.data,
        ]);
        conversationsRef.current = mergedConversations;
        setConversations(mergedConversations);
        setConversationTotal((current) =>
          Math.max(current + 1, mergedConversations.length),
        );
        selectedConversationRef.current = conversationId;
        setSelectedConversationId(conversationId);
        messagesRef.current = [];
        messageNextPageRef.current = 1;
        setMessages([]);
        setMessageTotal(0);
        setThreadError(null);
        setSelectedTaskId(null);
        selectedTaskRef.current = null;
        setCancelError(null);
        setCancelPendingTaskId(null);
      }

      if (conversationId === null) {
        return;
      }

      const activeConversationId: string = conversationId;
      const response = await runtime.run(MESSAGE_SEND_TIMEOUT_MS, (client) =>
        client.conversations.sendMessage(
          profileId,
          activeConversationId,
          { text },
          { idempotencyKey: entry.key },
        ),
      );

      if (
        !isMountedRef.current ||
        selectedConversationRef.current !== activeConversationId
      ) {
        return;
      }

      draftKeyRef.current = null;
      setDraft("");
      const mergedMessages = mergeMessages(messagesRef.current, [
        response.data.message,
      ]);
      messagesRef.current = mergedMessages;
      setMessages(mergedMessages);
      setMessageTotal((current) =>
        Math.max(current + 1, mergedMessages.length),
      );
      setTaskLookups((current) => ({
        ...current,
        [response.data.task.id]: { kind: "ready", task: response.data.task },
      }));
      const mergedConversations = mergeConversations(conversationsRef.current, [
        response.data.conversation,
      ]);
      conversationsRef.current = mergedConversations;
      setConversations(mergedConversations);
      setConversationTotal((current) =>
        Math.max(current, mergedConversations.length),
      );
      selectedTaskRef.current = response.data.task.id;
      setSelectedTaskId(response.data.task.id);
      setSubmitError(null);
      setConversationReloadKey((current) => current + 1);
      scheduleThreadRefresh([response.data.task.id]);
      onSessionChanged();
    } catch (error: unknown) {
      if (!isMountedRef.current || isAbortError(error)) {
        return;
      }

      setSubmitError(toDisplayError(error));

      if (
        conversationId !== null &&
        error instanceof ArgusApiError &&
        (error.status === 0 || error.status >= 500)
      ) {
        onSessionChanged();

        try {
          await refreshThreadPageOne(conversationId);
        } catch (refreshError: unknown) {
          if (!isAbortError(refreshError)) {
            console.error("Conversation thread reconcile failed:", refreshError);
          }
        }
      }
    } finally {
      submitPendingRef.current = false;

      if (isMountedRef.current) {
        setIsSubmitting(false);
      }
    }
  };

  const handleCancel = async (taskId: string): Promise<void> => {
    if (cancelPendingRef.current) {
      return;
    }

    cancelPendingRef.current = true;
    setCancelPendingTaskId(taskId);
    setCancelError(null);

    try {
      const response = await runtime.run(TASK_CANCEL_TIMEOUT_MS, (client) =>
        client.tasks.cancel(taskId),
      );

      if (!isMountedRef.current) {
        return;
      }

      setTaskLookups((current) => ({
        ...current,
        [taskId]: { kind: "ready", task: response.data },
      }));
    } catch (error: unknown) {
      if (!isMountedRef.current || isAbortError(error)) {
        return;
      }

      setCancelError({ taskId, message: toDisplayError(error) });
      await refreshTaskLookup(taskId);
    } finally {
      cancelPendingRef.current = false;

      if (isMountedRef.current) {
        setCancelPendingTaskId(null);
      }
    }
  };

  const knownTaskIds = buildTaskIdSet(messages);
  const knownTasks: Task[] = [];

  for (const taskId of knownTaskIds) {
    const lookup = taskLookups[taskId];
    if (lookup?.kind === "ready") {
      knownTasks.push(lookup.task);
    }
  }

  const hasRunningTask = hasNonTerminalTaskForConversation(
    knownTaskIds,
    knownTasks,
    taskEvents,
  );
  const hasPendingLiveTask = Array.from(knownTaskIds).some((taskId) => {
    if (taskLookups[taskId] !== undefined) {
      return false;
    }

    const status = taskEvents.get(taskId)?.status;
    return status !== undefined && !isTerminalTaskStatus(status);
  });
  const canUseComposer =
    profile !== null &&
    !isThreadLoading &&
    !isSubmitting &&
    !hasRunningTask &&
    !hasPendingLiveTask;
  const canSend =
    canUseComposer &&
    draft.trim().length >= 1 &&
    draft.trim().length <= MAX_MESSAGE_LENGTH;
  const hasMoreConversations = conversations.length < conversationTotal;
  const hasMoreMessages = messages.length < messageTotal;
  const selectedLookup =
    selectedTaskId === null ? undefined : taskLookups[selectedTaskId];
  const selectedTask =
    selectedLookup?.kind === "ready" ? selectedLookup.task : null;
  const selectedStatus =
    selectedTask === null || selectedTaskId === null
      ? null
      : effectiveTaskStatus(
          selectedTask.status,
          taskEvents.get(selectedTaskId)?.status,
        );
  const selectedSteps =
    selectedTaskId === null ? [] : (stepsByTask[selectedTaskId] ?? []);
  const selectedOverlayStep =
    selectedTaskId === null
      ? undefined
      : taskEvents.get(selectedTaskId)?.lastStep;
  const firstMessageIdByTask = new Map<string, string>();

  for (const message of messages) {
    if (
      message.taskId !== null &&
      !firstMessageIdByTask.has(message.taskId)
    ) {
      firstMessageIdByTask.set(message.taskId, message.id);
    }
  }

  if (profile === null) {
    return (
      <section className="empty-state" aria-labelledby="workspace-heading">
        <h2 className="empty-state-heading" id="workspace-heading">
          {texts.conversations.heading}
        </h2>
        <p className="empty-state-body">{texts.taskChat.noProfile}</p>
      </section>
    );
  }

  return (
    <div className="conversation-grid">
      <ConversationList
        conversations={conversations}
        selectedConversationId={selectedConversationId}
        isLoading={isConversationsLoading}
        isLoadingMore={isConversationsLoadingMore}
        isCreating={isCreatingConversation}
        error={conversationsError}
        createError={createError}
        hasMore={hasMoreConversations}
        onSelect={handleSelectConversation}
        onCreate={() => void handleCreateConversation()}
        onLoadMore={() => void handleLoadMoreConversations()}
        onRetry={() => setConversationReloadKey((current) => current + 1)}
      />

      <section
        className="panel conversation-thread"
        aria-labelledby="conversation-thread-heading"
        aria-busy={isThreadLoading || isThreadLoadingMore || isSubmitting}
      >
        <h2 className="panel-heading" id="conversation-thread-heading">
          {texts.conversations.threadHeading}
        </h2>

        {isThreadLoading && messages.length === 0 ? (
          <p className="panel-note" role="status" aria-live="polite">
            {texts.conversations.loadingMessages}
          </p>
        ) : null}

        {threadError === null ? null : (
          <>
            <p className="form-error" role="alert">
              {threadError}
            </p>
            <button
              className="button"
              type="button"
              onClick={() => setThreadReloadKey((current) => current + 1)}
              disabled={isThreadLoading}
            >
              {texts.conversations.retry}
            </button>
          </>
        )}

        {!isThreadLoading &&
        threadError === null &&
        messages.length === 0 ? (
          <p className="panel-note">{texts.conversations.emptyThread}</p>
        ) : null}

        {messages.length === 0 ? null : (
          <ol
            className="message-list"
            aria-label={texts.conversations.messageListLabel}
          >
            {messages.map((message) => {
              const overlay =
                message.taskId === null
                  ? undefined
                  : taskEvents.get(message.taskId);
              const lookup =
                message.taskId === null
                  ? undefined
                  : taskLookups[message.taskId];
              const status =
                lookup?.kind === "ready" && message.taskId !== null
                  ? effectiveTaskStatus(
                      lookup.task.status,
                      overlay?.status,
                    )
                  : null;
              const steps =
                message.taskId === null
                  ? []
                  : (stepsByTask[message.taskId] ?? []);
              const cachedStep = lastCachedStep(steps);
              const stepLine =
                overlay?.lastStep === undefined
                  ? cachedStep === null
                    ? null
                    : formatStepLine(
                        cachedStep.index,
                        cachedStep.action,
                        cachedStep.result.status,
                      )
                  : formatStepLine(
                      overlay.lastStep.index,
                      overlay.lastStep.action,
                      overlay.lastStep.status,
                    );
              const isStatusAnchor =
                message.taskId !== null &&
                firstMessageIdByTask.get(message.taskId) === message.id;
              const isCancelPending =
                message.taskId !== null &&
                cancelPendingTaskId === message.taskId;
              const cancelMessage =
                message.taskId !== null &&
                cancelError?.taskId === message.taskId
                  ? cancelError.message
                  : null;

              return (
                <li className="message" data-role={message.role} key={message.id}>
                  <div className="message-bubble">
                    <span className="chat-speaker">
                      {message.role === "operator"
                        ? texts.conversations.operatorLabel
                        : texts.conversations.agentLabel}
                    </span>
                    <p className="message-text">{message.text}</p>
                  </div>

                  {isStatusAnchor &&
                  (lookup !== undefined || cancelMessage !== null) ? (
                    <div className="message-turn">
                      {lookup?.kind === "unavailable" ? (
                        <span className="message-status">
                          {texts.conversations.statusUnavailable}
                        </span>
                      ) : status === null ? null : (
                        <>
                          <span className="chat-status" data-status={status}>
                            {taskStatusLabel(status)}
                          </span>
                          {stepLine === null ? null : (
                            <span className="message-step">{stepLine}</span>
                          )}
                          {isTerminalTaskStatus(status) ? null : (
                            <button
                              className="button button-quiet"
                              type="button"
                              onClick={() => {
                                if (message.taskId !== null) {
                                  void handleCancel(message.taskId);
                                }
                              }}
                              disabled={cancelPendingTaskId !== null}
                            >
                              {isCancelPending
                                ? texts.taskChat.cancelling
                                : texts.taskChat.cancel}
                            </button>
                          )}
                        </>
                      )}
                      {cancelMessage === null ? null : (
                        <p className="form-error" role="alert">
                          {cancelMessage}
                        </p>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}

        <div ref={threadEndRef} />

        {hasMoreMessages ? (
          <button
            className="button"
            type="button"
            onClick={() => void handleLoadMoreMessages()}
            disabled={isThreadLoading || isThreadLoadingMore}
          >
            {isThreadLoadingMore
              ? texts.conversations.loadingMore
              : texts.conversations.loadMore}
          </button>
        ) : null}

        <form
          className="chat-composer"
          onSubmit={(event) => void handleSubmit(event)}
        >
          <label className="field-label" htmlFor="conversation-message">
            {texts.conversations.composerLabel}
          </label>
          <textarea
            id="conversation-message"
            className="input chat-textarea"
            value={draft}
            rows={3}
            maxLength={MAX_MESSAGE_LENGTH}
            placeholder={texts.conversations.composerPlaceholder}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!canUseComposer}
          />
          <div className="chat-composer-meta">
            <span className="chat-counter">
              {texts.conversations.characterCount(draft.length)}
            </span>
            <button
              className="button button-primary"
              type="submit"
              disabled={!canSend}
            >
              {isSubmitting
                ? isPreparingSlow
                  ? texts.conversations.preparingBrowser
                  : texts.conversations.sending
                : texts.conversations.send}
            </button>
          </div>
          {session === null ? (
            <p className="panel-note">{texts.conversations.autoSession}</p>
          ) : null}
          {hasRunningTask ? (
            <p className="panel-note">{texts.conversations.blocked}</p>
          ) : null}
          {submitError === null ? null : (
            <p className="form-error" role="alert">
              {submitError}
            </p>
          )}
        </form>
      </section>

      {session === null ? (
        <section
          className="panel status-panel"
          aria-labelledby="status-panel-heading"
        >
          <h2 className="panel-heading" id="status-panel-heading">
            {texts.taskStatus.heading}
          </h2>
          <p className="panel-note">
            {texts.conversations.statusPanelUnavailable}
          </p>
        </section>
      ) : (
        <TaskStatusPanel
          runtime={runtime}
          profile={profile}
          session={session}
          task={selectedTask}
          status={selectedStatus}
          steps={selectedSteps}
          overlayStep={selectedOverlayStep}
        />
      )}
    </div>
  );
}
