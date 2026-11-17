---
description: "Caveman voice, recoverable compression, browser tools, and delegation for DeepSeek Harness."
kind: "package-bundle"
---

# @lornatang/dsh-caveman

English | [中文](README.zh.md)

## Summary

`dsh-caveman` brings Caveman skills and tools to DeepSeek Harness. It provides session-specific response styles, recoverable tool-result compression, Auto model routing, Blocks suggestions, Browse tools, and Cavecrew delegation. Install the bundle into a profile to make these capabilities available to its sessions.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Node.js 22.19 or newer and DSH are required. Install the bundle into the profile whose sessions should use Caveman.

### Install into a profile

After npm publication, install and remove the package with:

```text
dsh plugin --profile <name> add @lornatang/dsh-caveman
dsh plugin --profile <name> remove @lornatang/dsh-caveman
```

To install a package built from the repository:

```sh
git clone https://github.com/Lornatang/dsh-caveman.git
cd dsh-caveman
npm ci
npm pack
dsh plugin --profile <name> add ./lornatang-dsh-caveman-0.1.0.tgz
```

The `add` command composes the bundle into the profile. Its patches insert the `caveman` row, three Cavecrew presets, and their delegation tools. Restart DSH after `add` or `remove` so the profile reloads its composition.

### What you get

| Surface | Provided by |
|---|---|
| Caveman skills and session-specific response styles | `src/skills.ts`, `src/mode.ts` |
| `/caveman-stats` for recorded session usage | `src/stats.ts` |
| Recoverable tool-result compression and `caveman_retrieve` | `src/compression.ts` and the middleware runtime |
| Auto model selection | DSH pi-ai provider and Caveman proxy |
| Shell suggestions | `src/blocks.ts` and Blocks |
| `mcp__caveman_browse__*` browser tools | DSH MCP manager and Browse |
| `cavecrew-investigator`, `cavecrew-builder`, `cavecrew-reviewer` | `presets/cavecrew.patch.yml` and `src/cavecrew.ts` |
| `dsh-caveman` command when installed as a Node package | `scripts/caveman-cli.mjs` and `@caveman-ai/cli` |

### Configuration

The bundle supplies a `caveman` row. Override only the fields you want to change in the profile's `cordis.patch.yml`:

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- id: caveman
  config:
    defaultMode: manual
```

| Field | Default | Meaning |
|---|---|---|
| `defaultMode` | Configuration-derived, otherwise `caveman` | Starting voice for a session. |
| `inputCompression` | auto | Use a verified local runtime when available; set `false` to disable or `true` to use the configured endpoint. |
| `middlewareEndpoint` | `http://127.0.0.1:8787` | Loopback middleware address. |
| `blocksBinary` | auto-detected | Override the absolute path to `caveman-blocks`. |
| `browseBinary` | auto-detected | Override the absolute path to `caveman-browse`; requires the DSH MCP manager. |

### Voice and usage

Use `/caveman`, `/ultracave`, `/megacave`, `/caveman ultra`, `/caveman wenyan`, `/caveman status`, or `stop caveman`. Mode changes belong to the current session. All 22 Caveman skills are available for explicit invocation; the model can also invoke the skills whose metadata permits it.

`defaultMode` accepts `caveman`, `ultracave`, `megacave`, `manual`, or `off`. An explicit profile value wins; otherwise the resolver checks `CAVEMAN_DEFAULT_MODE`, project configuration, and user configuration before falling back to `caveman`.

`/caveman-stats` reports usage recorded on committed assistant messages in the current session. It identifies missing usage and excludes uncommitted attempts. Savings remain unknown without a comparison.

### Recoverable compression

Start the local Caveman middleware in `compress` mode. With the `input` module enabled, the plugin detects its loopback listener and verifies it against the runtime's local run-state before sending tool content. Set `inputCompression: false` to turn this off. To explicitly use a configured middleware endpoint, set:

```yaml
- id: caveman
  config:
    inputCompression: true
    middlewareEndpoint: 'http://127.0.0.1:8787'
```

Text blocks of at least 2048 UTF-16 code units in successful native tool results are eligible; other blocks remain intact. The model receives a recovery handle only when `caveman_retrieve` is callable. The original remains in the session log and is restored to the visible session after the model request is prepared. If the runtime becomes unavailable, the session can still return exact original pages.

### Auto model selection

