import { JSON_SCHEMA, load, YAMLException } from '../vendor/js-yaml.mjs'
import { extractSpecDirName, isValidDateString, isValidSpecId } from './id-format.ts'
import type {
  EventBlockIssue,
  EventProperty,
  FrontmatterIssue,
  SourceRange,
  SpecFrontmatter,
  SpecStatus,
  TrackingEvent
} from './spec-types.ts'

export { decodeUtf8Fatal, normalizeSpecText, sha256Hex } from './id-format.ts'

export const MAX_EVENTS_PER_SPEC = 200
export const MAX_EVENT_PROPERTIES = 50

const SPEC_STATUSES: readonly SpecStatus[] = ['draft', 'in-review', 'approved', 'superseded']
const PROP_TYPES: readonly EventProperty['type'][] = [
  'string',
  'integer',
  'number',
  'boolean',
  'enum'
]
const parseSpecStatus = (v: unknown): SpecStatus | null =>
  SPEC_STATUSES.find((s) => s === v) ?? null
const parsePropType = (v: unknown): EventProperty['type'] | null =>
  PROP_TYPES.find((t) => t === v) ?? null

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseYamlWithLineOffset(
  yamlText: string,
  firstLineNumber: number
): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: load(yamlText, { schema: JSON_SCHEMA }) }
  } catch (error) {
    if (error instanceof YAMLException && error.mark) {
      const line = firstLineNumber + (error.mark.line ?? 0)
      const col = (error.mark.column ?? 0) + 1
      return { ok: false, message: `${error.reason ?? error.message} (${line}:${col})` }
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export type FrontmatterExtractResult = {
  frontmatter: SpecFrontmatter | null
  error: string | null
  issues: FrontmatterIssue[]
  statusInvalid: boolean
  bodyStartIndex: number
}

function l003(field: string, reason: string, range: SourceRange): FrontmatterIssue {
  return {
    ruleId: 'PMS-L003',
    field,
    message: `头信息字段 ${field} 无效：${reason}`,
    hint: '按字段表修正',
    range
  }
}

function validateStringList(
  raw: unknown,
  field: string,
  maxItems: number,
  maxLen: number,
  range: SourceRange,
  issues: FrontmatterIssue[]
): string[] {
  if (raw === undefined || raw === null) {
    return []
  }
  if (!Array.isArray(raw)) {
    issues.push(l003(field, '必须是字符串数组', range))
    return []
  }
  if (raw.length > maxItems) {
    issues.push(l003(field, `最多 ${maxItems} 项`, range))
  }
  const result: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim().length === 0 || item.length > maxLen) {
      issues.push(l003(field, `每项需为 1～${maxLen} 个字符`, range))
    } else {
      result.push(item)
    }
  }
  return result
}

function fmFail(error: string, bodyStartIndex = 0): FrontmatterExtractResult {
  return { frontmatter: null, error, issues: [], statusInvalid: false, bodyStartIndex }
}

export function extractFrontmatter(
  lines: readonly string[],
  filePath: string
): FrontmatterExtractResult {
  if (lines.length === 0 || lines[0]?.trimEnd() !== '---') {
    return fmFail('缺少头信息或格式错误：首行不是 ---')
  }
  const endIndex = lines.findIndex((line, idx) => idx >= 1 && line.trimEnd() === '---')
  if (endIndex === -1) {
    return fmFail('缺少头信息或格式错误：未找到闭合的 ---')
  }
  const range: SourceRange = { startLine: 1, endLine: endIndex + 1 }
  const parsed = parseYamlWithLineOffset(lines.slice(1, endIndex).join('\n'), 2)
  if (!parsed.ok) {
    return fmFail(`缺少头信息或格式错误：${parsed.message}`, endIndex + 1)
  }
  if (!isPlainRecord(parsed.value)) {
    return fmFail('缺少头信息或格式错误：头信息必须是 YAML 对象', endIndex + 1)
  }
  const raw = parsed.value
  const issues: FrontmatterIssue[] = []
  const dirName = extractSpecDirName(filePath)
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!isValidSpecId(id)) {
    issues.push({
      ruleId: 'PMS-L002',
      field: 'id',
      message: `需求 ID ${id || '(空)'} 格式无效`,
      hint: '支持 2～64 位中文、字母、数字、-、_，且不能以 - 或 _ 开头',
      range
    })
  } else if (dirName !== null && id.normalize('NFC') !== dirName.normalize('NFC')) {
    issues.push({
      ruleId: 'PMS-L002',
      field: 'id',
      message: `需求 ID ${id} 与目录 ${dirName} 不一致`,
      hint: '统一目录名与 id',
      range
    })
  }

  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (typeof raw.title !== 'string' || title.length < 2 || title.length > 80) {
    issues.push(l003('title', '需为 2～80 个字符', range))
  }
  const owner = typeof raw.owner === 'string' ? raw.owner.trim() : ''
  if (typeof raw.owner !== 'string' || owner.length < 1 || owner.length > 40) {
    issues.push(l003('owner', '需为 1～40 个字符', range))
  }

  const parsedStatus = parseSpecStatus(raw.status)
  const statusInvalid = parsedStatus === null
  if (statusInvalid) {
    issues.push({
      ruleId: 'PMS-L004',
      field: 'status',
      message: `状态 ${typeof raw.status === 'string' ? raw.status : '(缺失)'} 无效`,
      hint: '使用 draft / in-review / approved / superseded',
      range
    })
  }
  const status = parsedStatus ?? 'draft'

  const version = typeof raw.version === 'number' ? raw.version : Number.NaN
  if (!Number.isInteger(version) || version < 1 || version > 9999) {
    issues.push(l003('version', '需为 1～9999 的整数', range))
  }

  let product: string | null = null
  if (raw.product !== undefined && raw.product !== null) {
    if (
      typeof raw.product === 'string' &&
      raw.product.trim().length > 0 &&
      raw.product.length <= 80
    ) {
      product = raw.product
    } else {
      issues.push(l003('product', '需为不超过 80 个字符的字符串', range))
    }
  }

  const reviewers = validateStringList(raw.reviewers, 'reviewers', 20, 40, range, issues)
  const codeRefs = validateStringList(raw.codeRefs, 'codeRefs', 20, 40, range, issues)

  const checkOptStr = (
    val: unknown,
    field: string,
    ok: (s: string) => boolean,
    reason: string
  ): string | null => {
    if (val === undefined || val === null) {
      return null
    }
    if (typeof val === 'string' && ok(val)) {
      return val
    }
    issues.push(l003(field, reason, range))
    return null
  }
  const supersedes = checkOptStr(
    raw.supersedes,
    'supersedes',
    isValidSpecId,
    '格式需与需求 ID 一致'
  )
  const updated = checkOptStr(raw.updated, 'updated', isValidDateString, '需为 YYYY-MM-DD 格式日期')

  return {
    frontmatter: {
      id,
      title,
      owner,
      status,
      version: Number.isInteger(version) ? version : 0,
      product,
      reviewers,
      codeRefs,
      supersedes,
      updated,
      range
    },
    error: null,
    issues,
    statusInvalid,
    bodyStartIndex: endIndex + 1
  }
}

