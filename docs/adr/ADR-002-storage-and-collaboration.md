# ADR-002：规格工作区存储与协作模型

- 状态：已确认
- 基线日期：2026-11-21

## 背景

产品经理在撰写 PRD 时通常不希望为了并发编辑去处理复杂的 Git 分支合并冲突；同时 LKL-PMStudio 继承自上游 Orca 架构，需要把“普通文件夹工作区（Folder Workspaces）”视为与 Git worktree 同等的一等公民，且不能强制要求产品团队放弃现有的飞书文档或 Confluence 知识库。

## 决策

### 1. 存储模型：Git 仓库与普通本机文件夹双兼容

- 规格工作区可以是 Git 仓库，也可以是普通本机文件夹。所有核心读写操作（初始化 `pmspec.json`、创建与校验 `specs/<SPEC-ID>/spec.md`、保存不可变快照）均通过 `node:fs` 原子写入实现，不依赖 `git commit` 或 `git tag`。
- 目录职责划分：
  - **可纳入版本控制的文件**：根目录 `pmspec.json`、规格正文与附件 `specs/<ID>/spec.md` 与 `specs/<ID>/assets/`、不可变快照 `.pmspec/snapshots/<ID>/v<version>.md` 与 `v<version>.json`。
  - **仅保留在本机的运行时文件**（初始化时自动写入根目录 `.gitignore`）：预检运行记录 `.pmspec/runs/`、网关意见本地缓存 `.pmspec/reviews/`、试点指标 `.pmspec/metrics.jsonl`。
- **凭据隔离**：自托管网关访问令牌、评审编辑令牌（`editToken`）与评审链接密钥（`reviewerKey`）只存储在插件 `secrets`（底层对应 macOS Keychain、Windows DPAPI 或 Linux Secret Service），严禁写入任何工作区文件。

### 2. 协作模型：单一负责人编辑 + 网关只读页面批注

- **单写者编辑**：每份规格由 `frontmatter.owner` 指定的单一产品经理在 LKL-PMStudio 桌面端编辑维护，不提供实时多人协同编辑，彻底规避并发写入与 Git 合并冲突。
- **零门槛网页批注与签核**：评审人无需安装 LKL-PMStudio，只需在浏览器打开内网自托管分享网关生成的能力链接 `GET /r/:slug?k=<reviewerKey>`，即可按条目锚点提交三类意见（`issue` / `suggestion` / `question`）或提交角色签核（`approve` / `request_changes`）。
- **状态机闭环回流**：桌面面板按 `commentSyncSeconds`（默认 60 秒）增量拉取意见，负责人逐条处理为 `resolved` 或 `wont_fix`（`wont_fix` 必须填写理由）。仅当当前 `spec.md` 哈希与已发布快照哈希一致、`requiredSignoffRoles` 全部角色最新签核均为 `approve`、且未解决的 `issue` 为 0 时，方可点击“标记为已批准”将状态推进为 `approved` 并关闭网页评审。

### 3. 与 Confluence / 飞书文档对齐

- 需求中心定位为**评审前工程化质量门禁与结构化工作台**，不替代飞书文档或 Confluence。
- 规格在桌面端达到 `approved` 后，PM 可直接复制最终版 `spec.md` 或不可变快照 `v<version>.md` 内容粘贴归档到飞书文档或 Confluence；评审期间以网关能力链接作为唯一事实入口，避免“文档一边改、评审页看不见”的割裂。

### 4. 当前已知约束

- v1 仅支持本机工作区（`hostId` 为 `local` 或 `null`），远程主机（`ssh:` / `runtime:`）在面板直接提示 `E_REMOTE_HOST` 并阻止本地路径读取。
- 单个规格工作区按修改时间最新上限加载 500 份规格。
