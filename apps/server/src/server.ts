// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The server shell (DR-033): one TCP port serves the staged UI
// bundle and the core's WebSocket endpoint to a remote browser,
// behind the core's token handshake, with optional TLS
// (SERVER-SHELL-1..4, 16). A non-loopback bind without TLS is refused
// unless --insecure makes the plaintext choice explicit
// (SERVER-SHELL-2).

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from "node:https";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from "node:zlib";

import { CoreService, type CoreServiceOptions } from "@sublang/spex-core";

export interface ServerShellOptions {
  host: string;
  port: number;
  token: string;
  configPath?: string;
  dataDir: string;
  /** The pre-DR-036 store to hand over for the one-time import. */
  legacyDb: string;
  tlsCert?: string;
  tlsKey?: string;
  insecure: boolean;
  uiDist: string;
  /**
   * Core service overrides for a harness starting the shell from code
   * (server-shell-20, DR-039): the core's agent seams and its
   * environment. No command-line form exists, so a served deployment
   * never carries them; absent, the boot is exactly the command line's.
   */
  core?: Pick<
    CoreServiceOptions,
    | "adapterImports"
    | "adapterRuntime" | "agentOptions"
    | "captainFactory"
    | "env"
    | "home"
    | "loadModule"
    | "runCommand"
    | "forgeAdapter"
    | "scaffoldCommand"
    | "watchConfig"
  >;
}

export interface RunningServer {
  service: CoreService;
  server: HttpServer | HttpsServer;
  /** The one access URL: scheme, bound host, port, and token. */
  url: string;
  port: number;
  close(): Promise<void>;
}

export function defaultDataDir(env: NodeJS.ProcessEnv): string {
  return env.SPEX_HOME?.trim() ? env.SPEX_HOME : join(env.HOME ?? homedir(), ".spex");
}

/** The pre-DR-036 store this shell used, handed over for the one-time
 * import (core-service-64) when it exists. */
export function legacyDbPath(env: NodeJS.ProcessEnv): string {
  const dataHome =
    env.XDG_DATA_HOME || join(env.HOME ?? homedir(), ".local", "share");
  return join(dataHome, "spex", "server.db");
}

function defaultUiDist(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "ui-dist");
}

/** The shell's own version, from its package manifest — what the
 * served page prints where the desktop prints its build's version
 * (SERVER-SHELL-4). */
export function shellVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
        "utf8",
      ),
    ) as { version?: unknown };
    return typeof manifest.version === "string" && manifest.version
      ? manifest.version
      : "dev";
  } catch {
    return "dev";
  }
}

/** Stamp the shell's version into a page's head as a
 * `spex-version` meta element (SERVER-SHELL-4), so the served
 * Settings surface never prints a dev placeholder. A page with no
 * head element is left as it is. */
export function stampVersion(page: string, version: string): string {
  const safe = version.replace(/[^A-Za-z0-9.+-]/g, "");
  if (!safe) return page;
  return page.replace(
    /<head(\s[^>]*)?>/i,
    (head) => `${head}<meta name="spex-version" content="${safe}">`,
  );
}

