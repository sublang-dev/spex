// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The role-binding editor (DR-032): which session player answers a
// role, plus that role's own model and effort. Adapter, permissions
// and workspace belong to the player's envelope and have no control
// here, because in the released model a binding cannot carry them.

import { useState, type RefObject } from "react";
import type {
  RoleBindingSummary,
  AgentModelOption,
  SessionPlayerSummary,
} from "@sublang/spex-core/protocol";

import { useAgentOptions, modelTuning } from "../lib/agent-options.js";
import { ModelField } from "./ModelField.js";
import { ModelDiscoveryStatus } from "./ModelDiscoveryStatus.js";
import { useFitInBox } from "../lib/popover-fit.js";
import { usePopover } from "../lib/usePopover.js";

export interface BindingChange {
  playerId: string;
  model?: string | false | null;
  effort?: string | false | null;
  fastMode?: boolean | null;
}

/** A tuning field is tri-state: inherit the player's default, take the
 * provider's current default, or pin a value (DR-032). */
function TuningField({
  label,
  value,
  playerDefault,
  onChange,
  models,
  efforts,
}: {
  label: "model" | "effort";
  models?: readonly AgentModelOption[];
  efforts?: readonly string[];
  value: string | false | undefined;
  playerDefault: string | undefined;
  onChange(next: string | false | null): void;
}) {
  const mode = value === undefined ? "inherit" : value === false ? "provider" : "pin";
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-neutral-500 dark:text-neutral-400">{label}</span>
      <select
        data-testid={`binding-${label}-mode`}
        value={mode}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "inherit") onChange(null);
          else if (next === "provider") onChange(false);
          else onChange(playerDefault ?? "");
        }}
        className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
      >
        <option value="inherit">
          inherit the player{playerDefault ? ` (${playerDefault})` : ""}
        </option>
        <option value="provider">the provider's default</option>
        <option value="pin">pin a value…</option>
      </select>
      {mode === "pin" && (label === "model" ? (
        <ModelField value={typeof value === "string" ? value : ""} models={models ?? []}
          onChange={(next) => onChange(next || false)} testId="binding-model-value" />
      ) : (
        <select data-testid="binding-effort-value" value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
          <option value="">Choose effort…</option>
          {typeof value === "string" && value && !efforts?.includes(value) && <option value={value}>{value} (current)</option>}
          {(efforts ?? []).map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select>
      ))}
    </label>
  );
}

