#!/usr/bin/env node
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
      auth: { password: hashDaemonPassword("smoke-owner") },
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
const cliEnv = { ...process.env };
delete cliEnv.PASEO_HOME;
delete cliEnv.PASEO_HOST;
delete cliEnv.PASEO_PASSWORD;
const execFileAsync = promisify(execFile);
const runCli = (args) =>
  execFileAsync(path.join(packageRoot, "bin/paseo"), [...args, "--home", home], {
    env: cliEnv,
    timeout: 90_000,
  });
let daemonStopped = false;
let managedStarted = false;
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
  await Promise.all(clients.map((connection) => connection.close()));
  await daemon.stop();
  daemonStopped = true;
  // Exercise the shipped CLI and supervisor, including the credential rotation during restart.
  // An in-process daemon cannot catch a failure while reconnecting to a replacement worker.
  managedStarted = true;
  await runCli(["daemon", "start", "--timeout", "60"]);
  const before = JSON.parse((await runCli(["daemon", "status", "--json"])).stdout);
  const restarted = JSON.parse(
    (await runCli(["daemon", "restart", "--timeout", "60", "--json"])).stdout,
  );
  assert.equal(restarted.action, "restarted");
  assert.equal(restarted.supervisorPid, before.pid);
  assert.equal(restarted.previousWorkerPid, before.workerPid);
  assert.notEqual(restarted.workerPid, before.workerPid);
  const after = JSON.parse((await runCli(["daemon", "status", "--json"])).stdout);
  assert.equal(after.connectedDaemon, "reachable");
  assert.equal(after.serverId, before.serverId);
  assert.equal(after.workerPid, restarted.workerPid);
  await runCli(["daemon", "stop", "--timeout", "30"]);
  managedStarted = false;
  console.log(
    JSON.stringify(
      {
        installedVersion: require("./package.json").version,
        projects: "separate",
        relativeSearch: "passed",
        nativeTerminal: "passed",
        localCliRestart: "passed",
        updateTarget,
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all(clients.map((client) => client.close()));
  if (!daemonStopped) await daemon.stop();
  if (managedStarted) await runCli(["daemon", "stop", "--force", "--timeout", "15"]);
  await rm(root, { recursive: true, force: true });
}
