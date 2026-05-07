"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronUp,
  FileText,
  MessageCircle,
  Paperclip,
  Plus,
  RotateCcw,
  Send,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHiveContext } from "@/components/hive-context";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";
import { validateAttachmentFiles } from "@/attachments/constants";
import {
  type AttachmentFileEntry,
  createAttachmentFileEntries,
  revokeAttachmentFileEntries,
} from "@/components/attachment-dropzone";

type ChatStatus = "queued" | "streaming" | "sent" | "failed";

interface EaChatMessage {
  id: string;
  threadId: string;
  role: "owner" | "assistant" | "system";
  content: string;
  source: string;
  status: ChatStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EaChatThread {
  id: string;
  hiveId: string;
  channelId: string;
  status: string;
  createdAt: string;
}

interface EaChatState {
  thread: EaChatThread;
  messages: EaChatMessage[];
  hasMore: boolean;
}

interface PendingMessage {
  id: string;
  role: "owner" | "assistant";
  content: string;
  status: "queued" | "streaming";
  createdAt: string;
}

const PENDING_OWNER_DEDUPE_WINDOW_MS = 10_000;

function hasMatchingPersistedOwnerMessage(
  persisted: EaChatMessage[],
  pendingMessage: PendingMessage,
) {
  if (pendingMessage.role !== "owner") return false;
  const pendingCreatedAt = Date.parse(pendingMessage.createdAt);
  if (Number.isNaN(pendingCreatedAt)) return false;

  const latestPersistedOwner = [...persisted]
    .reverse()
    .find((message) => message.role === "owner");
  if (!latestPersistedOwner || latestPersistedOwner.content !== pendingMessage.content) {
    return false;
  }

  const persistedCreatedAt = Date.parse(latestPersistedOwner.createdAt);
  if (Number.isNaN(persistedCreatedAt)) return false;
  return Math.abs(persistedCreatedAt - pendingCreatedAt) <= PENDING_OWNER_DEDUPE_WINDOW_MS;
}

function isMobileViewport() {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(max-width: 767px)").matches;
}

async function fetchChat(hiveId: string): Promise<EaChatState> {
  const response = await fetch(`/api/ea/chat?hiveId=${hiveId}&limit=40`);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error ?? "Conversation unavailable");
  }
  return body.data;
}

async function fetchEarlier(hiveId: string, before: string): Promise<EaChatState> {
  const response = await fetch(
    `/api/ea/chat?hiveId=${hiveId}&limit=40&before=${encodeURIComponent(before)}`,
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error ?? "Conversation unavailable");
  }
  return body.data;
}

async function sendMessage(input: {
  hiveId: string;
  content: string;
  files?: File[];
  onDelta?: (delta: string) => void;
}) {
  const hasFiles = (input.files?.length ?? 0) > 0;
  const requestBody = hasFiles ? new FormData() : JSON.stringify({
    hiveId: input.hiveId,
    content: input.content,
  });
  if (hasFiles && requestBody instanceof FormData) {
    requestBody.append("hiveId", input.hiveId);
    requestBody.append("content", input.content);
    for (const file of input.files ?? []) requestBody.append("files", file);
  }
  const response = await fetch("/api/ea/chat", {
    method: "POST",
    headers: {
      "Accept": "text/event-stream",
      ...(hasFiles ? {} : { "Content-Type": "application/json" }),
    },
    body: requestBody,
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (response.ok && contentType.includes("text/event-stream") && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((part) => part.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice(6)) as {
          type?: string;
          delta?: string;
        };
        if (event.type === "delta" && event.delta) input.onDelta?.(event.delta);
        if (event.type === "error") throw new Error("EA response failed");
      }
    }
    return { streamed: true };
  }

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error ?? "Failed to send message");
  }
  return body.data;
}

async function startFreshThread(hiveId: string) {
  const response = await fetch(`/api/ea/chat?hiveId=${hiveId}`, {
    method: "DELETE",
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error ?? "Failed to start fresh thread");
  }
  return body.data;
}

