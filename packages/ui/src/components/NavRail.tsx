// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The sidebar (DR-029, DR-030): the navigator. Surface entries around
// a Workspace section listing every project and its sessions, so what
// exists is always on screen while the tabs hold only what is open.
// Two widgets, not one — a navigation list for the surfaces and one
// ARIA tree for the projects — because "current surface" and
// "selected session" are different words (run-view-67).

import { useMemo, useRef, useState, type ReactNode } from "react";
import type { ProjectInfo, SessionInfo } from "@sublang/spex-core/protocol";

import type { AttentionItem } from "../state/dashboard.js";
import { keyLabel } from "../lib/shortcuts.js";
import { absoluteTitle, compactAge, relativeAge } from "../lib/time.js";
import { Icon, type IconName } from "./Icon.js";
import { InlineConfirm } from "./InlineConfirm.js";
import logo from "../assets/spex-logo.svg";

/** Sessions listed per project before the reveal-the-rest control
 * (run-view-67); the ended window only — a live session always shows. */
const RECENT_WINDOW = 5;

export type Surface = "Dashboard" | "Workspace" | "Playbooks" | "Settings";

export const SURFACES: readonly Surface[] = [
  "Dashboard",
  "Workspace",
  "Playbooks",
  "Settings",
];

// The interaction hue's tinted fill is a hue shift, not a luminance
// one — measured at 1.01:1 against the rail in dark. So "active" is
// carried by a brand-500 edge (>=3:1 in both themes) alongside the
// fill and the weight, and survives greyscale (DR-026 §3, DR-010 §8).
const ACTIVE =
  "border-l-2 border-brand-500 bg-brand-50 font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300";
const INACTIVE =
  "border-l-2 border-transparent text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800";

const SURFACE_ICONS: Record<Surface, IconName> = {
  Dashboard: "grid",
  Workspace: "folder",
  Playbooks: "book",
  Settings: "gear",
};

export interface NavRailProps {
  surface: Surface;
  onSurface(surface: Surface): void;
  /** Cross-project attention count; rides the Dashboard entry. */
  attentionCount: number;
  collapsed: boolean;
  onCollapsed(collapsed: boolean): void;
  projects: ProjectInfo[];
  sessions: SessionInfo[];
  /** Non-idle attention by session id, the same derivation the badge
   * and the tab dots use (run-view-73). */
  attention: Map<string, AttentionItem>;
  currentProjectId?: string;
  /** The session whose tab is showing, if any. */
  activeSessionId?: string;
  /** Explicit disclosure; a project with no entry follows current. */
  expanded: Record<string, boolean>;
  onExpanded(projectId: string, expanded: boolean): void;
  onPickProject(projectId: string): void;
  onActivateSession(sessionId: string): void;
  onNewSession(projectId: string): void;
  /** Delete an ended session this core owns (DR-038); rejects with
   * the core's reason, which the row shows. */
  onDeleteSession(sessionId: string): Promise<void>;
  onOpenPalette(): void;
  /** A just-ended session's row, revealed and briefly lit up. */
  revealSessionId?: string;
  /** Config status / playbook count, the foot's other tenant. */
  foot?: ReactNode;
}

type Life = "question" | "failure" | "running" | "ended-failed" | "ended" | "external-active" | "external-unknown";

/** Attention first, life second (run-view-73): the row says "answer
 * me" before it says "I am alive". */
function lifeOf(session: SessionInfo, item: AttentionItem | undefined): Life {
  if (session.externalWriter) return session.externalWriter === "active" ? "external-active" : "external-unknown";
  if (item?.kind === "question") return "question";
  if (item?.kind === "failure") return "failure";
  if (session.live) return "running";
  return session.failed ? "ended-failed" : "ended";
}

const LIFE_WORDS: Record<Life, string> = {
  question: "waiting for your reply",
  failure: "failed",
  running: "running",
  "ended-failed": "ended, held a failure",
  ended: "ended",
  "external-active": "in use elsewhere",
  "external-unknown": "ownership unknown",
};

