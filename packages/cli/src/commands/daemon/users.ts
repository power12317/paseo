import path from "node:path";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { Command } from "commander";
import { password, isCancel } from "@clack/prompts";
import { hashDaemonPassword, isBearerTokenValidAsync } from "@getpaseo/server/auth";
import { readPersistedConfig, savePersistedConfig } from "@getpaseo/server/configuration";
import { addLocalDaemonOptions } from "../../utils/command-options.js";
import { withOutput, type CommandOptions } from "../../output/index.js";

function result(data: Record<string, unknown>) {
  return {
    type: "single" as const,
    data,
    schema: {
      idField: () => "users",
      columns: [],
      renderHuman: () => JSON.stringify(data, null, 2),
    },
  };
}
function homeOf(options: CommandOptions): string {
  if (options.daemonTarget.kind !== "instance")
    throw new Error("User configuration requires a local --home");
  return options.daemonTarget.home;
}

export async function savePasswordSpace(
  home: string,
  id: string,
  roots: string[],
  secret: string,
  name?: string,
): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id))
    throw new Error("Use 1–64 letters, digits, underscores or hyphens for the user id");
  if (!secret || Buffer.byteLength(secret) > 72)
    throw new Error("Password must contain 1–72 UTF-8 bytes");
  const projectRoots = roots.map((root) =>
    path.resolve(root.startsWith("~/") ? path.join(homedir(), root.slice(2)) : root),
  );
  if (!projectRoots.length) throw new Error("At least one --root is required");
  for (const root of projectRoots)
    if (!(await stat(root)).isDirectory()) throw new Error(`Not a directory: ${root}`);
  const config = readPersistedConfig(home);
  const spaces = config.daemon?.userSpaces ?? [];
  const hashes = [
    config.daemon?.auth?.password,
    ...spaces.filter((space) => space.id !== id).map((space) => space.passwordHash),
  ];
  for (const hash of hashes)
    if (hash && (await isBearerTokenValidAsync({ password: hash, token: secret })))
      throw new Error("This password already belongs to another user or the owner");
  const space = {
    id,
    ...(name ? { name } : {}),
    passwordHash: hashDaemonPassword(secret),
    projectRoots,
  };
  savePersistedConfig(home, {
    ...config,
    daemon: { ...config.daemon, userSpaces: [...spaces.filter((item) => item.id !== id), space] },
  });
}

export function daemonUsersCommand(): Command {
  const users = new Command("users").description(
    "Manage password spaces and their project roots (local operation)",
  );
  addLocalDaemonOptions(users.command("set <id>"))
    .requiredOption("--root <paths...>", "Project root directories on the daemon computer")
    .option("--name <name>", "Display name")
    .action(
      withOutput(async (id: string, options: CommandOptions, _command: Command) => {
        if (!process.stdin.isTTY)
          throw new Error(
            "Run users set in an interactive terminal; passwords are never accepted as command-line arguments",
          );
        const first = await password({ message: `Password for ${id}` });
        if (isCancel(first)) throw new Error("Cancelled");
        const second = await password({ message: "Confirm password" });
        if (isCancel(second) || first !== second) throw new Error("Passwords do not match");
        const roots = options.root;
        if (
          !Array.isArray(roots) ||
          !roots.every((root): root is string => typeof root === "string")
        )
          throw new Error("Invalid --root");
        const home = homeOf(options);
        await savePasswordSpace(
          home,
          id,
          roots,
          first,
          typeof options.name === "string" ? options.name : undefined,
        );
        return result({
          action: "saved",
          user: id,
          roots,
          configPath: path.join(home, "config.json"),
          message:
            "Restart the daemon to apply user changes. Existing chats are retained when changing a password.",
        });
      }),
    );
  addLocalDaemonOptions(users.command("list")).action(
    withOutput(async (options: CommandOptions, _command: Command) => {
      const config = readPersistedConfig(homeOf(options));
      return result({
        users: (config.daemon?.userSpaces ?? []).map(({ id, name, projectRoots }) => ({
          id,
          name,
          projectRoots,
        })),
      });
    }),
  );
  addLocalDaemonOptions(users.command("remove <id>")).action(
    withOutput(async (id: string, options: CommandOptions, _command: Command) => {
      const home = homeOf(options);
      const config = readPersistedConfig(home);
      const remaining = (config.daemon?.userSpaces ?? []).filter((space) => space.id !== id);
      savePersistedConfig(home, {
        ...config,
        daemon: { ...config.daemon, userSpaces: remaining.length ? remaining : undefined },
      });
      return result({
        action: "removed",
        user: id,
        message: "Restart to apply. User data remains on disk.",
      });
    }),
  );
  return users;
}
