# 需求中心（`lkl.pm-spec`）

Orca / PMStudio 声明式插件，提供结构化产品需求规格解析、24 条确定性校验规则、AI 现状感知预检、不可变快照对比以及自托管网页评审回流。

## 安装

```bash
orca plugin install https://github.com/lkl-hubo/orca-plugin-pm-spec
```

## 目录结构

- `orca-plugin.json`：插件清单（`trusted-worker`）
- `core/`：纯 TypeScript 领域逻辑（无宿主 API 与文件系统依赖）
- `worker/`：Node Worker 进程，编排工作区扫描、证据核验、AI 预检与网关同步
- `pi/`：Pi 只读预检守卫扩展
- `src/`：声明式组件面板与 `protocol.ts` 协议定义
- `templates/`：工作区初始化模板与规格新建模板
- `vendor/`：内置 `js-yaml` ES 模块及类型声明
- `test/`：Worker 集成测试（`test/*.worker.test.ts`）与纯领域单元测试（`unit-tests/`）
- `docs/`：规格格式、用户指南、ADR 与性能报告
- `scripts/`：基准测试、试点指标统计与评审网关压测脚本

## 本地开发与验证

在宿主 Orca / PMStudio 仓库中可通过 `orca-dev` 或已安装的 `orca` CLI 验证：

```bash
orca plugin validate .
orca plugin dev load .
orca plugin test .
```

运行独立纯领域基准测试：

```bash
node scripts/pm-spec-bench.mjs --lines 2000 --runs 200 --json
```
