import type { SessionInboundMessage } from "@getpaseo/protocol/messages";
import { readdir as fsReadDir, realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import pLimit from "p-limit";
import { scorePathMatch } from "@getpaseo/protocol/search/text-match";
import type { DirectorySuggestionEntry } from "../../utils/directory-suggestions.js";

const io = pLimit(2);
const pendingIo = new Map<string, Promise<unknown>>();
function filesystemCall<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const pending = pendingIo.get(key);
  if (pending) return pending as Promise<T>;
  const promise = io(operation).finally(() => pendingIo.delete(key));
  pendingIo.set(key, promise);
  return promise;
}
const realpath = (value: string) => filesystemCall(`realpath:${value}`, () => fsRealpath(value));
const stat = (value: string) => filesystemCall(`stat:${value}`, () => fsStat(value));
const readdir = (value: string) =>
  filesystemCall(`readdir:${value}`, () => fsReadDir(value, { withFileTypes: true }));

const listings = new Map<
  string,
  { expires: number; entries: Promise<DirectorySuggestionEntry[]> }
>();
const skipped = new Set([".git", "node_modules", "vendor", "dist", "build", "target"]);

export function expandProjectPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return path.resolve(value);
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function nearestRealPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
    )
      throw error;
    const parent = path.dirname(value);
    if (parent === value) throw error;
    return path.join(await nearestRealPath(parent), path.basename(value));
  }
}

export async function assertProjectPath(roots: readonly string[], value: string): Promise<void> {
  const candidate = await nearestRealPath(expandProjectPath(value));
  for (const configured of roots) {
    const root = await realpath(expandProjectPath(configured)).catch(() => null);
    if (root && inside(root, candidate)) return;
  }
  throw new Error(`Project directory is outside this user's configured roots: ${roots.join(", ")}`);
}

function children(directory: string): Promise<DirectorySuggestionEntry[]> {
  const cached = listings.get(directory);
  if (cached && cached.expires > Date.now()) return cached.entries;
  if (listings.size > 512) listings.delete(listings.keys().next().value!);
  const entries = (async () => {
    const result: DirectorySuggestionEntry[] = [];
    for (const item of await readdir(directory)) {
      if (item.name.startsWith(".") || skipped.has(item.name)) continue;
      const entryPath = path.join(directory, item.name);
      if (
        item.isDirectory() ||
        (item.isSymbolicLink() && (await stat(entryPath).catch(() => null))?.isDirectory())
      ) {
        result.push({ path: entryPath, kind: "directory" });
      }
    }
    return result.sort((a, b) => a.path.localeCompare(b.path));
  })().catch((error: unknown) => {
    listings.delete(directory);
    throw error;
  });
  listings.set(directory, { expires: Date.now() + 5_000, entries });
  return entries;
}

export async function searchUserDirectories(input: {
  roots: readonly string[];
  query: string;
  limit?: number;
}): Promise<DirectorySuggestionEntry[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      searchUserDirectoriesNow(input),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Directory search timed out; check the SMB mount or narrow the configured root",
              ),
            ),
          2_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// This endpoint serves the existing client's search picker. Clicking a returned row still adds
