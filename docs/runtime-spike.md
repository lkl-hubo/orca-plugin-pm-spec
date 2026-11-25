# P0-T3 运行时验证记录（Runtime Spike）

- 基线日期：2026-11-21
- 目标插件：``（`lkl.pm-spec`）
- 说明：本文件结构化记录交付方案第 2.2 节 P0-T3 定义的 8 项运行时假设验证。**①、②、⑤、⑥** 已完成源码与内置 CLI 帮助核验；**③、④、⑦、⑧** 已由 `spec-worker` 补充非破坏性真实运行时 / Bundled Pi 1.5.2 SDK / 宿主与插件测试实测证据（含剩余桌面 PTY / 外部模型鉴权边界说明）。

---

## 汇总表

| 编号 | 验证假设                                                                                                    | 当前状态                          | 核验结论摘要                                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①    | Worker / 面板中 `import './x.ts'` 相对导入被 Orca 转译器接受                                                | 已通过源码与运行实测              | 成立；`plugin validate`、`plugin check`（9 场景 0 issues）与 `plugin test`（13/13 通过）已实测验证 `.ts` / `.tsx` 模块加载                                       |
| ②    | `import { load } from '../vendor/js-yaml.mjs'` 可用                                                         | 已通过源码与运行实测              | 成立；`.mjs` 跳过 TS 转译由 Node 原生 ESM 加载，已在 `worker-fs.test.ts` 与 `plugin test` 中实际执行                                                             |
| ③    | `agent.launch` 对 `reviewAgent` 枚举中每个 ID 的接受情况                                                    | 已完成配置/CLI 实测（待真实 PTY） | 7 个 ID 均为合法 `TuiAgent`；默认启用 6 个、`claude` 默认在 `DEFAULT_DISABLED_TUI_AGENTS`；本机实测内置 `pi@1.5.2` 与 `codebuddy` 可用，其余 5 项未装于 PATH     |
| ④    | `agent.tool.before` 在 Claude Code 下可返回 `deny`                                                          | 已通过单测链实测（待真实 Claude） | 宿主 `server-claude-plugin-tool-calls.test.ts`（3/3）与插件 `tool-guard.worker.test.ts`（E20，2/2）均已实测通过；真实 Claude 会话需安装并启用 `claude` CLI       |
| ⑤    | 插件自身调用 `agent.launch` 触发 `agent.launch.before` 及 `workspaceId` 对应关系                            | 已通过源码与单测实测              | **触发成立**；`worktree` 下 `workspace.list` 返回 `identity:<key>` 而 Hook 收到 `<repoId>::<path>`，已在 `pi-launch-inject.worker.test.ts` 实测 `::` 后缀匹配    |
| ⑥    | Orca 生成的 `pi` 启动命令末尾追加 `--tools` 与 `--extension` 后内置 `pi` 1.5.2 正常启动且提示词投递不受影响 | 已通过源码与 CLI 实测             | 成立；`cli.js --help` 与 `parseArgs` 确认支持 `--tools` / `--extension`，且 `agent.launch` 首轮不带 `prompt`，并在存在 `--` 时插在其前方                         |
| ⑦    | `--tools` 白名单接受扩展注册的工具名 `pmspec_submit_findings`                                               | 已通过内置 Pi SDK 实测            | 成立；实测 `pi@1.5.2` `discoverAndLoadExtensions` + `createAgentSession({ tools: parsed.tools })` 零报错加载并激活仅 5 个白名单工具，排他写入 `guard-claim.json` |
| ⑧    | `pi` 的 `read`、`grep`、`find` 能读取工作区之外的绝对路径                                                   | 已通过内置 Pi 工具实测            | 成立；实测 `createReadOnlyTools(wsDir)` 下 `read`/`grep`/`find`/`ls` 均成功读取独立临时 sibling 目录中的绝对路径文件，无需额外 `pmspec_read_repo_file` 降级      |

---

## 分项详细核验记录

### ① Worker / 面板中 `import './x.ts'` 相对导入被 Orca 转译器接受

