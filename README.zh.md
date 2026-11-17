---
description: "面向 DeepSeek Harness 的 Caveman 回答风格、可恢复压缩、浏览器工具与子代理。"
kind: "package-bundle"
---

# @lornatang/dsh-caveman

[English](README.md) | 中文

## 概要

`dsh-caveman` 为 DeepSeek Harness 提供 Caveman 技能和工具，包括按会话隔离的回答风格、可恢复的工具结果压缩、Auto 选模、Blocks 建议、Browse 工具和 Cavecrew 子代理。将 bundle 安装到 profile 后，该 profile 的会话即可使用相应能力。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制](#known-limitations-and-deferred-work)
- [开发者注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

需要 Node.js 22.19 或更新版本以及 DSH。把 bundle 安装到需要使用 Caveman 的会话所在的 profile。

### 安装到 profile

npm 发布后，可使用以下命令安装和移除：

```text
dsh plugin --profile <name> add @lornatang/dsh-caveman
dsh plugin --profile <name> remove @lornatang/dsh-caveman
```

也可以从仓库打包并安装：

```sh
git clone https://github.com/Lornatang/dsh-caveman.git
cd dsh-caveman
npm ci
npm pack
dsh plugin --profile <name> add ./lornatang-dsh-caveman-0.1.0.tgz
```

`add` 命令把 bundle 组合进 profile。patch 会插入 `caveman` 行、三个 Cavecrew 预设及其委派工具。`add` 或 `remove` 后重启 DSH，使 profile 重新加载配置。

### 你会得到

| 暴露面 | 提供方 |
|---|---|
| Caveman 技能与按会话隔离的回答风格 | `src/skills.ts`、`src/mode.ts` |
| 报告当前会话已记录用量的 `/caveman-stats` | `src/stats.ts` |
| 可恢复的工具结果压缩与 `caveman_retrieve` | `src/compression.ts` 和 middleware 运行时 |
| Auto 自动选模 | DSH pi-ai provider 和 Caveman 代理 |
| Shell 命令建议 | `src/blocks.ts` 和 Blocks |
| `mcp__caveman_browse__*` 浏览器工具 | DSH MCP manager 和 Browse |
| `cavecrew-investigator`、`cavecrew-builder`、`cavecrew-reviewer` | `presets/cavecrew.patch.yml` 和 `src/cavecrew.ts` |
| 作为 Node 包安装时提供的 `dsh-caveman` 命令 | `scripts/caveman-cli.mjs` 和 `@caveman-ai/cli` |

### 配置

bundle 自带 `caveman` 行。在 profile 的 `cordis.patch.yml` 中添加覆盖行，只列出需要修改的字段：

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- id: caveman
  config:
    defaultMode: manual
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `defaultMode` | 由配置决定，未设置时为 `caveman` | 会话的初始回答风格。 |
| `inputCompression` | `false` | 启用可恢复的原生工具结果压缩。 |
| `middlewareEndpoint` | `http://127.0.0.1:8787` | middleware 回环地址。 |
| `blocksBinary` | 自动查找 | 覆盖 `caveman-blocks` 的绝对路径。 |
| `browseBinary` | 自动查找 | 覆盖 `caveman-browse` 的绝对路径；需要 DSH MCP manager。 |

### 回答模式与用量

可使用 `/caveman`、`/ultracave`、`/megacave`、`/caveman ultra`、`/caveman wenyan`、`/caveman status` 和 `stop caveman`。模式切换只影响当前会话。22 个 Caveman 技能均可由用户显式调用，其中回答风格、提交、审查、压缩、帮助、统计和委派相关的九个技能也可由模型调用。

`defaultMode` 可设为 `caveman`、`ultracave`、`megacave`、`manual` 或 `off`。profile 的显式配置优先；否则依次检查 `CAVEMAN_DEFAULT_MODE`、项目配置和用户配置，均未设置时使用 `caveman`。

`/caveman-stats` 报告当前会话已提交 assistant 消息中记录的用量，说明哪些消息没有用量，排除未提交的尝试。没有对照数据时，节省量为未知。

### 可恢复压缩

在回环地址启动兼容的 Caveman middleware，并将其模式设为 `compress`，然后在 profile 中启用：

```yaml
- id: caveman
  config:
    inputCompression: true
    middlewareEndpoint: 'http://127.0.0.1:8787'
```

成功、只含一个文本块且不少于 2048 个 UTF-16 代码单元的原生工具结果可参与压缩。只有模型可以调用 `caveman_retrieve` 时才会提供恢复句柄。原文保留在会话日志中，模型请求准备好后会恢复到可见会话；运行时不可用时，仍可从会话恢复精确分页。

### Auto 自动选模

安装 [Caveman CLI](https://www.npmjs.com/package/@caveman-ai/cli)，通过 `caveman login` 登录，启用 `routing` 模块，再用 `caveman start` 启动本地代理。通过 DSH 凭证服务或环境变量提供 `OPENAI_API_KEY`。

把 [examples/caveman-auto.patch.yml](examples/caveman-auto.patch.yml) 中的 `caveman-auto` provider 加入现有 `llm-pi-ai` 配置，保留其他 provider，然后在 DSH 中选择其 `caveman-auto` 模型。示例只展示 provider map 的一部分；直接用它完整替换 map 会移除其他路由。

选择 Auto 并启用 routing 后，代理会把最近两次用户请求、上一次 assistant 回复的末尾及请求信息发送给 Caveman Cloud，以选择模型。免费计划下这些内容可能被保留用于改进路由。routing 关闭时，代理回退到 OpenAI 默认模型，仍可能产生模型费用。详见[隐私说明](https://github.com/JuliusBrussee/caveman/blob/main/docs/technical/security-and-privacy.md)。

### Blocks 和 Browse

安装 `caveman-blocks` 后，`bash` 和 `pwsh` 调用可收到 Blocks 建议。建议随结果提供，不会改写命令。Blocks 读取本地 `.blocks` 目录，并可能保存脱敏的脚本记录和使用数据；详见[遥测设置](https://github.com/caveman-ai/blocks/blob/main/docs/TELEMETRY.md)。

安装 `caveman-browse` 后，DSH MCP manager 会注册 `mcp__caveman_browse__browser_snapshot`、`browser_act`、`browser_eval` 和 `browser_recover`。Browse 默认启动专用的无头 Chrome；工具共享该服务的浏览器状态，可以导航并运行 JavaScript。

插件依次从 `CAVEMAN_BLOCKS_BIN` 或 `CAVEMAN_BROWSE_BIN`、`PATH`、`$CAVEMAN_HOME/bin`（默认 `~/.caveman/bin`）查找对应程序；profile 中的路径优先。`scripts` 和 `browse` 模块开关在启动时读取，修改后重启 DSH。

### Cavecrew

bundle 提供 `cavecrew-investigator`、`cavecrew-builder` 和 `cavecrew-reviewer` 预设及对应的委派工具。调查和审查角色可读取与搜索；构建角色可读取并编辑最多两个文件路径。这些角色不提供 shell。使用时 profile 需要 agent-preset registry 和进程内 subagent provider。

### 命令行

作为 Node 包安装时，`dsh-caveman` 把参数和退出状态转发给 `@caveman-ai/cli`。在源码目录可运行 `node scripts/caveman-cli.mjs --help`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕</summary>

| 路径 | 职责 |
|---|---|
| `cordis.patch.yml`、`presets/cavecrew.patch.yml` | 组合宿主插件、预设与委派工具。 |
| `src/index.ts` | 注册技能、会话回答规则和可选集成。 |
| `src/skills.ts`、`src/mode.ts` | 提供技能正文并解析会话模式切换。 |
| `src/stats.ts` | 报告已记录的会话用量。 |
| `src/compression.ts` | 准备可恢复的工具结果投影，并恢复会话 surface。 |
| `src/blocks.ts` | 为 shell 调用提供 Blocks 建议。 |
| `src/cavecrew.ts` | 安装 Cavecrew 角色规则并限定工具作用域。 |
| `scripts/caveman-cli.mjs` | 转发命令行参数。 |
| `tests/` | 验证 DSH 服务、运行时集成与包安装。 |

模式切换只读取用户直接编写的消息。压缩保留原始会话事件，并在清理时恢复等待中的投影；恢复句柄按会话隔离。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [CHANGELOG.md](CHANGELOG.md) — 包的变更。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — profile 和插件配置。
- [NOTICE](NOTICE)、[LICENSE](LICENSE) — 许可与归属。

-----

<a id="model-experience"></a>
## 模型体验

模型在用户轮次收到所选的回答规则。符合条件的工具结果可在模型请求中缩短，并附带 `caveman_retrieve` 句柄；用户提示词本身不会被改写。节省量和质量取决于实际任务，本集成没有对此作量化结论。

#### KV Cache 影响

切换回答风格以及替换、恢复工具结果 surface 可能改变缓存前缀。实际缓存行为取决于模型提供方。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制

- Auto 需要配置 pi-ai provider、Caveman 代理、Cloud 登录和 OpenAI 凭证；集成测试使用本地模拟服务。
- Browse 需要 MCP manager、`caveman-browse` 和 Chrome；Blocks 需要 `caveman-blocks` 与本地工作区。
- 原生压缩需要显式启用，处理单文本块的原生工具结果。离线恢复提供精确分页，按文本查询需要 middleware。
- 13 个技能需要用户显式调用，部分技能还需要额外的 CLI、账号或 agent 配置。
- Cavecrew 的只读角色使用读取和搜索工具；构建角色可编辑现有文件，限两个文件路径。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者上下文</summary>

`npm run typecheck` 检查 TypeScript；`npm test` 构建并运行测试。将 `CAVEMAN_PROXY_BINARY`、`CAVEMAN_BLOCKS_BINARY`、`CAVEMAN_BROWSE_BINARY` 分别设为兼容的可执行文件，并将 `CAVEMAN_BROWSE_CHROME` 设为 Chrome，可运行运行时集成测试。Auto 测试还需要 OpenSSL。`npm run test:dsh` 在隔离的 profile 中安装、启动并移除包；`npm pack` 通过 `prepack` 运行测试。

</details>
