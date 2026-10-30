import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { compare } from "bcryptjs";
import { WebSocketServer } from "ws";
import type { Logger } from "pino";
import { WSHelloMessageSchema, type WSHelloMessage } from "@getpaseo/protocol/messages";
import {
  createPaseoDaemon,
  parseListenString,
  type ListenTarget,
  type PaseoDaemon,
  type PaseoDaemonConfig,
  type PaseoDaemonDependencies,
} from "../bootstrap.js";
import { extractHttpBearerToken, extractWsBearerProtocol, extractWsBearerToken } from "../auth.js";
import { isHostnameAllowed } from "../hostnames.js";
import { matchesLocalCredential, deleteLocalCredential } from "../local-credential.js";
import { getOrCreateServerId } from "../server-id.js";
import { loadOrCreateDaemonKeyPair } from "../daemon-keypair.js";
import { createRelayRuntime, type RelayRuntime } from "../relay-runtime.js";
import { admitSecuredRelaySocket } from "../websocket/secure-relay-ingress.js";
import type { ExternalSocketMetadata, WebSocketLike } from "../websocket-server.js";
import { expandProjectPath } from "./project-directories.js";

// Spaces reuse the existing runtime in this process, with unbound HTTP servers. Only this
// gateway listens; no child daemons, proxy ports or per-user OS environments are created.
export async function createPasswordSpaceDaemon(
  config: PaseoDaemonConfig,
  logger: Logger,
  dependencies: PaseoDaemonDependencies,
): Promise<PaseoDaemon> {
  const spaces = config.userSpaces ?? [];
  const configuredTarget = parseListenString(config.listen);
  if (configuredTarget.type !== "tcp")
    throw new Error("Password spaces require a TCP listen address");
  if (new Set(spaces.map((space) => space.id)).size !== spaces.length)
    throw new Error("Duplicate password space id");
  const runtimes = new Map<string, Promise<PaseoDaemon>>();
  const active = new Map<string, PaseoDaemon>();
  const target: ListenTarget = { ...configuredTarget };
  let localCredential: string | null = null;
  let relay: RelayRuntime | null = null;
  let stopping = false;
  const serverId = getOrCreateServerId(config.paseoHome, { logger });
  const keypair = await loadOrCreateDaemonKeyPair(config.paseoHome, logger);
  const gatewayRelayConfig = () =>
    relay?.getConfig() ?? {
      enabled: config.relayEnabled === true,
      endpoint: config.relayEndpoint ?? "relay.paseo.sh:443",
      publicEndpoint: config.relayPublicEndpoint ?? config.relayEndpoint ?? "relay.paseo.sh:443",
      useTls: config.relayUseTls ?? true,
      publicUseTls: config.relayPublicUseTls ?? true,
    };

  const getRuntime = (id: string): Promise<PaseoDaemon> => {
    if (stopping) return Promise.reject(new Error("Daemon is stopping"));
    const existing = runtimes.get(id);
    if (existing) return existing;
    const pending = (async () => {
      const space = spaces.find((item) => item.id === id);
      if (id !== "_owner" && !space) throw new Error("Unknown password space");
      const home = space ? path.join(config.paseoHome, "users", space.id) : config.paseoHome;
      await mkdir(home, { recursive: true, mode: 0o700 });
      const roots = space?.projectRoots.map(expandProjectPath);
      const runtime = await createPaseoDaemon(
        {
          ...config,
          userSpaces: undefined,
          projectRoots: roots,
          paseoHome: home,
          agentStoragePath: path.join(home, "agents"),
          worktreesRoot: roots
            ? path.join(roots[0]!, ".paseo-worktrees", space!.id)
            : config.worktreesRoot,
          auth: space ? { password: space.passwordHash } : config.auth,
          relayEnabled: false,
          relayEnabledMutable: false,
          serviceProxy: { publicBaseUrl: null, standaloneListen: null },
          configReload: undefined,
          managedProcesses: undefined,
        },
        logger.child({ userSpace: id }),
        {
          ...dependencies,
          virtualTransport: {
            target,
            basePath: `/_paseo/${id}`,
            pairingHome: config.paseoHome,
            getRelayConfig: gatewayRelayConfig,
          },
        },
      );
      await runtime.start();
      active.set(id, runtime);
      return runtime;
    })();
    runtimes.set(id, pending);
    void pending.catch(() => runtimes.delete(id));
    return pending;
  };

  const resolvePassword = async (
    password: string | null,
    local = false,
  ): Promise<string | null> => {
    if (password === null) return null;
    if (local && localCredential && matchesLocalCredential(localCredential, password))
      return "_owner";
    let match: string | null = null;
    if (config.auth?.password && (await compare(password, config.auth.password))) match = "_owner";
    for (const space of spaces) {
      if (await compare(password, space.passwordHash)) {
        if (match) throw new Error("A password matches multiple user spaces");
        match = space.id;
      }
    }
    return match;
  };

  const handleHttp = async (req: IncomingMessage, res: ServerResponse) => {
    if (!isHostnameAllowed(req.headers.host, config.hostnames ?? config.allowedHosts)) {
      res.writeHead(403).end("Host not allowed");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const internal = url.pathname.match(/^\/_paseo\/([a-zA-Z0-9_-]+)(\/.*)$/);
    if (internal) {
      if (internal[2] !== "/mcp/agents" && internal[2] !== "/api/terminal-activity") {
        res.writeHead(404).end();
        return;
      }
      // Internal MCP, activity and plugin routes retain the runtime's own capability checks.
      const runtime = await getRuntime(internal[1]!);
      req.url = `${internal[2]}${url.search}`;
      runtime.dispatchHttp(req, res);
      return;
    }
    const token = extractHttpBearerToken(req.headers.authorization);
    let id = await resolvePassword(token, url.pathname === "/api/status");
    if (!id && url.pathname === "/api/files/download") {
      const download = url.searchParams.get("token") ?? "";
      id = [...active].find(([, runtime]) => runtime.ownsDownloadToken(download))?.[0] ?? null;
    }
    const publicRequest =
      req.method === "OPTIONS" ||
      url.pathname === "/api/health" ||
      (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/mcp/"));
    if (!id && !publicRequest) {
      res.writeHead(401).end("Unauthorized");
      return;
    }
    (await getRuntime(id ?? "_owner")).dispatchHttp(req, res);
  };
  const httpServer = createServer((req, res) => {
    void handleHttp(req, res).catch((error: unknown) => {
      logger.error({ err: error }, "Password space HTTP request failed");
      if (!res.headersSent) res.writeHead(503);
      res.end("User space unavailable");
    });
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 32 * 1024 * 1024,
    handleProtocols: (protocols) => {
      for (const protocol of protocols) if (protocol.startsWith("paseo.bearer.")) return protocol;
      return false;
    },
  });
  const routeClient = (
    ws: WebSocketLike,
    metadata?: ExternalSocketMetadata,
    headerPassword?: string | null,
  ) => {
    let admitted = false;
    let handling = false;
    const queued: unknown[][] = [];
    const timer = setTimeout(() => {
      if (!admitted) ws.close(4001, "Hello timeout");
    }, 15_000);
    timer.unref();
    ws.once("close", () => clearTimeout(timer));
    ws.once("error", () => clearTimeout(timer));
    ws.on("message", (...args) => {
      if (admitted) return;
      if (handling) {
        if (queued.length < 16) queued.push(args);
        else ws.close(1009, "Too many pending messages");
        return;
      }
      handling = true;
      void (async () => {
        const data = args[0];
        let text = "";
        if (typeof data === "string") text = data;
        else if (Buffer.isBuffer(data)) text = data.toString("utf8");
        if (text.length > 64 * 1024) throw new Error("Hello too large");
        const hello = WSHelloMessageSchema.parse(JSON.parse(text));
        const password =
          hello.auth?.kind === "password" ? hello.auth.password : (headerPassword ?? null);
        const id =
          hello.auth?.kind === "localCredential"
            ? await resolvePassword(hello.auth.token, true)
            : await resolvePassword(password);
        if (!id) {
          ws.send(
            JSON.stringify({
              type: "hello.rejected",
              reason: password ? "incorrect_password" : "password_required",
              accepts: ["password"],
            }),
          );
          ws.close(4003, password ? "Incorrect password" : "Password required");
          return;
        }
        const runtime = await getRuntime(id);
        const routedHello: WSHelloMessage =
          headerPassword && !hello.auth
            ? { ...hello, auth: { kind: "password", password: headerPassword } }
            : hello;
        admitted = true;
        clearTimeout(timer);
        await runtime.attachClient(ws, routedHello, metadata);
        const emitter = ws as WebSocketLike & {
          emit?: (event: string, ...values: unknown[]) => void;
        };
        for (const buffered of queued) emitter.emit?.("message", ...buffered);
        queued.length = 0;
      })().catch((error: unknown) => {
        logger.warn({ err: error }, "Password space admission failed");
        ws.close(4002, "Unable to open user space");
      });
    });
  };
  httpServer.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin;
    const allowed = new Set(["paseo://app", ...config.corsAllowedOrigins]);
    const sameOrigin =
      origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
    if (
      new URL(req.url ?? "/", "http://localhost").pathname !== "/ws" ||
      !isHostnameAllowed(req.headers.host, config.hostnames ?? config.allowedHosts) ||
      (origin && !sameOrigin && !allowed.has("*") && !allowed.has(origin))
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const password =
      extractHttpBearerToken(req.headers.authorization) ??
      extractWsBearerToken(extractWsBearerProtocol(req.headers["sec-websocket-protocol"]));
    wss.handleUpgrade(req, socket, head, (ws) => routeClient(ws, undefined, password));
  });
  const owner = await getRuntime("_owner");
  return {
    ...owner,
    config,
    async start() {
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(configuredTarget.port, configuredTarget.host, () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      const address = httpServer.address();
      if (!address || typeof address === "string") throw new Error("Missing gateway address");
      Object.assign(target, { port: address.port });
      localCredential = (
        await readFile(path.join(config.paseoHome, "local-credential"), "utf8")
      ).trim();
      for (const space of spaces) await getRuntime(space.id);
      relay = createRelayRuntime({
        config: gatewayRelayConfig(),
        logger,
        serverId,
        attachSocket: (socket, metadata) =>
          admitSecuredRelaySocket(
            socket,
            {
              daemonKeyPair: keypair.keyPair,
              logger,
              requireProtectedMode: () => config.relayRequireProtectedSecurity === true,
            },
            async (secured) =>
              routeClient(secured.socket, {
                ...metadata,
                transport: "relay",
                securityMode: secured.securityMode,
              }),
          ),
      });
      logger.info(
        { listen: target, users: spaces.map((space) => space.id) },
        "Password spaces listening on one daemon port",
      );
    },
    async stop(options) {
      stopping = true;
      await relay?.stop();
      for (const socket of wss.clients) socket.close(1001, "Daemon stopping");
      const results = await Promise.allSettled(
        [...runtimes.values()].map(async (runtime) => (await runtime).stop(options)),
      );
      wss.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await deleteLocalCredential(config.paseoHome);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
    getListenTarget: () => target,
    getServerId: () => serverId,
  };
}
