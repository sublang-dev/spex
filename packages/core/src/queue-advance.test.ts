// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Queue advancement executes the real core lifecycle and protocol; only
// provider replies and the Captain's root-run outcome are scripted.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { CoreService } from "./service.js";
import { fakeAdapterImports } from "./testing/fake-adapter.js";
import { createScriptedCaptain, type CaptainTurnScript } from "./testing/scripted-captain.js";
import type { Command, CommandResults, LedgerState, ServerMessage } from "./protocol.js";

const VALID_CONFIG = `
captain:
  adapter: claude
  model: claude-test
players:
  dev_coder:
    adapter: claude
    model: claude-test
playbooks:
  code:
    from: "@sublang/playbook/code/registry"
    roles:
      coder: dev_coder
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Client {
  private readonly socket: WebSocket;
  readonly messages: ServerMessage[] = [];
  private nextId = 0;

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/?token=test`);
    this.socket.on("message", (data) => {
      this.messages.push(JSON.parse(String(data)) as ServerMessage);
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (this.socket.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
    await this.waitFor((m) => m.type === "hello");
  }

  close(): void {
    this.socket.close();
  }

  async command<T extends Command["type"]>(
    type: T,
    fields: Omit<Extract<Command, { type: T }>, "type" | "id">,
  ): Promise<
    | { ok: true; result: CommandResults[T] }
    | { ok: false; error: { code: string; message: string } }
  > {
    const id = `c${(this.nextId += 1)}`;
    this.socket.send(JSON.stringify({ type, id, ...fields }));
    const reply = await this.waitFor(
      (m) => m.type === "reply" && m.id === id,
    );
    if (reply.type !== "reply") throw new Error("unreachable");
    return reply.ok
      ? { ok: true, result: reply.result as CommandResults[T] }
      : { ok: false, error: reply.error };
  }

  async expectOk<T extends Command["type"]>(
    type: T,
    fields: Omit<Extract<Command, { type: T }>, "type" | "id">,
  ): Promise<CommandResults[T]> {
    const reply = await this.command(type, fields);
    if (!reply.ok) {
      throw new Error(`${type} failed: ${reply.error.code} ${reply.error.message}`);
    }
    return reply.result;
  }

  /** The count-th message satisfying the check, appearing or already seen. */
  async waitFor(
    check: (message: ServerMessage) => boolean,
    count = 1,
    timeoutMs = 10000,
  ): Promise<ServerMessage> {
    const start = Date.now();
    for (;;) {
      const found = this.messages.filter(check);
      if (found.length >= count) return found[count - 1];
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `timeout waiting; got ${JSON.stringify(this.messages.map((m) => m.type))}`,
        );
      }
      await sleep(10);
    }
  }

  /** Poll ledger.get until the fold satisfies the check — session
   * bookkeeping (the turnActive flag) settles just after the final
   * record lands. */
  async ledgerUntil(
    check: (ledger: LedgerState) => boolean,
    label: string,
    timeoutMs = 10000,
  ): Promise<LedgerState> {
    const start = Date.now();
    for (;;) {
      const ledger = await this.expectOk("ledger.get", {});
      if (check(ledger)) return ledger;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timeout waiting for ${label}; ledger=${JSON.stringify(ledger)}`);
      }
      await sleep(25);
    }
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function harness(t: TestContext, script: CaptainTurnScript) {
  const dir = mkdtempSync(join(tmpdir(), "spex-advance-"));
  const configPath = join(dir, "playbook.config.yaml");
  writeFileSync(configPath, VALID_CONFIG);
  const projectDir = join(dir, "project");
  mkdirSync(projectDir);
  execFileSync("git", ["init", "-q", projectDir]);
  const options = {
    token: "test", configPath, dataDir: join(dir, "state"),
    adapterImports: fakeAdapterImports({}).imports,
    adapterRuntime: () => ({ usable: true }),
    captainFactory: async () => createScriptedCaptain(script),
    env: {}, home: join(dir, "home"), watchConfig: false,
  };
  const beforeStop: (() => void)[] = [];
  let service = await CoreService.start(options);
  let client = new Client(service.port());
  t.after(async () => {
    for (const cleanup of beforeStop) cleanup();
    client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await client.open();
  const project = await client.expectOk("project.register", { path: projectDir });
  const session = await client.expectOk("session.create", { projectId: project.id });
  await client.expectOk("subscribe", { channel: { kind: "session", sessionId: session.id } });
  return {
    get client() { return client; }, get service() { return service; },
    project, session, dir, beforeStop,
    async restart() {
      client.close();
      await service.stop();
      service = await CoreService.start(options);
      client = new Client(service.port());
      await client.open();
    },
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function settled(h: Harness, turns = 1): Promise<void> {
  await h.client.waitFor((message) => message.type === "session.state" &&
    message.session.id === h.session.id && message.session.turns === turns &&
    message.session.turnActive === false && !message.session.live);
  await h.service["sessions"].settled(h.session.id);
  await Promise.all([...h.service["advancing"]]);
  await h.client.expectOk("ledger.get", {});
}

async function terminal(
  session: Parameters<CaptainTurnScript>[2],
  kind = "success",
  depth = 0,
  playbookId = "code",
): Promise<void> {
  await session.emitTelemetry({
    topic: "playbook.trace",
    payload: {
      schemaVersion: 3, seq: 1, timestamp: Date.now(),
      type: "boss.input.settled", playbookId, depth,
      sessionId: depth ? "nested-review" : "root-code", rootSessionId: "root-code",
      payload: { outcome: "terminal", terminal: { kind } },
    },
  });
}

function entry(ledger: LedgerState, id: string) {
  const found = ledger.intents.find((row) => row.intent.id === id);
  assert.ok(found, `missing intent ${id}`);
  return found;
}

function starts(client: Client) {
  return client.messages.filter((message) => message.type === "record" && message.record.type === "turn_started");
}

for (const mode of ["automatic", "manual race", "confirmed during settlement"] as const) {
  test(`queue advance: settlement gates ${mode}`, { timeout: 20_000 }, async (t) => {
    const prompts: string[] = [];
    const h = await harness(t, async (turn, context, session) => {
      prompts.push(turn.prompt);
      if (prompts.length === 1) await terminal(session);
      await context.emitReply("Done");
    });
    const { client, project, session } = h;
    const first = await client.expectOk("intent.queue", { projectId: project.id, text: "First work" });
    const blocked = await client.expectOk("intent.queue", {
      projectId: project.id, text: "Explicitly waits for Confirm", afterIntentId: first.id,
    });
    const displaced = mode === "automatic"
      ? await client.expectOk("intent.queue", { projectId: project.id, text: "Previously next" }) : undefined;
    const next = await client.expectOk("intent.queue", { projectId: project.id, text: "Next work\nwith all details" });
    let nextText = next.text;
    const otherDir = join(h.dir, "other");
    mkdirSync(otherDir);
    execFileSync("git", ["init", "-q", otherDir]);
    const other = await client.expectOk("project.register", { path: otherDir });
    const foreign = await client.expectOk("intent.queue", { projectId: other.id, text: "Other project" });

    const store = h.service["store"];
    const sessions = h.service["sessions"];
    const refresh = store.refreshSession.bind(store);
    const reached = deferred();
    const release = deferred();
    h.beforeStop.push(() => { release.resolve(); store.refreshSession = refresh; });
    store.refreshSession = async (id, live) => {
      if (id === session.id && live === false && !sessions.getLive(id)) {
        store.refreshSession = refresh;
        reached.resolve();
        await release.promise;
      }
      return refresh(id, live);
    };
    await client.expectOk("turn.submit", { sessionId: session.id, text: first.text, intentId: first.id });
    await reached.promise;
    assert.equal(sessions.getLive(session.id), undefined, "runtime disposal alone must not advance");
    await client.expectOk("config.edit", { op: { kind: "captain.set", patch: { model: "claude-tuned" } } });
    if (mode === "automatic") {
      nextText = "Revised queued work\nwith the latest details";
      await client.expectOk("intent.edit", { intentId: next.id, text: nextText });
      await client.expectOk("intent.move", { intentId: next.id, afterIntentId: blocked.id });
    }
    const before = await client.expectOk("ledger.get", {});
    assert.equal(entry(before, next.id).intent.dispatched, undefined);
    assert.deepEqual(prompts, [first.text]);

    if (mode === "confirmed during settlement") {
      await client.expectOk("intent.close", { intentId: first.id, as: "done" });
      // Keep the explicitly linked follower blocked on an unrelated open
      // predecessor so this case still selects the same unblocked next row.
      await client.expectOk("intent.link", { intentId: blocked.id, afterIntentId: foreign.id });
    }
    let pending: ReturnType<Client["command"]> | undefined;
    if (mode === "manual race") {
      const entering = deferred();
      const wait = sessions.settled.bind(sessions);
      sessions.settled = async (id) => { entering.resolve(); await wait(id); };
      h.beforeStop.push(() => { sessions.settled = wait; });
      pending = client.command("turn.submit", { sessionId: session.id, text: next.text, intentId: next.id });
      await entering.promise;
    }
    release.resolve();
    if (pending) {
      const reply = await pending;
      assert.ok(reply.ok || ["busy", "conflict"].includes(reply.error.code), JSON.stringify(reply));
    }
    const after = await client.ledgerUntil((ledger) => entry(ledger, next.id).state === "finished", "the next intent to finish");
    await settled(h, 2);
    assert.deepEqual(prompts, [first.text, nextText], "the latest queued text and rank select exactly one dispatch");
    if (displaced) assert.equal(entry(after, displaced.id).intent.dispatched, undefined);
    assert.equal(starts(client).length, 2);
    assert.equal(entry(after, next.id).intent.dispatched?.sessionId, session.id);
    assert.equal(entry(after, next.id).intent.dispatched?.turnId, 2);
    assert.equal(typeof entry(after, next.id).intent.dispatched?.at, "number");
    if (mode === "confirmed during settlement") {
      const history = await client.expectOk("ledger.history", { projectId: project.id });
      assert.ok(history.intents.some((row) => row.intent.id === first.id && row.intent.closedAs === "done"));
    } else {
      assert.equal(entry(after, first.id).state, "finished");
      assert.equal(entry(after, first.id).intent.closedAt, undefined);
      assert.ok(after.attention.some((row) => row.intentId === first.id && row.band === "finished" && row.turnId === 1));
    }
    assert.equal(entry(after, blocked.id).blockedBy?.intentId, mode === "confirmed during settlement" ? foreign.id : first.id);
    assert.equal(entry(after, blocked.id).intent.dispatched, undefined);
    assert.equal(entry(after, foreign.id).intent.dispatched, undefined);
    const current = h.service["store"].listSessions().find((row) => row.id === session.id);
    assert.equal(current?.turns, 2);
    // The session context is emitted by normal continuation, not a separate
    // queue runner carrying the previous runtime's configuration.
    const contexts = h.service["store"].getRecords(session.id, { includeHidden: true }).flatMap(({ record }) =>
      (record as { type?: string }).type === "session_context"
        ? [record as unknown as { configuration: { captain: { model: { kind: string; value: string } } } }] : []);
    assert.deepEqual(contexts.at(-1)?.configuration.captain.model, { kind: "value", value: "claude-tuned" });
  });
}

for (const outcome of ["chat", "unowned-success", "unknown", "question", "failure", "nested-only", "nested-success-root-failure", "captain-only", "success-then-new-root", "success-then-nonterminal", "throw", "abort"] as const) {
  test(`queue advance: ${outcome} does not dispatch queued work`, { timeout: 15_000 }, async (t) => {
    const abortGate = deferred();
    const entered = deferred();
    const prompts: string[] = [];
    const h = await harness(t, async (turn, context, session) => {
      prompts.push(turn.prompt);
      if (outcome === "abort") {
        entered.resolve();
        await abortGate.promise;
        return;
      }
      if (outcome === "unowned-success") await terminal(session);
      if (outcome === "throw") throw new Error("scripted Captain failure");
      if (outcome === "nested-only" || outcome === "nested-success-root-failure") await terminal(session, "success", 1, "review");
      if (outcome === "failure" || outcome === "nested-success-root-failure") await terminal(session, "failure");
      if (outcome === "captain-only") await terminal(session, "success", 0, "captain");
      if (outcome === "success-then-new-root" || outcome === "success-then-nonterminal") {
        await terminal(session);
        const root = outcome === "success-then-new-root" ? "new-root" : "root-code";
        await session.emitTelemetry({
          topic: "playbook.trace", payload: {
            schemaVersion: 3, playbookId: "code", depth: 0, sessionId: root, rootSessionId: root,
            type: outcome === "success-then-new-root" ? "session.started" : "boss.input.settled",
            payload: { outcome: "awaiting-boss" },
          },
        });
      }
      if (outcome === "question") {
        await session.emitTelemetry({ topic: "playbook.fsm.state", payload: { from: "working", to: "awaitBossReply" } });
        await session.emitTelemetry({
          topic: "playbook.trace", payload: {
            schemaVersion: 3, type: "boss.input.settled", playbookId: "code",
            sessionId: "root-code", rootSessionId: "root-code", depth: 0,
            payload: { outcome: "awaiting-boss" },
          },
        });
      }
      await context.emitReply("Captain replied without successful root work");
    });
    h.beforeStop.push(abortGate.resolve);
    const { client, project, session } = h;
    const first = await client.expectOk("intent.queue", { projectId: project.id, text: "First intent" });
    const next = await client.expectOk("intent.queue", { projectId: project.id, text: "Must remain queued" });
    await client.expectOk("turn.submit", {
      sessionId: session.id, text: first.text,
      ...(["chat", "unowned-success"].includes(outcome) ? {} : { intentId: first.id }),
    });
    if (outcome === "abort") {
      await entered.promise;
      await client.expectOk("turn.abort", { sessionId: session.id });
      abortGate.resolve();
    }
    await settled(h);
    const ledger = await client.expectOk("ledger.get", {});
    assert.equal(entry(ledger, next.id).state, "queued");
    assert.equal(entry(ledger, next.id).intent.dispatched, undefined);
    assert.deepEqual(prompts, [first.text]);
    assert.equal(starts(client).length, 1);
  });
}

test("queue advance: queue edits, Confirm, subsequent plain chat, and restart never replay a completed success", { timeout: 20_000 }, async (t) => {
  const prompts: string[] = [];
  const h = await harness(t, async (turn, context, session) => {
    prompts.push(turn.prompt);
    await terminal(session);
    await context.emitReply("Done");
  });
  const { project, session } = h;
  const first = await h.client.expectOk("intent.queue", { projectId: project.id, text: "First work" });
  const next = await h.client.expectOk("intent.queue", {
    projectId: project.id, text: "Wait for Confirm", afterIntentId: first.id,
  });
  await h.client.expectOk("turn.submit", { sessionId: session.id, text: first.text, intentId: first.id });
  await settled(h);
  assert.equal(entry(await h.client.expectOk("ledger.get", {}), next.id).intent.dispatched, undefined);
  await h.client.expectOk("intent.close", { intentId: first.id, as: "done" });
  await h.client.expectOk("intent.edit", { intentId: next.id, text: "Edited after confirmation" });
  await h.client.expectOk("intent.move", { intentId: next.id, afterIntentId: null });
  const added = await h.client.expectOk("intent.queue", { projectId: project.id, text: "Added after settlement" });
  let ledger = await h.client.expectOk("ledger.get", {});
  for (const id of [next.id, added.id]) {
    assert.equal(entry(ledger, id).state, "queued");
    assert.equal(entry(ledger, id).intent.dispatched, undefined);
  }
  assert.deepEqual(prompts, [first.text]);
  // A successful unbound turn after Confirm is new chat, even though
  // the session still stores the earlier intent's dispatch stamp.
  const chat = "Plain conversation after confirmation";
  await h.client.expectOk("turn.submit", { sessionId: session.id, text: chat });
  await settled(h, 2);
  ledger = await h.client.expectOk("ledger.get", {});
  for (const id of [next.id, added.id]) assert.equal(entry(ledger, id).intent.dispatched, undefined);
  assert.deepEqual(prompts, [first.text, chat]);
  assert.equal(starts(h.client).length, 2);
  await h.restart();
  ledger = await h.client.expectOk("ledger.get", {});
  for (const id of [next.id, added.id]) assert.equal(entry(ledger, id).intent.dispatched, undefined);
  assert.deepEqual(prompts, [first.text, chat], "stored success is evidence, not a restart trigger");
});

for (const initial of ["unknown", "question"] as const) {
  test(`queue advance: successful manual follow-up after ${initial} advances the attributed intent`, { timeout: 20_000 }, async (t) => {
    const prompts: string[] = [];
    const h = await harness(t, async (turn, context, session) => {
      prompts.push(turn.prompt);
      if (prompts.length === 1 && initial === "question") {
        await session.emitTelemetry({ topic: "playbook.fsm.state", payload: { from: "working", to: "awaitBossReply" } });
      }
      if (turn.prompt === "Continue with that answer") {
        if (initial === "question") {
          await session.emitTelemetry({ topic: "playbook.fsm.state", payload: { from: "awaitBossReply", to: "working" } });
        }
        await terminal(session);
      }
      await context.emitReply("Captain reply");
    });
    const { client, project, session } = h;
    const first = await client.expectOk("intent.queue", { projectId: project.id, text: "First intent" });
    const next = await client.expectOk("intent.queue", { projectId: project.id, text: "Next intent" });
    await client.expectOk("turn.submit", { sessionId: session.id, text: first.text, intentId: first.id });
    await settled(h);
    const before = await client.expectOk("ledger.get", {});
    assert.equal(entry(before, next.id).intent.dispatched, undefined);
    if (initial === "question") assert.equal(entry(before, first.id).reason, "question");

    // No repeated intent id: ordinary follow-ups belong to the latest
    // dispatched open intent and can supply its missing completion evidence.
    await client.expectOk("turn.submit", { sessionId: session.id, text: "Continue with that answer" });
    const after = await client.ledgerUntil((ledger) => entry(ledger, next.id).state === "finished", "the follow-up to advance");
    await settled(h, 3);
    assert.deepEqual(prompts, [first.text, "Continue with that answer", next.text]);
    assert.equal(starts(client).length, 3);
    assert.equal(entry(after, first.id).intent.dispatched?.turnId, 1);
    assert.equal(entry(after, first.id).stats?.turns, 2);
    assert.equal(entry(after, first.id).intent.closedAt, undefined);
    assert.ok(after.attention.some((row) => row.intentId === first.id && row.band === "finished" && row.turnId === 2));
    assert.equal(entry(after, next.id).intent.dispatched?.sessionId, session.id);
    assert.equal(entry(after, next.id).intent.dispatched?.turnId, 3);
  });
}

test("queue advance: invalid configuration refuses admission and repairing it does not retry", { timeout: 20_000 }, async (t) => {
  const reached = deferred();
  const release = deferred();
  const prompts: string[] = [];
  const h = await harness(t, async (turn, context, session) => {
    prompts.push(turn.prompt);
    if (prompts.length === 1) {
      await terminal(session);
      reached.resolve();
      await release.promise;
    }
    await context.emitReply("Done");
  });
  h.beforeStop.push(release.resolve);
  const { client, project, session } = h;
  const configPath = join(h.dir, "playbook.config.yaml");
  const first = await client.expectOk("intent.queue", { projectId: project.id, text: "First intent" });
  const next = await client.expectOk("intent.queue", { projectId: project.id, text: "Next intent" });
  await client.expectOk("turn.submit", { sessionId: session.id, text: first.text, intentId: first.id });
  await reached.promise;
  writeFileSync(configPath, "captain: [invalid current config]\n");
  await h.service.reloadConfig();
  release.resolve();
  await settled(h);
  const refused = await client.expectOk("ledger.get", {});
  assert.equal(entry(refused, next.id).state, "queued");
  assert.equal(entry(refused, next.id).intent.dispatched, undefined);
  assert.equal(starts(client).length, 1);

  writeFileSync(configPath, VALID_CONFIG);
  await client.expectOk("config.edit", { op: { kind: "captain.set", patch: { model: "claude-test" } } });
  await Promise.all([...h.service["advancing"]]);
  assert.equal(entry(await client.expectOk("ledger.get", {}), next.id).intent.dispatched, undefined);
  assert.deepEqual(prompts, [first.text], "configuration repair does not replay completion");
  await client.expectOk("turn.submit", { sessionId: session.id, text: next.text, intentId: next.id });
  await settled(h, 2);
  assert.deepEqual(prompts, [first.text, next.text], "manual submission can resume after the repair");
  assert.equal(entry(await client.expectOk("ledger.get", {}), next.id).intent.dispatched?.turnId, 2);
});

test("queue advance: dropping the owner during continuation prevents dispatch and releases the idle runtime", { timeout: 20_000 }, async (t) => {
  const prompts: string[] = [];
  const h = await harness(t, async (turn, context, session) => {
    prompts.push(turn.prompt);
    await terminal(session);
    await context.emitReply("Done");
  });
  const { client, project, session } = h;
  const first = await client.expectOk("intent.queue", { projectId: project.id, text: "First work" });
  const next = await client.expectOk("intent.queue", { projectId: project.id, text: "Must stay queued" });
  const continued = h.service["continueSession"].bind(h.service);
  const opened = deferred();
  const release = deferred();
  h.beforeStop.push(() => { release.resolve(); h.service["continueSession"] = continued; });
  h.service["continueSession"] = async (id) => {
    await continued(id);
    opened.resolve();
    await release.promise;
  };
  await client.expectOk("turn.submit", { sessionId: session.id, text: first.text, intentId: first.id });
  await opened.promise;
  assert.ok(h.service["sessions"].getLive(session.id), "automatic admission opened the continued runtime");
  assert.equal(entry(await client.expectOk("ledger.get", {}), next.id).intent.dispatched, undefined);
  await client.expectOk("intent.close", { intentId: first.id, as: "dropped" });
  release.resolve();
  await Promise.all([...h.service["advancing"]]);
  const after = await client.expectOk("ledger.get", {});
  assert.equal(entry(after, next.id).state, "queued");
  assert.equal(entry(after, next.id).intent.dispatched, undefined);
  assert.deepEqual(prompts, [first.text]);
  assert.equal(starts(client).length, 1);
  assert.equal(h.service["sessions"].getLive(session.id), undefined, "cancelled admission releases its idle runtime");
  assert.equal(h.service["sessions"].listSessions().find((row) => row.id === session.id)?.live, false);
});
