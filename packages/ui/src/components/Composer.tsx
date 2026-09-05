// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The single Boss composer (RUN-3/6/7/8): free text and /commands,
// queueing while a turn is active, awaitBossReply banner, abort.
// Failed submissions keep the draft and surface the error here.
// Drafts live in the store so tab/surface switches never eat text.
//
// One composer shape across the app (run-view-106, DR-041 §9): the
// field on top growing with its text, one caption line under it that
// hints and acknowledgments share, and an action row beneath that
// wraps — secondary left, primary last and right. The Captain home
// builds its composer from the same parts.
//
// The queue is the one part that grows without bound, so it lives in
// its own scrolling frame a few entries tall and the composer yields
// around it: the field, its caption, and its actions keep their place
// whatever the Boss has queued (run-view-8).

import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import type { PlaybookSummary } from "@sublang/spex-core/protocol";

import { useAutoGrow } from "../lib/useAutoGrow.js";
import type { ComposerState, StagedIntent } from "../state/store.js";
import type { SessionView } from "../state/reducer.js";
import { SlashMenuList, slashMatches } from "./SlashMenu.js";
import { Icon } from "./Icon.js";

/** The caption every composer carries when nothing else needs the
 * line (run-view-106). */
export const COMPOSER_HINT = "/ for playbooks · Enter sends";

/** The primary control's key hint (run-view-8). */
export const SEND_KEYS = "Enter to send · Shift+Enter for a new line";

/** A placeholder is at most 24 characters (run-view-106); a player
 * whose id would push past that is not named. */
export function replyPlaceholder(player?: string): string {
  const named = player ? `Reply to ${player}…` : undefined;
  return named && named.length <= 24 ? named : "Answer the question…";
}

const PRIMARY_CLASS =
  "rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-500 disabled:opacity-40";
const SECONDARY_CLASS =
  "rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800";

/** The box is the control (DR-010 §8): focus reads as its own border
 * rather than a ring around it. */
export function ComposerBox({
  field,
  caption,
  secondary,
  actions,
}: {
  field: ReactNode;
  caption: ReactNode;
  /** The one secondary action, at the row's left. */
  secondary?: ReactNode;
  /** The right-hand group: Abort while a turn runs, then the primary. */
  actions: ReactNode;
}) {
  return (
    <div
      data-testid="composer-box"
      className="flex flex-col gap-1 rounded-xl border border-neutral-300 bg-white p-2 focus-within:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:focus-within:border-neutral-400"
    >
      {field}
      {caption}
      <div className="flex flex-wrap items-center gap-1.5">
        {secondary}
        <span className="ml-auto flex items-center gap-1.5">{actions}</span>
      </div>
    </div>
  );
}

/** The field: full width on top, one row when empty, growing with
 * its text to a maximum and scrolling past it, no native grip. */
export function ComposerField({
  fieldRef,
  value,
  className,
  ...rest
}: Omit<ComponentProps<"textarea">, "ref" | "value" | "rows"> & {
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
}) {
  useAutoGrow(fieldRef, value);
  return (
    <textarea
      ref={fieldRef}
      value={value}
      rows={1}
      className={`w-full resize-none border-0 bg-transparent px-1 py-1 text-sm outline-none [field-sizing:content] max-h-[max(40vh,1.75rem)] disabled:opacity-60 ${
        className ?? ""
      }`}
      {...rest}
    />
  );
}

/** One caption line: the staged intent chip, else a transient
 * acknowledgment, else the hint (run-view-85, run-view-86). */
export function ComposerCaption({
  staged,
  onDetachStaged,
  note,
}: {
  staged?: StagedIntent;
  onDetachStaged?: () => void;
  note?: string;
}) {
  return (
    <div
      data-testid="composer-caption"
      className="flex min-h-6 items-center px-1 text-xs text-neutral-500 dark:text-neutral-400"
    >
      {staged ? (
        <span
          data-testid="staged-intent-chip"
          className="flex min-w-0 max-w-full items-center gap-1 rounded-full border border-brand-300 bg-brand-50 pl-2.5 font-medium text-brand-700 dark:border-brand-700 dark:bg-brand-950 dark:text-brand-300"
        >
          <span className="min-w-0 truncate" title={staged.title}>
            Starting: {staged.title}
          </span>
          <button
            type="button"
            title="Take the task out of the message"
            aria-label="Take the task out of the message"
            onClick={onDetachStaged}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full hover:bg-brand-100 dark:hover:bg-brand-900"
          >
            <Icon name="close" className="h-3 w-3" />
          </button>
        </span>
      ) : note ? (
        <span
          data-testid="queued-intent-note"
          role="status"
          className="min-w-0 truncate"
          title={note}
        >
          {note}
        </span>
      ) : (
        <span className="min-w-0 truncate">{COMPOSER_HINT}</span>
      )}
    </div>
  );
}