export function EaChatEntryButton({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  const { selected, loading } = useHiveContext();
  const disabled = loading || !selected;
  const { data } = useQuery({
    queryKey: selected ? queryKeys.eaChat.active(selected.id) : ["ea-chat", "disabled"],
    queryFn: () => fetchChat(selected!.id),
    enabled: Boolean(selected),
    refetchInterval: (query) => {
      const messages = query.state.data?.messages ?? [];
      return messages.some((message) => message.status === "streaming") ? 3000 : false;
    },
  });
  const thinking = data?.messages.some(
    (message) => message.role === "assistant" && message.status === "streaming",
  );
  const status = disabled ? "Select a hive" : thinking ? "Thinking" : "Ready";
  const scopeText = selected ? `${selected.name} · ${status}` : status;

  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500",
        "text-amber-900 hover:bg-amber-100/70 dark:text-amber-100 dark:hover:bg-white/[0.05]",
        open && "bg-amber-100/70 dark:bg-white/[0.05]",
        disabled && "cursor-not-allowed opacity-55",
      )}
      aria-label={`${open ? "Close" : "Open"} Executive Assistant chat for ${selected?.name ?? "selected hive"}, ${status.toLowerCase()}`}
      title={disabled ? "Select a hive to chat with its EA." : undefined}
    >
      <MessageCircle className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block font-medium leading-tight">EA Chat</span>
        <span className="block text-xs leading-tight text-amber-700/65 dark:text-zinc-400">
          {scopeText}
        </span>
      </span>
    </button>
  );
}

