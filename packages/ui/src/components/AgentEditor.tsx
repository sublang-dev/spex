// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The one shared agent editor (DR-019): adapter (with readiness
// dots), model, adapter-scoped effort, a fast-mode switch where the
// runtime declares it (DR-038), permission mode and writable paths.
// It edits a local draft and emits a merge patch on save;
// AgentEditorPopover wraps it for the at-hand flows (DR-007/009).

import { useEffect, useRef, useState, type RefObject } from "react";
import {
  adapterNameSchema,
  type AdapterName,
  type AgentBlockInput,
  type ReadinessEntry,
} from "@sublang/spex-core/protocol";

import { useAgentOptions, modelTuning } from "../lib/agent-options.js";
import { ModelField } from "./ModelField.js";
import { ModelDiscoveryStatus } from "./ModelDiscoveryStatus.js";
import type { AgentPatch } from "../lib/config-ops.js";
import { useFitInBox } from "../lib/popover-fit.js";
import { FAST_MODE_MARK, type ChipAgent } from "./AgentChip.js";

export const ADAPTERS = adapterNameSchema.options;

const MODES = ["auto", "bypass", "none"] as const;
type Mode = (typeof MODES)[number];

/** What each permission mode means, in the reader's words
 * (settings-10): the select alone says nothing about the stakes. */
export const MODE_HELP: Record<Mode, string> = {
  auto: "auto: the agent works on its own inside the repo, with the adapter's own protections on",
  bypass: "bypass: no permission prompts — sandboxed repos only",
  none: "none: the adapter's own default posture",
};

function knownAdapter(adapter: string | undefined): AdapterName {
  return (ADAPTERS as readonly string[]).includes(adapter ?? "")
    ? (adapter as AdapterName)
    : "claude";
}

function initialMode(agent: ChipAgent | undefined): Mode {
  const mode = agent?.permissions?.mode;
  return mode === "auto" || mode === "bypass" ? mode : "none";
}

type CarriedPermissions = Pick<
  NonNullable<AgentBlockInput["permissions"]>,
  "fileWrite" | "shellExecute" | "networkAccess"
>;

function carriedFrom(agent: AgentBlockInput | undefined): CarriedPermissions {
  const permissions = agent?.permissions;
  const carried: CarriedPermissions = {};
  if (permissions?.fileWrite) carried.fileWrite = permissions.fileWrite;
  if (permissions?.shellExecute)
    carried.shellExecute = permissions.shellExecute;
  if (permissions?.networkAccess)
    carried.networkAccess = permissions.networkAccess;
  return carried;
}

export interface AgentEditorProps {
  /** The block the draft seeds from; a fresh assignment passes its
   * default block. */
  initial?: ChipAgent;
  /** Adapter-keyed readiness entries; dots render when passed, and
   * the fast-mode switch shows for adapters declaring it (DR-038). */
  readiness?: ReadinessEntry[];
  /** When set, offers "Same as Captain": copies the Captain's
   * adapter, model, effort, fast mode, and permissions into the draft. */
  captain?: ChipAgent;
  saveLabel?: string;
  /** Creation forms save an untouched draft: the seeded block is
   * already a deliberate choice, so there is nothing to dirty. */
  allowUnchanged?: boolean;
  onSave: (patch: AgentPatch) => Promise<unknown> | void;
  onCancel?: () => void;
}

