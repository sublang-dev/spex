// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Settings surface (SET-1..10): a validated editor over the shared
// playbook config. Every save round-trips through the core, which
// refuses launcher-invalid states and preserves file comments.
// DR-019: agents are inline blocks. DR-032 forks the editors: the
// Captain and the session-player roster are identities and live here,
// while which player answers a role is a binding and lives with its
// playbook in the Library. The Captain and every player are rows of
// one shape — a chip, opened by one edit control into the shared
// editor with Save and Cancel, one row open at a time (settings-1,
// settings-26). The Agents panel shows per-adapter readiness. Every
// edit acknowledges in place — disabled while it is in flight, a
// transient "Saved ✓" on the row once it landed (DR-010 §3).

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  PROTOCOL_VERSION,
  type AgentBlockInput,
  type ConfigEditOpInput,
  type ReadinessEntry,
  type SessionPlayerSummary,
} from "@sublang/spex-core/protocol";

import { getClient, useAppStore } from "../state/store.js";
import { patchPlayer, setCaptain } from "../lib/config-ops.js";
import { NOTIFICATION_LABELS } from "../lib/labels.js";
import {
  PLAIN_SHORTCUTS,
  SHORTCUTS,
  keyLabel,
  modKey,
} from "../lib/shortcuts.js";
import { AgentChip } from "./AgentChip.js";
import { AgentEditor } from "./AgentEditor.js";
import { Icon } from "./Icon.js";
import { InlineConfirm } from "./InlineConfirm.js";
import { appVersion } from "../lib/version.js";

const NOTIFICATION_EVENTS = [
  "player_finished",
  "turn_finished",
  "turn_aborted",
] as const;
const SINKS = ["off", "bell", "desktop"] as const;

/** The one acknowledgment a landed edit gets (settings-6). */
const SAVED = "Saved ✓";

/** Transient text that clears itself — the saved tick — with the
 * timer dying alongside the component. */
function useTransient(
  ms: number,
): [string | undefined, (value: string) => void] {
  const [value, setValue] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const set = useCallback(
    (next: string) => {
      setValue(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setValue(undefined), ms);
    },
    [ms],
  );
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return [value, set];
}

function SavedTick({ testId }: { testId: string }) {
  return (
    <span
      role="status"
      data-testid={testId}
      className="text-xs text-emerald-700 dark:text-emerald-300"
    >
      {SAVED}
    </span>
  );
}

/** Which agent row's editor stands open — the Captain's or one
 * player's — and how a row hands focus back to its own edit control
 * when its editor closes (DR-010 §6): one editor at a time, so a
 * second row opening closes the first. */
interface RowEditing {
  editing?: string;
  open: (key: string) => void;
  close: (key: string) => void;
  toggleRef: (key: string) => (element: HTMLButtonElement | null) => void;
}

function useRowEditing(): RowEditing {
  const [editing, setEditing] = useState<string>();
  const toggles = useRef(new Map<string, HTMLButtonElement>());
  const open = useCallback(
    (key: string) =>
      setEditing((current) => (current === key ? undefined : key)),
    [],
  );
  const close = useCallback((key: string) => {
    setEditing((current) => (current === key ? undefined : current));
    // The editor's own controls leave with it; the edit control that
    // opened it is where the keyboard lands next.
    toggles.current.get(key)?.focus();
  }, []);
  const toggleRef = useCallback(
    (key: string) => (element: HTMLButtonElement | null) => {
      if (element) toggles.current.set(key, element);
      else toggles.current.delete(key);
    },
    [],
  );
  return { editing, open, close, toggleRef };
}

/** The pencil that opens a row's editor in place (DR-010 §7: a named
 * 24px target that says whether its editor stands open). */
function EditToggle({
  rows,
  rowKey,
  label,
  title,
  testId,
}: {
  rows: RowEditing;
  rowKey: string;
  label: string;
  title: string;
  testId: string;
}) {
  const open = rows.editing === rowKey;
  return (
    <button
      ref={rows.toggleRef(rowKey)}
      type="button"
      data-testid={testId}
      aria-label={label}
      aria-expanded={open}
      title={title}
      onClick={() => rows.open(rowKey)}
      className={`flex h-6 w-6 items-center justify-center rounded hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200 ${
        open ? "text-brand-600 dark:text-brand-300" : "text-neutral-500"
      }`}
    >
      <Icon name="edit" />
    </button>
  );
}

/** An open row editor: Escape cancels it the way Cancel does. */
function RowEditor({
  onCancel,
  children,
}: {
  onCancel: () => void;
  children: ReactNode;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onCancel();
  };
  return <div onKeyDown={onKeyDown}>{children}</div>;
}