- **状态**：已通过源码核验成立
- **源码依据**：
  - `src/main/plugins/source-loading/plugin-module-candidate-paths.ts`：`PLUGIN_MODULE_RESOLVE_EXTENSIONS` 包含 `.tsx`、`.ts`、`.jsx`、`.js`、`.mts`、`.mjs`；`pluginModuleCandidatePaths(target)` 对带后缀相对导入（如 `./x.ts`）首先生成精确候选 `[target]`，同时支持 TypeScript ESM 风格（`./x.js` 映射到 `x.ts` / `x.tsx`）与无后缀导入。
  - `src/main/plugins/source-loading/plugin-source-sucrase-transform.ts`：`transformPluginSource` 与 `transformPluginSourceWithMappings` 使用 `sucrase`（`TRANSFORMS_BY_EXTENSION` 覆盖 `.ts`、`.mts`、`.tsx`、`.jsx`，`jsxRuntime: 'automatic'`、`jsxImportSource: 'orca'`、`disableESTransforms: true`）剥离类型和 JSX 并附加内联 Source Map。
  - Worker 侧：`src/main/plugins/workers/child-runtime/plugin-worker-source-hooks.ts` 通过 `node:module` 的 `registerHooks` 拦截插件根目录内相对导入（`./` / `../`）并调用 `pluginModuleCandidatePaths` 与 `transformPluginSource`；同目录集成测试 `src/main/plugins/workers/plugin-worker-typescript-entry.integration.test.ts` 已验证 `main.ts` 相对导入 `.ts` 模块并映射错误行号。
  - 面板侧：`src/main/plugins/panels/frame-serving/plugin-frame-module-resolution.ts` 与 `src/main/plugins/panels/frame-serving/plugin-frame-module-transform.ts` 对 `.ts` / `.tsx` / `.mts` / `.jsx` 执行相同候选解析并重写 specifier。
- **附加约束**：
  - `isPluginWorkerSourcePath`（`src/shared/plugins/frames/plugin-frame-source-modules.ts`）仅允许 Worker 加载 `.ts` / `.mts`，禁止在 `core/` 与 `worker/` 引入 `.tsx` / `.jsx`。
  - 独立 Node 24 脚本（例如 `scripts/pm-spec-bench.mjs`）以原生 Node 类型擦除直接导入 `core/*.ts` 时，`core/` 内部须避免 `enum`、命名空间和构造函数参数属性等非擦除语法。

---

### ② `import { load } from '../vendor/js-yaml.mjs'` 可用

- **状态**：已通过源码核验成立
- **源码依据**：
  - Worker 侧：在 `src/main/plugins/workers/child-runtime/plugin-worker-source-hooks.ts` 中，相对导入 `../vendor/js-yaml.mjs` 若文件已存在，`resolveHook` 直接由 Node `nextResolve` 命中精确 URL；进入 `loadHook` 后，`isPluginWorkerSourcePath` 对 `.mjs` 返回 `false`，直接走 `nextLoad` 由 Node 原生 ESM 加载，不经过 `sucrase`。
  - 面板侧：`src/main/plugins/panels/frame-serving/plugin-frame-module-resolution.ts` 通过 `pluginModuleCandidatePaths` 精确匹配 `vendor/js-yaml.mjs` 并放行重写；`src/main/plugins/panels/frame-serving/plugin-frame-content-types.ts` 将 `.mjs` 映射为 `text/javascript; charset=utf-8`。
- **结论影响**：`js-yaml@4.1.0` 的 `dist/js-yaml.mjs` 为零外部依赖 ESM 文件，可作为自包含相对模块在 Worker 中安全导入，无需构建打包步骤。

---

### ③ `agent.launch` 对 `reviewAgent` 枚举中每个 ID 的接受情况

