import { EVENT_NAME_REGEX, EVENT_PROP_NAME_REGEX } from './id-format.ts'
import type {
  LintIssue,
  LintSeverity,
  ParsedSpec,
  SourceRange,
  WorkspaceConfig
} from './spec-types.ts'
import { checkStateMachine } from './state-machine-check.ts'

export const STRUCTURAL_RULE_IDS: ReadonlySet<string> = new Set([
  'PMS-L001',
  'PMS-L002',
  'PMS-L006',
  'PMS-L024'
])

export const REQUIRED_SECTIONS: readonly { title: string; severity: LintSeverity }[] = [
  { title: '背景与目标', severity: 'warning' },
  { title: '范围', severity: 'warning' },
  { title: '角色与权限', severity: 'warning' },
  { title: '需求明细', severity: 'error' },
  { title: '非功能需求', severity: 'warning' },
  { title: '埋点', severity: 'warning' },
  { title: '待决问题', severity: 'warning' }
]

export const VAGUE_AC_TERMS: readonly string[] = [
  '尽快',
  '及时',
  '适当',
  '合理',
  '友好',
  '大概',
  '左右',
  '若干',
  '等等',
  '相关',
  '一般情况下',
  '支持多种'
]

export function makeLintIssue(
  ruleId: string,
  severity: LintSeverity,
  message: string,
  hint: string,
  anchor: string | null,
  range: SourceRange | null
): LintIssue {
  return { ruleId, severity, message, hint, anchor, range }
}

export function collectRequirementAndMachineIssues(
  parsed: ParsedSpec,
  effectiveStatus: string
): LintIssue[] {
  const out: LintIssue[] = []
  const add = (
    ruleId: string,
    severity: LintSeverity,
    message: string,
    hint: string,
    anchor: string | null,
    range: SourceRange | null
  ): void => {
    out.push(makeLintIssue(ruleId, severity, message, hint, anchor, range))
  }
  for (const req of parsed.requirements) {
    if (req.criteria.length === 0) {
      add('PMS-L007', 'error', `${req.id} 没有验收标准`, '至少补充 1 条 AC', req.id, req.range)
    }
    if (req.priority === null) {
      add(
        'PMS-L021',
        'warning',
        `${req.id} 缺少优先级`,
        '添加 [P0] / [P1] / [P2]',
        req.id,
        req.range
      )
    }
    if (req.assumption && (effectiveStatus === 'in-review' || effectiveStatus === 'approved')) {
      const sev = effectiveStatus === 'approved' ? 'error' : 'warning'
      add('PMS-L020', sev, `${req.id} 仍是待确认假设`, '确认后移除 [假设] 标记', req.id, req.range)
    }
    for (const ac of req.criteria) {
      if (ac.reqNumber !== req.number) {
        add(
          'PMS-L009',
          'error',
          `${ac.id} 不属于 ${req.id}`,
          `改为 AC-${String(req.number).padStart(3, '0')}-xx`,
          ac.id,
          ac.range
        )
      }
      if (!ac.hasGivenWhenThen) {
        add(
          'PMS-L008',
          'warning',
          `${ac.id} 不是“假如、当、那么”三段结构`,
          '改写为前置条件、动作、结果',
          ac.id,
          ac.range
        )
      }
      for (const term of VAGUE_AC_TERMS) {
        if (ac.text.includes(term)) {
          add(
            'PMS-L017',
            'warning',
            `${ac.id} 含模糊表述「${term}」`,
            '改为可度量的数值或明确条件',
            ac.id,
            ac.range
          )
        }
      }
    }
  }
  for (const blockError of parsed.blockErrors) {
    add(
      'PMS-L013',
      'error',
      blockError.message,
      '在 states 中定义并修正状态机块',
      blockError.anchor,
      blockError.range
    )
  }
  for (const machine of parsed.stateMachines) {
    out.push(...checkStateMachine(machine))
  }
  return out
}

export function collectEventAndRoleIssues(
  parsed: ParsedSpec,
  config: WorkspaceConfig | null
): LintIssue[] {
  const out: LintIssue[] = []
  const add = (
    ruleId: string,
    severity: LintSeverity,
    message: string,
    hint: string,
    anchor: string | null,
    range: SourceRange | null
  ): void => {
    out.push(makeLintIssue(ruleId, severity, message, hint, anchor, range))
  }
  const reqIds = new Set(parsed.requirements.map((req) => req.id))
  for (const evIssue of parsed.eventIssues) {
    add('PMS-L015', 'error', evIssue.message, evIssue.hint, evIssue.anchor, evIssue.range)
  }
  for (const ev of parsed.events) {
    const anchor = ev.event ? `EVT-${ev.event}` : null
    const nameLabel = ev.event || '(空)'
    if (!EVENT_NAME_REGEX.test(ev.event)) {
      add(
        'PMS-L015',
        'error',
        `埋点 ${nameLabel}：事件名格式无效`,
        '按埋点块字段修正',
        anchor,
        ev.range
      )
    }
    if (ev.trigger === null) {
      add(
        'PMS-L015',
        'error',
        `埋点 ${nameLabel}：缺少 trigger`,
        '按埋点块字段修正',
        anchor,
        ev.range
      )
    }
    if (ev.anchor !== null && !reqIds.has(ev.anchor)) {
      add(
        'PMS-L015',
        'error',
        `埋点 ${nameLabel}：anchor ${ev.anchor} 指向不存在的 REQ`,
        '按埋点块字段修正',
        anchor,
        ev.range
      )
    }
    for (const prop of ev.properties) {
      if (!EVENT_PROP_NAME_REGEX.test(prop.name)) {
        add(
          'PMS-L015',
          'error',
          `埋点 ${nameLabel}：属性名 ${prop.name || '(空)'} 无效`,
          '按埋点块字段修正',
          anchor,
          ev.range
        )
      }
      if (prop.type === 'enum' && prop.values.length === 0) {
        add(
          'PMS-L015',
          'error',
          `埋点 ${nameLabel}：enum 属性 ${prop.name} 缺少 values`,
          '按埋点块字段修正',
          anchor,
          ev.range
        )
      }
    }
  }
  if (config !== null) {
    const declaredRoles = new Set(config.roles)
    for (const role of parsed.roleTable) {
      if (!declaredRoles.has(role)) {
        add(
          'PMS-L016',
          'warning',
          `角色「${role}」未在工作区角色列表中声明`,
          '在 pmspec.json 补充或改用已声明角色',
          null,
          null
        )
      }
    }
  }
  return out
}
