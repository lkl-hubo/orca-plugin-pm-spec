# 规格格式规范 v1（PM Spec Format v1）

- 版本：v1
- 基线日期：2026-11-21
- 适用插件：`lkl.pm-spec`（``）

## 1. 文件编码与规模上限

1. 所有 `spec.md` 必须为有效 **UTF-8** 编码，解析器使用 `TextDecoder('utf-8', { fatal: true })` 读取；解码失败直接触发 `PMS-L001` 并停止解析。
2. 允许文件头存在 UTF-8 BOM（解析前剥离）；允许 CRLF 换行（解析前统一为 `\n`）。文件哈希 `rawSha256` 与快照哈希统一对**原始文件字节**计算；条目哈希 `items[].sha256` 对统一换行符为 `\n` 后的条目 Markdown 计算。
3. 单个规格文件大小上限为 **1 MiB**，行数上限为 **5,000 行**；超过任一上限触发 `PMS-L024`（`error`）并立即停止后续解析与规则执行。
4. 单个规格工作区按修改时间最新最多展示 **500** 份规格。

## 2. 规格工作区目录约定

```text
<规格工作区根目录>/
  pmspec.json                          # 工作区配置（提交到版本库）
  .gitignore                           # 初始化时追加 .pmspec/runs/ 与 .pmspec/reviews/
  specs/
    PAY-REFUND-001/
      spec.md                          # 规格正文（提交到版本库）
      assets/
        refund-flow.png                # 图片附件（可选，提交到版本库）
  .pmspec/
    snapshots/
      PAY-REFUND-001/
        v3.md                          # 不可变快照正文（提交到版本库）
        v3.json                        # 快照清单（提交到版本库）
    runs/
      R-20261121-163012-a3f9/          # AI 预检运行目录（不提交）
        prompt.md
        run.json
        findings.json
        result.json
    reviews/
      q7Zk3VbN0pW2xYfA9cLm1g/          # 评审意见本地缓存（不提交）
        review.json
        comments.json
    metrics.jsonl                      # 本地试点指标事件流（不提交）
```

安全隔离约定：网关访问令牌、评审编辑令牌（`editToken`）与评审密钥（`reviewerKey`）只存于系统密钥库（插件 `secrets`），严禁写入工作区任何文件。

## 3. 工作区配置 `pmspec.json` 规范

