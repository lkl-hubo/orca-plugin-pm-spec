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

待补充具体验收步骤。

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
