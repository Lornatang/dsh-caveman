---
description: "An independent DeepSeek Harness integration of Caveman's response styles and recoverable tool-result compression."
kind: "package-bundle"
---

# @lornatang/dsh-caveman

English | [中文](README.zh.md)

> **Work in progress.** This repository contains the full upstream source snapshot, but its DSH adapter does not yet reproduce every upstream capability. The npm package has not been released. See [Known Limitations](#known-limitations-and-deferred-work) before trying it.

## Summary

`dsh-caveman` is an independent integration of [Caveman](https://github.com/JuliusBrussee/caveman) for DeepSeek Harness. It registers the original response-style skills, tracks mode changes separately for each session, and can use the original Caveman middleware to shorten eligible native tool results while preserving a route back to the original. Optional Blocks and Browse integrations supply shell suggestions and browser tools. Its command-line wrapper forwards arguments to the published upstream CLI. The complete public upstream source at commit `9b243662ff98d392bc0a95b865a554583d71be75` is preserved under `upstream/`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install the bundle into the profile whose sessions should use Caveman. Node.js 22.19 or newer and DSH 0.2.2-rc.3 or newer are required.

### Install into a profile

After the npm release, install and remove the package with:

```text
dsh plugin --profile <name> add @lornatang/dsh-caveman
dsh plugin --profile <name> remove @lornatang/dsh-caveman
```

The package has not been published yet, so the npm `add` command is not available today. To try the current development build, pack the repository and add the resulting local tarball:

```sh
git clone https://github.com/Lornatang/dsh-caveman.git
cd dsh-caveman
npm ci
npm pack
dsh plugin --profile <name> add ./lornatang-dsh-caveman-0.1.0.tgz
```

The `add` command composes the bundle into the profile: `cordis.patch.yml` inserts a row with id `caveman`, and `package.json` declares the patch through `dsh.bundle.patch`. With no row configuration, the plugin uses the upstream voice-mode default and leaves compression, Blocks, and Browse disabled. Restart DSH after `add` or `remove`, because the row is composed when the profile loads.

### What you get

| Surface | Provided by |
|---|---|
| Original Caveman skills and per-session voice instructions | host entry, `src/skills.ts` and `src/mode.ts` |
| `/caveman-stats` for recorded current-session usage | host entry, `src/stats.ts` |
| Recoverable native tool-result compression and `caveman_retrieve`, when enabled | host entry, `src/compression.ts` and the upstream middleware |
| Shell-command suggestions, when Blocks is configured | host entry, `src/blocks.ts` and the upstream Blocks hook |
| `mcp__caveman_browse__*` tools, when Browse is configured | DSH MCP manager and the upstream Browse server |
| `dsh-caveman` command when installed as a Node package | `scripts/caveman-cli.mjs` and the upstream CLI |

### Configuration

The bundle ships a `caveman` row without configuration. Add a row override to the profile's `cordis.patch.yml` for the fields you want to change:

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- id: caveman
  config:
    defaultMode: manual
```

| Field | Default | Meaning |
|---|---|---|
| `defaultMode` | upstream configuration, otherwise `caveman` | Initial voice mode for each session. |
| `inputCompression` | `false` | Enable recoverable native tool-result compression. |
| `middlewareEndpoint` | `http://127.0.0.1:8787` | Upstream middleware endpoint; only loopback is enabled. |
| `blocksBinary` | unset | Absolute path to an upstream Blocks executable. |
| `browseBinary` | unset | Absolute path to an upstream Browse executable; requires DSH's MCP manager. |

### Voice and commands

The default mode is `caveman`. `/caveman`, `/ultracave`, `/megacave`, `/caveman ultra`, `/caveman wenyan`, `/caveman status`, and `stop caveman` use the upstream parser. A mode belongs to one DSH session. All 22 original skill bodies are available for explicit invocation. The model can also invoke `caveman`, `ultracave`, `megacave`, `caveman-help`, `caveman-commit`, `caveman-review`, `caveman-compress`, and `caveman-stats`; the remaining skills are user-invocable only. Some skills refer to upstream CLI commands, accounts, or other agent integrations that require separate setup. `caveman-compress` also needs the Python and model-provider setup described in its upstream skill.

The bundle's profile row can choose a startup mode:

```yaml
- id: caveman
  config:
    defaultMode: manual
```

The values are `caveman`, `ultracave`, `megacave`, `manual`, and `off`. `manual` starts with normal replies and permits explicit activation; `off` uses the upstream off-default behavior. An explicit profile value takes precedence. Without one, the upstream resolver checks `CAVEMAN_DEFAULT_MODE`, project configuration, and user configuration, in that order, and otherwise selects `caveman`.

`/caveman-stats` reports usage attached to committed assistant messages in the current DSH session. It states how many messages included usage, excludes uncommitted attempts, and marks savings as unknown. Historical or sharing options from the Claude Code implementation are not supported.

### Recoverable tool-result compression

Compression is opt-in. Start a compatible upstream Caveman middleware runtime on loopback with middleware mode set to `compress`, then enable the profile row:

```yaml
- id: caveman
  config:
    defaultMode: caveman
    inputCompression: true
    middlewareEndpoint: 'http://127.0.0.1:8787'
```

Only successful native tool results with a single text block of at least 2048 UTF-16 code units are considered. The upstream SDK may keep an eligible result unchanged. Before applying a replacement, the adapter verifies that the exact `caveman_retrieve` tool is available to the model. The unmodified tool result remains in the DSH session log; the adapter restores it to the visible session after preparing the model request. If the middleware stops, exact original pages can also be recovered from that session log. A runtime that is unavailable, refuses the request, or cannot provide recovery leaves the original unchanged. Remote content transfer is not enabled by this adapter.

### Upstream CLI

The package includes a `dsh-caveman` command that forwards arguments and exit status to `@caveman-ai/cli` 4.1.0. In a checkout, run `node scripts/caveman-cli.mjs --help`. This is the upstream CLI, including its own setup and account requirements; forwarding a command does not make every upstream agent integration native to DSH.

### Blocks suggestions

To enable the upstream Blocks hook, install a compatible `caveman-blocks` binary and set its absolute path in the profile row:

```yaml
- id: caveman
  config:
    blocksBinary: '/absolute/path/to/caveman-blocks'
```

The adapter passes each `bash` or `pwsh` command and its working directory to the original generic hook before execution. A returned hint reaches the model alongside the tool result; it does not deny or rewrite the command. An unavailable or failing hook is ignored. The upstream hook reads the local `.blocks` directory and may save scrubbed script sightings and usage data to its state directory; it follows [upstream telemetry settings](https://github.com/caveman-ai/blocks/blob/main/docs/TELEMETRY.md). The adapter is intended for local workspaces.

### Browse

Install a compatible upstream `caveman-browse` binary and configure its absolute path:

```yaml
- id: caveman
  config:
    browseBinary: '/absolute/path/to/caveman-browse'
```

On a DSH profile with `mcpManager`, the plugin registers the original Browse MCP server for its own lifetime. Its snapshot, action, JavaScript evaluation, and recovery tools appear under `mcp__caveman_browse__*`. Browse starts a dedicated headless Chrome by default; the original server controls its browser and recovery-store settings, including `CAVEMAN_BROWSE_CHROME`. The tools share that server's browser state and can navigate and run JavaScript. These tools are separate from other DSH browser providers; their results are not intercepted automatically.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

| Path | Responsibility |
|---|---|
| `cordis.patch.yml` | Installs the host row into the selected profile. |
| `src/index.ts` | Registers skills and injects per-session voice instructions on user turns. |
| `src/skills.ts` | Serves original skill bodies and their resource directories through `ctx.skills`. |
| `src/mode.ts` | Replays user-authored session messages through the upstream mode parser. |
| `src/stats.ts` | Reports recorded DSH session usage without inferring savings. |
| `src/compression.ts` | Calls upstream middleware, checks recovery-tool visibility, temporarily projects eligible tool results, and restores their original surface. |
| `src/blocks.ts` | Forwards shell calls to the upstream generic Blocks hook and delivers its hint. |
| `scripts/caveman-cli.mjs` | Forwards to the upstream CLI without embedding a second copy. |
| `upstream/` | Complete public source snapshot, with upstream licenses and notices. |
| `tests/` | Real DSH registry/session tests and optional tests against the upstream proxy binary. |

The adapter reads only direct user messages for mode switches; injected contexts and quoted triggers do not change mode. The compressed result is a DSH surface replacement citing the earlier original event. The replacement is restored after request construction, and on cancellation or plugin disposal when a pending projection remains. Recovery handles are scoped to the session. The upstream SDK restricts the configured endpoint to loopback unless its explicit remote-content option is enabled; this package does not enable it.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Upstream Caveman repository](https://github.com/JuliusBrussee/caveman) — original product, installation, and benchmarks.
- [Upstream middleware protocol](upstream/docs/technical/middleware-protocol.md) — optimization and recovery contract.
- [Upstream licensing](upstream/LICENSING.md) and [NOTICE](NOTICE) — source and third-party attribution.
- [Implementation plan](docs/superpowers/plans/2026-11-17-dsh-caveman.md) — remaining parity work.

-----

<a id="model-experience"></a>
## Model Experience

The model receives the selected upstream voice instructions on user turns. A native tool result can be replaced in a model request by an upstream-generated shorter result with a `caveman_retrieve` handle; the user prompt itself is not rewritten. No savings or quality-equivalence percentage is claimed for this DSH integration.

#### KV Cache effect

Changing mode or replacing and restoring a tool-result surface changes session history and may invalidate cached prefixes. Actual cache behavior depends on the provider; this integration has not measured its effect.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- This is **not yet a complete DSH port** of Caveman. Auto model routing, interception of other browser providers, cache warming, upstream historical statistics, and Cavecrew presets are not integrated into DSH.
- Browse requires the DSH MCP manager and a separately installed upstream binary and Chrome; it starts only when `browseBinary` is configured.
- Blocks suggestions require an explicitly configured upstream binary and a local workspace; the adapter does not install Blocks or configure other agents.
- Native compression requires an independently running compatible upstream middleware service. It is disabled by default and currently does not shorten PTC `run_code` or rich/multiblock tool results.
- The 14 user-invocable-only skills retain their original instructions; availability in the registry does not make their external CLI, Cloud, or other-agent dependencies native to DSH.
- Offline recovery serves exact pages from the same DSH session; text-query recovery still requires the upstream middleware.
- The upstream hosted Cloud service is separate proprietary software and is not included in the public snapshot. The CLI can access the upstream service under its own account and terms.
- The project has not been published to npm or merged into the dshmarket catalog.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context</summary>

`npm run typecheck` checks TypeScript; `npm test` builds and runs the local suite. To exercise the middleware, Blocks, and Browse integrations, set `CAVEMAN_PROXY_BINARY`, `CAVEMAN_BLOCKS_BINARY`, and `CAVEMAN_BROWSE_BINARY` to the respective pinned upstream `bin-v4.1.0` executables, and set `CAVEMAN_BROWSE_CHROME` to Chrome. Tests without the corresponding values are skipped. `npm run test:dsh` installs and boots the pack in an isolated DSH profile. `npm pack` runs the test suite through `prepack`. The DSH tests use a local mock model and do not measure model quality or provider billing. `upstream/` is preserved as a reference snapshot; adapter changes belong in root `src/`.

</details>

This independent project is not affiliated with or endorsed by the upstream author.