function parseEventProperties(
  rawProps: unknown,
  eventName: string,
  anchor: string | null,
  range: SourceRange,
  eventIssues: EventBlockIssue[]
): EventProperty[] {
  if (!Array.isArray(rawProps)) {
    return []
  }
  const label = eventName || '(未知)'
  const pushIssue = (message: string): void => {
    eventIssues.push({ anchor, message, hint: '按埋点块字段修正', range })
  }
  if (rawProps.length > MAX_EVENT_PROPERTIES) {
    pushIssue(`埋点 ${label}：属性数量超过 ${MAX_EVENT_PROPERTIES}`)
  }
  const properties: EventProperty[] = []
  for (const prop of rawProps.slice(0, MAX_EVENT_PROPERTIES)) {
    if (!isPlainRecord(prop)) {
      pushIssue(`埋点 ${label}：属性条目必须是对象`)
      continue
    }
    const parsedType = parsePropType(prop.type)
    if (!parsedType) {
      pushIssue(
        `埋点 ${label}：属性 ${typeof prop.name === 'string' ? prop.name : '(未知)'} 的 type 无效`
      )
    }
    const values = Array.isArray(prop.values)
      ? prop.values.filter((v): v is string => typeof v === 'string')
      : []
    properties.push({
      name: typeof prop.name === 'string' ? prop.name : '',
      type: parsedType ?? 'string',
      required: prop.required === true,
      values
    })
  }
  return properties
}

export function parseEventsBlock(
  yamlText: string,
  range: SourceRange,
  events: TrackingEvent[],
  eventIssues: EventBlockIssue[],
  recordAnchor: (anchor: string, r: SourceRange) => void
): void {
  const pushBlockErr = (message: string, hint = '按埋点块字段修正'): void => {
    eventIssues.push({ anchor: null, message, hint, range })
  }
  const parsed = parseYamlWithLineOffset(yamlText, range.startLine + 1)
  if (!parsed.ok) {
    pushBlockErr(`埋点块 YAML 解析失败：${parsed.message}`, '检查埋点块 YAML 缩进与语法')
    return
  }
  if (!Array.isArray(parsed.value)) {
    pushBlockErr('埋点块必须是 YAML 数组')
    return
  }
  for (const item of parsed.value) {
    if (events.length >= MAX_EVENTS_PER_SPEC) {
      pushBlockErr(`埋点事件总数超过上限 ${MAX_EVENTS_PER_SPEC}`, '拆分规格或精简埋点数量')
      break
    }
    if (!isPlainRecord(item)) {
      pushBlockErr('埋点条目必须是对象')
      continue
    }
    const eventName = typeof item.event === 'string' ? item.event : ''
    const anchor = eventName ? `EVT-${eventName}` : null
    if (anchor) {
      recordAnchor(anchor, range)
    }
    events.push({
      event: eventName,
      trigger: typeof item.trigger === 'string' && item.trigger.trim() ? item.trigger.trim() : null,
      anchor: typeof item.anchor === 'string' && item.anchor.trim() ? item.anchor.trim() : null,
      properties: parseEventProperties(item.properties, eventName, anchor, range, eventIssues),
      range
    })
  }
}
