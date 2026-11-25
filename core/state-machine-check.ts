import { STATE_KEY_REGEX } from './id-format.ts'
import type { LintIssue, SourceRange, StateMachine, StateTransition } from './spec-types.ts'
import { isPlainRecord, parseYamlWithLineOffset } from './yaml-frontmatter.ts'

export const MAX_STATE_MACHINE_STATES = 40
export const MAX_STATE_MACHINE_TRANSITIONS = 200

export function parseStateMachineBlock(
  yamlText: string,
  range: SourceRange
):
  | { ok: true; machine: StateMachine }
  | { ok: false; anchor: string | null; message: string; range: SourceRange } {
  const parsed = parseYamlWithLineOffset(yamlText, range.startLine + 1)
  if (!parsed.ok) {
    return {
      ok: false,
      anchor: null,
      message: `状态机块 YAML 解析失败：${parsed.message}`,
      range
    }
  }
  if (!isPlainRecord(parsed.value)) {
    return { ok: false, anchor: null, message: '状态机块必须是 YAML 对象', range }
  }
  const raw = parsed.value
  const machineName = typeof raw.machine === 'string' ? raw.machine : ''
  const anchor = machineName ? `SM-${machineName}` : null
  if (!STATE_KEY_REGEX.test(machineName)) {
    return { ok: false, anchor, message: '状态机名称 machine 无效或缺失', range }
  }
  if (typeof raw.initial !== 'string' || raw.initial.length === 0) {
    return { ok: false, anchor, message: `状态机 ${machineName} 缺少 initial 状态`, range }
  }
  if (!isPlainRecord(raw.states)) {
    return { ok: false, anchor, message: `状态机 ${machineName} 缺少 states 对象`, range }
  }
  const stateEntries = Object.entries(raw.states)
  if (stateEntries.length === 0 || stateEntries.length > MAX_STATE_MACHINE_STATES) {
    return {
      ok: false,
      anchor,
      message: `状态机 ${machineName} 状态数量需在 1～${MAX_STATE_MACHINE_STATES} 之间`,
      range
    }
  }
  const states: Record<string, { label: string; terminal: boolean }> = {}
  for (const [key, value] of stateEntries) {
    if (!STATE_KEY_REGEX.test(key) || !isPlainRecord(value) || typeof value.label !== 'string') {
      return {
        ok: false,
        anchor,
        message: `状态机 ${machineName} 的状态 ${key} 定义无效`,
        range
      }
    }
    states[key] = {
      label: value.label,
      terminal: value.terminal === true
    }
  }
  if (raw.transitions !== undefined && !Array.isArray(raw.transitions)) {
    return {
      ok: false,
      anchor,
      message: `状态机 ${machineName} 的 transitions 必须是数组`,
      range
    }
  }
  const rawTransitions = raw.transitions ?? []
  if (rawTransitions.length > MAX_STATE_MACHINE_TRANSITIONS) {
    return {
      ok: false,
      anchor,
      message: `状态机 ${machineName} 迁移数量超过上限 ${MAX_STATE_MACHINE_TRANSITIONS}`,
      range
    }
  }
  const transitions: StateTransition[] = []
  for (const [index, entry] of rawTransitions.entries()) {
    if (!isPlainRecord(entry) || typeof entry.from !== 'string' || typeof entry.to !== 'string') {
      return {
        ok: false,
        anchor,
        message: `状态机 ${machineName} 第 ${index + 1} 条迁移缺少 from 或 to`,
        range
      }
    }
    transitions.push({
      from: entry.from,
      to: entry.to,
      trigger:
        typeof entry.trigger === 'string' && entry.trigger.trim() ? entry.trigger.trim() : null,
      actor: typeof entry.actor === 'string' && entry.actor.trim() ? entry.actor.trim() : null,
      line: range.startLine + 1
    })
  }
  return {
    ok: true,
    machine: {
      machine: machineName,
      initial: raw.initial,
      states,
      transitions,
      range
    }
  }
}

export function checkStateMachine(machine: StateMachine): LintIssue[] {
  const issues: LintIssue[] = []
  const anchor = `SM-${machine.machine}`
  const definedStates = new Set(Object.keys(machine.states))
  const hasInitial = definedStates.has(machine.initial)

  if (!hasInitial) {
    issues.push({
      ruleId: 'PMS-L013',
      severity: 'error',
      message: `迁移引用了未定义状态 ${machine.initial}`,
      hint: '在 states 中定义',
      anchor,
      range: machine.range
    })
    return issues
  }

  for (const transition of machine.transitions) {
    if (!definedStates.has(transition.from)) {
      issues.push({
        ruleId: 'PMS-L013',
        severity: 'error',
        message: `迁移引用了未定义状态 ${transition.from}`,
        hint: '在 states 中定义',
        anchor,
        range: { startLine: transition.line, endLine: transition.line }
      })
    }
    if (!definedStates.has(transition.to)) {
      issues.push({
        ruleId: 'PMS-L013',
        severity: 'error',
        message: `迁移引用了未定义状态 ${transition.to}`,
        hint: '在 states 中定义',
        anchor,
        range: { startLine: transition.line, endLine: transition.line }
      })
    }
  }

  const adj = new Map<string, string[]>()
  const outCount = new Map<string, number>()
  for (const stateKey of definedStates) {
    adj.set(stateKey, [])
    outCount.set(stateKey, 0)
  }

  for (const transition of machine.transitions) {
    if (definedStates.has(transition.from) && definedStates.has(transition.to)) {
      adj.get(transition.from)?.push(transition.to)
      outCount.set(transition.from, (outCount.get(transition.from) ?? 0) + 1)
    }
    if (machine.states[transition.from]?.terminal) {
      issues.push({
        ruleId: 'PMS-L012',
        severity: 'error',
        message: `终态 ${transition.from} 存在迁移到 ${transition.to}`,
        hint: '删除迁移或取消终态标记',
        anchor,
        range: { startLine: transition.line, endLine: transition.line }
      })
    }
    if (transition.trigger === null || transition.actor === null) {
      issues.push({
        ruleId: 'PMS-L014',
        severity: 'warning',
        message: `第 ${transition.line} 行迁移缺少触发条件或执行者`,
        hint: '补充 trigger 与 actor',
        anchor,
        range: { startLine: transition.line, endLine: transition.line }
      })
    }
  }

  const visited = new Set<string>([machine.initial])
  const queue: string[] = [machine.initial]
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!
    for (const next of adj.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next)
        queue.push(next)
      }
    }
  }

  for (const stateKey of definedStates) {
    if (!visited.has(stateKey)) {
      issues.push({
        ruleId: 'PMS-L010',
        severity: 'error',
        message: `状态机 ${machine.machine} 的状态 ${stateKey} 不可达`,
        hint: '补充进入该状态的迁移或删除该状态',
        anchor,
        range: machine.range
      })
    }
    const stateDef = machine.states[stateKey]!
    if (!stateDef.terminal && (outCount.get(stateKey) ?? 0) === 0) {
      issues.push({
        ruleId: 'PMS-L011',
        severity: 'error',
        message: `状态 ${stateKey} 不是终态但无法离开`,
        hint: '补充迁移或标记 terminal: true',
        anchor,
        range: machine.range
      })
    }
  }

  return issues
}
