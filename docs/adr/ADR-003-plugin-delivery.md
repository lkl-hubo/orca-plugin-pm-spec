# ADR-003：内置插件交付与网关增量演进（Core-Thin Edge-Rich）

- 状态：已确认
- 基线日期：2026-11-21
- 关联文件：`src/main/plugins/bootstrap/plugin-bundled-bootstrap.ts`、`src/main/plugins/workers/parent-process/plugin-host-process.ts`、`services/share-gateway/src/share-gateway-server.mjs`、`services/share-gateway/src/gateway-database.mjs`

## 背景

LKL-PMStudio 持续跟随上游 Orca（当前基线 `v1.4.266`）定期同步。如果把规格解析、校验规则、面板 UI、预检任务编排和外部网关调用直接写入 `src/main` 与 `src/renderer`，每次上游重构窗口、工作区或面板基础设施都会产生大面积合并冲突，且难以单独停用或回滚。

## 决策

### 1. 桌面端：以内置插件 `lkl.pm-spec` 交付，核心代码零入侵

- 源码独立放在 PMStudio 自有目录 ``（上游仓库不存在该目录）：
  - `orca-plugin.json` 声明 `manifestVersion: 2`、`execution: "trusted-worker"`、`publisher: "lkl"`、`id: "pm-spec"`、`engines.orca: ">=1.4.248"`，状态栏条目 ID 使用 kebab-case 格式 `'pmspec-status'`。
  - UI 全部通过 Host API 1.10 组件面板（`ui: "components"`）实现，不修改 `src/renderer/`。
  - Worker 在宿主 `fork(entryPath, [], { execArgv: [] })` 出的独立 Node 子进程中运行（见 `src/main/plugins/workers/parent-process/plugin-host-process.ts`），通过标准 `node:fs`、`node:child_process`、全局 `fetch` 与 Host API 完成业务闭环，不侵入 `src/main/`。
- **同步与完整性门禁**：
  - 运维脚本 `scripts/sync-pm-spec-plugin.mjs` 仅抽取运行时目录（`orca-plugin.json`、`README.md`、`core/`、`worker/`、`pi/`、`src/`、`templates/`、`vendor/`，排除 `test/` 与 `.orca/`）同步至 `resources/plugins/launch/lkl.pm-spec/`，调用 `config/scripts/desktop-distribution/runtime-verification/verify-packaged-plugin-resources.cjs` 的 `hashPackagedPluginTree` 计算树哈希并写入 `resources/plugins/launch/bundled-plugins.json`。
  - Gate 5（`src/shared/pmstudio-product-gates.test.ts`）在 CI 与构建前验证内置索引哈希与源码运行时文件逐字节一致。
- **内置发行商白名单（`PMSTUDIO_BUNDLED_PLUGIN_PUBLISHERS`）**：
  - 上游默认通过 `hasOfficialPluginPublisher` 将内置插件限制为 `'stablyai'` 发行商。为保持核心改动最小化并兼顾上游同步安全，`lkl.pm-spec` 通过 `src/shared/pmstudio-config.ts` 中的 `PMSTUDIO_BUNDLED_PLUGIN_PUBLISHERS`（`new Set(['lkl'])`）加入内置插件发行商白名单，并在 `src/main/plugins/installation/plugin-install-trust.ts` 与 `src/main/plugins/bootstrap/plugin-bundled-bootstrap.ts` 做最小化白名单放行校验。

### 2. 服务端：在 `services/share-gateway/` 采用增量表与增量路由

- 复用现有原生 Node `http` + `node:sqlite` + Bearer 鉴权（`gateway-auth.mjs`）+ 幂等键表 `idempotency_keys` + `markdown-renderer.mjs` + `GatewayHttpError`：
  - 新增 6 个独立模块：`spec-review-schema.mjs`、`spec-review-validate.mjs`、`spec-review-routes.mjs`、`spec-review-page.mjs`、`spec-review-form.mjs`、`request-rate-limit.mjs`。
  - 现有文件仅两处最小接线：`services/share-gateway/src/gateway-database.mjs` 追加执行 `SPEC_REVIEW_SCHEMA_SQL`；`services/share-gateway/src/share-gateway-server.mjs` 在 `handleSkillShareRoutes` 之后注册 `handleSpecReviewRoutes`。
- 既有 `/a/:slug` 工件分享、`/v1/artifacts` 与 `/v1/skills` 接口逻辑与表结构保持原样，不产生兼容风险。

### 3. 上游同步安全性与回滚

- **冲突面压缩**：同步上游时唯一可能产生文本冲突的文件是 `resources/plugins/launch/bundled-plugins.json`（新增 1 条记录）；冲突后保留双方条目并重跑 `sync-pm-spec-plugin.mjs` 即可恢复一致。
- **回滚路径**：
  - 桌面端全量回滚：从 `bundled-plugins.json` 移除 `lkl.pm-spec` 并重新打包，客户端启动时 `src/main/plugins/bootstrap/plugin-bundled-bootstrap.ts` 会自动卸载并回收已安装目录，工作区内的 `pmspec.json` 与 `specs/` 文件完全保留。
  - 单机紧急停用：用户可在“设置 → 插件”停用，或执行 `orca plugin disable lkl.pm-spec`。
  - 网关回滚：切回上一镜像标签重启即可，旧版本会自动忽略新增的 `spec_reviews` 三张表。
