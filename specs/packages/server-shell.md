<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# server-shell: Server Shell

## Intent

This spec covers the Spex server shell — the headless CLI in `apps/server` that serves the Spex GUI to a remote browser: one TCP port carrying both the built UI bundle and the core service's WebSocket endpoint, guarded by the core's handshake token, with optional TLS ([DR-033](../decisions/033-remote-gui-serving.md)) — including its source-development launch.
It is a single-user deployment of the same core and UI the desktop app embeds ([DR-002](../decisions/002-desktop-app-architecture.md)), not a hosted multi-tenant service.

## External Behavior

### Startup

#### server-shell-1

Where the host platform is supported [[core-service-89](core-service.md#core-service-89)], when the server shell starts, it shall boot one core service attached to the shell's own HTTP server — so the shell's port carries both the UI pages and the core's WebSocket endpoint [[core-service-1](core-service.md#core-service-1)] — and print one access URL naming the scheme, bound host, port, and handshake token [[core-service-24](core-service.md#core-service-24)]:

| Option | Default |
| --- | --- |
| `--host` | `127.0.0.1` |
| `--port` | `8137` |
| `--token` | the `SPEX_TOKEN` environment variable, else a random value per launch |
| `--config` | unset: the core resolves its own shared config path |
| `--data-dir` | the shared state root of [DR-036](../decisions/036-file-state-store.md), created as needed |
| `--tls-cert`, `--tls-key` | unset: plain HTTP |

- A loopback bind is reached remotely over an SSH tunnel; the startup printout names that command.
- An empty token is refused at startup, naming the mistake: a blank secret would disable the handshake.
- An IPv6 bind host appears bracketed in the URL.
- A store an earlier release left at the retired `--db` default is handed to the core for its one-time import [[core-service-64](core-service.md#core-service-64)].

#### server-shell-2

Where the requested bind host is not a loopback address and no TLS material is configured, when the server shell starts, it shall refuse to start with an error naming both remedies — `--tls-cert`/`--tls-key`, or `--insecure` to accept a plaintext public bind:

- With `--insecure`, the shell binds plain HTTP anyway; the token then travels unencrypted.
- A loopback bind needs neither TLS nor the override.

#### server-shell-3

Where TLS certificate and key files are both configured, the server shell shall serve HTTPS on its port and accept `wss:` WebSocket handshakes on the same port:

- Exactly one of the pair configured is refused at startup, naming the missing half.

### Serving

#### server-shell-4

When an HTTP request arrives, the server shell shall serve only the staged UI bundle, read-only:

- a method other than GET or HEAD yields 405 and an empty body;
- an undecodable URL path yields 400 and an empty body;
- `/` resolves to the bundle's `index.html`, and another decoded path resolves relative to the bundle only after a lexical containment check;
- a lexical escape, a missing path, a non-file path, or a real path outside the bundle, including through a symlink, yields 404 and an empty body;
- if GET cannot materialize a successfully resolved response body because reading or encoding fails, it yields 500 with an empty body, writes one standard-error diagnostic naming the resolved path and failure cause, and remains isolated to that request, leaving the HTTP and core endpoints available;
- after successful path resolution, HEAD neither reads nor encodes representation bytes, sends no body, and any advertised `Content-Length` matches the corresponding GET representation;
- a successfully contained file has index semantics when either its lexically resolved requested path or its real path is the bundle's `index.html`: a successful index response carries `Cache-Control: no-store`, and, when its resolved extension is `.html`, its `connect-src` policy is retargeted to the serving origin so the page may open WebSockets to this origin and to no other host, and its head element gains a `spex-version` meta element carrying the shell's own version from its package manifest — the served page's counterpart to the desktop's `?version=` query — so a served page never reads as a dev build;
- apart from that policy substitution and version stamp, every successful GET body is byte-identical, after removal of any HTTP content coding, to the staged bundle bytes from which the selected representation was materialized [[server-shell-18](#server-shell-18)];
- a successful response maps the resolved file extension to its content type, with `application/octet-stream` as the fallback:

| Extension | Content-Type |
| --- | --- |
| `.html` | `text/html; charset=utf-8` |
| `.js` | `text/javascript; charset=utf-8` |
| `.css` | `text/css; charset=utf-8` |
| `.json`, `.map` | `application/json` |
| `.png` | `image/png` |
| `.svg` | `image/svg+xml` |
| `.ico` | `image/x-icon` |
| `.txt` | `text/plain; charset=utf-8` |
| `.woff2` | `font/woff2` |

#### server-shell-16

When the server shell selects the representation for a successfully resolved bundle request, it shall apply content coding according to the file type and `Accept-Encoding`:

- HTML, JavaScript, CSS, JSON, SVG, source maps, and plain text prefer Brotli when `br` is offered, then gzip when `gzip` is offered, and otherwise identity;
- other formats, including PNG, ICO, and WOFF2, use identity coding and do not carry `Vary: Accept-Encoding`;
- an explicitly listed coding with quality zero is not offered, and a nonzero wildcard offers a coding that is not explicitly listed;
- a Brotli or gzip response carries the matching `Content-Encoding`, and every compressible response carries `Vary: Accept-Encoding`, including an identity response;
- an index response whose resolved extension is `.html` is encoded only after its `connect-src` retargeting, so decoding yields the same retargeted bytes as an identity response;
- HEAD selects the same content coding and coding-dependent headers that a successful GET of the resolved file would use.

#### server-shell-5

When the served page resolves its core endpoint, the UI shall connect to the page's own origin — `ws:` under `http:`, `wss:` under `https:` — presenting the handshake token [[core-service-24](core-service.md#core-service-24)]:

| Case | Outcome |
| --- | --- |
| `?token=` in the page URL | the token is adopted for the page session, removed from the address bar, and presented on the connection |
| no URL token, a page-session copy held | the held token is presented, so a reload reconnects without re-showing the secret |
| an explicit `?core=` URL | it wins unchanged, preserving the desktop and dev flows |
| neither token nor `?core=` | resolution falls back to the build-time or localhost default unchanged |

- The address bar is scrubbed only once the page session verifiably holds the copy; a storage-blocked browser keeps the URL token so a reload still connects.
- The rows compose: a URL carrying both `?core=` and `?token=` connects per the `?core=` row while the token is still adopted and scrubbed.

### Shutdown

#### server-shell-6

When the server shell receives SIGINT or SIGTERM, it shall stop the core service — disposing every live session runtime [[core-service-39](core-service.md#core-service-39)] — and exit only after the stop completes, leaving no orphan agent process.

### Source Development

#### server-shell-14

Where `npm ci` has installed the repository dependencies, when a contributor invokes root `npm run start:server`, the command shall invoke root `npm run build` and, after it succeeds, start the compiled server shell in the launcher's lifecycle with every command-line argument forwarded unchanged.

## Internal Behavior

### Package Layout

#### server-shell-7

The `apps/server` workspace package shall declare the `claude`, `codex`, and `opencode` agent SDKs as its own dependencies at the unconstrained range — extending the app-supply duty of [DR-024](../decisions/024-app-supplied-agent-runtimes.md) to this shell — so SDK-backed adapters resolve when its embedded core loads them.

#### server-shell-8

The server shell build shall stage the built UI bundle into the shell package, so serving depends on no sibling workspace at run time.

### Test Seam

#### server-shell-20

Where the server shell is started from code with core service overrides — the agent seams of the core: adapter imports, the adapter runtime check, the Captain factory, environment, and home ([DR-039](../decisions/039-browser-acceptance-journeys.md)) — the server shell shall pass them to the core service it boots [[server-shell-1](#server-shell-1)] unchanged:

- the overrides have no command-line form, so a served deployment never carries them;
- absent overrides leave the boot exactly as the command line configures it.

### Representation Cache

#### server-shell-18

When the server shell serves bundle representations, it shall avoid repeated synchronous compression of non-index assets with a per-launch encoded-body cache:

- a non-index Brotli or gzip GET stores and reuses its encoded body by resolved real path and content coding;
- a cached body remains valid only while the file's size and modification time match the values observed after the traversal guards, and a mismatch replaces it from the current file;
- a materialization failure stores no cache entry;
- every request with index semantics [[server-shell-4](#server-shell-4)] remains uncached; for an HTML index, this prevents reuse of retargeted bytes that depend on the request's Host header.

## Verification

### Serving Coverage

#### server-shell-9

Where the server shell runs on a loopback port with a temporary config and store, the test suite shall assert over real HTTP and WebSocket connections that:

- `GET /` serves the UI page with `Cache-Control: no-store`, its `connect-src` policy naming the serving origin, and the shell's manifest version stamped in its head, the 400 and 405 cases reject with empty bodies, and the empty-body 404 cases cover a lexical escape, a missing path, a contained non-file path, and a real path outside the bundle [[server-shell-4](#server-shell-4)];
- requested-path and real-path classification retain HTML index semantics [[server-shell-4](#server-shell-4)] through post-retarget content coding [[server-shell-16](#server-shell-16)], while a non-HTML index target retains its mapped content type and exact bytes [[server-shell-4](#server-shell-4)] under its type-selected coding [[server-shell-16](#server-shell-16)];
- unreadable index, identity, and cold encoded representations each yield an empty 500 response and one standard-error diagnostic naming the resolved path and failure cause, after which successful HTTP and WebSocket requests prove that the failure stayed local [[server-shell-4](#server-shell-4)];
- a temporary bundle fixture covers every content-type table row and the fallback with byte-identical identity bodies, and a successful HEAD response sends no body with any advertised length matching GET [[server-shell-4](#server-shell-4)];
- a WebSocket handshake presenting the access URL's token from the page's own origin reaches the core's hello, on the same port that served the page [[server-shell-1](#server-shell-1)].

#### server-shell-10

Where the server shell runs with fixture TLS material, the test suite shall assert that an HTTPS page fetch and a token-bearing `wss:` handshake succeed on the one port [[server-shell-3](#server-shell-3)] and that the access URL's scheme is `https` [[server-shell-1](#server-shell-1)].

### Startup Refusal Coverage

#### server-shell-11

Where a startup precondition is violated, the test suite shall assert each refusal: a plaintext public bind refused naming both remedies with `--insecure` lifting it [[server-shell-2](#server-shell-2)], a lone half of the TLS pair refused naming the missing half [[server-shell-3](#server-shell-3)], and an empty token refused [[server-shell-1](#server-shell-1)].

### Shutdown Coverage

#### server-shell-12

Where the server shell runs as a real child process, the test suite shall assert that the access URL it prints matches its bound endpoint [[server-shell-1](#server-shell-1)] and that on SIGTERM the process exits cleanly with its port closed [[server-shell-6](#server-shell-6)].

### Page Connection Coverage

#### server-shell-13

Where a browser-document environment stands at a served page URL, the test suite shall drive the UI's endpoint resolution through the page-connection cases and assert each outcome of [[server-shell-5](#server-shell-5)]: the same-origin `ws:`/`wss:` endpoint carrying the token, the address bar scrubbed with the page-session copy surviving a reload, the URL token kept unscrubbed where storage is blocked, `?core=` precedence with the token still adopted, and the unchanged fallback.

### Source-Run Coverage

#### server-shell-15

Where built server artifacts and a controlled npm executable are available on a POSIX host, when the source-run integration suite invokes root `npm run start:server` with explicit host, ephemeral port, token, config, and data-directory arguments, the suite shall assert the source-launch flow:

- the launcher invokes `npm run build` at the repository root before starting the real compiled server [[server-shell-14](#server-shell-14)];
- the forwarded arguments govern the printed reachable access URL, config status, and created state root [[server-shell-14](#server-shell-14)] [[server-shell-1](#server-shell-1)];
- SIGTERM delivered to the launcher lifecycle process shuts the core down cleanly, makes the root command return 0, and closes the bound port [[server-shell-6](#server-shell-6)].

### Compression Coverage

#### server-shell-17

Where the integration suite runs separate server-shell instances against the staged UI bundle and a type-complete temporary bundle, when it requests bundle files over real HTTP, it shall assert the negotiated representation cases of [[server-shell-16](#server-shell-16)]: Brotli preference across differing positive qualities, gzip fallback, identity without an offered coding, explicit quality-zero exclusion, nonzero wildcard offers, `Content-Encoding` and `Vary` headers, a real staged asset's identity body matching the bundle bytes from which it was materialized [[server-shell-4](#server-shell-4)], byte-identical decoded and identity bodies after the page's `connect-src` retargeting, every compressible and excluded file type, and HEAD coding headers matching GET.

### Cache Coverage

#### server-shell-19

Where the server shell serves mutable fixture assets, when the integration suite exercises cached representations, it shall assert the cache cases:

- a cold HEAD carries the GET-selected coding headers [[server-shell-16](#server-shell-16)] without reading or sending a body [[server-shell-4](#server-shell-4)] and does not seed the cache [[server-shell-18](#server-shell-18)];
- a failed cold GET stores no cache entry [[server-shell-18](#server-shell-18)], so a later successful request materializes the current bytes [[server-shell-4](#server-shell-4)];
- separate resolved paths and content codings keep independent entries, and matching size and modification time reuse the encoded body whose decoded bytes remain those from which the selected representation was materialized [[server-shell-4](#server-shell-4)] [[server-shell-18](#server-shell-18)];
- changing either size or modification time refreshes the decoded response from the current file [[server-shell-18](#server-shell-18)];
- a fresh launch does not reuse an earlier launch's cache entry [[server-shell-18](#server-shell-18)];
- an index edit that preserves size and modification time is still observed because the index remains uncached [[server-shell-18](#server-shell-18)], and distinct Host values produce independently retargeted bodies [[server-shell-4](#server-shell-4)] after content coding [[server-shell-16](#server-shell-16)];
- a populated path later resolving outside the bundle is rejected [[server-shell-4](#server-shell-4)] before cache reuse [[server-shell-18](#server-shell-18)].

### Browser Journey Coverage

#### server-shell-21

Where the browser journey harness ([DR-039](../decisions/039-browser-acceptance-journeys.md)) starts the server shell from code with core overrides naming the fake adapter, a ready adapter runtime, and the scripted Captain, when a browser opens the shell's token URL, the test suite shall assert that the page connects to its own origin and drops the token from the address bar, that a reload reconnects without the token [[server-shell-5](#server-shell-5)], and that the served core answers through the overrides — readiness reporting the fake environment ready and a turn running the scripted narration [[server-shell-20](#server-shell-20)].