- **状态**：已完成策略源码与本机 CLI 探测；真实桌面 PTY 会话待用户环境登录验证
- **实测结果（2026-11-21 `spec-worker`）**：
  - 协议与启动守卫：`src/shared/agent-launch/catalog/tui-agent.ts` 与 `src/shared/plugins/workers/plugin-host-api-workspace-methods.ts` 接受全部 7 个 ID；`src/main/runtime/terminal/launch/runtime-agent-terminal-startup.ts` 仅在 `disabledTuiAgents` 禁用对应 agent 时拒绝。
  - 默认启用策略（`src/shared/pmstudio-config.ts`）：`pi`、`opencode`、`codebuddy`、`qwen-code`、`kimi`、`mimo-code` 默认启用；`claude` 属于 `DEFAULT_DISABLED_TUI_AGENTS`，需用户在设置开启后方可由 `agent.launch` 拉起。
  - 本机二进制探测（`which` + 内置包）：
    - `pi`：内置 `out/pi-runtime/package/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` 存在（v1.5.2），`--help` 退出码 0；
    - `codebuddy`：`/Users/hubo/.nvm/versions/node/v24.22.1/bin/codebuddy` 已安装；
    - `opencode`、`qwen-code`、`kimi`、`mimo-code`、`claude`：当前环境 `PATH` 下均为 `NOT_FOUND`；已通过 `test/review-runs.worker.test.ts` E21 验证 `agent.launch` 失败时回滚并发锁并返回 `E_AGENT_UNAVAILABLE`。
  - 保留策略：保留全部 7 个合法 `TuiAgent` 枚举值以支持用户按需安装/启用对应 CLI；后续在桌面窗口人工验收可按需补跑下方 `orca-dev.mjs plugin dev load` 链路。
- **精确验证命令（P1 `spec-worker` 执行）**：

```bash
export PATH="/Users/hubo/.nvm/versions/node/v24.22.1/bin:$HOME/.bun/bin:$PATH"
cd <PMStudio-repo>

# 1. 校验插件清单并运行后台开发加载（首次带 --approve <指纹>）
node config/scripts/development/launch/orca-dev.mjs plugin validate extensions/pm-spec --json
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/development/launch/orca-dev.mjs plugin dev load extensions/pm-spec --json

# 2. 对已初始化并打开的本地测试规格工作区，依次把设置中 reviewAgent 切为：
#    pi, opencode, codebuddy, qwen-code, kimi, mimo-code, claude（先在设置启用 claude）
#    通过 dev request 触发一次 review.start 并检查日志是否返回 terminalId 或 E_AGENT_UNAVAILABLE：
node config/scripts/development/launch/orca-dev.mjs plugin dev request extensions/pm-spec review.start --data '{"specId":"PAY-REFUND-001"}' --json
node config/scripts/development/launch/orca-dev.mjs plugin logs lkl.pm-spec --json
```

- **补齐验收标准**：逐一记录 7 个 ID 的实测状态（接受并拉起 / 被禁用 / CLI 未安装 / 启动报错），将无法通过 `agent.launch` 启动的 ID 从 `orca-plugin.json` 的 `reviewAgent.enum` 移除。

---

### ④ `agent.tool.before` 在 Claude Code 下可返回 `deny`

- **状态**：宿主 Hook 服务端与插件 `mountWorker` 链路已实测通过（真机 Claude PTY 依赖安装及启用 `claude`）
- **实测结果（2026-11-21 `spec-worker`）**：
  - 宿主服务端：`src/main/agent-hooks/server/testing/permissions/server-claude-plugin-tool-calls.test.ts` 与 `src/main/agent-hooks/installation/opencode-pi-plugin-hook-files.test.ts` 运行实测 **2 文件 5 用例全部通过**（`PreToolUse` `permissionDecision: 'deny'` 响应链验证成立）。
  - 插件 Worker 守卫：执行 `node config/scripts/development/launch/orca-dev.mjs plugin test extensions/pm-spec --json`，`test/tool-guard.worker.test.ts`（E20，2/2 用例通过）实测验证 Claude Code 仓外绝对路径/相对路径 `Write`/`Edit` 及 `Bash` 重定向/写命令均返回 `kind: 'deny'`，`runDir` 内写入放行，非预检终端与非 Claude 终端行为符合预期。
  - 待真实环境验证项：因本机未安装 `claude` 且其默认禁用，真实 Claude Code 交互终端中的端到端拦截仍需在目标启用环境实测一次。
- **精确验证命令（P1 `spec-worker` 执行）**：