export function Composer({
  view,
  composer,
  connected,
  blockedReason,
  error,
  playbooks = [],
  staged,
  onCompileNew,
  onDraftChange,
  onSubmit,
  onAbort,
  onRemoveQueued,
  onDismissError,
  onDetachStaged,
  onQueueInstead,
}: {
  view: SessionView;
  composer: ComposerState;
  connected: boolean;
  blockedReason?: string;
  error?: string;
  playbooks?: PlaybookSummary[];
  /** The intent staged into this composer, worn as a chip (DR-035). */
  staged?: StagedIntent;
  onCompileNew?: () => void;
  /** Persist the draft in the store (DR-010: drafts survive). */
  onDraftChange?: (draft: string) => void;
  onSubmit: (text: string) => Promise<void>;
  onAbort: () => void;
  onRemoveQueued: (index: number) => void;
  onDismissError: () => void;
  /** Detach the staged chip without sending (DR-035). */
  onDetachStaged?: () => void;
  /** Queue instead of send (DR-035): the typed text becomes a queued
   * intent for this project; nothing is sent. */
  onQueueInstead?: (text: string) => Promise<void>;
}) {
  const [localText, setLocalText] = useState("");
  const text = onDraftChange ? (composer.draft ?? "") : localText;
  const setText = onDraftChange ?? setLocalText;
  const [sending, setSending] = useState(false);
  const [aborting, setAborting] = useState(false);
  /** Transient queue-instead-of-send acknowledgment (run-view-85). */
  const [queuedNote, setQueuedNote] = useState<string>();
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  const slashItems = slashMatches(text, playbooks);
  const slash = slashDismissed ? undefined : slashItems;

  function insertCommand(command: string) {
    setText(`/${command} `);
    setSlashIndex(0);
    setSlashDismissed(false);
    textareaRef.current?.focus();
  }

  const awaiting = view.pendingQuestion !== undefined;

  // Keep the composer ready to type: focus on mount and the moment a
  // player question arrives.
  useEffect(() => {
    textareaRef.current?.focus();
  }, [awaiting]);

  // The newest queued message is the one the Boss just wrote, so the
  // frame stays at its end as the queue grows (run-view-8).
  useEffect(() => {
    const el = queueRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [composer.queued.length]);

  // "Aborting…" clears itself when the abort lands (turn ends) or
  // the attempt failed and the error strip explains why.
  useEffect(() => {
    if (!view.turnActive) setAborting(false);
  }, [view.turnActive]);
  useEffect(() => {
    if (error) setAborting(false);
  }, [error]);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || sending || !connected || blockedReason) return;
    setSending(true);
    onSubmit(trimmed)
      .then(() => setText(""))
      .catch(() => {
        // Draft is kept; the error strip explains what happened.
      })
      .finally(() => {
        setSending(false);
        textareaRef.current?.focus();
      });
  }

  const placeholder = !connected
    ? "Connecting…"
    : awaiting
      ? replyPlaceholder(view.pendingQuestionPlayer)
      : view.turnActive
        ? "Sends after this turn…"
        : "Message the Captain…";

  return (
    // The composer yields inside its column (DR-041 §9): what it holds
    // scrolls in its own frame rather than pushing the transcript away
    // and the action row out of the window.
    <div className="flex min-h-0 flex-col gap-1.5">
      {error ? (
        <div
          data-testid="run-error"
          role="status"
          className="flex shrink-0 items-start gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            onClick={onDismissError}
            className="flex h-6 w-6 items-center justify-center rounded text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-900"
            title="Dismiss"
            aria-label="Dismiss error"
          >
            <Icon name="close" className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
      {awaiting ? (
        <div
          data-testid="boss-reply-banner"
          className="shrink-0 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
        >
          {view.pendingQuestionPlayer ? (
            <>
              <span className="font-mono font-semibold">
                {view.pendingQuestionPlayer}
              </span>{" "}
              is waiting for your reply — your next message answers it.
            </>
          ) : (
            <>Waiting for your reply — your next message answers it.</>
          )}
        </div>
      ) : null}
      {composer.queued.length > 0 ? (
        // A few entries tall, its own positioned scroll box, its end
        // in view: the queue never grows the composer past its share
        // of the column (run-view-8, DR-041 §9).
        <div
          ref={queueRef}
          data-testid="queue-indicator"
          className="relative flex max-h-40 min-h-0 flex-col items-end gap-1 overflow-y-auto"
        >
          {composer.queued.map((entry, index) => (
            <div
              key={index}
              className="flex max-w-[85%] shrink-0 flex-col rounded-2xl rounded-br-md border border-brand-300 px-3 py-1.5 text-sm text-brand-700 dark:border-brand-700 dark:text-brand-300"
            >
              {/* An unbroken token breaks anywhere rather than
                  widening the frame (run-view-3). */}
              <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                {entry.text}
              </span>
              <span className="mt-0.5 flex items-center gap-1 text-xs text-neutral-500">
                {entry.intentId !== undefined ? (
                  <span
                    data-testid="queued-intent-chip"
                    className="rounded-full border border-brand-300 px-1.5 font-medium text-brand-600 dark:border-brand-700 dark:text-brand-300"
                  >
                    intent
                  </span>
                ) : null}
                sends when this turn ends
                <button
                  type="button"
                  title="Remove this message"
                  aria-label="Remove this queued message"
                  onClick={() => onRemoveQueued(index)}
                  className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-red-500 dark:hover:bg-neutral-800"
                >
                  <Icon name="close" className="h-3 w-3" />
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="relative shrink-0">
        {slash ? (
          <SlashMenuList
            items={slash}
            activeIndex={Math.min(slashIndex, slash.length - 1)}
            onPick={(playbook) => insertCommand(playbook.command)}
            onCompileNew={onCompileNew}
          />
        ) : null}
        <ComposerBox
          field={
            <ComposerField
              fieldRef={textareaRef}
              data-testid="boss-composer"
              autoFocus
              value={text}
              aria-controls={slash ? "slash-listbox" : undefined}
              aria-activedescendant={
                slash
                  ? `slash-option-${Math.min(slashIndex, slash.length - 1)}`
                  : undefined
              }
              onChange={(event) => {
                setText(event.target.value);
                setSlashIndex(0);
                setSlashDismissed(false);
                setQueuedNote(undefined);
                // Emptying the composer detaches the staged intent
                // (DR-035): sending something else stamps nothing.
                if (staged && event.target.value.trim().length === 0) {
                  onDetachStaged?.();
                }
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229)
                  return;
                if (slash) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setSlashIndex((index) => (index + 1) % slash.length);
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setSlashIndex(
                      (index) => (index - 1 + slash.length) % slash.length,
                    );
                    return;
                  }
                  if (event.key === "Tab" || event.key === "Enter") {
                    event.preventDefault();
                    insertCommand(
                      slash[Math.min(slashIndex, slash.length - 1)].command,
                    );
                    return;
                  }
                  if (event.key === "Escape") {
                    // Hide the menu, never the draft (DR-010 §4).
                    event.preventDefault();
                    setSlashDismissed(true);
                    return;
                  }
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={placeholder}
              disabled={!connected}
            />
          }
          caption={
            <ComposerCaption
              staged={staged}
              onDetachStaged={onDetachStaged}
              note={queuedNote}
            />
          }
          secondary={
            onQueueInstead && !staged ? (
              <button
                type="button"
                data-testid="queue-intent-button"
                title="Add this to the project's Up next without sending it"
                onClick={() => {
                  const trimmed = text.trim();
                  if (!trimmed || sending) return;
                  setSending(true);
                  onQueueInstead(trimmed)
                    .then(() => {
                      setText("");
                      setQueuedNote(
                        "Added to Up next — see the project's Overview.",
                      );
                    })
                    .catch(() => {
                      // Draft kept; the error strip explains.
                    })
                    .finally(() => {
                      setSending(false);
                      textareaRef.current?.focus();
                    });
                }}
                disabled={text.trim().length === 0 || sending || !connected || !!blockedReason}
                className={SECONDARY_CLASS}
              >
                Add to Up next
              </button>
            ) : null
          }
          actions={
            <>
              {view.turnActive ? (
                <button
                  type="button"
                  data-testid="abort-button"
                  onClick={() => {
                    setAborting(true);
                    onAbort();
                    // The control leaves with the turn it stops; focus
                    // stays in the conversation, never on <body>
                    // (run-view-50).
                    textareaRef.current?.focus();
                  }}
                  disabled={aborting || !connected}
                  title={!connected ? "Not connected" : undefined}
                  className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
                >
                  {aborting ? "Aborting…" : "Abort"}
                </button>
              ) : null}
              <button
                type="button"
                data-testid="send-button"
                onClick={submit}
                className={PRIMARY_CLASS}
                disabled={text.trim().length === 0 || sending || !connected || !!blockedReason}
                title={
                  !connected
                    ? "Not connected"
                    : view.turnActive
                      ? `Sends when this turn ends · ${SEND_KEYS}`
                      : SEND_KEYS
                }
              >
                {view.turnActive ? "Send next" : "Send"}
              </button>
            </>
          }
        />
      </div>
    </div>
  );
}
