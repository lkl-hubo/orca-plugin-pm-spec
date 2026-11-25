# PM Spec Hub v1 性能基准报告（P3-T1）

- 测量日期：2026-11-21
- 分支基线：`feat/pm-spec-hub`
- 参照规范：交付方案第 1.5.1 节（性能指标）与第 3.5 节（P01–P04）

## 测试环境

| 项目                    | 实测环境参数                                           |
| ----------------------- | ------------------------------------------------------ |
| 处理器                  | Apple M4 Pro（darwin / arm64）                         |
| 内存                    | 48.0 GB                                                |
| Node 运行时             | `v24.22.1`（原生 TypeScript 类型擦除模式）             |
| 网关存储与传输          | `node:sqlite` + 原生 Node `http`（`127.0.0.1` 回环）   |
| 限流策略（仅 P03 压测） | `NODE_ENV=test` 且 `SPEC_REVIEW_RATE_LIMIT_DISABLED=1` |

## 实测结果汇总

| 编号 | 指标项                                                        | 预算目标                   | 实测结果                                                                                                                            | 结论 |
| ---- | ------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---- |
| P01  | 解析 + 校验 2,000 行规格（120 REQ、2 状态机各 30 态，200 次） | P95 ≤ 150 ms（M1 参考）    | Mean `4.74 ms` / P50 `4.6 ms` / P95 `5.34 ms` / P99 `6.84 ms` / Max `11.09 ms`（0 error，0 warning）                                | 通过 |
| P02  | 解析 + 校验 5,000 行规格（300 REQ、2 状态机各 30 态，200 次） | P95 ≤ 500 ms               | Mean `11.73 ms` / P50 `11.53 ms` / P95 `12.72 ms` / P99 `16.53 ms` / Max `21.04 ms`（0 error，0 warning）                           | 通过 |
| P03  | 网关意见并发提交（20 并发持续 60 s）                          | P95 ≤ 200 ms，0 错误       | `64,365` 请求（`1,072.2 req/s`），轮换创建 `36` 个评审，`0` 错误，P50 `16.25 ms` / P95 `37.94 ms` / P99 `55.52 ms` / Max `820.4 ms` | 通过 |
| P04  | 评审页服务端渲染（300 条目 + 500 意见）                       | ≤ 300 ms                   | 10 次请求 P50 `6.74 ms` / P95 `9.56 ms` / Max `9.56 ms`；同步在集成测试中稳定通过 `< 300 ms` 断言                                   | 通过 |
| S1   | 网关创建评审（1,000 条目，50 次）                             | P95 ≤ 300 ms               | P50 `1.9 ms` / P95 `3.34 ms` / Max `13.06 ms`                                                                                       | 通过 |
| S2   | 快照原子写入（`1,023,902` 字节 / `3,507` 行，L024 上限内）    | ≤ 200 ms                   | 单次端到端写入 `29.03 ms`                                                                                                           | 通过 |
| S3   | 工具拦截钩子 `evaluateToolGuard`（各 1,000 次）               | 非预检 ≤ 1 ms；预检 ≤ 5 ms | 非预检 P95 `0.0005 ms`（Max `0.0355 ms`）；预检写拦截 P95 `0.0027 ms`（Max `0.0897 ms`）                                            | 通过 |

## 复现命令与原始数据

### 1. P01 / P02：规格解析与校验基准

```bash
export PATH="/Users/hubo/.nvm/versions/node/v24.22.1/bin:$HOME/.bun/bin:$PATH"
node scripts/pm-spec-bench.mjs --lines 2000 --runs 200 --json
node scripts/pm-spec-bench.mjs --lines 5000 --runs 200 --json
```

- 2,000 行夹具（`180,605` 字节、`120` 条 REQ、`2` 个状态机）：
  - `runs=200`, `lintCounts={ error: 0, warning: 0 }`
  - `meanMs=4.74`, `p50Ms=4.6`, `p95Ms=5.34`, `p99Ms=6.84`, `maxMs=11.09`, `budgetMs=150`, `passed=true`
- 5,000 行夹具（`466,304` 字节、`300` 条 REQ、`2` 个状态机）：
  - `runs=200`, `lintCounts={ error: 0, warning: 0 }`
  - `meanMs=11.73`, `p50Ms=11.53`, `p95Ms=12.72`, `p99Ms=16.53`, `maxMs=21.04`, `budgetMs=500`, `passed=true`

### 2. P03：网关意见并发压测（60 秒）

针对本地临时拉起的 `createShareGatewayServer({ port: 0, host: '127.0.0.1', dataDir, authMode: 'static', authTokens: 'bench-token:bench-user' })`（运行环境变量 `NODE_ENV=test SPEC_REVIEW_RATE_LIMIT_DISABLED=1`）执行：

```bash
node scripts/spec-review-load.mjs --base <ephemeral-url> --token bench-token --concurrency 20 --duration 60 --json
```

实测输出：

```json
{
  "concurrency": 20,
  "durationSeconds": 60,
  "actualDurationSeconds": 60.03,
  "reviewsCreated": 36,
  "totalRequests": 64365,
  "rps": 1072.2,
  "errorCount": 0,
  "p50Ms": 16.25,
  "p95Ms": 37.94,
  "p99Ms": 55.52,
  "maxMs": 820.4,
  "budgetMs": 200,
  "passed": true
}
```

压测结束后已由脚本自动 `DELETE` 清理全部 36 个临时评审，关闭临时网关并删除临时数据目录。

### 3. P04 / 创建 / 快照写入 / 工具拦截实测

- 网关创建（1,000 条目，50 次 `POST /v1/spec-reviews`）：`p50Ms=1.9`, `p95Ms=3.34`, `maxMs=13.06`。
- 评审页 SSR 渲染（300 条目 + 500 意见，10 次 `GET /r/:slug?k=<reviewerKey>`）：`p50Ms=6.74`, `p95Ms=9.56`, `maxMs=9.56`；同时 `src/main/share-gateway/spec-review-gateway.integration.test.ts` 内 P04 断言稳定低于 300 ms 阈值。
- 1 MiB 边界快照写入（`1,023,902` 字节、`3,507` 行，`writeSpecSnapshot`）：`29.03 ms`。
- 工具拦截 `evaluateToolGuard`（1,000 次热路径调用）：非预检终端 P95 `0.0005 ms`；预检终端命中拦截规则 P95 `0.0027 ms`。

## 未在本机自动脚本覆盖的桌面端运行项

以下 3 项属于打包桌面端或真实内网环境的运行指标，按交付计划在 P3-T5 打包安装与内网试跑阶段实测补充记录：

- 桌面面板点击后 100 ms `Skeleton` 首次反馈与 200 规格列表加载耗时（需桌面渲染进程观测）。
- 1 MiB 评审载荷在真实企业内网局域网至网关的端到端发布耗时（需真实内网链路）。
- Worker 在桌面宿主进程内长时空闲 RSS 内存采样（需打包应用运行态采样）。
