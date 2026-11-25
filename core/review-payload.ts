import type {
  ExtractedSpecItem,
  ParsedSpec,
  Requirement,
  SignoffRole,
  SnapshotManifest,
  SourceRange,
  StateMachine,
  TrackingEvent,
  WorkspaceConfig
} from './spec-types.ts'
import { sha256Hex } from './yaml-frontmatter.ts'

export const MAX_REVIEW_ITEMS = 1000
export const MAX_ITEM_MARKDOWN_BYTES = 64 * 1024

export type GatewayReviewItem = {
  anchor: string
  kind: ExtractedSpecItem['kind']
  parent: string | null
  title: string
  markdown: string
}

export type GatewayReviewPayload = {
  specId: string
  title: string
  version: number
  snapshotSha256: string
  requiredSignoffRoles: SignoffRole[]
  expiresInDays: number
  previousVersionDiff?: {
    fromVersion: number
    added: number
    modified: number
    removed: number
  }
  items: GatewayReviewItem[]
}

function formatRequirementTitle(req: Requirement): string {
  const parts: string[] = []
  if (req.priority) {
    parts.push(`[${req.priority}]`)
  }
  if (req.assumption) {
    parts.push('[假设]')
  }
  parts.push(req.title)
  return parts.join(' ').slice(0, 200)
}

function formatStateMachineMarkdown(machine: StateMachine): string {
  const rows: string[] = [
    '| 起始状态 | 目标状态 | 触发条件 | 执行者 |',
    '| --- | --- | --- | --- |'
  ]
  for (const t of machine.transitions) {
    const fromLabel = machine.states[t.from]?.label ?? t.from
    const toLabel = machine.states[t.to]?.label ?? t.to
    rows.push(`| ${fromLabel} | ${toLabel} | ${t.trigger ?? '-'} | ${t.actor ?? '-'} |`)
  }
  return rows.join('\n')
}

function formatEventMarkdown(ev: TrackingEvent): string {
  const lines: string[] = [`触发条件：${ev.trigger ?? '-'}`]
  if (ev.anchor) {
    lines.push(`关联需求：${ev.anchor}`)
  }
  if (ev.properties.length > 0) {
    lines.push('', '| 属性名 | 类型 | 必填 | 取值 |', '| --- | --- | --- | --- |')
    for (const prop of ev.properties) {
      const vals = prop.values.length > 0 ? prop.values.join(', ') : '-'
      lines.push(`| ${prop.name} | ${prop.type} | ${prop.required ? '是' : '否'} | ${vals} |`)
    }
  }
  return lines.join('\n')
}

function makeItem(
  anchor: string,
  kind: ExtractedSpecItem['kind'],
  parent: string | null,
  title: string,
  markdown: string
): ExtractedSpecItem {
  const normalized = markdown.replaceAll('\r\n', '\n').trim()
  return {
    anchor,
    kind,
    parent,
    title: title.slice(0, 200),
    markdown: normalized,
    sha256: sha256Hex(normalized)
  }
}

function isLineInsideRanges(lineNum: number, ranges: readonly SourceRange[]): boolean {
  return ranges.some((r) => lineNum >= r.startLine && lineNum <= r.endLine)
}

function extractSectionOwnMarkdown(
  parsed: ParsedSpec,
  sectionRange: SourceRange,
  childRanges: readonly SourceRange[]
): string {
  const ownLines: string[] = []
  for (let lineNum = sectionRange.startLine + 1; lineNum <= sectionRange.endLine; lineNum += 1) {
    if (isLineInsideRanges(lineNum, childRanges)) {
      continue
    }
    const idx = lineNum - parsed.bodyStartLine
    if (idx >= 0 && idx < parsed.bodyLines.length) {
      ownLines.push(parsed.bodyLines[idx]!)
    }
  }
  return ownLines.join('\n').trim()
}