export function EaChatPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { selected } = useHiveContext();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<AttachmentFileEntry[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [pendingMessage, setPendingMessage] = useState<PendingMessage | null>(null);
  const [streamingAssistant, setStreamingAssistant] = useState<PendingMessage | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState("");
  const [earlierMessages, setEarlierMessages] = useState<EaChatMessage[]>([]);
  const [earlierHasMore, setEarlierHasMore] = useState<boolean | null>(null);
  const [earlierError, setEarlierError] = useState<string | null>(null);
  const [freshNotice, setFreshNotice] = useState(false);
  const [newMessagesHidden, setNewMessagesHidden] = useState(false);
  const [collapsedOpen, setCollapsedOpen] = useState<Record<string, boolean>>({});
  const panelRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const filesRef = useRef<AttachmentFileEntry[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const hiveId = selected?.id ?? "";
  const previousHiveIdRef = useRef(hiveId);
  const chatQuery = useQuery({
    queryKey: hiveId ? queryKeys.eaChat.active(hiveId) : ["ea-chat", "disabled"],
    queryFn: () => fetchChat(hiveId),
    enabled: open && Boolean(hiveId),
    refetchInterval: (query) => {
      const messages = query.state.data?.messages ?? [];
      const hasStreaming = messages.some((message) => message.status === "streaming");
      return hasStreaming ? 3000 : false;
    },
  });

  const sendMutation = useMutation({
    mutationFn: (input: { hiveId: string; content: string; files: File[] }) =>
      sendMessage({
        ...input,
        onDelta: (delta) => {
          setStreamingAssistant((current) => {
            const now = new Date().toISOString();
            return {
              id: current?.id ?? `streaming-${Date.now()}`,
              role: "assistant",
              content: `${current?.content ?? ""}${delta}`,
              status: "streaming",
              createdAt: current?.createdAt ?? now,
            };
          });
        },
      }),
    onSuccess: async () => {
      setPendingMessage(null);
      setStreamingAssistant(null);
      setSendError(null);
      setFileError(null);
      setStatusText("EA response complete");
      await queryClient.invalidateQueries({ queryKey: queryKeys.eaChat.active(hiveId) });
    },
    onError: (error) => {
      setSendError(error instanceof Error ? error.message : "Failed to send message");
      setStatusText("Message was not sent");
    },
  });

  const freshMutation = useMutation({
    mutationFn: startFreshThread,
    onSuccess: async () => {
      setEarlierMessages([]);
      setEarlierHasMore(false);
      setFreshNotice(true);
      setDraft("");
      setFileError(null);
      revokeAttachmentFileEntries(filesRef.current);
      setFiles([]);
      setPendingMessage(null);
      setStreamingAssistant(null);
      setSendError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.eaChat.active(hiveId) });
    },
  });

  const messages = useMemo(() => {
    const persisted = [...earlierMessages, ...(chatQuery.data?.messages ?? [])];
    const showPendingMessage =
      pendingMessage && !hasMatchingPersistedOwnerMessage(persisted, pendingMessage);
    if (showPendingMessage) {
      return streamingAssistant
        ? [...persisted, pendingMessage, streamingAssistant]
        : [...persisted, pendingMessage];
    }
    return streamingAssistant ? [...persisted, streamingAssistant] : persisted;
  }, [chatQuery.data?.messages, earlierMessages, pendingMessage, streamingAssistant]);

  const hasStreaming = messages.some(
    (message) => message.role === "assistant" && message.status === "streaming",
  );
  const lastMessageContentLength = messages[messages.length - 1]?.content.length ?? 0;
  const sending = sendMutation.isPending;
  const composerDisabled = !selected || chatQuery.isLoading || sending || freshMutation.isPending;
  const firstPersistedMessage = messages.find((message) => "threadId" in message) as
    | EaChatMessage
    | undefined;

  const hasEarlier = earlierHasMore ?? Boolean(chatQuery.data?.hasMore);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    return () => revokeAttachmentFileEntries(filesRef.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const mobile = isMobileViewport();
    const originalOverflow = document.body.style.overflow;
    if (mobile) document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent | globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      document.removeEventListener("keydown", onKeyDown);
      openerRef.current?.focus();
    };
  }, [onClose, open]);

  useEffect(() => {
    if (previousHiveIdRef.current === hiveId) return;
    previousHiveIdRef.current = hiveId;
    window.requestAnimationFrame(() => {
      setEarlierMessages([]);
      setEarlierHasMore(null);
      setEarlierError(null);
      setFreshNotice(false);
      setPendingMessage(null);
      setStreamingAssistant(null);
      setSendError(null);
      setFileError(null);
      revokeAttachmentFileEntries(filesRef.current);
      setFiles([]);
    });
  }, [hiveId]);

  useEffect(() => {
    if (!open) return;
    if (chatQuery.isLoading) {
      headingRef.current?.focus();
      return;
    }
    textareaRef.current?.focus();
  }, [chatQuery.isLoading, open]);

  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (distanceFromBottom > 140) {
      window.requestAnimationFrame(() => setNewMessagesHidden(true));
      return;
    }
    if (hasStreaming && typeof list.scrollTo === "function") {
      list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
    } else {
      list.scrollTop = list.scrollHeight;
    }
    window.requestAnimationFrame(() => setNewMessagesHidden(false));
  }, [messages.length, lastMessageContentLength, open, hasStreaming]);

  const liveStatusText = hasStreaming ? "EA is responding" : statusText;

  if (!open || !selected) return null;

  const addFiles = (incoming: File[]) => {
    if (incoming.length === 0) return;
    setFileError(null);
    const nextFiles = [...files.map((entry) => entry.file), ...incoming];
    const validationError = validateAttachmentFiles(nextFiles);
    if (validationError) {
      setFileError(validationError);
      return;
    }
    setFiles((current) => [...current, ...createAttachmentFileEntries(incoming)]);
  };

  const removeFile = (index: number) => {
    setFiles((current) => {
      const next = [...current];
      const [removed] = next.splice(index, 1);
      if (removed) revokeAttachmentFileEntries([removed]);
      return next;
    });
    setFileError(null);
  };

  const submit = (contentOverride?: string) => {
    const content = (contentOverride ?? draft).trim();
    if ((!content && files.length === 0) || composerDisabled) return;
    const now = new Date().toISOString();
    const filesToSend = files;
    const optimisticContent = content || `Sent ${filesToSend.length} attachment${filesToSend.length === 1 ? "" : "s"}`;
    setPendingMessage({
      id: `pending-${Date.now()}`,
      role: "owner",
      content: optimisticContent,
      status: "queued",
      createdAt: now,
    });
    setDraft("");
    setFiles([]);
    setFileError(null);
    setSendError(null);
    setFreshNotice(false);
    setStatusText("Message sending");
    setStreamingAssistant({
      id: `streaming-${Date.now()}`,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: now,
    });
    sendMutation.mutate({
      hiveId,
      content,
      files: filesToSend.map((entry) => entry.file),
    }, {
      onSettled: () => revokeAttachmentFileEntries(filesToSend),
    });
  };

  const retry = () => {
    if (!pendingMessage) return;
    sendMutation.mutate({ hiveId, content: pendingMessage.content, files: [] });
  };

  const loadEarlierMessages = async () => {
    if (!firstPersistedMessage) return;
    setEarlierError(null);
    try {
      const state = await fetchEarlier(hiveId, firstPersistedMessage.createdAt);
      setEarlierMessages((current) => [...state.messages, ...current]);
      setEarlierHasMore(state.hasMore);
    } catch (error) {
      setEarlierError(error instanceof Error ? error.message : "Could not load earlier messages");
    }
  };

  const onTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return (
    <aside
      ref={panelRef}
      onDragOver={(event) => {
        if (composerDisabled) return;
        event.preventDefault();
      }}
      onDrop={(event) => {
        if (composerDisabled) return;
        event.preventDefault();
        addFiles(Array.from(event.dataTransfer.files));
      }}
      role={isMobileViewport() ? "dialog" : "complementary"}
      aria-modal={isMobileViewport() ? "true" : undefined}
      aria-labelledby="ea-chat-title"
      className={cn(
        "fixed z-40 flex bg-card text-card-foreground shadow-xl shadow-black/10",
        "bottom-0 left-0 right-0 top-14 md:inset-y-0 md:left-auto md:w-[min(420px,calc(100vw-64px))]",
        "border-t border-amber-200/70 md:border-l md:border-t-0 dark:border-white/[0.08]",
      )}
    >
      <div className="flex min-h-0 w-full flex-col">
        <header className="shrink-0 border-b border-amber-200/70 bg-amber-50/80 px-4 py-3 dark:border-white/[0.08] dark:bg-sidebar">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2
                ref={headingRef}
                tabIndex={-1}
                id="ea-chat-title"
                className="text-base font-semibold text-amber-950 outline-none dark:text-amber-100"
              >
                Executive Assistant
              </h2>
              <p className="mt-0.5 truncate text-xs text-amber-800/70 dark:text-zinc-400">
                {selected.name} · {hasStreaming ? "thinking" : "active thread"}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              onClick={() => freshMutation.mutate(hiveId)}
              disabled={freshMutation.isPending || sending}
              aria-label="Start a fresh EA thread"
              title="New thread"
            >
              <Plus aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              onClick={onClose}
              aria-label="Close Executive Assistant chat"
              title="Close"
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        </header>

        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
          role="region"
          aria-label="EA conversation"
        >
          {chatQuery.isLoading ? (
            <StatusRow>Loading conversation...</StatusRow>
          ) : chatQuery.isError ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
              Conversation unavailable.{" "}
              <button className="underline underline-offset-2" onClick={() => chatQuery.refetch()}>
                Retry loading.
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {hasEarlier && (
                <div className="flex justify-center">
                  <Button type="button" variant="outline" size="sm" onClick={loadEarlierMessages}>
                    <ChevronUp aria-hidden="true" />
                    Load earlier
                  </Button>
                </div>
              )}
              {earlierError && (
                <StatusRow tone="error">Could not load earlier messages. Try again.</StatusRow>
              )}
              {freshNotice && <StatusRow>Fresh thread started</StatusRow>}
              {messages.length === 0 ? (
                <EmptyThread onPrompt={(prompt) => setDraft(prompt)} />
              ) : (
                messages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    expanded={collapsedOpen[message.id]}
                    onToggleExpanded={() =>
                      setCollapsedOpen((current) => ({
                        ...current,
                        [message.id]: !current[message.id],
                      }))
                    }
                  />
                ))
              )}
              {sending && !hasStreaming && <StatusRow>EA is thinking...</StatusRow>}
            </div>
          )}
        </div>

        {newMessagesHidden && (
          <div className="flex justify-center border-t border-amber-200/60 bg-card px-4 py-2 dark:border-white/[0.06]">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
                setNewMessagesHidden(false);
              }}
            >
              New messages
            </Button>
          </div>
        )}

        <footer className="shrink-0 border-t border-amber-200/70 bg-amber-50/70 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] dark:border-white/[0.08] dark:bg-sidebar">
          <div className="sr-only" aria-live="polite" aria-atomic="true">
            {liveStatusText}
          </div>
          {sendError && (
            <div
              className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
              aria-live="assertive"
            >
              <span className="flex min-w-0 items-center gap-2">
                <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0">{sendError}</span>
              </span>
              {pendingMessage && (
                <Button type="button" variant="outline" size="sm" onClick={retry}>
                  <RotateCcw aria-hidden="true" />
                  Retry
                </Button>
              )}
            </div>
          )}
          {fileError && (
            <div
              className="mb-2 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
              aria-live="assertive"
            >
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">{fileError}</span>
            </div>
          )}
          {files.length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-2" aria-label="Selected attachments">
              {files.map((entry, index) => (
                <li key={`${entry.file.name}-${entry.file.size}-${index}`}>
                  {entry.objectUrl ? (
                    <div className="group flex items-center gap-2 rounded-md border border-amber-200 bg-white p-1 pr-2 text-xs text-amber-950 shadow-sm dark:border-white/[0.08] dark:bg-zinc-950 dark:text-zinc-100">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={entry.objectUrl}
                        alt={entry.file.name}
                        className="size-10 rounded object-cover"
                      />
                      <span className="max-w-28 truncate">{entry.file.name}</span>
                      <button
                        type="button"
                        disabled={composerDisabled}
                        onClick={() => removeFile(index)}
                        className="rounded p-1 text-muted-foreground hover:bg-amber-100 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/[0.06]"
                        aria-label={`Remove ${entry.file.name}`}
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex max-w-[13rem] items-center gap-2 rounded-full border border-amber-200 bg-white px-2 py-1 text-xs text-amber-950 shadow-sm dark:border-white/[0.08] dark:bg-zinc-950 dark:text-zinc-100">
                      <FileText className="size-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{entry.file.name}</span>
                      <button
                        type="button"
                        disabled={composerDisabled}
                        onClick={() => removeFile(index)}
                        className="rounded-full p-0.5 text-muted-foreground hover:bg-amber-100 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/[0.06]"
                        aria-label={`Remove ${entry.file.name}`}
                      >
                        <X className="size-3" aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              disabled={composerDisabled}
              onChange={(event) => {
                addFiles(Array.from(event.target.files ?? []));
                event.currentTarget.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="icon-lg"
              onClick={() => fileInputRef.current?.click()}
              disabled={composerDisabled}
              aria-label="Attach files"
              title="Attach files"
              className="min-h-11 shrink-0"
            >
              <Paperclip aria-hidden="true" />
            </Button>
            <label className="sr-only" htmlFor="ea-chat-composer">
              Message Executive Assistant
            </label>
            <textarea
              ref={textareaRef}
              id="ea-chat-composer"
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onTextareaKeyDown}
              disabled={composerDisabled}
              placeholder="Ask the EA or give it work to route..."
              className="max-h-36 min-h-11 flex-1 resize-none rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-amber-950 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-zinc-950 dark:text-zinc-100"
            />
            <Button
              type="button"
              size="lg"
              onClick={() => submit()}
              disabled={composerDisabled || (draft.trim().length === 0 && files.length === 0)}
              aria-label="Send message"
              className="min-h-11"
            >
              <Send aria-hidden="true" />
              <span className="hidden sm:inline">Send</span>
            </Button>
          </div>
        </footer>
      </div>
    </aside>
  );
}

function StatusRow({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "error";
}) {
  return (
    <div
      className={cn(
        "mx-auto w-fit rounded-full px-3 py-1 text-center text-xs",
        tone === "error"
          ? "bg-destructive/10 text-destructive"
          : "bg-amber-100/70 text-amber-800 dark:bg-white/[0.05] dark:text-zinc-400",
      )}
    >
      {children}
    </div>
  );
}

function EmptyThread({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  const prompts = [
    "What needs my attention?",
    "Summarise active goals",
    "Start a new goal...",
  ];
  return (
    <div className="rounded-lg border border-dashed border-amber-200 bg-amber-50/40 p-4 text-center dark:border-white/[0.08] dark:bg-white/[0.03]">
      <h3 className="text-sm font-medium text-amber-950 dark:text-amber-100">
        No messages in this thread
      </h3>
      <p className="mt-1 text-sm text-amber-800/70 dark:text-zinc-400">
        Ask for status, give a directive, or start a goal.
      </p>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {prompts.map((prompt) => (
          <Button
            key={prompt}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onPrompt(prompt)}
          >
            {prompt}
          </Button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  expanded,
  onToggleExpanded,
}: {
  message: EaChatMessage | PendingMessage;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const isOwner = message.role === "owner";
  const content = message.content || (message.status === "streaming" ? "EA is thinking..." : "");
  const long = !isOwner && content.split(/\s+/).length > 1200;
  const visibleContent = long && !expanded ? content.split(/\n\n/).slice(0, 1).join("\n\n") : content;
  const createdAt = new Date(message.createdAt);
  const label = `${isOwner ? "Owner" : "Executive Assistant"} message, ${message.status}, ${createdAt.toLocaleString()}`;

  return (
    <article
      className={cn("flex", isOwner ? "justify-end" : "justify-start")}
      aria-label={label}
    >
      <div
        className={cn(
          "max-w-[92%] rounded-lg px-3 py-2 text-sm leading-relaxed shadow-sm",
          isOwner
            ? "bg-amber-500/16 text-amber-950 ring-1 ring-amber-300/60 dark:bg-amber-300/12 dark:text-amber-50 dark:ring-amber-400/20"
            : "bg-muted text-foreground ring-1 ring-foreground/10",
          message.status === "failed" && "bg-destructive/10 text-destructive ring-destructive/30",
        )}
      >
        <div className="mb-1 text-[0.7rem] font-medium uppercase tracking-normal text-muted-foreground">
          {isOwner ? "Owner" : "EA"}
          {message.status === "queued" && " · Sending"}
          {message.status === "streaming" && " · Thinking"}
          {message.status === "failed" && " · Runtime error"}
        </div>
        <div className="whitespace-pre-wrap break-words">{visibleContent}</div>
        {long && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="mt-2 h-auto p-0"
            onClick={onToggleExpanded}
          >
            {expanded ? "Show less" : "Show full response"}
          </Button>
        )}
      </div>
    </article>
  );
}
