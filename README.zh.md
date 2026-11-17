---
description: "面向 DeepSeek Harness 的独立 Caveman 集成，提供回答风格与可恢复的工具结果压缩。"
kind: "package-bundle"
---

# @lornatang/dsh-caveman

[English](README.md) | 中文

> **开发中。** 本仓库保存了完整的上游公开源码快照，但 DSH 适配层尚未复刻全部上游能力，npm 包尚未发布。使用前请查看[已知限制](#known-limitations-and-deferred-work)。

## 概要

`dsh-caveman` 是 [Caveman](https://github.com/JuliusBrussee/caveman) 的独立 DeepSeek Harness 集成。它注册上游原始回答风格技能，按会话跟踪模式变化，并可借助上游 middleware 压缩符合条件的原生工具结果，同时保留原文恢复途径。可选的 Blocks 和 Browse 集成提供 shell 建议和浏览器工具。命令行包装器把参数转发给上游已发布的 CLI。`upstream/` 保存上游提交 `9b243662ff98d392bc0a95b865a554583d71be75` 的完整公开源码。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发者注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把 bundle 安装到需要使用 Caveman 的会话所在的 profile。需要 Node.js 22.19 或更新版本，以及 DSH 0.2.2-rc.3 或更新版本。

### 安装到 profile

npm 发布后，可使用以下命令安装和移除：

```text
dsh plugin --profile <name> add @lornatang/dsh-caveman
dsh plugin --profile <name> remove @lornatang/dsh-caveman
```

该包目前尚未发布，因此现在不能通过 npm 的 `add` 命令安装。要试用当前开发版，请先打包仓库，再安装生成的本地 tarball：

```sh
git clone https://github.com/Lornatang/dsh-caveman.git
cd dsh-caveman
npm ci
npm pack
dsh plugin --profile <name> add ./lornatang-dsh-caveman-0.1.0.tgz
```

`add` 命令把 bundle 组合进 profile：`cordis.patch.yml` 插入一条 id 为 `caveman` 的行，`package.json` 通过 `dsh.bundle.patch` 声明该 patch。行不带配置时，插件采用上游回答模式默认值，压缩、Blocks 和 Browse 均未启用。`add` 或 `remove` 后重启 DSH：profile 加载时才会组合这条行。

### 你会得到

| 暴露面 | 提供方 |
|---|---|
| 上游 Caveman 技能与按会话隔离的回答规则 | 宿主入口、`src/skills.ts` 和 `src/mode.ts` |
| 报告当前会话已记录用量的 `/caveman-stats` | 宿主入口、`src/stats.ts` |
| 启用后可恢复的原生工具结果压缩及 `caveman_retrieve` | 宿主入口、`src/compression.ts` 和上游 middleware |
| 配置 Blocks 后的 shell 命令建议 | 宿主入口、`src/blocks.ts` 和上游 Blocks 钩子 |
| 配置 Browse 后的 `mcp__caveman_browse__*` 工具 | DSH MCP manager 和上游 Browse 服务 |
| 作为 Node 包安装时提供的 `dsh-caveman` 命令 | `scripts/caveman-cli.mjs` 和上游 CLI |

### 配置

bundle 自带不含配置的 `caveman` 行。在 profile 的 `cordis.patch.yml` 中加入覆盖行，只列出需要修改的字段：

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- id: caveman
  config:
    defaultMode: manual
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `defaultMode` | 上游配置，未设置时为 `caveman` | 每个会话的初始回答模式。 |
| `inputCompression` | `false` | 启用可恢复的原生工具结果压缩。 |
| `middlewareEndpoint` | `http://127.0.0.1:8787` | 上游 middleware 地址；当前只允许回环地址。 |
| `blocksBinary` | 未设置 | 上游 Blocks 可执行文件的绝对路径。 |
| `browseBinary` | 未设置 | 上游 Browse 可执行文件的绝对路径；需要 DSH MCP manager。 |

### 回答模式与命令

默认模式为 `caveman`。`/caveman`、`/ultracave`、`/megacave`、`/caveman ultra`、`/caveman wenyan`、`/caveman status` 与 `stop caveman` 均由上游解析器识别。模式按 DSH 会话隔离。全部 22 个原始技能正文均可由用户显式调用；其中 `caveman`、`ultracave`、`megacave`、`caveman-help`、`caveman-commit`、`caveman-review`、`caveman-compress` 和 `caveman-stats` 也可由模型调用，其余仅供用户显式调用。部分技能涉及上游 CLI、账号或其他 agent 集成，需要单独配置；`caveman-compress` 还需要其上游说明中的 Python 与模型提供方配置。

可在 profile 行中选择启动模式：

```yaml
- id: caveman
  config:
    defaultMode: manual
```

可选值为 `caveman`、`ultracave`、`megacave`、`manual` 和 `off`。`manual` 从普通回答开始，仍允许显式启用；`off` 遵循上游关闭默认模式的行为。profile 显式配置优先；未配置时，上游解析器依次检查 `CAVEMAN_DEFAULT_MODE`、项目配置和用户配置，均未设置时使用 `caveman`。

`/caveman-stats` 报告当前 DSH 会话已提交 assistant 消息中记录的用量，说明有多少消息包含用量，排除未提交的尝试，并将节省量标记为未知。Claude Code 实现中的历史统计和分享选项不受支持。

### 可恢复的工具结果压缩

压缩需要显式启用。先在回环地址启动兼容的上游 Caveman middleware，且将 middleware 模式设为 `compress`，再配置 profile 行：

```yaml
- id: caveman
  config:
    defaultMode: caveman
    inputCompression: true
    middlewareEndpoint: 'http://127.0.0.1:8787'
```

只考虑成功、仅含一个文本块且不少于 2048 个 UTF-16 代码单元的原生工具结果。上游 SDK 可能决定保留原文。应用压缩结果前，适配层检查模型能否使用准确的 `caveman_retrieve` 工具。未修改的结果保留在 DSH 会话日志中；模型请求准备好后，适配层把原文恢复到可见会话。middleware 停止时，也可从该会话日志恢复原文分页。运行时不可用、拒绝请求或无法提供恢复时，原结果保持不变。本适配层没有开启远程内容传输。

### 上游 CLI

本包提供 `dsh-caveman` 命令，把参数和退出状态转发给 `@caveman-ai/cli` 4.1.0。在源码目录可运行 `node scripts/caveman-cli.mjs --help`。这仍是上游 CLI，遵循其设置和账号要求；命令转发不代表所有上游 agent 集成都已原生接入 DSH。

### Blocks 建议

要启用上游 Blocks 钩子，请安装兼容的 `caveman-blocks` 程序，并在 profile 行中填写其绝对路径：

```yaml
- id: caveman
  config:
    blocksBinary: '/absolute/path/to/caveman-blocks'
```

适配层在执行前把每个 `bash` 或 `pwsh` 命令及其工作目录传给上游 generic 钩子。返回的提示随工具结果提供给模型；它不会拒绝或改写命令。钩子不可用或失败时会被忽略。上游钩子读取本地 `.blocks` 目录，可能在状态目录保存脱敏的脚本记录与使用数据；其遥测遵循[上游设置](https://github.com/caveman-ai/blocks/blob/main/docs/TELEMETRY.md)。本适配层面向本地工作区。

### Browse

安装兼容的上游 `caveman-browse` 程序，并配置其绝对路径：

```yaml
- id: caveman
  config:
    browseBinary: '/absolute/path/to/caveman-browse'
```

在提供 `mcpManager` 的 DSH profile 中，插件会在自身生命周期内注册原始 Browse MCP 服务。快照、操作、JavaScript 求值和恢复工具以 `mcp__caveman_browse__*` 名称提供。Browse 默认启动专用的无头 Chrome；浏览器和恢复存储设置由上游服务控制，包括 `CAVEMAN_BROWSE_CHROME`。这些工具共享该服务的浏览器状态，可以导航并运行 JavaScript；它们独立于其他 DSH 浏览器提供方，不会自动拦截其他提供方的结果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕</summary>

| 路径 | 职责 |
|---|---|
| `cordis.patch.yml` | 将宿主行安装到选定 profile。 |
| `src/index.ts` | 注册技能，并在用户轮次注入会话对应的回答规则。 |
| `src/skills.ts` | 通过 `ctx.skills` 提供上游技能正文及资源目录。 |
| `src/mode.ts` | 用上游模式解析器重放用户编写的会话消息。 |
| `src/stats.ts` | 报告 DSH 会话中已记录的用量，不推断节省量。 |
| `src/compression.ts` | 调用上游 middleware、检查恢复工具、临时投影符合条件的结果并恢复原始 surface。 |
| `src/blocks.ts` | 把 shell 调用转发给上游 generic Blocks 钩子并提供提示。 |
| `scripts/caveman-cli.mjs` | 转发到上游 CLI。 |
| `upstream/` | 完整公开源码快照及上游许可证、声明。 |
| `tests/` | 真实 DSH 注册表和会话测试，以及可选的上游代理集成测试。 |

适配层只读取用户直接编写的消息来切换模式；注入上下文和被引用的触发词不会切换。压缩结果是引用原始事件的 DSH surface 替换。请求构造后恢复原文；取消或卸载插件时，也会恢复仍在等待的投影。恢复句柄按会话隔离。上游 SDK 默认只允许回环端点，除非显式允许远程内容传输；本包没有开启该选项。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [上游 Caveman 仓库](https://github.com/JuliusBrussee/caveman) — 原项目、安装与基准。
- [上游 middleware 协议](upstream/docs/technical/middleware-protocol.md) — 优化与恢复契约。
- [上游许可](upstream/LICENSING.md)与 [NOTICE](NOTICE) — 源码及第三方归属。
- [实现计划](docs/superpowers/plans/2026-11-17-dsh-caveman.md) — 尚未完成的对齐工作。

-----

<a id="model-experience"></a>
## 模型体验

模型在用户轮次收到所选的上游回答规则。原生工具结果可在模型请求中替换为上游生成的较短结果，并带有 `caveman_retrieve` 句柄；用户提示词本身不会被改写。本 DSH 集成没有声明任何节省比例或质量等价百分比。

#### KV Cache 影响

切换模式以及替换、恢复工具结果 surface 会改变会话历史，可能使缓存前缀失效。实际缓存行为取决于提供方；本集成尚未测量该影响。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 这**尚不是完整的 Caveman DSH 移植**。自动选模、其他浏览器提供方的结果拦截、缓存保温、上游历史统计和 Cavecrew 预设尚未接入 DSH。
- Browse 需要 DSH MCP manager、单独安装的上游程序和 Chrome；只有配置 `browseBinary` 后才会启动。
- Blocks 建议需要显式配置上游程序与本地工作区；适配层不会安装 Blocks，也不会配置其他 agent。
- 原生结果压缩需要单独运行兼容的上游 middleware，默认关闭；目前不压缩 PTC `run_code` 结果或富内容、多块工具结果。
- 其余 14 个只能由用户显式调用的技能保留原始说明；注册到 DSH 并不表示其外部 CLI、Cloud 或其他 agent 依赖已原生接入 DSH。
- 离线恢复只从同一 DSH 会话提供精确分页；按文本查询仍需要上游 middleware。
- 上游托管 Cloud 服务是独立的专有软件，不包含在公开源码快照中。CLI 可按上游账号和条款访问该服务。
- 项目尚未发布到 npm，也尚未合入 dshmarket 目录。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者上下文</summary>

`npm run typecheck` 检查 TypeScript；`npm test` 构建并运行本地测试。要验证 middleware、Blocks 和 Browse 集成，请把 `CAVEMAN_PROXY_BINARY`、`CAVEMAN_BLOCKS_BINARY` 和 `CAVEMAN_BROWSE_BINARY` 分别指向上游 `bin-v4.1.0` 程序，并把 `CAVEMAN_BROWSE_CHROME` 指向 Chrome；未设置时对应测试会跳过。`npm run test:dsh` 在隔离的 DSH profile 中安装并启动包。`npm pack` 通过 `prepack` 运行测试。DSH 测试使用本地 mock 模型，不测量模型质量或提供方账单。`upstream/` 是参考快照；适配层修改放在根目录 `src/`。

</details>

本独立项目与上游作者没有隶属或背书关系。
