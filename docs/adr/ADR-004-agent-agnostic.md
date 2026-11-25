# ADR-004：智能体无关的 AI 预检与分级只读防护

- 状态：已确认
- 基线日期：2026-11-21
- 关联文件：`src/shared/pmstudio-config.ts`、`src/shared/pi-runtime-pin.ts`、`src/main/ipc/pty/spawn/spawn-agent-launch-plugin-hook.ts`、`src/main/agent-hooks/tool-events/agent-tool-plugin-hooks.ts`

## 背景

PMStudio 新鲜安装默认智能体为 `pi`（`src/shared/pmstudio-config.ts`），默认启用列表包含 `pi`、`opencode`、`mimo-code`、`dsh`、`zcode`、`kimi`、`qwen-code`、`codebuddy`，部分研发团队还会启用 `claude`。AI 预检若强依赖单一智能体的私有技能格式会限制适用面；同时，智能体在分析关联业务代码仓时，必须严格防止因误操作或代码注释提示词注入而篡改业务代码。

## 决策

### 1. 智能体无关的文件契约（`agent.launch` + `prompt.md` + `findings.json`）

- Worker 统一调用 Host API `agent.launch({ workspaceId, agent, prompt })` 拉起用户配置的任意已启用智能体，传递给终端的启动指令固定要求智能体读取 `.pmspec/runs/<runId>/prompt.md` 并在结束后回复 `PMSPEC_REVIEW_DONE <runId>`。
- 预检产出统一约定为 `.pmspec/runs/<runId>/findings.json`（先写 `findings.tmp.json`，校验为合法 JSON 后原子 `rename`）。
- 完成判定采用双信号机制，防止部分智能体不上报完成事件：
  - **主信号**：`findings.json` 存在且 `mtime` 连续 1.5 秒保持不变，进入收集与校验阶段；
  - **辅助信号**：收到匹配 `terminalId` 的 `agent.status.changed`（`state = done`）后若 60 秒内仍无 `findings.json`，标记 `failed`（`E_NO_FINDINGS`）；超过 `reviewTimeoutMinutes` 仍未完成则标记 `timed_out` 并保留终端输出供排障。

### 2. 分级只读防护策略

| 智能体                                                                        | 强制拦截机制                                                    | 事后核验 | `run.json.guard`                                |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------- | -------- | ----------------------------------------------- |
| `pi`（默认，内置 1.5.2）                                                      | 四层只读防护（启动白名单 + 守卫扩展 + 受控提交工具 + 改动检测） | 有       | 认领成功为 `enforced`，超时未认领为 `unguarded` |
| `claude`（Claude Code）                                                       | 宿主 `agent.tool.before` 阻塞钩子                               | 有       | `enforced`                                      |
| 其余已启用智能体（`opencode`、`codebuddy`、`qwen-code`、`kimi`、`mimo-code`） | 提示词约束 + `agent.tool.before` 违规记录                       | 有       | `unguarded`                                     |

#### A. 默认智能体 `pi` 四层只读防护

通过 `src/main/ipc/pty/spawn/spawn-agent-launch-plugin-hook.ts` 提供的 `agent.launch.before` 钩子向预检会话追加 CLI 参数与环境变量（**不使用 `--no-extensions`**，以保留 Orca 托管状态扩展 `@orca-managed-pi-extension` 上报 `agent.status.changed`）：

1. **L1 工具白名单**：追加 `--tools read,grep,find,ls,pmspec_submit_findings`（当目标代码仓存在 `.codegraph/` 且本机可用 `codegraph` 命令时追加 `pmspec_codegraph_explore`），使模型从上下文层面完全不可见 `write`、`edit`、`bash`、`powershell`。
2. **L2 守卫扩展拦截**：通过 `--extension .pmspec/runs/<runId>/ext/pi/pmspec-review-guard.ts` 加载随任务复制的守卫扩展，在 `tool_call` 事件中调用纯函数 `isToolAllowed` 做大小写敏感精确白名单检查，越权工具一律返回 `{ block: true, reason }`。
3. **L3 唯一受控写入口**：扩展注册自定义工具 `pmspec_submit_findings`（使用 `typebox` 校验参数并调用 `validateSubmittedFindings` 执行 V1/V10/V11 预校验），仅允许原子写入 `<runDir>/findings.json`。扩展初始化时通过 `openSync('<runDir>/guard-claim.json', 'wx')` 原子排他认领会话；若 Worker 在 30 秒内未检测到认领文件，降级为 `unguarded` 并在面板黄色提示，但不中断预检。
4. **L4 仓库改动检测**：弥补用户全局 `~/.pi/agent/extensions/` 第三方扩展事件处理器绕过工具调用写文件的残余风险。

注：经源码核验，`agent.launch.before` 收到的 `workspaceId` 为内部 `worktree.id`（文件夹工作区与 `workspace.list` 一致，Git worktree 与 `identity:` 不同），因此 `pendingPiLaunch` 会话匹配需结合时间窗口与工作区类型处理，详见 [runtime-spike.md](../runtime-spike.md)。

#### B. Claude Code `agent.tool.before` 拦截

- `src/main/agent-hooks/tool-events/agent-tool-plugin-hooks.ts` 对 Claude Code 的 `PreToolUse` 请求等待 `agent.tool.before` 决策（预算 6,000 ms）。
- `worker/tool-guard.ts` 维护 `activeReviewTerminals` 映射表，非预检终端首行即 `return` 放行（额外开销 ≤ 1 ms）。
- 命中预检终端时：`Write`/`Edit`/`MultiEdit`/`NotebookEdit` 的目标路径经 `path.resolve` 检查必须在 `<runDir>/` 内；`Bash` 禁止修改类命令（`git commit/push/reset/checkout/switch/stash/clean/rebase/merge/am/apply`、`rm`、`mv`、`cp`、`chmod`、`chown`、`sed -i`、`perl -i`、`tee`、包安装命令）及向 `<runDir>` 之外（非 `/dev/null`）的重定向。

#### C. 仓库污染检测（`worker/repo-taint-check.ts`）

- 预检发起前与结果收集后，分别对 `codeRepos` 中每个可访问的 Git 仓库执行 `git rev-parse HEAD` 与 `git status --porcelain=v1 -uall`（通过 `execFile` 以 `windowsHide: true` 与 10 秒超时执行）并比对前后哈希摘要。
- 一旦发现摘要变化，`run.json` 状态记为 `tainted`，面板弹出红色横幅列出被改动仓库并引导执行 `git status` 检查；**插件绝不自动执行任何 `git reset` 或回滚操作**，避免破坏用户工作区原有未提交修改。