export function extractSpecItems(parsed: ParsedSpec): ExtractedSpecItem[] {
  const childRanges: SourceRange[] = [
    ...parsed.requirements.map((r) => r.range),
    ...parsed.questions.map((q) => q.range),
    ...parsed.stateMachines.map((sm) => sm.range),
    ...parsed.events.map((ev) => ev.range)
  ]

  type PositionedChild = { startLine: number; item: Omit<ExtractedSpecItem, 'parent'> }
  const positionedChildren: PositionedChild[] = []

  for (const req of parsed.requirements) {
    positionedChildren.push({
      startLine: req.range.startLine,
      item: makeItem(req.id, 'req', null, formatRequirementTitle(req), req.bodyMarkdown)
    })
  }
  for (const sm of parsed.stateMachines) {
    positionedChildren.push({
      startLine: sm.range.startLine,
      item: makeItem(`SM-${sm.machine}`, 'states', null, sm.machine, formatStateMachineMarkdown(sm))
    })
  }
  const seenEvents = new Set<string>()
  for (const ev of parsed.events) {
    const anchor = `EVT-${ev.event}`
    if (!ev.event || seenEvents.has(anchor)) {
      continue
    }
    seenEvents.add(anchor)
    positionedChildren.push({
      startLine: ev.range.startLine,
      item: makeItem(anchor, 'events', null, ev.event, formatEventMarkdown(ev))
    })
  }
  for (const q of parsed.questions) {
    const qMarkdown = q.conclusion ? `${q.text} 结论：${q.conclusion}` : q.text
    positionedChildren.push({
      startLine: q.range.startLine,
      item: makeItem(q.id, 'question', null, `${q.id} [${q.status}]`, qMarkdown)
    })
  }

  positionedChildren.sort((a, b) => a.startLine - b.startLine)

  const items: ExtractedSpecItem[] = []
  const assignedChildren = new Set<PositionedChild>()

  for (const section of parsed.sections) {
    const ownMarkdown = extractSectionOwnMarkdown(parsed, section.range, childRanges)
    items.push(makeItem(section.anchor, 'section', null, section.title, ownMarkdown))
    for (const child of positionedChildren) {
      if (
        !assignedChildren.has(child) &&
        child.startLine >= section.range.startLine &&
        child.startLine <= section.range.endLine
      ) {
        assignedChildren.add(child)
        items.push({ ...child.item, parent: section.anchor })
      }
    }
  }

  for (const child of positionedChildren) {
    if (!assignedChildren.has(child)) {
      items.push({ ...child.item, parent: null })
    }
  }

  return items
}

export function buildSnapshotManifest(
  parsed: ParsedSpec,
  options: { createdAt: string; createdBy: string; lint: { error: number; warning: number } }
): SnapshotManifest {
  if (!parsed.frontmatter) {
    throw new Error('Cannot build snapshot manifest without valid frontmatter')
  }
  const extracted = extractSpecItems(parsed)
  return {
    schemaVersion: 1,
    specId: parsed.frontmatter.id,
    version: parsed.frontmatter.version,
    sha256: parsed.rawSha256,
    createdAt: options.createdAt,
    createdBy: options.createdBy,
    lint: { error: options.lint.error, warning: options.lint.warning },
    items: extracted.map((item) => ({
      anchor: item.anchor,
      kind: item.kind,
      title: item.title,
      sha256: item.sha256
    }))
  }
}

export function buildGatewayReviewPayload(
  parsed: ParsedSpec,
  config: WorkspaceConfig,
  options: {
    snapshotSha256: string
    expiresInDays?: number
    previousVersionDiff?: GatewayReviewPayload['previousVersionDiff']
  }
): GatewayReviewPayload {
  if (!parsed.frontmatter) {
    throw new Error('Cannot build review payload without valid frontmatter')
  }
  const extracted = extractSpecItems(parsed)
  if (extracted.length === 0 || extracted.length > MAX_REVIEW_ITEMS) {
    throw new Error(`items must contain 1-${MAX_REVIEW_ITEMS} entries (got ${extracted.length})`)
  }
  const encoder = new TextEncoder()
  const items: GatewayReviewItem[] = extracted.map((item, index) => {
    if (encoder.encode(item.markdown).byteLength > MAX_ITEM_MARKDOWN_BYTES) {
      throw new Error(`items[${index}].markdown exceeds 64 KiB`)
    }
    return {
      anchor: item.anchor,
      kind: item.kind,
      parent: item.parent,
      title: item.title,
      markdown: item.markdown
    }
  })

  return {
    specId: parsed.frontmatter.id,
    title: parsed.frontmatter.title,
    version: parsed.frontmatter.version,
    snapshotSha256: options.snapshotSha256,
    requiredSignoffRoles: [...config.review.requiredSignoffRoles],
    expiresInDays: options.expiresInDays ?? 14,
    ...(options.previousVersionDiff ? { previousVersionDiff: options.previousVersionDiff } : {}),
    items
  }
}