`pmspec.json` 位于规格工作区根目录，解析器（`core/workspace-config.ts`）按以下 JSON Schema 执行等价严格校验（不允许额外字段）：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "pmstudio:pm-spec/pmspec-workspace-v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "product", "codeRepos", "roles", "review"],
  "properties": {
    "version": { "const": 1 },
    "product": { "type": "string", "minLength": 1, "maxLength": 80 },
    "specsDir": {
      "type": "string",
      "default": "specs",
      "pattern": "^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+){0,3}$"
    },
    "codeRepos": {
      "type": "array",
      "maxItems": 10,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["key", "path"],
        "properties": {
          "key": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{1,39}$" },
          "path": { "type": "string", "minLength": 1, "maxLength": 1024 },
          "description": { "type": "string", "maxLength": 200 }
        }
      }
    },
    "roles": {
      "type": "array",
      "minItems": 1,
      "maxItems": 30,
      "uniqueItems": true,
      "items": { "type": "string", "minLength": 1, "maxLength": 20 }
    },
    "review": {
      "type": "object",
      "additionalProperties": false,
      "required": ["requiredSignoffRoles"],
      "properties": {
        "requiredSignoffRoles": {
          "type": "array",
          "uniqueItems": true,
          "maxItems": 6,
          "items": { "enum": ["产品", "研发", "测试", "业务", "风控", "其他"] }
        }
      }
    },
    "lint": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "disabled": {
          "type": "array",
          "uniqueItems": true,
          "items": { "type": "string", "pattern": "^PMS-L0(0[3-5]|0[7-9]|1[0-9]|2[0-3])$" }
        },
        "severityOverrides": {
          "type": "object",
          "propertyNames": { "pattern": "^PMS-L0(0[3-5]|0[7-9]|1[0-9]|2[0-3])$" },
          "additionalProperties": { "enum": ["error", "warning"] }
        }
      }
    }
  }
}
```

补充约束：

- `PMS-L001`、`PMS-L002`、`PMS-L006`、`PMS-L024` 为结构性规则，不可禁用、不可降级（已在上述正则中排除）。
- `codeRepos[].key` 在数组中必须唯一。
- `codeRepos[].path` 支持本机绝对路径，或相对于 `pmspec.json` 所在目录的相对路径；解析后必须是本机存在的目录，否则在预检时跳过该仓库并在 `run.json.repos[].skippedReason` 记录原因。

## 4. `spec.md` YAML 头信息字段

文件第 1 行必须为 `---`，由 `js-yaml@4.1.0` 使用 `JSON_SCHEMA` 解析（确保 `updated: 2026-11-21` 保持为字符串而不被自动转为日期对象）。

| 字段         | 类型     | 必填 | 格式与长度约束                                                                                                                                                                                     | 违反时命中规则 |
| ------------ | -------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `id`         | string   | 是   | 正则 `^[\p{L}0-9][\p{L}0-9_-]{1,63}$/u`（2～64 位中文、字母、数字、`-`、`_`，不能以 `-`/`_` 开头或使用 Windows 保留名 `CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9`），且 NFC 归一化后与所在目录名一致 | `PMS-L002`     |
| `title`      | string   | 是   | 去首尾空白后长度 2～80 个字符                                                                                                                                                                      | `PMS-L003`     |
| `owner`      | string   | 是   | 长度 1～40 个字符                                                                                                                                                                                  | `PMS-L003`     |
| `status`     | string   | 是   | 枚举值：`draft` / `in-review` / `approved` / `superseded`                                                                                                                                          | `PMS-L004`     |
| `version`    | integer  | 是   | 整数 1～9999                                                                                                                                                                                       | `PMS-L003`     |
| `product`    | string   | 否   | 长度不超过 80 个字符                                                                                                                                                                               | `PMS-L003`     |
| `reviewers`  | string[] | 否   | 最多 20 项，每项长度不超过 40 个字符                                                                                                                                                               | `PMS-L003`     |
| `codeRefs`   | string[] | 否   | 每项必须是 `pmspec.json` 中已声明的 `codeRepos[].key`                                                                                                                                              | `PMS-L022`     |
| `supersedes` | string   | 否   | 被替代的规格 ID，格式约束同 `id`                                                                                                                                                                   | `PMS-L003`     |
| `updated`    | string   | 否   | 格式 `YYYY-MM-DD`                                                                                                                                                                                  | `PMS-L003`     |

## 5. 必需章节与锚点体系

### 5.1 必需二级标题（文本完全匹配）

允许在文档中增加额外二级标题（例如 `## 状态流转`、`## 附录`），章节出现顺序不做强制；二级标题按出现顺序自动分配评审定位锚点 `S-01`、`S-02` 等。

| 顺序 | 标题文本        | 缺失时严重级别 | 规则       |
| ---- | --------------- | -------------- | ---------- |
| 1    | `## 背景与目标` | `warning`      | `PMS-L005` |
| 2    | `## 范围`       | `warning`      | `PMS-L005` |
| 3    | `## 角色与权限` | `warning`      | `PMS-L005` |
| 4    | `## 需求明细`   | `error`        | `PMS-L005` |
| 5    | `## 非功能需求` | `warning`      | `PMS-L005` |
| 6    | `## 埋点`       | `warning`      | `PMS-L005` |
| 7    | `## 待决问题`   | `warning`      | `PMS-L005` |

### 5.2 锚点与结构化元素语法

所有围栏代码块（除 `pmspec-states` 与 `pmspec-events` 自身之外）内部的文本不会误解析为 `REQ`、`AC`、`Q` 等锚点。