function ReadinessBadge({ entry }: { entry?: ReadinessEntry }) {
  if (!entry) return null;
  if (entry.ready === true) {
    return (
      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
        ready
      </span>
    );
  }
  if (entry.ready === false) {
    return (
      <span
        className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300"
        title={entry.requirement}
      >
        not ready
      </span>
    );
  }
  return (
    <span
      className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800"
      title={
        entry.requirement ??
        "no automatic check for this adapter — verify sign-in yourself"
      }
    >
      unverified
    </span>
  );
}

/** "captain", or a player id trailing the roles it answers, as
 * `dev.coder (code.coder, fix.coder)` → chip copy (DR-010 §2). The
 * chip shows the lane; the whole string stays in its title. */
function positionLabel(position: string): string {
  if (position === "captain") return "Captain";
  const paren = position.indexOf(" (");
  return paren === -1 ? position : position.slice(0, paren);
}

function ThemeInput({
  value,
  disabled,
  onCommit,
}: {
  value: string;
  disabled?: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <input
      aria-label="Terminal pane theme"
      value={draft}
      placeholder="auto"
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
      className="w-48 rounded border border-neutral-300 bg-white px-2 py-1 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
    />
  );
}

/** The sheet's keys the platform way: glyphs on a Mac, words
 * elsewhere, so "Ctrl+Shift+S" never reads "Ctrl+⇧S". */
function sheetKeys(keys: string): string {
  return keyLabel(modKey() === "⌘" ? keys : keys.replace(/⇧/g, "Shift+"));
}

/** The starting block for a lane the user is adding: a deliberate,
 * visible choice rather than a blank the launcher would refuse. */
const NEW_PLAYER_BLOCK: AgentBlockInput = {
  adapter: "claude",
  model: "claude-opus-5",
  effort: "high",
  permissions: { mode: "auto" },
};

/** The session-player roster (DR-032): each lane is one identity and
 * one provider conversation, edited here whole. Removal is refused by
 * the core while a binding still names the lane, and that refusal is
 * what the user reads. */