```bash
export PATH="/Users/hubo/.nvm/versions/node/v24.22.1/bin:$HOME/.bun/bin:$PATH"
cd <PMStudio-repo>

# 1. 验证宿主 Claude PreToolUse Hook 服务端链路
rtk bypass pnpm test src/main/agent-hooks/server/testing/permissions/server-claude-plugin-tool-calls.test.ts --maxWorkers=2

# 2. 验证插件侧 tool-guard.worker.test.ts（P1-T7 交付后）
node config/scripts/development/launch/orca-dev.mjs plugin test extensions/pm-spec --json

# 3. 模拟触发插件的 agent.tool.before 钩子链验证返回结构
node config/scripts/development/launch/orca-dev.mjs plugin dev hook extensions/pm-spec agent.tool.before --data '{"agent":"claude","workspaceId":"local-ws","terminalId":"term-active-review","tool":"Write","input":{"file_path":"/tmp/outside.txt","content":"bad"}}' --json
```

---

### ⑤ 插件自身调用 `agent.launch` 触发 `agent.launch.before` 及 `workspaceId` 对应关系

- **状态**：已通过源码核验确认（并发现重要 ID 格式差异）
- **源码依据**：
  1. **调用路径必然触发 `agent.launch.before`**：
     - `src/main/plugins/workers/host-api/plugin-host-workspace-method-bindings.ts` 中 `agent.launch` 首次调用 `effect(ctx, 'agent.launch', { target: { kind: 'existing', worktree: workspaceSelector(params.workspaceId) }, agent: params.agent, surface: 'terminal', presentation: 'background', launchSource: 'plugin' })`（不携带 `prompt`）。
     - 经 `src/main/runtime/rpc/methods/agent-launch/agent-launch.ts` → `src/main/runtime/rpc/methods/agent-launch/agent-launch-surfaces.ts` 调用 `context.runtime.createTerminal('id:' + worktreeId, { wslUserAct: true, startupAgent: agent, launchSource: attributedLaunchSource })` → `src/main/ipc/pty/runtime/spawn.ts` 执行 `applyAgentLaunchPluginHook(ctx.args, deps.runtime)`（`src/main/ipc/pty/spawn/spawn-agent-launch-plugin-hook.ts`）。
     - 该路径不设置 `spawnIntent` 恢复标记、`resumeOrigin` 和 `resumeProviderSession`，因此**必定触发** `agent.launch.before`。若传入了 `prompt`，随后的 `reuseTerminal` 投递仅写已有 PTY，不再触发 `agent.launch.before`。
  2. **`workspaceId` 与 `workspace.list` 的对应关系差异（关键发现）**：
     - `workspace.list`（`src/main/plugins/workers/host-api/plugin-host-workspace-list.ts`）通过 `pluginWorkspaceId`（`src/shared/plugins/workers/plugin-host-api-workspace-methods.ts`）为**带 `identityKey` 的 Git worktree** 返回 **`identity:<identityKey>`**，为**文件夹工作区**返回 **`folder:<folderWorkspaceId>`**。
     - `agent.launch` 执行前在 `src/main/runtime/rpc/methods/agent-launch/agent-launch-intent-resolution.ts` 将选择器的 `identity:` 解引用为内部 `workspace.id`（即原始 `worktree.id` 或 `folder:<folderWorkspaceId>`），传给 `createTerminal` 成为 `args.worktreeId`。
     - `src/main/ipc/pty/spawn/spawn-agent-launch-plugin-hook.ts` 直接把内部 **`args.worktreeId`**（而非 `identity:<identityKey>`）赋给 `agent.launch.before` 载荷的 `event.workspaceId`。
- **设计影响（供 P1-T7 适配）**：
  - 文件夹工作区（`folder:<id>`）下，`event.workspaceId` 与 `workspace.list` 的 `id` 完全一致；
  - 带 `identityKey` 的 Git worktree 下，`workspace.list` 返回 `identity:<key>`，而 `event.workspaceId` 为 `<repoId>::<path>`，**不可直接对两者做全等字符串比对**，否则 Git worktree 规格工作区会永远匹配失败并退化为 `unguarded`。
  - P1-T7 实现 `pendingPiLaunch` 匹配时：若 `pendingPiLaunch.workspaceId` 以 `folder:` 开头可校验精确相等；若以 `identity:` 开头则校验 `event.agent === 'pi'`、`event.workspaceKind === 'worktree'`、非空 `event.workspaceId` 及 15 秒窗口（若条件允许也可核对工作区路径后缀），再依靠 `<runDir>/guard-claim.json` 的 `O_EXCL`（`'wx'`）排他认领消除串号风险。