| 元素         | Markdown 语法                       | 正则表达式                                                              | 语义与父子约束                                                                                   |
| ------------ | ----------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 需求         | `### REQ-001 [P0] 标题`             | `^### (REQ-(\d{3})) (?:\[(P[0-2])\] )?(?:\[假设\] )?(.{2,80})$`         | 应位于 `## 需求明细` 下；`[P0]`/`[P1]`/`[P2]` 可选，缺失触发 `PMS-L021`；`[假设]` 表示待确认假设 |
| 验收标准     | `- AC-001-01：文本`                 | `^- (AC-(\d{3})-(\d{2}))[：:]\s*(.+)$`                                  | 前 3 位编号必须与所属 `REQ-xxx` 的 3 位编号相同，否则触发 `PMS-L009`                             |
| 待决问题     | `- Q-001 [open] 文本`               | `^- (Q-\d{3}) \[(open\|resolved)\] (.+)$`                               | 标记 `[resolved]` 时同一行必须包含 `结论：`                                                      |
| 状态机块     | 语言为 `pmspec-states` 的围栏代码块 | 块内为 YAML 对象                                                        | 锚点 `SM-<machine>`                                                                              |
| 埋点块       | 语言为 `pmspec-events` 的围栏代码块 | 块内为 YAML 数组                                                        | 锚点 `EVT-<event>`                                                                               |
| 代码证据引用 | `@code(仓库键:相对路径#L起-L止)`    | `@code\(([a-z0-9][a-z0-9-]{1,39}):([^#\s)]+)(?:#L(\d+)(?:-L(\d+))?)?\)` | `#L起-L止` 与 `-L止` 均可省略；经 `PMS-L019` 校验路径归属与行号范围                              |

补充解析规则：

- **Given / When / Then 结构检查（`PMS-L008`）**：验收标准文本中须依次出现 `假如`（或英文 `Given`）、`当`（或 `When`）、`那么`（或 `Then`），英文不区分大小写，三段顺序不得颠倒。
- **角色表提取（`PMS-L016`）**：扫描 `## 角色与权限` 下的第一张 Markdown 表格，首列表头必须为 `角色`，其余数据行首列提取为当前规格声明的角色名，并与 `pmspec.json.roles` 比对。

### 5.3 状态机块字段（`pmspec-states`）

```yaml
machine: refund_order # 必填，正则 ^[a-z][a-z0-9_]{1,39}$
initial: refunding # 必填，必须是 states 中已定义的键
states: # 必填，1～40 个状态；键名正则 ^[a-z][a-z0-9_]{1,39}$
  refunding: { label: 退款中 }
  succeeded: { label: 退款成功, terminal: true }
transitions: # 0～200 条迁移记录
  - { from: refunding, to: succeeded, trigger: 渠道回调成功, actor: 系统 }
```

### 5.4 埋点块字段（`pmspec-events`）

```yaml
- event: refund_submit_click # 必填，正则 ^[a-z][a-z0-9_]{2,63}$，全文件唯一，最多 200 个
  trigger: 商户管理员点击「确认退款」 # 必填
  anchor: REQ-001 # 可选；若填写必须指向本文件内已存在的 REQ-xxx
  properties: # 0～50 个属性
    - { name: order_id, type: string, required: true } # name 正则 ^[a-z][a-z0-9_]{1,63}$
    - { name: refund_type, type: enum, values: [full, partial], required: true }
```

`properties[].type` 允许取值为：`string`、`integer`、`number`、`boolean`、`enum`。当 `type` 为 `enum` 时，必须提供非空的 `values` 数组。

## 6. 确定性校验规则目录（`PMS-L001` 至 `PMS-L024`）

### 6.1 全部 24 条规则