Install the [Caveman CLI](https://www.npmjs.com/package/@caveman-ai/cli), sign in with `caveman login`, enable the `routing` module, and start the local proxy with `caveman start`. Make an OpenAI credential available to DSH as `OPENAI_API_KEY`.

Merge the `caveman-auto` provider from [examples/caveman-auto.patch.yml](examples/caveman-auto.patch.yml) into the existing `llm-pi-ai` provider configuration, preserving other providers, and select its `caveman-auto` model. The example is an excerpt; replacing the entire provider map with it would remove other routes.

When Auto is selected and routing is enabled, the proxy sends the latest and previous user asks, the tail of the last assistant response, and request facts to Caveman Cloud to select a model. The Free plan may retain that information to improve routing. When routing is off, the proxy falls back to its OpenAI default model; provider billing still applies. See the [privacy details](https://github.com/JuliusBrussee/caveman/blob/main/docs/technical/security-and-privacy.md).

### Blocks and Browse

When `caveman-blocks` is installed, `bash` and `pwsh` calls can receive Blocks suggestions. Suggestions accompany the result and do not change the command. Blocks reads the local `.blocks` directory and may save scrubbed script observations and usage data; see its [telemetry settings](https://github.com/caveman-ai/blocks/blob/main/docs/TELEMETRY.md).

When `caveman-browse` is installed, the DSH MCP manager registers `mcp__caveman_browse__browser_snapshot`, `browser_act`, `browser_eval`, and `browser_recover`. Browse starts a dedicated headless Chrome by default. Its tools share the server's browser state and can navigate and run JavaScript.

The plugin looks for each binary in its `CAVEMAN_BLOCKS_BIN` or `CAVEMAN_BROWSE_BIN` override, on `PATH`, then in `$CAVEMAN_HOME/bin` (or `~/.caveman/bin`). Profile paths take precedence. The `scripts` and `browse` module switches are read on startup; restart DSH after changing them.

### Cavecrew

The bundle defines the `cavecrew-investigator`, `cavecrew-builder`, and `cavecrew-reviewer` presets and corresponding delegation tools. The investigator and reviewer can read and search files and inspect Git through `cavecrew_git`; the builder can read and edit up to two file paths. The Git tool provides the read-only operations relevant to each role. They require the profile's agent-preset registry and in-process subagent provider.

Each role inherits its parent provider and model. Set `CAVECREW_INVESTIGATOR_MODEL`, `CAVECREW_BUILDER_MODEL`, or `CAVECREW_REVIEWER_MODEL` before starting DSH to select another model on that provider for the corresponding role.

### Command-line interface

When installed as a Node package, `dsh-caveman` forwards arguments and exit status to `@caveman-ai/cli`. In a checkout, run `node scripts/caveman-cli.mjs --help`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

| Path | Responsibility |
|---|---|
| `cordis.patch.yml` and `presets/cavecrew.patch.yml` | Compose the host plugin, presets, and delegation tools. |
| `src/index.ts` | Register skills, session voice instructions, and optional integrations. |
| `src/skills.ts` and `src/mode.ts` | Provide skill content and resolve session mode changes. |
| `src/stats.ts` | Report recorded session usage. |
| `src/compression.ts` | Prepare recoverable tool-result projections and restore the session surface. |
| `src/blocks.ts` | Supply Blocks suggestions for shell calls. |
| `src/cavecrew.ts` | Install Cavecrew personas and scope their tools. |
| `scripts/caveman-cli.mjs` | Forward command-line arguments. |
| `tests/` | Verify DSH services, runtime integrations, and package installation. |

Mode changes use direct user messages. Compression keeps the original session event and restores any pending projection during cleanup. Recovery handles are scoped to a session.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [CHANGELOG.md](CHANGELOG.md) — package changes.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — profile and plugin configuration.
- [NOTICE](NOTICE) and [LICENSE](LICENSE) — licensing and attribution.

-----

<a id="model-experience"></a>
## Model Experience

The selected voice is supplied to the model on user turns. Eligible tool results can be shortened in model requests with a `caveman_retrieve` handle. User prompts are not rewritten. Savings and quality depend on the workload and have not been measured for this integration.

#### KV Cache effect

Changing voice or replacing and restoring a tool-result surface can change the cached prefix. Cache behavior depends on the provider.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations

- Auto requires a configured pi-ai provider, Caveman proxy, Cloud login, and OpenAI credential. The integration tests use local mock services.
- Browse requires the MCP manager, `caveman-browse`, and Chrome. Blocks requires `caveman-blocks` and a local workspace.
- Native compression handles text blocks in native tool results. Offline recovery returns exact pages; text-query recovery requires the middleware.
- Some skills require additional CLI, account, or agent setup.
- Cavecrew's inspection roles use read, search, and read-only Git tools; the builder can edit existing files and is limited to two file paths.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context</summary>

`npm run typecheck` checks TypeScript; `npm test` builds and runs the tests. Set `CAVEMAN_PROXY_BINARY`, `CAVEMAN_BLOCKS_BINARY`, and `CAVEMAN_BROWSE_BINARY` to compatible executables and `CAVEMAN_BROWSE_CHROME` to Chrome to run the runtime integration tests. Auto's test also requires OpenSSL. `npm run test:dsh` installs, boots, and removes the pack in an isolated profile. `npm pack` runs the test suite through `prepack`. `npm run benchmark` measures skill discovery and session mode replay on synthetic input.

</details>