---

### ⑥ Orca 生成的 `pi` 启动命令末尾追加 `--tools` 与 `--extension` 后，内置 `pi` 1.5.2 正常启动且提示词投递不受影响

- **状态**：已通过源码核验与 CLI 帮助实测成立
- **源码与 CLI 依据**：
  - `src/shared/pi-runtime-pin.ts` 锁定内置版本 `@earendil-works/pi-coding-agent@1.5.2`。
  - 在仓库根目录实测执行 `node out/pi-runtime/package/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js --help`，输出确认支持 `--tools, -t <tools>` 与 `--extension, -e <path>`。
  - 查阅 `out/pi-runtime/package/node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js` 的 `parseArgs` 逻辑：`--tools` 与 `--extension` 支持在选项区任意顺序出现。
  - 查阅 `src/main/plugins/workers/host-api/plugin-host-workspace-method-bindings.ts` 与 `src/shared/agent-launch/startup/tui-agent-startup.ts`：插件调用 `agent.launch({ workspaceId, agent: 'pi', prompt })` 时，首轮 `createTerminalAgent` **不带 `prompt`**，生成的基础命令仅包含 `pi` 及设置中的参数/模型选项；待 `pi` 终端启动后，`reuseTerminal` 通过 PTY 通道投递 `prompt`（`src/main/agent-launch/agent-launch-prompt-delivery.ts`）。因此向 `event.command` 末尾追加 `--tools read,grep,find,ls,pmspec_submit_findings --extension .pmspec/runs/<runId>/ext/pi/pmspec-review-guard.ts` 不会夹在位置消息之后，提示词投递流程完全不受影响。
- **边界提醒**：若用户在个人设置中为 `pi` 配置了含 `--` 选项终结符的自定义 `agentArgs`，拼接参数时应插入到独立 `--` 之前。

---

### ⑦ `--tools` 白名单接受扩展注册的工具名 `pmspec_submit_findings`

- **状态**：已通过内置 `pi@1.5.2` SDK 实测成立（仅带模型推理的在线 `--print` 未外发请求）
- **实测结果（2026-11-21 `spec-worker`）**：
  - 使用 `stageGuardExtensionFiles` 将 `pmspec-review-guard.ts` 及其 6 个传递依赖（`core/pi-guard-policy.ts`、`findings-validate.ts`、`spec-types.ts`、`id-format.ts`、`yaml-frontmatter.ts`、`vendor/js-yaml.mjs`）复制到隔离临时 `.pmspec/runs/<runId>/ext/` 后：
    1. **独立扩展加载实测**：调用内置 `out/pi-runtime/package/node_modules/@earendil-works/pi-coding-agent/dist/index.js` 的 `discoverAndLoadExtensions([guardPath], ws)` 返回 `errors: []`、`extensions: 1`、注册工具 `['pmspec_submit_findings']`；`guard-claim.json` 立即排他创建；触发 `tool_call({ toolName: 'write' })` 返回 `{ block: true, reason: '规格预检为只读任务，禁止使用工具 write' }`；触发 `tool_call({ toolName: 'read' })` 返回 `undefined` 放行。
    2. **Pi SDK 会话初始化实测**：调用 `parseArgs(["--tools", "read,grep,find,ls,pmspec_submit_findings", "--extension", guardPath, "--no-session"])` + `DefaultResourceLoader` + `createAgentSession({ cwd: ws, agentDir, tools: parsed.tools, resourceLoader, settingsManager, sessionManager })` 返回 `extensionsResult.errors: []`，且 `session.getAllTools()` 与 `session.getActiveToolNames()` 均为精确 5 项 `['read', 'grep', 'find', 'ls', 'pmspec_submit_findings']`（`write`/`edit`/`bash` 均未激活）。
    3. 已同步固化进自动化测试 `test/pi-launch-inject.worker.test.ts`（E51–E53），包括 `pmspec_submit_findings.execute` 校验并原子写入 `findings.json`。
    4. 注：无 API Key 下不执行在线 LLM `--print` 推理请求；实际携带模型密钥的 `cli.js --print` 会话可按下方命令复测。
