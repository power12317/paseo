# Paseo-mod daemon

This fork adds password-selected personal spaces and root-scoped project directory search. The desktop/mobile client stays unchanged. One daemon process and one public port serve all spaces; each space has its own projects, chats, workspace labels, schedules and terminal runtime. Claude Code keeps the daemon OS user's existing environment and credentials.

## Install and upgrade

Requires Node.js 22 or newer and your existing Claude Code installation/login. Install the prebuilt tarball with npm:

```sh
npm install -g https://github.com/power12317/paseo/releases/latest/download/paseo-latest.tgz
paseo --version
```

The archive deliberately uses the existing `@getpaseo/cli` package name and `paseo` executable, so installing this URL replaces the official global CLI. It bundles this fork's compiled server and internal packages; it does not fetch an unmodified server from npm. External dependencies, including platform-native terminal and speech modules, install normally on the target machine.

Upgrade with the same URL. The daemon's existing self-update operation also reads this fork's update URL from its installed package, instead of installing the official npm latest. **Do not use `npm update -g @getpaseo/cli` or `npm install -g @getpaseo/cli@latest`: those select the official registry package.**

Installing does not automatically replace an already running daemon. Restart it when ready, using the CLI service command you already use. Back up `~/.paseo` before your first switch. Existing owner projects and chats stay at their existing paths.

Paseo Desktop manages its own bundled local daemon; use the installed fork as a separate server and connect the official desktop/mobile app to it. Do not use Desktop's local daemon auto-management to replace this installation.

## Configure users on the Mac mini

See the [Chinese multi-user CLI guide](docs/multi-user-cli.zh-CN.md) for user creation, password and root updates, client connections, deactivation, backups and troubleshooting.

Manual configuration uses `daemon.userSpaces` entries with `id`, optional `name`, `passwordHash`, and a nonempty `projectRoots` array. Use the CLI in the guide to generate password hashes and validate roots.

## Find projects without typing absolute paths

In the existing **Add Project → Search for directory** field:

- Type a short name, including Chinese, to search only your configured roots.
- Type `.` to list root directories and their immediate children.
- Type `团队/` to list that folder and its immediate children.
- Type `团队/订` to complete the next directory name, such as `团队/订单服务`.
- Paste an absolute path or `~/Documents/...` when you already know it.

Results are absolute paths on the daemon machine. Clicking a row adds that project; the existing client does not turn a row click into folder navigation. Search supports relative prefixes so you do not need to enter the root again. The unchanged client ignores server suggestions for an empty query, hence `.` is the initial-list shortcut. This release does not add a graphical Browse button.

Directory listings cache for five seconds. Keyword search uses breadth-first traversal with a one-second scheduling budget, 2,000-entry scan budget and six directory levels, returning up to 30 matches to the standard client. Search ignores common build/dependency folders. Prefer separate configured roots over one very large shared drive. A stuck filesystem operation can outlive the search budget; the daemon limits concurrent filesystem searches and reports mount timeouts.

SMB mounts may live under `/Volumes/...` or `~/Documents/...`. Configured symlink aliases are followed, canonical targets are checked and duplicate results are removed. macOS must allow the actual daemon launcher to read Documents/network volumes. Confirm the mount is readable by the same macOS user; the daemon does not mount SMB shares or change OS permissions.

Project placement and workspace creation are limited to the configured roots. Managed worktrees are placed inside the first root under `.paseo-worktrees/<id>/`. This is project organization for trusted collaborators, not OS-level containment of shell/agent tools. External Claude terminal-history discovery/import is disabled in user spaces; create Chats in Paseo normally.

Relay can be enabled in the gateway startup configuration; all users use its shared pairing offer and their own password. Configure relay centrally, then restart. Each space's runtime does not start another relay. Direct LAN/VPN is the primary integration-tested path.

## Releases through GitHub Actions

Push changes to `main`. The **Fork daemon release** workflow tests the daemon/CLI, builds the package, verifies a clean npm installation, and publishes a GitHub Release containing `paseo-latest.tgz`, a versioned tarball, and integrity metadata. It uses the workflow's built-in `GITHUB_TOKEN`; no personal GitHub login or npm registry token is required.

Each run uses `<upstream version>-mod.<GitHub run number>`. A re-run replaces that run's release assets. Older queued builds check the current `main` revision before publishing, so they cannot replace a newer source revision's release. Subsequent installs and the existing daemon self-update operation use the latest GitHub Release asset.

Local builds are for validation only:

```sh
npm ci
npm run build:server
node scripts/build-fork-package.mjs 0.14.0-mod.1
```

`releases/` is ignored by Git. The builder records the source commit in `latest.json`. Never run the upstream `release:publish` scripts for this fork.

The package contains CLI/daemon assets, not a rebuilt browser app. Use the existing desktop/mobile client or the hosted web client. The fork does not add an npm registry publishing requirement.