export function parseArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
): ServerShellOptions {
  const options: ServerShellOptions = {
    host: "127.0.0.1",
    port: 8137,
    token: env.SPEX_TOKEN ?? randomUUID(),
    dataDir: defaultDataDir(env),
    legacyDb: legacyDbPath(env),
    insecure: false,
    uiDist: defaultUiDist(),
  };
  for (const arg of argv) {
    if (arg === "--insecure") {
      options.insecure = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    const [, key, value] = match ?? [];
    switch (key) {
      case "host":
        options.host = value;
        break;
      case "port": {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new Error(`invalid --port: ${value}`);
        }
        options.port = port;
        break;
      }
      case "token":
        options.token = value;
        break;
      case "config":
        options.configPath = value;
        break;
      case "data-dir":
        options.dataDir = value;
        break;
      case "tls-cert":
        options.tlsCert = value;
        break;
      case "tls-key":
        options.tlsKey = value;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export function isLoopback(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/** An IPv6 literal must be bracketed in URLs and ssh forwards. */
export function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

const COMPRESSIBLE_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".css",
  ".json",
  ".map",
  ".svg",
  ".txt",
]);

type ContentCoding = "br" | "gzip" | "identity";

interface CachedEncodedBody {
  body: Buffer;
  mtimeMs: number;
  size: number;
}

type EncodedBodyCache = Map<string, CachedEncodedBody>;

function acceptsContentCoding(
  header: string | string[] | undefined,
  coding: Exclude<ContentCoding, "identity">,
): boolean {
  if (header === undefined) return false;
  const value = Array.isArray(header) ? header.join(",") : header;
  let explicitQuality: number | undefined;
  let wildcardQuality: number | undefined;
  for (const entry of value.split(",")) {
    const [namePart = "", ...parameters] = entry.split(";");
    const name = namePart.trim().toLowerCase();
    if (name !== coding && name !== "*") continue;
    const qualityParameter = parameters.find((parameter) =>
      /^\s*q\s*=/i.test(parameter),
    );
    const quality = qualityParameter
      ? Number(qualityParameter.replace(/^\s*q\s*=\s*/i, ""))
      : 1;
    const normalizedQuality =
      Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0;
    if (name === coding) {
      explicitQuality = Math.max(explicitQuality ?? 0, normalizedQuality);
    } else {
      wildcardQuality = Math.max(wildcardQuality ?? 0, normalizedQuality);
    }
  }
  return (explicitQuality ?? wildcardQuality ?? 0) > 0;
}

function negotiateContentCoding(
  header: string | string[] | undefined,
): ContentCoding {
  if (acceptsContentCoding(header, "br")) return "br";
  if (acceptsContentCoding(header, "gzip")) return "gzip";
  return "identity";
}

function encodeBody(body: Buffer, coding: ContentCoding): Buffer {
  if (coding === "br") {
    return brotliCompressSync(body, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
    });
  }
  if (coding === "gzip") return gzipSync(body);
  return body;
}

function cachedEncodedBody(
  cache: EncodedBodyCache,
  filePath: string,
  coding: Exclude<ContentCoding, "identity">,
  fileStat: Stats,
): Buffer {
  const key = `${coding}\0${filePath}`;
  const cached = cache.get(key);
  if (
    cached &&
    cached.mtimeMs === fileStat.mtimeMs &&
    cached.size === fileStat.size
  ) {
    return cached.body;
  }
  const body = encodeBody(readFileSync(filePath), coding);
  cache.set(key, {
    body,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
  });
  return body;
}

// The built page's CSP names only localhost connect targets — right
// for the desktop's file:// copy, wrong here. Retarget connect-src to
// the serving origin (SERVER-SHELL-4) so the page may open WebSockets
// to this origin and to no other host.
export function retargetCsp(
  page: string,
  hostHeader: string | undefined,
): string {
  const host =
    hostHeader && /^[A-Za-z0-9.\-[\]:]+$/.test(hostHeader)
      ? hostHeader
      : undefined;
  if (!host) return page;
  return page.replace(
    /connect-src [^;"]*/,
    `connect-src 'self' ws://${host} wss://${host}`,
  );
}

function serveBundle(
  bundleDir: string,
  encodedBodyCache: EncodedBodyCache,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(
      new URL(req.url ?? "/", "http://bundle").pathname,
    );
  } catch {
    res.writeHead(400).end();
    return;
  }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // Guard the lexical path, then the real one: a symlink staged into
  // the bundle must not serve what it points at outside it.
  let filePath = resolve(bundleDir, relative);
  if (!filePath.startsWith(bundleDir + sep)) {
    res.writeHead(404).end();
    return;
  }
  const requestedIndex = filePath === join(bundleDir, "index.html");
  try {
    filePath = realpathSync(filePath);
  } catch {
    res.writeHead(404).end();
    return;
  }
  if (!filePath.startsWith(bundleDir + sep)) {
    res.writeHead(404).end();
    return;
  }
  let fileStat: Stats;
  try {
    fileStat = statSync(filePath);
  } catch {
    res.writeHead(404).end();
    return;
  }
  if (!fileStat.isFile()) {
    res.writeHead(404).end();
    return;
  }
  const isIndex = requestedIndex || filePath === join(bundleDir, "index.html");
  const extension = extname(filePath);
  const type = CONTENT_TYPES[extension] ?? "application/octet-stream";
  const headers: OutgoingHttpHeaders = { "content-type": type };
  if (isIndex) headers["cache-control"] = "no-store";
  let coding: ContentCoding = "identity";
  if (COMPRESSIBLE_EXTENSIONS.has(extension)) {
    coding = negotiateContentCoding(req.headers["accept-encoding"]);
    headers.vary = "Accept-Encoding";
    if (coding !== "identity") headers["content-encoding"] = coding;
  }
  if (req.method === "HEAD") {
    res.writeHead(200, headers).end();
    return;
  }
  let responseBody: Buffer;
  try {
    if (isIndex) {
      const body =
        extension === ".html"
          ? Buffer.from(
              stampVersion(
                retargetCsp(readFileSync(filePath, "utf8"), req.headers.host),
                shellVersion(),
              ),
            )
          : readFileSync(filePath);
      responseBody = encodeBody(body, coding);
    } else if (coding === "identity") {
      responseBody = readFileSync(filePath);
    } else {
      responseBody = cachedEncodedBody(
        encodedBodyCache,
        filePath,
        coding,
        fileStat,
      );
    }
  } catch (error) {
    console.error(
      `[spex-server] bundle materialization failed: ${JSON.stringify({
        path: filePath,
        cause: error instanceof Error ? error.message : String(error),
      })}`,
    );
    res.writeHead(500).end();
    return;
  }
  res.writeHead(200, headers);
  res.end(responseBody);
}

export async function startServer(
  options: ServerShellOptions,
): Promise<RunningServer> {
  if (options.token === "") {
    throw new Error(
      "the token must not be empty — a blank secret would disable the " +
        "handshake; unset SPEX_TOKEN/--token for a random one, or pass a secret",
    );
  }
  if ((options.tlsCert === undefined) !== (options.tlsKey === undefined)) {
    const missing = options.tlsCert === undefined ? "--tls-cert" : "--tls-key";
    throw new Error(`TLS needs both halves: ${missing} is missing`);
  }
  const tls = options.tlsCert !== undefined && options.tlsKey !== undefined;
  if (!isLoopback(options.host) && !tls && !options.insecure) {
    throw new Error(
      `refusing to bind ${options.host} without TLS: pass ` +
        `--tls-cert/--tls-key, or --insecure to accept a plaintext public bind`,
    );
  }
  const bundleDir = realpathSync(options.uiDist);
  const encodedBodyCache: EncodedBodyCache = new Map();
  const handler = (req: IncomingMessage, res: ServerResponse) =>
    serveBundle(bundleDir, encodedBodyCache, req, res);
  const server = tls
    ? createHttpsServer(
        {
          cert: readFileSync(options.tlsCert as string),
          key: readFileSync(options.tlsKey as string),
        },
        handler,
      )
    : createHttpServer(handler);
  mkdirSync(options.dataDir, { recursive: true });
  const legacy = options.legacyDb;
  const service = await CoreService.start({
    httpServer: server,
    token: options.token,
    dataDir: options.dataDir,
    ...(existsSync(legacy) ? { legacyDbPath: legacy } : {}),
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.core ?? {}),
  });
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(options.port, options.host, resolveListen);
    });
  } catch (error) {
    await service.stop();
    throw error;
  }
  const port = (server.address() as AddressInfo).port;
  const scheme = tls ? "https" : "http";
  const url = `${scheme}://${formatHost(options.host)}:${port}/?token=${encodeURIComponent(options.token)}`;
  return {
    service,
    server,
    url,
    port,
    close: async () => {
      // Sever transports first: a vanished peer's WebSocket would
      // otherwise hold the graceful stop until ws's close timeout.
      server.closeAllConnections();
      await service.stop();
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    },
  };
}