- **精确验证命令（P1 `spec-worker` 执行）**：

```bash
export PATH="/Users/hubo/.nvm/versions/node/v24.22.1/bin:$HOME/.bun/bin:$PATH"
cd <PMStudio-repo>

# 1. 创建隔离临时运行目录并验证 pi 1.5.2 加载扩展与激活自定义工具
TMP_RUN_DIR=$(mktemp -d /tmp/pmspec-spike-7-XXXXXX)
PMSPEC_RUN_ID="R-20261121-170000-a1b2" \
PMSPEC_RUN_DIR="$TMP_RUN_DIR" \
PMSPEC_SPEC_ID="PAY-REFUND-001" \
PMSPEC_CODEGRAPH_REPOS="[]" \
node out/pi-runtime/package/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  --no-session \
  --tools read,grep,find,ls,pmspec_submit_findings \
  --extension pi/pmspec-review-guard.ts \
  --print "请列出你当前可用的全部工具名称，不要修改文件"

# 2. 验证守卫认领文件已排他写入
cat "$TMP_RUN_DIR/guard-claim.json"
```

---

### ⑧ `pi` 的 `read`、`grep`、`find` 能读取工作区之外的绝对路径

- **状态**：已通过内置 `pi@1.5.2` 工具执行实测成立
- **实测结果（2026-11-21 `spec-worker`）**：
  - 构造相互独立的临时目录 `wsDir`（作为 `cwd`）与 `siblingRepo`（作为工作区外关联代码仓），调用内置 `@earendil-works/pi-coding-agent` 的 `createReadOnlyTools(wsDir)`（返回 `read`、`grep`、`find`、`ls`）直接对 `siblingRepo` 下的 `RefundService.ts` 绝对路径执行工具调用：
    - `readTool.execute('r1', { path: targetFile })` 返回 `"export const refundLimit = 100;\n"`；
    - `grepTool.execute('g1', { pattern: 'refundLimit', path: siblingRepo })` 返回 `"RefundService.ts:1: export const refundLimit = 100;"`；
    - `findTool.execute('f1', { pattern: '*.ts', path: siblingRepo })` 与 `lsTool.execute('l1', { path: siblingRepo })` 均返回 `"RefundService.ts"`。
  - 结论：内置 `pi` 只读工具默认支持读取 `cwd` 之外关联代码仓绝对路径，**无需**启用降级工具 `pmspec_read_repo_file`。下方命令可供带模型 Key 端到端 `--print` 复验。
- **精确验证命令（P1 `spec-worker` 执行）**：

```bash
export PATH="/Users/hubo/.nvm/versions/node/v24.22.1/bin:$HOME/.bun/bin:$PATH"
cd <PMStudio-repo>

# 1. 构造独立的规格目录（cwd）与位于 cwd 之外的代码仓目录
TMP_BASE=$(mktemp -d /tmp/pmspec-spike-8-XXXXXX)
mkdir -p "$TMP_BASE/spec-ws" "$TMP_BASE/outside-repo/src/refund"
printf 'public class RefundController {\n  // line 2 target\n}\n' > "$TMP_BASE/outside-repo/src/refund/RefundController.java"
TMP_RUN_DIR="$TMP_BASE/spec-ws/.pmspec/runs/R-20261121-170500-c3d4"
mkdir -p "$TMP_RUN_DIR"

# 2. 以 spec-ws 为 cwd 启动 pi 1.5.2，实测 read / grep / find 读取 cwd 之外的绝对路径
(
  cd "$TMP_BASE/spec-ws" && \
  PMSPEC_RUN_ID="R-20261121-170500-c3d4" \
  PMSPEC_RUN_DIR="$TMP_RUN_DIR" \
  PMSPEC_SPEC_ID="PAY-REFUND-001" \
  PMSPEC_CODEGRAPH_REPOS="[]" \
  node out/pi-runtime/package/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
    --no-session \
    --tools read,grep,find,ls,pmspec_submit_findings \
    --extension pi/pmspec-review-guard.ts \
    --print "请依次使用 find、grep 和 read 检查绝对路径 $TMP_BASE/outside-repo 下的文件并逐字输出第 2 行内容"
)
```