function PlayerRoster({
  players,
  readiness,
  captain,
  rows,
}: {
  players: SessionPlayerSummary[];
  readiness: ReadinessEntry[];
  captain: AgentBlockInput;
  rows: RowEditing;
}) {
  const [adding, setAdding] = useState(false);
  const [newId, setNewId] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const [error, setError] = useState<{ playerId: string; message: string }>();
  // The editor closes on save, so the tick lives on the row.
  const [saved, setSaved] = useTransient(1500);
  const readinessByAdapter = new Map(
    readiness.map((entry) => [entry.adapter, entry]),
  );

  function remove(playerId: string): void {
    setError(undefined);
    void getClient()
      .command("config.edit", { op: { kind: "player.delete", playerId } })
      .then(() => setConfirmDelete(undefined))
      .catch((cause: Error) =>
        setError({ playerId, message: cause.message }),
      );
  }

  return (
    <section data-testid="players-section" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-neutral-500">
          Session players
        </h2>
        <span className="text-xs text-neutral-500">
          Each player is one conversation for the whole session; roles bind
          to them in the Library.
        </span>
      </div>
      {players.map((player) => (
        <div
          key={player.id}
          data-testid={`player-row-${player.id}`}
          className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono font-medium">{player.id}</span>
            <AgentChip
              agent={player.agent}
              readiness={readinessByAdapter.get(player.agent.adapter)}
              label={player.id}
            />
            {player.boundBy.length > 0 ? (
              <span
                data-testid={`player-bound-${player.id}`}
                title={`Answers ${player.boundBy.join(", ")}`}
                className="flex flex-wrap gap-1"
              >
                {player.boundBy.map((position) => (
                  <span
                    key={position}
                    className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                  >
                    {position}
                  </span>
                ))}
              </span>
            ) : (
              <span className="text-xs text-neutral-500">
                bound to no role yet
              </span>
            )}
            <span className="ml-auto flex items-center gap-1">
              {saved === player.id ? (
                <SavedTick testId={`player-saved-${player.id}`} />
              ) : null}
              <EditToggle
                rows={rows}
                rowKey={player.id}
                label={`Edit ${player.id}`}
                title="Edit this player's agent"
                testId={`player-edit-${player.id}`}
              />
              {confirmDelete === player.id ? (
                <InlineConfirm
                  question={`Remove ${player.id}?`}
                  confirmLabel="Remove"
                  cancelLabel="Keep"
                  onConfirm={() => remove(player.id)}
                  onCancel={() => setConfirmDelete(undefined)}
                />
              ) : (
                <button
                  type="button"
                  data-testid={`player-delete-${player.id}`}
                  aria-label={`Remove ${player.id}`}
                  title="Remove this player from the roster"
                  onClick={() => setConfirmDelete(player.id)}
                  className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-red-500 dark:hover:bg-neutral-800"
                >
                  <Icon name="close" />
                </button>
              )}
            </span>
          </div>
          {error?.playerId === player.id ? (
            <p
              data-testid={`player-error-${player.id}`}
              className="text-xs text-red-600 dark:text-red-400"
            >
              {error.message}
            </p>
          ) : null}
          {rows.editing === player.id ? (
            <RowEditor onCancel={() => rows.close(player.id)}>
              <AgentEditor
                key={JSON.stringify(player.agent)}
                initial={player.agent}
                readiness={readiness}
                captain={captain}
                onSave={(patch) =>
                  patchPlayer(player.id, patch).then((result) => {
                    rows.close(player.id);
                    setSaved(player.id);
                    return result;
                  })
                }
                onCancel={() => rows.close(player.id)}
              />
            </RowEditor>
          ) : null}
        </div>
      ))}
      {players.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 px-4 py-3 text-xs text-neutral-500 dark:border-neutral-700">
          No players yet — enabling a playbook in the Library adds the ones
          its roles need.
        </p>
      ) : null}
      {adding ? (
        <div
          data-testid="player-add-form"
          className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900"
        >
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-neutral-500 dark:text-neutral-400">
              Player id — lowercase, dots to group (e.g. dev.coder)
            </span>
            <input
              data-testid="player-add-id"
              value={newId}
              onChange={(event) => setNewId(event.target.value)}
              className="rounded border border-neutral-300 bg-white px-2 py-1 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          {error?.playerId === "" ? (
            <p
              data-testid="player-add-error"
              className="text-xs text-red-600 dark:text-red-400"
            >
              {error.message}
            </p>
          ) : null}
          <AgentEditor
            initial={NEW_PLAYER_BLOCK}
            readiness={readiness}
            captain={captain}
            saveLabel="Add player"
            allowUnchanged
            onSave={(patch) => {
              // Adding never overwrites: an id already in the roster
              // is turned back to its own editor (settings-27).
              const id = newId.trim();
              if (!id) {
                setError({ playerId: "", message: "Give the player an id first." });
                return Promise.reject(new Error("no id"));
              }
              if (players.some((player) => player.id === id)) {
                setError({
                  playerId: "",
                  message: `A player named ${id} already exists — edit it above instead.`,
                });
                return Promise.reject(new Error("duplicate id"));
              }
              return patchPlayer(id, patch).then(
                (result) => {
                  setAdding(false);
                  setNewId("");
                  setError(undefined);
                  setSaved(id);
                  return result;
                },
                (cause: Error) => {
                  setError({ playerId: "", message: cause.message });
                  throw cause;
                },
              );
            }}
            onCancel={() => {
              setAdding(false);
              setError(undefined);
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          data-testid="player-add"
          onClick={() => setAdding(true)}
          className="self-start rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          Add a player
        </button>
      )}
    </section>
  );
}