// A live failure summons (filled red); a failure a session ended
// holding is history (hollow), and counts toward no badge.
const LIFE_MARKS: Record<Life, string> = {
  question: "bg-amber-500",
  failure: "bg-red-500",
  running: "bg-emerald-500",
  "ended-failed": "border-2 border-red-500",
  ended: "border-2 border-neutral-500",
  "external-active": "bg-emerald-500",
  "external-unknown": "border-2 border-neutral-500",
};

function sessionLabel(
  session: SessionInfo,
  life: Life,
  now: number,
  item: AttentionItem | undefined,
): string {
  const title = session.title ?? "no messages yet";
  const when = session.endedAt ?? session.createdAt;
  const turns = `${session.turns} turn${session.turns === 1 ? "" : "s"}`;
  const detail = item?.text ? ` — ${item.text}` : "";
  return `${title} — ${LIFE_WORDS[life]}, ${relativeAge(when, now)}, ${turns}${detail}`;
}

interface Row {
  key: string;
  kind: "project" | "session" | "action";
  projectId: string;
  sessionId?: string;
  activate(): void;
}

export function NavRail(props: NavRailProps) {
  const {
    surface,
    onSurface,
    attentionCount,
    collapsed,
    onCollapsed,
    projects,
    sessions,
    attention,
    currentProjectId,
    activeSessionId,
    expanded,
    onExpanded,
    revealSessionId,
  } = props;
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [focusKey, setFocusKey] = useState<string>();
  // Deletion is destructive and irreversible, so it keeps one inline
  // confirmation at the row (DR-038, DR-010 §4).
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const treeRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", at: 0 });
  // One clock per render keeps every row's age consistent.
  const now = Date.now();

  const isExpanded = (projectId: string): boolean =>
    expanded[projectId] ?? projectId === currentProjectId;

  const byProject = useMemo(() => {
    const map = new Map<string, { live: SessionInfo[]; ended: SessionInfo[] }>();
    for (const project of projects) map.set(project.id, { live: [], ended: [] });
    for (const session of sessions) {
      const bucket = map.get(session.projectId);
      if (!bucket) continue;
      if (session.live || session.externalWriter) bucket.live.push(session);
      else bucket.ended.push(session);
    }
    for (const bucket of map.values()) {
      bucket.live.sort((a, b) => b.createdAt - a.createdAt);
      bucket.ended.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    }
    return map;
  }, [projects, sessions]);

  const projectAttention = useMemo(() => {
    const map = new Map<string, "question" | "failure">();
    for (const session of sessions) {
      const item = attention.get(session.id);
      if (!item || item.kind === "idle") continue;
      const worst = map.get(session.projectId);
      if (item.kind === "failure" || !worst) {
        map.set(session.projectId, item.kind === "failure" ? "failure" : "question");
      }
    }
    return map;
  }, [sessions, attention]);

  // The rows the tree can reach right now, in visual order — the one
  // list arrow keys, Home/End and type-ahead all walk.
  const rows: Row[] = [];
  for (const project of projects) {
    rows.push({
      key: `p:${project.id}`,
      kind: "project",
      projectId: project.id,
      activate: () => props.onPickProject(project.id),
    });
    if (!isExpanded(project.id)) continue;
    const bucket = byProject.get(project.id) ?? { live: [], ended: [] };
    const ended = showAll[project.id]
      ? bucket.ended
      : bucket.ended.slice(0, RECENT_WINDOW);
    for (const session of [...bucket.live, ...ended]) {
      rows.push({
        key: `s:${session.id}`,
        kind: "session",
        projectId: project.id,
        sessionId: session.id,
        activate: () => props.onActivateSession(session.id),
      });
    }
    if (!showAll[project.id] && bucket.ended.length > RECENT_WINDOW) {
      rows.push({
        key: `m:${project.id}`,
        kind: "action",
        projectId: project.id,
        activate: () =>
          setShowAll((current) => ({ ...current, [project.id]: true })),
      });
    }
    rows.push({
      key: `n:${project.id}`,
      kind: "action",
      projectId: project.id,
      activate: () => props.onNewSession(project.id),
    });
  }

  const focused = rows.some((row) => row.key === focusKey)
    ? focusKey
    : rows[0]?.key;

  function moveFocus(key: string): void {
    setFocusKey(key);
    // Row keys carry ids, not CSS identifiers: find by value rather
    // than build a selector out of one.
    const rowElements = treeRef.current?.querySelectorAll<HTMLElement>("[data-row]");
    for (const element of rowElements ?? []) {
      if (element.dataset.row === key) {
        element.focus();
        return;
      }
    }
  }

  function onTreeKeyDown(event: React.KeyboardEvent): void {
    // The focused row comes from the event, not from state: a burst of
    // keys must not all navigate from the same stale place.
    const from =
      (event.target as HTMLElement | null)?.dataset?.row ?? focused;
    const index = rows.findIndex((row) => row.key === from);
    if (index < 0) return;
    const row = rows[index];
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveFocus(rows[Math.min(index + 1, rows.length - 1)].key);
        return;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(rows[Math.max(index - 1, 0)].key);
        return;
      case "Home":
        event.preventDefault();
        moveFocus(rows[0].key);
        return;
      case "End":
        event.preventDefault();
        moveFocus(rows[rows.length - 1].key);
        return;
      case "ArrowRight":
        if (row.kind === "project") {
          event.preventDefault();
          if (!isExpanded(row.projectId)) onExpanded(row.projectId, true);
          else if (rows[index + 1]) moveFocus(rows[index + 1].key);
        }
        return;
      case "ArrowLeft":
        event.preventDefault();
        if (row.kind === "project" && isExpanded(row.projectId)) {
          onExpanded(row.projectId, false);
        } else {
          moveFocus(`p:${row.projectId}`);
        }
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        row.activate();
        return;
      default:
        break;
    }
    // APG type-ahead: reaching a session by its own first words is
    // the whole point of titling the rows.
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey) return;
    const at = Date.now();
    const text =
      (at - typeahead.current.at < 800 ? typeahead.current.text : "") +
      event.key.toLowerCase();
    typeahead.current = { text, at };
    const labelOf = (candidate: Row): string => {
      if (candidate.kind === "project") {
        return projects.find((p) => p.id === candidate.projectId)?.name ?? "";
      }
      if (candidate.sessionId) {
        return sessions.find((s) => s.id === candidate.sessionId)?.title ?? "";
      }
      return "";
    };
    const order = [...rows.slice(index + 1), ...rows.slice(0, index + 1)];
    const hit = order.find((candidate) =>
      labelOf(candidate).toLowerCase().startsWith(text),
    );
    if (hit) {
      event.preventDefault();
      moveFocus(hit.key);
    }
  }

  function deleteSession(sessionId: string): void {
    setConfirmDelete(undefined);
    setDeleting((current) => ({ ...current, [sessionId]: true }));
    setDeleteErrors(({ [sessionId]: _, ...rest }) => rest);
    void props
      .onDeleteSession(sessionId)
      .catch((cause: Error) =>
        setDeleteErrors((current) => ({
          ...current,
          [sessionId]: cause.message || "delete failed",
        })),
      )
      .finally(() =>
        setDeleting(({ [sessionId]: _, ...rest }) => rest),
      );
  }

  /** The row's own controls: a click or key inside them never
   * activates or navigates the row. */
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();

  const surfaceEntry = (name: Surface) => {
    const active = surface === name;
    const badge = name === "Dashboard" && attentionCount > 0;
    return (
      <button
        key={name}
        type="button"
        onClick={() => onSurface(name)}
        aria-current={active ? "page" : undefined}
        title={collapsed ? name : undefined}
        aria-label={
          badge
            ? `${name} — ${attentionCount} need${attentionCount === 1 ? "s" : ""} your attention`
            : name
        }
        className={`relative flex items-center gap-2 rounded-md py-1.5 pr-2.5 pl-2 text-left text-sm ${
          collapsed ? "justify-center" : ""
        } ${active ? ACTIVE : INACTIVE}`}
      >
        <Icon name={SURFACE_ICONS[name]} className="h-4 w-4 shrink-0" />
        {collapsed ? null : <span className="min-w-0 flex-1">{name}</span>}
        {badge ? (
          <span
            data-testid="nav-attention-badge"
            aria-hidden
            title={`${attentionCount} session${attentionCount === 1 ? "" : "s"} need${attentionCount === 1 ? "s" : ""} your reply`}
            className={`rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-900 dark:bg-amber-900 dark:text-amber-200 ${
              // Positioned at the entry's corner, beside the glyph,
              // never over it (run-view-108).
              collapsed
                ? "absolute -top-1 right-0 px-1 py-0 text-xs leading-4"
                : ""
            }`}
          >
            {/* The count prints "9+" past nine; the exact count rides
                the entry's accessible name and tooltip (run-view-108). */}
            {attentionCount > 9 ? "9+" : attentionCount}
          </span>
        ) : null}
      </button>
    );
  };

  // Selection says where the reader is, so it follows the surface
  // (run-view-67): off the Workspace the surface's own entry is the
  // only current place, and the remembered project lights again when
  // the Workspace comes back.
  const inWorkspace = surface === "Workspace";
  const selectedProjectId = inWorkspace ? currentProjectId : undefined;
  const shownSessionId = inWorkspace ? activeSessionId : undefined;

  /** One selection voice: the active row wears the interaction hue,
   * the treatment the surface entries already use (run-view-73). */
  function rowClass(active: boolean): string {
    return `flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-1.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
      active ? ACTIVE : INACTIVE
    }`;
  }

  // The palette control keeps its icon-only form across the fold
  // (DR-030): collapse never hides the way to add or switch a project.
  const paletteControl = (
    <button
      type="button"
      data-testid="sidebar-palette"
      onClick={props.onOpenPalette}
      title={`Switch or add a project (${keyLabel("P")})`}
      aria-label="Switch or add a project"
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200 ${
        collapsed ? "self-center" : "-my-0.5"
      }`}
    >
      <Icon name="plus" className="h-3.5 w-3.5" />
    </button>
  );

  const tree = (
    <div
      ref={treeRef}
      role="tree"
      aria-label="Projects and sessions"
      aria-multiselectable={false}
      onKeyDown={onTreeKeyDown}
      className="relative flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      {projects.length === 0 ? (
        <button
          type="button"
          data-testid="sidebar-add-project"
          onClick={props.onOpenPalette}
          className="rounded-md border border-brand-300 px-2 py-1 text-left text-[13px] text-brand-600 hover:bg-brand-50 dark:border-brand-800 dark:text-brand-300 dark:hover:bg-brand-950"
        >
          Add a project…
        </button>
      ) : null}
      {projects.map((project) => {
        const open = isExpanded(project.id);
        const bucket = byProject.get(project.id) ?? { live: [], ended: [] };
        const worst = projectAttention.get(project.id);
        const listed = showAll[project.id]
          ? bucket.ended
          : bucket.ended.slice(0, RECENT_WINDOW);
        const hidden = bucket.ended.length - listed.length;
        return (
          <div key={project.id} className="flex flex-col">
            <div
              role="treeitem"
              aria-expanded={open}
              aria-selected={project.id === selectedProjectId}
              data-row={`p:${project.id}`}
              data-testid={`sidebar-project-${project.id}`}
              tabIndex={focused === `p:${project.id}` ? 0 : -1}
              onFocus={() => setFocusKey(`p:${project.id}`)}
              onClick={() => props.onPickProject(project.id)}
              title={`${project.path}${worst ? ` — needs you` : ""}`}
              aria-label={`${project.name}${worst ? `, ${worst === "failure" ? "a session failed" : "a session is waiting for your reply"}` : ""}`}
              className={`${rowClass(
                project.id === selectedProjectId && !shownSessionId,
              )} pl-0.5`}
            >
              <button
                type="button"
                tabIndex={-1}
                data-testid={`sidebar-disclose-${project.id}`}
                aria-label={`${open ? "Hide" : "Show"} sessions in ${project.name}`}
                onClick={(event) => {
                  // Disclosure is its own axis (DR-027): opening a
                  // project never moves the workspace into it.
                  event.stopPropagation();
                  onExpanded(project.id, !open);
                }}
                // A 24px target inside a shorter row: the negative
                // margins keep the row's height (DR-010 §7).
                className="-my-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
              >
                <Icon
                  name={open ? "caretDown" : "caretRight"}
                  className="h-3.5 w-3.5"
                />
              </button>
              <Icon name="folder" className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {worst ? (
                <span
                  data-testid={`sidebar-project-attention-${project.id}`}
                  aria-hidden
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    worst === "failure" ? "bg-red-500" : "bg-amber-500"
                  }`}
                />
              ) : null}
            </div>
            {open ? (
              <div role="group" className="flex flex-col">
                {[...bucket.live, ...listed].map((session) => {
                  const item = attention.get(session.id);
                  const life = lifeOf(session, item);
                  const active = session.id === shownSessionId;
                  // External ownership must be known idle before deletion.
                  const deletable = !session.live && !session.externalWriter;
                  const confirming = deletable && confirmDelete === session.id;
                  return (
                    <div
                      key={session.id}
                      role="treeitem"
                      aria-selected={active}
                      data-row={`s:${session.id}`}
                      data-testid={`sidebar-session-${session.id}`}
                      tabIndex={focused === `s:${session.id}` ? 0 : -1}
                      onFocus={() => setFocusKey(`s:${session.id}`)}
                      onClick={() => props.onActivateSession(session.id)}
                      aria-label={sessionLabel(session, life, now, item)}
                      title={sessionLabel(session, life, now, item)}
                      className={`${rowClass(active)} group pl-6 ${
                        revealSessionId === session.id
                          ? "animate-pulse ring-2 ring-brand-300 dark:ring-brand-700"
                          : ""
                      }`}
                    >
                      <span
                        aria-hidden
                        data-testid={`sidebar-mark-${session.id}`}
                        data-life={life}
                        className={`h-2 w-2 shrink-0 rounded-full ${LIFE_MARKS[life]}`}
                      />
                      {confirming ? (
                        <span
                          data-testid={`sidebar-delete-confirm-${session.id}`}
                          onClick={stop}
                          onKeyDown={stop}
                          className="min-w-0 flex-1"
                        >
                          <InlineConfirm
                            question={
                              session.foreign
                                ? "Delete this session? It was run from the terminal; its history goes too."
                                : "Delete this session and its transcript?"
                            }
                            confirmLabel="Delete"
                            cancelLabel="Keep"
                            onConfirm={() => deleteSession(session.id)}
                            onCancel={() => setConfirmDelete(undefined)}
                          />
                        </span>
                      ) : (
                        <>
                          <span
                            className={`min-w-0 flex-1 truncate ${
                              session.title
                                ? ""
                                : "italic text-neutral-500 dark:text-neutral-400"
                            }`}
                          >
                            {session.title ?? "no messages yet"}
                          </span>
                          {deleteErrors[session.id] ? (
                            <span
                              data-testid={`sidebar-delete-error-${session.id}`}
                              title={deleteErrors[session.id]}
                              className="shrink-0 truncate text-xs text-red-600 dark:text-red-400"
                            >
                              not deleted
                            </span>
                          ) : (
                            // The one time vocabulary (run-view-73): a
                            // compact age with the exact moment on hover.
                            <span
                              data-testid={`sidebar-age-${session.id}`}
                              title={absoluteTitle(
                                session.endedAt ?? session.createdAt,
                              )}
                              className="shrink-0 text-xs tabular-nums text-neutral-500 dark:text-neutral-400"
                            >
                              {deleting[session.id]
                                ? "deleting…"
                                : compactAge(
                                    session.endedAt ?? session.createdAt,
                                    now,
                                  )}
                            </span>
                          )}
                          {deletable ? (
                            // Revealed on hover or focus, reachable by
                            // Tab regardless (DR-010 §6).
                            <button
                              type="button"
                              data-testid={`sidebar-delete-${session.id}`}
                              aria-label={`Delete session ${session.title ?? "no messages yet"}`}
                              title="Delete this session and its transcript"
                              disabled={deleting[session.id]}
                              onClick={(event) => {
                                event.stopPropagation();
                                setConfirmDelete(session.id);
                              }}
                              onKeyDown={stop}
                              className="-my-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 opacity-0 hover:text-red-600 focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 disabled:opacity-40 dark:hover:text-red-400"
                            >
                              <Icon name="trash" className="h-3.5 w-3.5" />
                            </button>
                          ) : null}
                        </>
                      )}
                    </div>
                  );
                })}
                {hidden > 0 ? (
                  <div
                    role="treeitem"
                    aria-selected={false}
                    data-row={`m:${project.id}`}
                    data-testid={`sidebar-more-${project.id}`}
                    tabIndex={focused === `m:${project.id}` ? 0 : -1}
                    onFocus={() => setFocusKey(`m:${project.id}`)}
                    onClick={() =>
                      setShowAll((current) => ({
                        ...current,
                        [project.id]: true,
                      }))
                    }
                    aria-label={`Show all ${bucket.ended.length} sessions in ${project.name}`}
                    className={`${rowClass(false)} pl-6 text-xs text-brand-600 dark:text-brand-300`}
                  >
                    all {bucket.ended.length}…
                  </div>
                ) : null}
                <div
                  role="treeitem"
                  aria-selected={false}
                  data-row={`n:${project.id}`}
                  data-testid={`sidebar-new-${project.id}`}
                  tabIndex={focused === `n:${project.id}` ? 0 : -1}
                  onFocus={() => setFocusKey(`n:${project.id}`)}
                  onClick={() => props.onNewSession(project.id)}
                  aria-label={`New session in ${project.name}`}
                  className={`${rowClass(false)} pl-6 text-neutral-500`}
                >
                  <Icon name="plus" className="h-3 w-3 shrink-0" />
                  New session
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );

  return (
    <nav
      data-testid="sidebar"
      data-collapsed={collapsed ? "1" : "0"}
      aria-label="Spex navigation"
      className={`flex flex-col gap-1 border-r border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900 ${
        collapsed ? "w-14 items-stretch" : "w-56"
      }`}
    >
      <div
        className={`mb-1 flex items-center gap-2 px-1 ${collapsed ? "justify-center" : ""}`}
      >
        <img src={logo} alt="" className="h-6 w-6" />
        {collapsed ? null : (
          <span className="text-base font-bold tracking-tight">Spex</span>
        )}
      </div>

      {surfaceEntry("Dashboard")}

      {collapsed ? (
        <>
          {surfaceEntry("Workspace")}
          {paletteControl}
          {/* Entries keep their places across the fold: Playbooks and
              Settings stay at the foot in both states. */}
          <div className="flex-1" />
        </>
      ) : (
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1 px-1 pb-0.5 pt-2">
            <button
              type="button"
              data-testid="sidebar-workspace"
              onClick={() => onSurface("Workspace")}
              aria-current={surface === "Workspace" ? "page" : undefined}
              className={`min-w-0 flex-1 rounded px-1 py-0.5 text-left text-xs font-semibold uppercase tracking-wide ${
                surface === "Workspace"
                  ? "text-brand-700 dark:text-brand-300"
                  : "text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-300"
              }`}
            >
              Workspace
            </button>
            {paletteControl}
          </div>
          {tree}
        </section>
      )}

      {surfaceEntry("Playbooks")}
      {surfaceEntry("Settings")}

      <div
        className={`mt-auto flex items-center gap-1 pt-2 ${
          collapsed ? "flex-col" : ""
        }`}
      >
        {props.foot}
        <button
          type="button"
          data-testid="sidebar-collapse"
          onClick={() => onCollapsed(!collapsed)}
          title={`${collapsed ? "Show" : "Collapse"} the sidebar (${keyLabel("B")})`}
          aria-label={collapsed ? "Show the sidebar" : "Collapse the sidebar"}
          aria-expanded={!collapsed}
          className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <Icon name="sidebar" className="h-4 w-4" />
        </button>
      </div>
    </nav>
  );
}