| 规则 ID    | 默认级别                                                                      | 触发条件                                                                                                                                                 | 提示文案模板                                       | 修复建议                                                                             |
| ---------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `PMS-L001` | `error`                                                                       | 文件非有效 UTF-8、首行不是 `---`、或头信息 YAML 解析失败                                                                                                 | 缺少头信息或格式错误：`<YAML 错误行列>`            | 在文件开头补齐 `---` 包裹的合法 YAML 头信息                                          |
| `PMS-L002` | `error`                                                                       | `id` 不符合命名正则，或与所在目录名不一致                                                                                                                | 规格 ID `<id>` 与目录 `<dir>` 不一致               | 统一规格目录名与头信息 `id`                                                          |
| `PMS-L003` | `error`                                                                       | 必填字段缺失，或字段类型、长度、日期格式不符                                                                                                             | 头信息字段 `<field>` 无效：`<原因>`                | 按头信息字段约束修正                                                                 |
| `PMS-L004` | `error`                                                                       | `status` 不在 `draft` / `in-review` / `approved` / `superseded` 内                                                                                       | 状态 `<value>` 无效                                | 改用 `draft`、`in-review`、`approved` 或 `superseded`                                |
| `PMS-L005` | `error`（需求明细）/ `warning`（其余 6 个章节）                               | 缺少必需二级标题                                                                                                                                         | 缺少章节「`<title>`」                              | 按模板补齐必需章节标题                                                               |
| `PMS-L006` | `error`                                                                       | 任一锚点（`REQ` / `AC` / `Q` / `SM` / `EVT`）在全文件出现超过一次                                                                                        | 锚点 `<anchor>` 重复，出现在第 `<lines>` 行        | 为重复锚点重新编号                                                                   |
| `PMS-L007` | `error`                                                                       | 某个 `REQ` 下没有任何 `AC`                                                                                                                               | `<REQ>` 没有验收标准                               | 至少补充 1 条验收标准 `- AC-xxx-01：假如 <前置条件>，当 <触发动作>，那么 <预期结果>` |
| `PMS-L008` | `warning`                                                                     | `AC` 文本未依次包含“假如 / 当 / 那么”（或 `Given / When / Then`）                                                                                        | `<AC>` 不是“假如、当、那么”三段结构                | 改写为前置条件、触发动作与预期结果三段式                                             |
| `PMS-L009` | `error`                                                                       | `AC` 编号前 3 位数字与所属 `REQ` 的 3 位编号不一致                                                                                                       | `<AC>` 不属于 `<REQ>`                              | 修改为 `AC-<REQ 编号>-<两位序号>`                                                    |
| `PMS-L010` | `error`                                                                       | 状态机中存在从 `initial` 出发经 BFS 不可达的状态                                                                                                         | 状态机 `<machine>` 的状态 `<state>` 不可达         | 补充进入该状态的迁移或移除该冗余状态                                                 |
| `PMS-L011` | `error`                                                                       | 非终态（`terminal` 不为 `true`）没有任何出边迁移                                                                                                         | 状态 `<state>` 不是终态但无法离开                  | 补充出边迁移或将其标记为 `terminal: true`                                            |
| `PMS-L012` | `error`                                                                       | 终态（`terminal: true`）存在出边迁移                                                                                                                     | 终态 `<state>` 存在迁移到 `<to>`                   | 删除该出边或取消终态标记                                                             |
| `PMS-L013` | `error`                                                                       | 状态机 YAML 解析失败（`blockErrors`）、`initial` 未定义、迁移引用了未定义状态、或状态/迁移数量越界                                                       | 迁移引用了未定义状态 `<state>`（或块解析失败）     | 在 `states` 中定义对应状态并修正块内 YAML 格式                                       |
| `PMS-L014` | `warning`                                                                     | 状态迁移缺少非空的 `trigger` 或 `actor`                                                                                                                  | 第 `<line>` 行迁移缺少触发条件或执行者             | 在迁移对象中补齐 `trigger` 与 `actor`                                                |
| `PMS-L015` | `error`                                                                       | 埋点块 YAML 语法错、事件名不合法或重复、`trigger` 缺失、`enum` 缺少非空 `values`、`anchor` 指向不存在的 `REQ`、属性名或类型不合法                        | 埋点 `<event>`：`<原因>`                           | 按埋点块字段规范修正                                                                 |
| `PMS-L016` | `warning`                                                                     | 角色表中出现的角色未在 `pmspec.json.roles` 中声明                                                                                                        | 角色「`<role>`」未在工作区角色列表中声明           | 在 `pmspec.json` 补充该角色或改用已声明角色                                          |
| `PMS-L017` | `warning`                                                                     | `AC` 含有模糊词：`尽快`、`及时`、`适当`、`合理`、`友好`、`大概`、`左右`、`若干`、`等等`、`相关`、`一般情况下`、`支持多种`                                | `<AC>` 含模糊表述「`<词>`」                        | 替换为可度量的具体数值、时限或明确枚举条件                                           |
| `PMS-L018` | `error`（`approved`）/ `warning`（`in-review`）；`draft` 与 `superseded` 不报 | 存在 `[open]` 状态的待决问题，或 `[resolved]` 行缺少 `结论：`                                                                                            | 待决问题 `<Q>` 尚未关闭                            | 给出明确结论并将状态标记为 `[resolved]` 附带 `结论：`                                |
| `PMS-L019` | `error`                                                                       | `@code(<仓库键>:<相对路径>)` 引用的仓库键未在 `codeRepos` 声明、路径逃逸仓库根目录、文件不存在、或起止行号越界（`startLine > endLine` 或超出文件总行数） | 证据引用 `<ref>` 无效：`<原因>`                    | 修正仓库键、相对路径或行号范围                                                       |
| `PMS-L020` | `error`（`approved`）/ `warning`（`in-review`）；`draft` 不报                 | 存在 `[假设]` 标记的需求                                                                                                                                 | `<REQ>` 仍是待确认假设                             | 与业务确认后补充验收细节并移除 `[假设]` 标记                                         |
| `PMS-L021` | `warning`                                                                     | 需求标题缺少 `[P0]` / `[P1]` / `[P2]` 优先级标记                                                                                                         | `<REQ>` 缺少优先级                                 | 在需求标题中补充 `[P0]`、`[P1]` 或 `[P2]`                                            |
| `PMS-L022` | `error`                                                                       | 头信息 `codeRefs` 引用了 `pmspec.json` 中未声明的 `codeRepos[].key`                                                                                      | 头信息 codeRefs 中的 `<key>` 未在 pmspec.json 声明 | 在 `pmspec.json` 的 `codeRepos` 中补充声明或移除错误键名                             |
| `PMS-L023` | `warning`（`edit` 阶段）/ `error`（`publish` 阶段）                           | 命中真实手机号、校验位合法的 18 位身份证号、Luhn 校验通过的 16～19 位银行卡号；邮箱仅在 `edit` 阶段报 `warning`                                          | 第 `<line>` 行疑似包含`<类型>`                     | 改为脱敏示例写法，例如 `138****1234`                                                 |
| `PMS-L024` | `error`                                                                       | 规格文件大于 1 MiB 或超过 5,000 行                                                                                                                       | 规格文件超过上限                                   | 将超大规格拆分为多个独立规格文档                                                     |

