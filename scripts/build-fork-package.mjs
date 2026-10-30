#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile, rm, chmod, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const root = path.resolve(import.meta.dirname, "..");
const base = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = process.argv[2] ?? `${base.version}-mod.1`;
if (!/^\d+\.\d+\.\d+-mod\.\d+$/.test(version)) throw new Error("Version must be X.Y.Z-mod.N");
const output = path.join(root, "releases");
const staging = path.join(os.tmpdir(), `paseo-fork-package-${process.pid}`);
const updateUrl = "https://github.com/power12317/paseo/releases/latest/download/paseo-latest.tgz";
await mkdir(output, { recursive: true });
await mkdir(staging, { recursive: true });
const packages = ["highlight", "relay", "protocol", "client", "plugin", "server", "cli"];
const dependencies = { "node-gyp-build-optional-packages": "5.2.2", "node-gyp-build": "4.8.4" };
const bundled = [];
try {
  for (const folder of packages) {
    const source = path.join(root, "packages", folder);
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", staging], {
        cwd: source,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }),
    )[0];
    const metadata = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
    for (const [name, range] of Object.entries(metadata.dependencies ?? {}))
      if (!name.startsWith("@getpaseo/")) dependencies[name] = range;
    const name = folder === "cli" ? "@getpaseo/cli-mod" : metadata.name;
    const destination = path.join(staging, "node_modules", name);
    await mkdir(destination, { recursive: true });
    execFileSync("tar", [
      "-xzf",
      path.join(staging, packed.filename),
      "--strip-components=1",
      "-C",
      destination,
    ]);
    const stagedManifest = JSON.parse(
      await readFile(path.join(destination, "package.json"), "utf8"),
    );
    stagedManifest.name = name;
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      if (stagedManifest[field]?.["@getpaseo/server"])
        stagedManifest[field]["@getpaseo/server"] = version;
    }

    if (folder === "cli" || folder === "server") stagedManifest.version = version;
    delete stagedManifest.scripts;
    delete stagedManifest.devDependencies;
    delete stagedManifest.bin;
    // npm treats the entire dependency closure of a bundled package as bundled. External
    // manifests therefore belong on the wrapper, rather than becoming empty bundle entries.
    stagedManifest.dependencies = Object.fromEntries(
      Object.entries(stagedManifest.dependencies ?? {}).filter(([dependency]) =>
        dependency.startsWith("@getpaseo/"),
      ),
    );
    delete stagedManifest.peerDependencies;
    delete stagedManifest.peerDependenciesMeta;
    delete stagedManifest.optionalDependencies;
    if (folder === "plugin") {
      const alias = "@getpaseo/plugin-acp-sdk-mod";
      dependencies[alias] =
        `npm:@agentclientprotocol/sdk@${metadata.dependencies["@agentclientprotocol/sdk"]}`;
      const rewrite = async (directory) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) await rewrite(file);
          else if (/\.(?:js|ts)$/.test(entry.name))
            await writeFile(
              file,
              (await readFile(file, "utf8")).replaceAll("@agentclientprotocol/sdk", alias),
            );
        }
      };
      await rewrite(path.join(destination, "dist"));
    }

    // Internal packages ship in this archive; their peer ranges retain the upstream protocol floor.
    await writeFile(
      path.join(destination, "package.json"),
      `${JSON.stringify(stagedManifest, null, 2)}\n`,
    );
    dependencies[name] = stagedManifest.version;
    bundled.push(name);
    await rm(path.join(staging, packed.filename));
  }
  await mkdir(path.join(staging, "bin"));
  await writeFile(
    path.join(staging, "bin", "paseo"),
    '#!/usr/bin/env -S node --disable-warning=DEP0040\nimport "@getpaseo/cli-mod/dist/index.js";\n',
  );
  await chmod(path.join(staging, "bin", "paseo"), 0o755);
  await writeFile(
    path.join(staging, "package.json"),
    `${JSON.stringify({ name: "@getpaseo/cli", version, description: "Paseo-mod: password spaces and project directory search", type: "module", bin: { paseo: "bin/paseo" }, files: ["bin", "README.md"], license: "Apache-2.0", repository: { type: "git", url: "https://github.com/power12317/paseo.git" }, engines: { node: ">=22" }, paseoFork: { updateUrl }, dependencies, bundledDependencies: bundled }, null, 2)}\n`,
  );
  await cp(path.join(root, "FORK.md"), path.join(staging, "README.md"));
  const result = JSON.parse(
    execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output], {
      cwd: staging,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }),
  )[0];
  const artifact = path.join(output, result.filename);
  await cp(artifact, path.join(output, "paseo-latest.tgz"));
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  await writeFile(
    path.join(output, "latest.json"),
    `${JSON.stringify({ version, sourceRevision: revision, url: updateUrl, integrity: result.integrity, shasum: result.shasum }, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({ artifact, version, size: result.size, bundled: result.bundled }, null, 2),
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