export function AgentEditor(props: AgentEditorProps) {
  const { initial } = props;
  const [adapter, setAdapter] = useState<AdapterName>(
    knownAdapter(initial?.adapter),
  );
  const [model, setModel] = useState(initial?.model ?? "");
  const [effort, setEffort] = useState(initial?.effort ?? "");
  const [fastMode, setFastMode] = useState(initial?.fastMode ?? false);
  const [mode, setMode] = useState<Mode>(initialMode(initial));
  const [writablePaths, setWritablePaths] = useState(
    (initial?.permissions?.writablePaths ?? []).join(", "),
  );
  // Unsurfaced permission policies ride along invisibly: the merge
  // replaces the permissions object wholesale, so dropping them from
  // the emitted patch would erase hand-written values.
  const [carried, setCarried] = useState<CarriedPermissions>(() =>
    carriedFrom(initial),
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const readinessByAdapter = new Map(
    (props.readiness ?? []).map((entry) => [entry.adapter, entry]),
  );

  const discovery = useAgentOptions(adapter);
  const tuning = modelTuning(discovery.options, model);
  const models = discovery.options?.discovery.status === "available" ? discovery.options.discovery.models : [];
  const supportsFastMode = tuning.fastModeSupported ?? readinessByAdapter.get(adapter)?.fastModeSupported ?? false;
  const invalidEffort = Boolean(discovery.options && effort && !tuning.efforts.includes(effort));
  const invalidFastMode = Boolean(fastMode && discovery.options && !supportsFastMode);

  function pickAdapter(next: AdapterName): void {
    if (next === adapter) return;
    setAdapter(next);
    setModel("");
    setEffort("");
    setFastMode(false);
  }

  const dirty =
    adapter !== knownAdapter(initial?.adapter) ||
    model !== (initial?.model ?? "") ||
    effort !== (initial?.effort ?? "") ||
    fastMode !== (initial?.fastMode ?? false) ||
    mode !== initialMode(initial) ||
    writablePaths !== (initial?.permissions?.writablePaths ?? []).join(", ");

  function save(): void {
    // The emitted patch is the surfaced set only (DR-019): adapter,
    // model, effort, permissions. `instruction` — and any other
    // hand-written top-level key — is NEVER included; the core
    // applies merge semantics, so absent keys survive as written.
    // Permissions DO replace wholesale on merge, so the unsurfaced
    // policies (fileWrite, shellExecute, networkAccess) are carried
    // over from the source block. Clearing model or effort emits an
    // explicit null, which unsets the key so the agent falls back to
    // its adapter's default — blanking must mean what it shows.
    const patch: AgentPatch = { adapter };
    const trimmedModel = model.trim();
    if (trimmedModel) patch.model = trimmedModel;
    else if (initial?.model) patch.model = null;
    if (effort) patch.effort = effort;
    else if (initial?.effort) patch.effort = null;
    // Fast mode is off by default, so the switch writes true or unsets
    // the key (DR-038) — the same shape effort takes.
    if (fastMode) patch.fastMode = true;
    else if (initial?.fastMode) patch.fastMode = null;
    const permissions: NonNullable<AgentPatch["permissions"]> = {
      ...carried,
    };
    if (mode !== "none") permissions.mode = mode;
    const paths = writablePaths
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (paths.length > 0) permissions.writablePaths = paths;
    if (Object.keys(permissions).length > 0 || initial?.permissions) {
      patch.permissions = permissions;
    }
    setBusy(true);
    setError(undefined);
    Promise.resolve(props.onSave(patch))
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(false));
  }

  return (
    <div
      data-testid="agent-editor"
      className="flex flex-col gap-2 rounded-lg border border-brand-200 bg-brand-50/40 p-3 dark:border-brand-900 dark:bg-brand-950/30"
    >
      <div className="flex flex-col gap-0.5 text-sm">
        <span className="text-xs text-neutral-500">Adapter</span>
        <div role="radiogroup" aria-label="Adapter" className="flex flex-wrap gap-1">
          {ADAPTERS.map((name) => {
            const entry = readinessByAdapter.get(name);
            return (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={adapter === name}
                data-testid={`agent-adapter-${name}`}
                onClick={() => pickAdapter(name)}
                className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                  adapter === name
                    ? "border-brand-400 bg-brand-100 font-medium text-brand-700 dark:border-brand-700 dark:bg-brand-950 dark:text-brand-300"
                    : "border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                }`}
              >
                {name}
                {entry ? (
                  entry.ready === true ? (
                    <span aria-hidden className="text-emerald-500" title="ready">
                      ●
                    </span>
                  ) : entry.ready === false ? (
                    <span
                      aria-hidden
                      className="text-red-500"
                      title={entry.requirement ?? "not ready"}
                    >
                      ●
                    </span>
                  ) : (
                    <span
                      aria-hidden
                      className="text-neutral-500"
                      title={
                        entry.requirement ??
                        "no automatic check for this adapter — verify sign-in yourself"
                      }
                    >
                      ●
                    </span>
                  )
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-neutral-500">Model (optional)</span>
          <ModelField value={model} models={models} onChange={setModel} testId="agent-model" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-neutral-500">Reasoning effort</span>
          <select
            data-testid="agent-effort"
            value={effort}
            onChange={(event) => setEffort(event.target.value)}
            className="w-full min-w-0 rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="">(default)</option>
            {effort && !tuning.efforts.includes(effort) && <option value={effort}>{effort}{discovery.options ? " (unsupported)" : " (current)"}</option>}
            {tuning.efforts.map((name) => (
              <option key={name} value={name}>
                {name}{tuning.additionalEfforts.includes(name) ? " (adapter-wide)" : ""}
              </option>
            ))}
          </select>
        </label>
        {(supportsFastMode || fastMode) ? (
          <label className="col-span-2 flex items-center gap-2">
            <input
              type="checkbox"
              data-testid="agent-fast-mode"
              checked={fastMode}
              onChange={(event) => setFastMode(event.target.checked)}
              className="accent-brand-600"
            />
            <span>
              Fast mode <span aria-hidden>{FAST_MODE_MARK}</span>{invalidFastMode ? " (unsupported)" : ""}
            </span>
            <span className="text-xs text-neutral-500">
              {tuning.fastModeKnown ? (supportsFastMode ? "Supported by this model" : "Not supported by this model") : "Adapter option; model support unverified"}
            </span>
          </label>
        ) : null}
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-neutral-500">Permission mode</span>
          <select
            data-testid="agent-mode"
            value={mode}
            onChange={(event) => setMode(event.target.value as Mode)}
            className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="auto">auto (protected)</option>
            <option value="bypass">bypass</option>
            <option value="none">none (adapter default)</option>
          </select>
          <span
            data-testid="agent-mode-help"
            className="text-xs text-neutral-500"
          >
            {MODE_HELP[mode]}
          </span>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-neutral-500">
            Writable paths (comma-separated)
          </span>
          <input
            data-testid="agent-paths"
            value={writablePaths}
            onChange={(event) => setWritablePaths(event.target.value)}
            placeholder="e.g. .git, docs/generated"
            className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <span className="text-xs text-neutral-500">
            Repo-relative paths the agent may write under auto mode beyond
            its usual set — e.g. <span className="font-mono">.git</span> for
            commits
          </span>
        </label>
      </div>
      <ModelDiscoveryStatus state={discovery} />
      {!tuning.effortKnown && <p className="text-xs text-neutral-500">Effort options apply to the adapter; support for this model is unverified.</p>}
      {invalidEffort && <p role="alert" className="text-xs text-red-600">Choose a listed effort or the provider default.</p>}
      {invalidFastMode && <p role="alert" className="text-xs text-red-600">Turn off fast mode for this selection.</p>}
      {error ? (
        <div className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="agent-save"
          disabled={busy || invalidEffort || invalidFastMode || (!dirty && !props.allowUnchanged)}
          onClick={save}
          className="rounded-md bg-brand-600 px-3 py-1 text-sm font-medium text-white hover:bg-brand-500 disabled:opacity-40"
        >
          {busy ? "Saving…" : (props.saveLabel ?? "Save")}
        </button>
        {props.onCancel ? (
          <button
            type="button"
            data-testid="agent-cancel"
            onClick={props.onCancel}
            className="rounded-md px-3 py-1 text-sm text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            Cancel
          </button>
        ) : null}
        {props.captain ? (
          <button
            type="button"
            data-testid="agent-same-as-captain"
            title="Copies the Captain's adapter, model, effort, fast mode, and permissions"
            onClick={() => {
              const captain = props.captain!;
              const nextAdapter = knownAdapter(captain.adapter);
              setAdapter(nextAdapter);
              setModel(captain.model ?? "");
              setEffort(captain.effort ?? "");
              setFastMode(Boolean(captain.fastMode));
              setMode(initialMode(captain));
              setWritablePaths(
                (captain.permissions?.writablePaths ?? []).join(", "),
              );
              setCarried(carriedFrom(captain));
            }}
            className="ml-auto rounded-md border border-neutral-300 px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Same as Captain
          </button>
        ) : null}
      </div>
    </div>
  );
}

export interface AgentEditorPopoverProps extends AgentEditorProps {
  title: string;
  /** Open downward instead of upward (for anchors near a scroll top). */
  direction?: "up" | "down";
  /** The trigger element; clicks inside it are not outside-closes. */
  anchorRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}

/** The at-hand agent editor (DR-007/009): an anchored popover
 * carrying the full editor, so tuning an agent never forces a
 * surface switch. Focus discipline per DR-010 §6: focus moves into
 * the dialog on mount and returns to the opener on unmount; Escape
 * and outside clicks close. It lies inside the box that must show it
 * at every width, however small the anchor it hangs from
 * (settings-33). */
export function AgentEditorPopover({
  title,
  direction,
  anchorRef,
  onClose,
  ...editorProps
}: AgentEditorPopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  useFitInBox(rootRef);

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const target = rootRef.current?.querySelector<HTMLElement>(
      "button, input, select",
    );
    target?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={title}
      data-testid="agent-popover"
      // The width is a wish, not a demand: the box that must show it
      // bounds both axes, and the editor scrolls its own content
      // rather than leaving the box (settings-33, DR-041 §9).
      className={`absolute right-0 z-20 w-96 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-neutral-200 bg-white p-2 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900 ${
        direction === "down" ? "top-full mt-1" : "bottom-full mb-1"
      }`}
    >
      <div className="px-1 pb-1 text-xs font-semibold text-neutral-500">
        {title}
      </div>
      <AgentEditor {...editorProps} onCancel={onClose} />
    </div>
  );
}