### 6.2 规则依赖与短路逻辑

为确保“一处缺陷只报一类问题”，规则执行遵循以下短路原则：

1. 命中 `PMS-L024` 时立即终止，不解析正文也不执行任何其他规则。
2. 头信息为 `null`（命中 `PMS-L001`）时，跳过 `PMS-L002`、`PMS-L003`、`PMS-L004`、`PMS-L018`、`PMS-L020`、`PMS-L022`。
3. `status` 非法（命中 `PMS-L004`）时，`PMS-L018` 与 `PMS-L020` 按 `draft` 阶段行为处理。
4. 某个状态机块 YAML 解析失败（进入 `blockErrors`）时，该块只报 `PMS-L013`，跳过 `PMS-L010`、`PMS-L011`、`PMS-L012`、`PMS-L014`。

### 6.3 敏感信息检测规范（`PMS-L023`）

扫描正文全部行（包含围栏代码块），不扫描头信息 `owner` 与 `reviewers`：

| 类型     | 匹配正则                                           | 二次校验                           | 阶段策略                          |
| -------- | -------------------------------------------------- | ---------------------------------- | --------------------------------- |
| 手机号   | `(?<!\d)1[3-9]\d{9}(?!\d)`                         | 无                                 | `edit`: warning；`publish`: error |
| 身份证号 | `(?<![0-9Xx])[1-9]\d{16}[0-9Xx](?![0-9Xx])`        | ISO 7064 MOD 11-2 校验位通过才命中 | `edit`: warning；`publish`: error |
| 银行卡号 | `(?<!\d)\d{16,19}(?!\d)`                           | Luhn 算法通过才命中                | `edit`: warning；`publish`: error |
| 邮箱     | `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}` | 无                                 | 仅 `edit` 阶段报 warning          |

## 7. 完整工作示例：`PAY-REFUND-001`

### 7.1 `pmspec.json`

