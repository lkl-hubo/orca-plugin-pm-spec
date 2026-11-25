import { describe, expect, it } from './test-kit.ts'
import type { StateMachine } from '../core/spec-types.ts'
import {
  checkStateMachine,
  parseStateMachineBlock
} from '../core/state-machine-check.ts'

describe('state-machine-check', () => {
  it('passes valid connected state machine with terminal exits', () => {
    const machine: StateMachine = {
      machine: 'order_flow',
      initial: 'pending',
      states: {
        pending: { label: '处理中', terminal: false },
        done: { label: '已完成', terminal: true }
      },
      transitions: [{ from: 'pending', to: 'done', trigger: '完成', actor: '系统', line: 5 }],
      range: { startLine: 1, endLine: 8 }
    }
    expect(checkStateMachine(machine)).toEqual([])
  })

  it('detects L010 unreachable, L011 dead-end, L012 terminal exit, L014 missing trigger/actor', () => {
    const machine: StateMachine = {
      machine: 'refund_flow',
      initial: 'init',
      states: {
        init: { label: '初始', terminal: false },
        stuck: { label: '卡住', terminal: false },
        done: { label: '结束', terminal: true },
        orphan: { label: '孤岛', terminal: true }
      },
      transitions: [
        { from: 'init', to: 'stuck', trigger: null, actor: '系统', line: 10 },
        { from: 'init', to: 'done', trigger: '完成', actor: null, line: 11 },
        { from: 'done', to: 'init', trigger: '回退', actor: '运营', line: 12 }
      ],
      range: { startLine: 1, endLine: 14 }
    }

    const issues = checkStateMachine(machine)
    const rules = issues.map((i) => i.ruleId)
    expect(rules).toContain('PMS-L010')
    expect(rules).toContain('PMS-L011')
    expect(rules).toContain('PMS-L012')
    expect(rules.filter((r) => r === 'PMS-L014')).toHaveLength(2)
  })

  it('reports L013 when initial is undefined and skips L010/L011/L012', () => {
    const machine: StateMachine = {
      machine: 'bad_init',
      initial: 'missing',
      states: {
        ready: { label: '就绪', terminal: false }
      },
      transitions: [],
      range: { startLine: 1, endLine: 6 }
    }
    const issues = checkStateMachine(machine)
    expect(issues.map((i) => i.ruleId)).toEqual(['PMS-L013'])
  })

  it('rejects >40 states or >200 transitions in parseStateMachineBlock', () => {
    const stateLines = Array.from({ length: 41 }, (_, i) => `  s_${i}: { label: S${i} }`).join('\n')
    const tooManyStates = `machine: big\ninitial: s_0\nstates:\n${stateLines}\ntransitions: []`
    expect(parseStateMachineBlock(tooManyStates, { startLine: 10, endLine: 55 }).ok).toBe(false)

    const transLines = Array.from(
      { length: 201 },
      () => '  - { from: a, to: b, trigger: go, actor: sys }'
    ).join('\n')
    const tooManyTransitions = `machine: many_t\ninitial: a\nstates:\n  a: { label: A }\n  b: { label: B, terminal: true }\ntransitions:\n${transLines}`
    expect(parseStateMachineBlock(tooManyTransitions, { startLine: 1, endLine: 210 }).ok).toBe(
      false
    )
  })
})