// a project; typing a slash requests the next level without requiring the full absolute path.
async function searchUserDirectoriesNow(input: {
  roots: readonly string[];
  query: string;
  limit?: number;
}): Promise<DirectorySuggestionEntry[]> {
  const roots = input.roots.map(expandProjectPath);
  const query = input.query.trim();
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const matches = new Map<string, DirectorySuggestionEntry>();
  const add = async (entry: DirectorySuggestionEntry) => {
    try {
      await assertProjectPath(roots, entry.path);
      const canonical = await realpath(entry.path);
      if (!matches.has(canonical)) matches.set(canonical, entry);
    } catch {
      /* A disconnected mount or out-of-root link is not a project candidate. */
    }
  };
  const list = async (directory: string) => {
    await assertProjectPath(roots, directory);
    await add({ path: directory, kind: "directory" });
    for (const child of await children(directory)) {
      await add(child);
      if (matches.size >= limit) break;
    }
  };
  if (!query || query === "." || query === "./") {
    for (const root of roots) await list(root);
    return [...matches.values()].slice(0, limit);
  }
  if (path.isAbsolute(query) || query.startsWith("~/")) {
    const requested = expandProjectPath(query);
    await assertProjectPath(roots, requested);
    if ((await stat(requested).catch(() => null))?.isDirectory()) {
      await list(requested);
    } else {
      for (const child of await children(path.dirname(requested))) {
        if (
          path.basename(child.path).toLowerCase().startsWith(path.basename(requested).toLowerCase())
        )
          await add(child);
      }
    }
    return [...matches.values()].slice(0, limit);
  }
  const relativeQuery = query.replace(/^\.\//, "");
  if (query.endsWith("/")) {
    for (const root of roots) {
      const candidate = path.resolve(root, relativeQuery);
      try {
        await list(candidate);
      } catch {
        /* Try the next configured mount. */
      }
    }
    return [...matches.values()].slice(0, limit);
  }
  const slash = relativeQuery.lastIndexOf("/");
  if (slash >= 0) {
    const prefix = relativeQuery.slice(slash + 1).toLowerCase();
    for (const root of roots) {
      const parent = path.resolve(root, relativeQuery.slice(0, slash));
      await assertProjectPath(roots, parent);
      for (const child of await children(parent).catch(() => [])) {
        if (path.basename(child.path).toLowerCase().startsWith(prefix)) await add(child);
      }
    }
    return [...matches.values()].slice(0, limit);
  }
  await searchKeywords(roots, relativeQuery, matches, add, limit);

  return [...matches.values()].slice(0, limit);
}

async function searchKeywords(
  roots: string[],
  relativeQuery: string,
  matches: Map<string, DirectorySuggestionEntry>,
  add: (entry: DirectorySuggestionEntry) => Promise<void>,
  limit: number,
): Promise<void> {
  const pending = roots.map((directory) => ({ directory, depth: 0 }));
  const visited = new Set<string>();
  const deadline = Date.now() + 1_000;
  let scanned = 0;
  while (pending.length && scanned < 2_000 && Date.now() < deadline) {
    const item = pending.shift()!;
    const canonical = await realpath(item.directory).catch(() => null);
    if (!canonical || visited.has(canonical)) continue;
    visited.add(canonical);
    const allowed = await assertProjectPath(roots, item.directory).then(
      () => true,
      () => false,
    );
    if (!allowed) continue;
    for (const entry of await children(item.directory).catch(() => [])) {
      if (scanned >= 2_000 || Date.now() >= deadline) return;
      scanned++;
      const relative =
        roots
          .map((root) => path.relative(root, entry.path))
          .find((value) => !value.startsWith("..")) ?? entry.path;
      if (scorePathMatch(relativeQuery, relative) !== null) await add(entry);
      if (item.depth < 5) pending.push({ directory: entry.path, depth: item.depth + 1 });
      if (matches.size >= limit) return;
    }
  }
}

export async function assertProjectRequest(
  roots: readonly string[] | undefined,
  msg: SessionInboundMessage,
): Promise<void> {
  if (!roots) return;
  if ("cwd" in msg && typeof msg.cwd === "string" && msg.cwd.trim())
    await assertProjectPath(roots, msg.cwd);
  if (msg.type === "workspace.create.request") {
    const directory = msg.source.kind === "directory" ? msg.source.path : msg.source.cwd;
    if (directory) await assertProjectPath(roots, directory);
  }
  if (msg.type === "project.create_directory.request")
    await assertProjectPath(roots, msg.parentPath);
  if (msg.type === "project.github.clone.request")
    await assertProjectPath(roots, msg.targetDirectory);
  if (msg.type === "fetch_recent_provider_sessions_request" || msg.type === "import_agent_request")
    throw new Error(
      "External provider history import is disabled for password spaces; create a Chat in Paseo instead.",
    );
}