export function BindingEditorPopover({
  role,
  position,
  binding,
  players,
  anchorRef,
  onSave,
  onClose,
}: {
  role: string;
  /** This binding's own position, `<playbook>.<role>`, so the lane's
   * other holders can be named without counting this one. */
  position: string;
  binding: RoleBindingSummary;
  players: SessionPlayerSummary[];
  anchorRef: RefObject<HTMLButtonElement | null>;
  onSave(next: BindingChange): Promise<unknown>;
  onClose(): void;
}) {
  const [draft, setDraft] = useState<BindingChange>({
    playerId: binding.playerId,
    model: binding.model,
    effort: binding.effort,
    fastMode: binding.fastMode,
  });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // The house popover idiom (DR-010 §6): focus enters on open and
  // returns to the role's control on close; Escape and an outside
  // click close.
  const boxRef = usePopover<HTMLDivElement>(true, { anchorRef, onClose });
  // And it lies inside the box that must show it, however narrow the
  // pane or far along the roles row its control sits
  // (playbook-library-43, DR-041 §9).
  useFitInBox(boxRef);
  const lane = players.find((player) => player.id === draft.playerId);
  const discovery = useAgentOptions(lane?.agent.adapter ?? "claude");
  const effectiveModel = draft.model === false ? "" : draft.model ?? lane?.agent.model ?? "";
  const tuning = modelTuning(discovery.options, effectiveModel);
  const models = discovery.options?.discovery.status === "available" ? discovery.options.discovery.models : [];
  const effectiveEffort = draft.effort === false ? undefined : draft.effort ?? lane?.agent.effort;
  const invalidEffort = draft.effort === "" || Boolean(discovery.options && effectiveEffort && !tuning.efforts.includes(effectiveEffort));
  const effectiveFastMode = draft.fastMode ?? lane?.agent.fastMode ?? false;
  const adapterFastMode = discovery.options?.fastModeSupported;
  const invalidFastMode = (adapterFastMode === false && draft.fastMode != null) || (effectiveFastMode && tuning.fastModeSupported === false);
  const invalidModel = typeof draft.model === "string" && !draft.model.trim();
  // Every other position this lane already answers: picking it here
  // joins that one conversation rather than opening a new one.
  const others = (lane?.boundBy ?? []).filter((held) => held !== position);

  return (
    <div
      ref={boxRef}
      data-testid={`binding-editor-${role}`}
      role="dialog"
      aria-label={`Bind ${role}`}
      className="absolute left-0 top-7 z-20 flex w-72 max-w-[calc(100vw-1rem)] flex-col gap-2 overflow-y-auto rounded-lg border border-neutral-300 bg-white p-3 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
    >
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-neutral-500 dark:text-neutral-400">
          {role} runs as
        </span>
        <select
          data-testid="binding-player"
          value={draft.playerId}
          onChange={(event) =>
            setDraft((current) => ({ ...current, playerId: event.target.value }))
          }
          className="rounded border border-neutral-300 bg-white px-2 py-1 font-mono dark:border-neutral-700 dark:bg-neutral-900"
        >
          {players.map((player) => (
            <option key={player.id} value={player.id}>
              {player.id} · {player.display}
            </option>
          ))}
        </select>
        {others.length > 0 ? (
          <span
            data-testid="binding-shared-note"
            className="text-xs text-brand-700 dark:text-brand-300"
          >
            Also answers {others.join(", ")} — one conversation across them.
          </span>
        ) : null}
      </label>

      <TuningField
        label="model"
        value={draft.model === null ? undefined : draft.model}
        playerDefault={lane?.agent.model}
        models={models}
        onChange={(next) => setDraft((current) => ({ ...current, model: next }))}
      />
      <TuningField
        label="effort"
        value={draft.effort === null ? undefined : draft.effort}
        playerDefault={lane?.agent.effort}
        efforts={tuning.efforts}
        onChange={(next) => setDraft((current) => ({ ...current, effort: next }))}
      />

      {(adapterFastMode === true || draft.fastMode != null || effectiveFastMode) && <label className="flex flex-col gap-1 text-xs">
        <span className="text-neutral-500 dark:text-neutral-400">Fast mode</span>
        <select data-testid="binding-fast-mode" value={draft.fastMode == null ? "inherit" : draft.fastMode ? "on" : "off"}
          onChange={(event) => setDraft((current) => ({ ...current, fastMode: event.target.value === "inherit" ? null : event.target.value === "on" }))}
          className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
          <option value="inherit">Inherit the player ({lane?.agent.fastMode ? "on" : "off"})</option>
          {adapterFastMode === true && (tuning.fastModeSupported !== false || draft.fastMode === true) && <option value="on">On{tuning.fastModeSupported === false ? " (unsupported)" : ""}</option>}
          {adapterFastMode === true && <option value="off">Off</option>}
          {adapterFastMode !== true && draft.fastMode != null && <option value={draft.fastMode ? "on" : "off"}>{draft.fastMode ? "On" : "Off"} ({adapterFastMode === false ? "unsupported" : "current"})</option>}
        </select>
        {!tuning.fastModeKnown && <span className="text-neutral-500">Adapter option; model support unverified.</span>}
      </label>}
      <ModelDiscoveryStatus state={discovery} />
      {!tuning.effortKnown && <p className="text-xs text-neutral-500">Effort options apply to the adapter; support for this model is unverified.</p>}
      {invalidFastMode && <p role="alert" className="text-xs text-red-600">{adapterFastMode === false ? "Clear the fast-mode override; this adapter does not accept it." : "Turn off fast mode for this model."}</p>}
      {invalidEffort && <p role="alert" className="text-xs text-red-600">Choose a listed effort, inherit, or use the provider default.</p>}
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Adapter and permissions belong to the player — edit them in
        Settings.
      </p>

      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="min-h-6 rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="binding-save"
          disabled={busy || invalidEffort || invalidModel || invalidFastMode}
          onClick={() => {
            setBusy(true);
            setError(undefined);
            void Promise.resolve(onSave(draft))
              .catch((cause: Error) => setError(cause.message))
              .finally(() => setBusy(false));
          }}
          className="min-h-6 rounded bg-brand-600 px-2 py-1 text-xs font-medium text-white hover:bg-brand-500 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
