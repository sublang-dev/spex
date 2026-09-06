// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The public CLI continues a session written by the actual Spex core
// (core-service-77). Only provider adapter classes are substituted.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { createSessionStore } from "@sublang/playbook/session-store";

import { CoreService } from "./service.js";
import type { Command, CommandResults, ServerMessage } from "./protocol.js";
import { fakeAdapterImports } from "./testing/fake-adapter.js";

const exec = promisify(execFile);
const CONFIG = `captain:
  adapter: claude
  model: claude-test
players:
  dev.coder:
    adapter: claude
    model: claude-test
playbooks:
  code:
    from: "@sublang/playbook/code/registry"
    roles:
      coder: dev.coder
`;

// Same provider-only loader seam as Playbook's CLI storage integration
// suite: keep the installed adapter module's helpers and replace its class.
const PROVIDER = `
import { appendFileSync } from 'node:fs';
class FixtureAdapter {
  agent = 'claude-code';
  async isAvailable() { return true; }
  async *run(prompt, options) {
    appendFileSync(process.env.SPEX_TEST_PROVIDER_LOG, JSON.stringify({prompt,resume:options?.resume})+'\\n');
    const result = prompt.includes('Select exactly one action from the closed set')
      ? JSON.stringify({action:'respond',text:'Continued by the real CLI.'}) : 'Continued by the real CLI.';
    yield {type:'done',agent:this.agent,timestamp:Date.now(),sessionId:'fixture-cli-provider',payload:{status:'success',result,resumeToken:'fixture-cli-continuation',usage:{toolUses:0},durationMs:1}};
  }
}
export { FixtureAdapter as ClaudeCodeAdapter };
`;

test("core-service-77: the real CLI continues a Spex-created session", { timeout: 60_000 }, async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "spex-cli-continuation-")));
  const home = join(scratch, "home");
  const dataDir = join(home, ".spex");
  const cwd = join(scratch, "project");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(cwd);
  await exec("git", ["init", "-q", cwd]);
  const configPath = join(dataDir, "playbook", "playbook.config.yaml");
  await mkdir(dirname(configPath), { mode: 0o700 });
  await writeFile(configPath, CONFIG, { mode: 0o600 });
  let service: CoreService | undefined;
  let socket: WebSocket | undefined;
  try {
    service = await CoreService.start({
      dataDir, configPath, token: "test", home, env: { SPEX_HOME: dataDir }, watchConfig: false,
      adapterRuntime: () => ({ usable: true }),
      adapterImports: fakeAdapterImports({
        rules: [{ match: "Select exactly one action from the closed set", response: {
          result: JSON.stringify({ action: "respond", text: "Created by the real Spex core." }),
        } }],
        fallback: { result: "Created by the real Spex core." },
      }).imports,
    });
    socket = new WebSocket(`ws://127.0.0.1:${service.port()}/?token=test`);
    const messages: ServerMessage[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
    await new Promise<void>((resolve, reject) => {
      socket!.once("open", resolve);
      socket!.once("error", reject);
    });
    let sequence = 0;
    async function command<T extends Command["type"]>(
      type: T,
      fields: Omit<Extract<Command, { type: T }>, "type" | "id">,
    ): Promise<CommandResults[T]> {
      const id = `cli-test-${++sequence}`;
      socket!.send(JSON.stringify({ type, id, ...fields }));
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const reply = messages.find((message) => message.type === "reply" && message.id === id);
        if (reply?.type === "reply") {
          assert.equal(reply.ok, true, JSON.stringify(reply));
          if (reply.ok) return reply.result as CommandResults[T];
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`${type} did not reply`);
    }
    const project = await command("project.register", { path: cwd });
    const session = await command("session.create", { projectId: project.id });
    await command("turn.submit", { sessionId: session.id, text: "Start in Spex." });
    const deadline = Date.now() + 15_000;
    for (;;) {
      const current = (await command("session.list", {})).find((entry) => entry.id === session.id);
      if (current?.turns === 1 && current.turnActive === false) break;
      assert.ok(Date.now() < deadline, "Spex turn did not settle");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    socket.close();
    await service.stop();
    service = undefined;

    const store = createSessionStore({ sessionsDir: join(dataDir, "sessions") });
    const before = await store.read(session.id);
    assert.equal(before.state, "settled");
    assert.equal(before.snapshot.sequences.turn, 1);
    const streamPath = join(store.sessionsDir, `${session.id}.records.jsonl`);
    const replayBefore = await readFile(streamPath);

    const loader = join(scratch, "loader.mjs");
    await writeFile(loader, `export async function load(url,context,nextLoad){
      const result=await nextLoad(url,context);
      if(!url.endsWith('/adapters/claude-code.js'))return result;
      const source=String(result.source);
      if(!source.includes('export class ClaudeCodeAdapter'))throw Error('Provider fixture no longer matches the installed adapter');
      return {...result,source:source.replace('export class ClaudeCodeAdapter','class OriginalClaudeCodeAdapter')+${JSON.stringify(PROVIDER)}};
    }`);
    const preload = join(scratch, "preload.mjs");
    await writeFile(preload, "import {register} from 'node:module';register('./loader.mjs',import.meta.url);\n");
    const providerLog = join(scratch, "provider.jsonl");
    const cli = join(dirname(fileURLToPath(import.meta.resolve("@sublang/playbook/code/registry"))), "bin", "playbook.js");
    const result = await exec(process.execPath, ["--import", preload, cli, "run", "--continue", "--json", "Continue in the terminal."], {
      cwd, timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: home, SPEX_HOME: dataDir,
        ANTHROPIC_API_KEY: "fixture", SPEX_TEST_PROVIDER_LOG: providerLog },
    });
    // execFile rejects every non-zero exit, so this is executable-level
    // success, not merely a call to the embedded host API.
    assert.deepEqual(JSON.parse(result.stdout), { sessionId: session.id, reply: "Continued by the real CLI." });
    const after = await store.read(session.id);
    assert.equal(after.state, "settled");
    assert.equal(after.snapshot.sequences.turn, 2);
    assert.equal(after.sessionId, session.id);
    assert.ok((await store.validate(session.id)).resumable);
    const replayAfter = await readFile(streamPath);
    assert.deepEqual(replayAfter.subarray(0, replayBefore.length), replayBefore);
    const turns = replayAfter.toString("utf8").trim().split("\n").map((line) => JSON.parse(line))
      .filter((entry) => entry.record.type === "turn_started");
    assert.deepEqual(turns.map((entry) => entry.record.turn.prompt), ["Start in Spex.", "Continue in the terminal."]);
    assert.ok((await readFile(providerLog, "utf8")).includes("Continue in the terminal."), "CLI did not use the fixture provider");
  } finally {
    socket?.close();
    await service?.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});