export function SettingsSurface() {
  const configState = useAppStore((state) => state.configState);
  const readiness = useAppStore((state) => state.readiness);
  const refreshReadiness = useAppStore((state) => state.refreshReadiness);
  const refresh = useAppStore((state) => state.refresh);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // Which preference edit is in flight, and which one just landed.
  const [pending, setPending] = useState<string>();
  const [saved, setSaved] = useTransient(1500);
  // The one open agent-row editor, the Captain's or a player's.
  const rows = useRowEditing();

  if (!configState) {
    return (
      <div className="m-auto text-sm text-neutral-500">loading config…</div>
    );
  }
  if (configState.status !== "valid") {
    const missing = configState.status === "missing";
    return (
      <div className="relative mx-auto min-h-0 w-full max-w-2xl flex-1 overflow-y-auto p-6">
        <div
          data-testid="config-broken"
          className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          <div className="font-semibold">
            {missing ? "No config file" : "Config file invalid"}
          </div>
          {missing ? (
            <p className="mt-1 text-xs">
              Spex could not create a starter config at{" "}
              <span className="font-mono">{configState.path}</span> — check
              the folder is writable, then retry.
            </p>
          ) : null}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {missing ? null : (
              <span className="font-mono text-xs">{configState.path}</span>
            )}
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(configState.path);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="rounded border border-red-300 px-1.5 py-0.5 text-xs hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-900"
            >
              {copied ? "Copied" : "Copy path"}
            </button>
            {missing ? (
              <button
                type="button"
                data-testid="config-retry"
                disabled={retrying}
                onClick={() => {
                  setRetrying(true);
                  setError(undefined);
                  refresh()
                    .catch((cause: Error) => setError(cause.message))
                    .finally(() => setRetrying(false));
                }}
                className="rounded border border-red-300 px-1.5 py-0.5 text-xs font-medium hover:bg-red-100 disabled:opacity-50 dark:border-red-800 dark:hover:bg-red-900"
              >
                {retrying ? "Retrying…" : "Retry"}
              </button>
            ) : null}
          </div>
          {configState.status === "invalid" ? (
            <>
              <ul className="mt-2 list-disc pl-5">
                {configState.errors.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
              <div className="mt-2 text-xs">
                Fix the file in your editor; Spex reloads it live.
              </div>
            </>
          ) : null}
          {error ? <p className="mt-2 text-xs">{error}</p> : null}
        </div>
      </div>
    );
  }

  const summary = configState.summary;
  const readinessByAdapter = new Map(
    readiness.map((entry) => [entry.adapter, entry]),
  );

  /** A preference edit: disabled in flight, ticked once landed. */
  function edit(op: ConfigEditOpInput, key: string) {
    setError(undefined);
    setPending(key);
    getClient()
      .command("config.edit", { op })
      .then(() => setSaved(key))
      .catch((cause: Error) => setError(cause.message))
      .finally(() =>
        setPending((current) => (current === key ? undefined : current)),
      );
  }

  return (
    // The surface root is the box Settings scrolls in (DR-041 §9):
    // height-constrained, and the containing block for its own
    // positioned content — the shortcut table's screen-reader caption
    // included — so the page itself never scrolls.
    <div className="relative mx-auto flex w-full min-h-0 max-w-3xl flex-1 flex-col gap-5 overflow-y-auto p-6">
      <div>
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="mt-0.5 text-xs text-neutral-500">
          Shared with the playbook CLI:{" "}
          <span className="font-mono break-all">{summary.path}</span> — external
          edits appear here live.
        </p>
        {configState.seeded ? (
          <p
            data-testid="config-seeded"
            className="mt-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
          >
            Created a starter config at{" "}
            <span className="font-mono">{summary.path}</span>
          </p>
        ) : null}
        <p className="mt-0.5 text-xs text-neutral-500">
          Spex {appVersion()}
          {" · protocol "}
          {PROTOCOL_VERSION}
        </p>
      </div>
      {error ? (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <section data-testid="captain-section" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-neutral-500">Captain</h2>
        {/* The Captain is a row of the players' shape (settings-1): its
            chip, opened by the pencil into the shared editor, which
            closes on Save or Cancel — no removal, since a session has
            exactly one Captain. */}
        <div
          data-testid="captain-row"
          className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono font-medium">captain</span>
            <AgentChip
              agent={summary.captain}
              readiness={readinessByAdapter.get(summary.captain.adapter)}
              label="Captain"
            />
            <span className="text-xs text-neutral-500">
              Reads your messages and picks the playbook to run.
            </span>
            <span className="ml-auto flex items-center gap-1">
              {saved === "captain" ? <SavedTick testId="captain-saved" /> : null}
              <EditToggle
                rows={rows}
                rowKey="captain"
                label="Edit the Captain"
                title="Edit the Captain's agent"
                testId="captain-edit"
              />
            </span>
          </div>
          {rows.editing === "captain" ? (
            <RowEditor onCancel={() => rows.close("captain")}>
              <AgentEditor
                key={JSON.stringify(summary.captain)}
                initial={summary.captain}
                readiness={readiness}
                onSave={(patch) =>
                  setCaptain(patch).then((result) => {
                    rows.close("captain");
                    setSaved("captain");
                    return result;
                  })
                }
                onCancel={() => rows.close("captain")}
              />
            </RowEditor>
          ) : null}
        </div>
      </section>

      <PlayerRoster
        players={summary.players}
        readiness={readiness}
        captain={summary.captain}
        rows={rows}
      />

      <section data-testid="agents-section" className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-neutral-500">Agents</h2>
          <button
            type="button"
            title="Re-run adapter readiness checks (e.g. after signing in)"
            onClick={() => void refreshReadiness()}
            className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            Re-check readiness
          </button>
        </div>
        {readiness.map((entry) => (
          <div
            key={entry.adapter}
            data-testid={`agent-row-${entry.adapter}`}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900"
          >
            <span className="font-mono font-medium">{entry.adapter}</span>
            <ReadinessBadge entry={entry} />
            {entry.ready === false && entry.requirement ? (
              <span className="min-w-0 flex-1 text-xs text-neutral-500">
                {entry.requirement}
              </span>
            ) : null}
            <span className="ml-auto flex flex-wrap gap-1">
              {entry.usedBy.map((position) => (
                <span
                  key={position}
                  title={position}
                  className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                >
                  {positionLabel(position)}
                </span>
              ))}
            </span>
          </div>
        ))}
        {readiness.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-300 px-4 py-3 text-xs text-neutral-500 dark:border-neutral-700">
            No adapters in use yet — assign agents to the Captain or a
            playbook role and their readiness shows here.
          </div>
        ) : null}
      </section>

      <section
        data-testid="notifications-section"
        className="flex flex-col gap-2"
      >
        <h2 className="text-sm font-semibold text-neutral-500">
          Notifications
        </h2>
        <p className="text-xs text-neutral-500">
          Where each moment reaches you: nowhere, a terminal bell, or a
          desktop notification.
        </p>
        <div className="flex flex-col gap-1.5">
          {NOTIFICATION_EVENTS.map((event) => {
            const key = `notifications:${event}`;
            return (
              <div
                key={event}
                // The select wraps under its label in a narrow pane
                // (settings-22, DR-041).
                className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
              >
                <span className="min-w-0 shrink basis-56 text-xs" title={event}>
                  {NOTIFICATION_LABELS[event] ?? event}
                </span>
                <select
                  aria-label={`${NOTIFICATION_LABELS[event] ?? event} — where to notify`}
                  value={summary.notifications?.[event] ?? "off"}
                  disabled={pending === key}
                  onChange={(changeEvent) =>
                    edit(
                      {
                        kind: "notifications.set",
                        prefs: {
                          ...(summary.notifications ?? {}),
                          [event]: changeEvent.target.value,
                        },
                      },
                      key,
                    )
                  }
                  className="rounded border border-neutral-300 bg-white px-2 py-1 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {SINKS.map((sink) => (
                    <option key={sink}>{sink}</option>
                  ))}
                </select>
                {saved === key ? (
                  <SavedTick testId={`notification-saved-${event}`} />
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <section data-testid="shortcuts-section" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-neutral-500">
          Keyboard shortcuts
        </h2>
        <p className="text-xs text-neutral-500">
          The same in the desktop app and a browser; {modKey()} is this
          machine's modifier.
        </p>
        <div className="relative overflow-x-auto rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Keyboard shortcuts</caption>
            <thead>
              <tr className="text-xs text-neutral-500">
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Keys
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Does
                </th>
              </tr>
            </thead>
            <tbody>
              {SHORTCUTS.map((shortcut) => (
                <tr
                  key={shortcut.keys}
                  className="border-t border-neutral-100 dark:border-neutral-800"
                >
                  <td className="whitespace-nowrap px-3 py-1.5">
                    <kbd className="rounded border border-neutral-300 bg-neutral-50 px-1.5 py-0.5 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-950">
                      {sheetKeys(shortcut.keys)}
                    </kbd>
                  </td>
                  <td className="px-3 py-1.5">{shortcut.does}</td>
                </tr>
              ))}
              {PLAIN_SHORTCUTS.map((shortcut) => (
                <tr
                  key={shortcut.keys}
                  className="border-t border-neutral-100 dark:border-neutral-800"
                >
                  <td className="whitespace-nowrap px-3 py-1.5">
                    <kbd className="rounded border border-neutral-300 bg-neutral-50 px-1.5 py-0.5 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-950">
                      {shortcut.keys}
                    </kbd>
                  </td>
                  <td className="px-3 py-1.5">{shortcut.does}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section data-testid="theme-section" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-neutral-500">
          Terminal pane theme (CLI only)
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <ThemeInput
            value={summary.theme ?? ""}
            disabled={pending === "theme"}
            onCommit={(value) =>
              edit({ kind: "theme.set", theme: value || null }, "theme")
            }
          />
          {saved === "theme" ? <SavedTick testId="theme-saved" /> : null}
          <span className="text-xs text-neutral-500">
            Only sessions run from the playbook CLI use it — the tmux pane
            theme (e.g. a catppuccin flavor, or auto); Spex itself follows
            your OS theme.
          </span>
        </div>
      </section>
    </div>
  );
}