```json
{
  "version": 1,
  "product": "收单商户平台",
  "specsDir": "specs",
  "codeRepos": [
    {
      "key": "merchant-api",
      "path": "../merchant-api",
      "description": "商户服务：退款申请、退款单查询"
    }
  ],
  "roles": ["商户管理员", "商户操作员", "运营", "系统"],
  "review": { "requiredSignoffRoles": ["研发", "测试"] },
  "lint": { "disabled": [], "severityOverrides": {} }
}
```

### 7.2 `specs/PAY-REFUND-001/spec.md`

````markdown
---
id: PAY-REFUND-001
title: 商户自助退款
owner: 张三
status: draft
version: 3
product: 收单商户平台
reviewers: [李四（研发）, 王五（测试）]
codeRefs: [merchant-api]
updated: 2026-11-21
---

# 商户自助退款

## 背景与目标

商户目前需联系客服发起退款，平均处理时长 2 个工作日。目标：商户在商户后台自助发起退款，90% 的退款申请在 10 分钟内完成渠道受理。

## 范围

- 范围内：已支付订单的全额退款、部分退款；退款结果查询。
- 范围外：跨月退款的手续费返还规则（由清结算规格 SETTLE-FEE-002 负责）。

## 角色与权限

| 角色       | 可执行操作                             |
| ---------- | -------------------------------------- |
| 商户管理员 | 发起全额退款、部分退款，查看全部退款单 |
| 商户操作员 | 查看退款单                             |
| 系统       | 处理渠道回调、超时关闭                 |

## 需求明细

### REQ-001 [P0] 商户发起全额退款

现网退款入口仅对客服开放，见 @code(merchant-api:src/refund/RefundController.java#L40-L58)。

- AC-001-01：假如 订单状态为「已支付」且未发生过退款，当 商户管理员提交全额退款，那么 系统创建退款单，状态为「退款中」，并冻结订单可退金额。
- AC-001-02：假如 同一订单已存在「退款中」的退款单，当 商户管理员再次提交退款，那么 系统拒绝请求并提示「该订单有处理中的退款」。

### REQ-002 [P0] 渠道退款结果处理

- AC-002-01：假如 退款单状态为「退款中」，当 系统收到渠道退款成功回调，那么 退款单状态变为「退款成功」，解冻并扣减可退金额。
- AC-002-02：假如 同一渠道回调重复送达，当 系统再次处理，那么 退款单状态与金额不发生变化，并记录重复回调日志。

### REQ-003 [P1] 退款失败后重发

- AC-003-01：假如 退款单状态为「退款失败」且失败时间在 7 天内，当 商户管理员点击「重新发起」，那么 系统将该退款单状态改为「退款中」并重新请求渠道。
- AC-003-02：假如 退款单状态为「退款失败」且失败时间超过 7 天，当 系统执行每日关闭任务，那么 退款单状态变为「已关闭」，解冻可退金额。

## 状态流转

```pmspec-states
machine: refund_order
initial: refunding
states:
  refunding: { label: 退款中 }
  succeeded: { label: 退款成功, terminal: true }
  failed: { label: 退款失败 }
  closed: { label: 已关闭, terminal: true }
transitions:
  - { from: refunding, to: succeeded, trigger: 渠道回调成功, actor: 系统 }
  - { from: refunding, to: failed, trigger: 渠道回调失败, actor: 系统 }
  - { from: failed, to: refunding, trigger: 商户重新发起, actor: 商户管理员 }
  - { from: failed, to: closed, trigger: 失败超过 7 天, actor: 系统 }
```

## 非功能需求

- 退款提交接口 P95 响应时间 ≤ 800 毫秒。
- 渠道回调处理必须幂等，以渠道退款流水号去重。

## 埋点

```pmspec-events
- event: refund_submit_click
  trigger: 商户管理员点击「确认退款」
  anchor: REQ-001
  properties:
    - { name: order_id, type: string, required: true }
    - { name: refund_amount_fen, type: integer, required: true }
    - { name: refund_type, type: enum, values: [full, partial], required: true }
```

## 待决问题

- Q-001 [resolved] 部分退款是否允许多次？结论：允许，累计金额不超过订单实付金额。
````
