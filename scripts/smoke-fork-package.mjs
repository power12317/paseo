#!/usr/bin/env node
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const prefix = path.resolve(process.argv[2]);
const packageRoot = path.join(
  prefix,
  process.platform === "win32" ? "node_modules" : "lib/node_modules",
  "@getpaseo/cli",
);
const require = createRequire(path.join(packageRoot, "package.json"));
const load = (specifier) => import(pathToFileURL(require.resolve(specifier)).href);
const { createPaseoDaemon } = await load("@getpaseo/server");
const { loadConfig } = await load("@getpaseo/server/configuration");
const { hashDaemonPassword } = await load("@getpaseo/server/auth");
const { DaemonClient } = await load("@getpaseo/client/internal/daemon-client");
const { resolveCliUpdateTarget } = await import(
  pathToFileURL(
    path.join(
      packageRoot,
      "node_modules/@getpaseo/server/dist/server/server/session/daemon/npm-global-cli.js",
    ),
  ).href
);
const WebSocket = require("ws");
const pino = require("pino");
const root = await mkdtemp(path.join(os.tmpdir(), "paseo-installed-smoke-"));
const home = path.join(root, "home");
const aRoot = path.join(root, "alice");
const bRoot = path.join(root, "bob");
await mkdir(home);
await mkdir(path.join(aRoot, "团队", "订单服务"), { recursive: true });
await mkdir(bRoot);
await writeFile(
  path.join(home, "config.json"),
  JSON.stringify({
    daemon: {
      listen: "127.0.0.1:0",
      relay: { enabled: false },
      userSpaces: [
        { id: "alice", passwordHash: hashDaemonPassword("smoke-alice"), projectRoots: [aRoot] },
        { id: "bob", passwordHash: hashDaemonPassword("smoke-bob"), projectRoots: [bRoot] },
      ],
    },
  }),
);
const config = loadConfig(home, { env: {} });
config.pluginsEnabled = false;
config.mcpEnabled = false;
const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));
const clients = [];
try {
  await daemon.start();
  const address = daemon.getListenTarget();
  assert.equal(address.type, "tcp");
  const client = (password) => {
    const result = new DaemonClient({
      url: `ws://127.0.0.1:${address.port}/ws`,
      password,
      clientId: `smoke-${password}`,
      webSocketFactory: (url, options) =>
        new WebSocket(url, options?.protocols, { headers: options?.headers }),
    });
    clients.push(result);
    return result;
  };
  const alice = client("smoke-alice");
  const bob = client("smoke-bob");
  await Promise.all([alice.connect(), bob.connect()]);
  assert.notEqual(
    alice.getLastServerInfoMessage().serverId,
    bob.getLastServerInfoMessage().serverId,
  );
  const matches = await alice.getDirectorySuggestions({ query: "团队/订" });
  assert(matches.directories.includes(path.join(aRoot, "团队", "订单服务")));
  await alice.addProject(path.join(aRoot, "团队", "订单服务"));
  assert.equal((await bob.listProjects()).projects.length, 0);
  const created = await alice.createWorkspace({ source: { kind: "directory", path: aRoot } });
  assert(created.workspace, created.error ?? "Missing workspace");
  const terminal = await alice.createTerminal(aRoot, "Installed package shell", undefined, {
    workspaceId: created.workspace.id,
  });
  assert.equal(terminal.error, null);
  assert(terminal.terminal);
  assert.equal((await bob.listTerminals()).terminals.length, 0);
  const updateTarget = await resolveCliUpdateTarget();
  assert.equal(
    updateTarget,
    "https://github.com/power12317/paseo/releases/latest/download/paseo-latest.tgz",
  );
  console.log(
    JSON.stringify(
      {
        installedVersion: require("./package.json").version,
        projects: "separate",
        relativeSearch: "passed",
        nativeTerminal: "passed",
        updateTarget,
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all(clients.map((client) => client.close()));
  await daemon.stop();
  await rm(root, { recursive: true, force: true });
}
