import {
  AC_ITEM_REGEX,
  CODE_REF_PATTERN,
  decodeUtf8Fatal,
  hasGivenWhenThenOrder,
  normalizeSpecText,
  parseQuestionContent,
  parseTableCells,
  QUESTION_ITEM_REGEX,
  REQ_HEADING_REGEX,
  splitMarkdownLines
} from './id-format.ts'
import type { AcceptanceCriterion, ParsedSpec, SourceRange } from './spec-types.ts'
import { parseStateMachineBlock } from './state-machine-check.ts'
import { extractFrontmatter, parseEventsBlock } from './yaml-frontmatter.ts'

export { hasGivenWhenThenOrder } from './id-format.ts'

export const MAX_SPEC_BYTES = 1024 * 1024
export const MAX_SPEC_LINES = 5000

const TABLE_SEP_RE = /^:?-{1,}:?$/
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/

function createBaseParsedSpec(filePath: string, rawSha256: string, byteLength: number): ParsedSpec {
  return {
    filePath,
    rawSha256,
    byteLength,
    lineCount: 0,
    sizeLimitExceeded: false,
    frontmatter: null,
    frontmatterError: null,
    frontmatterIssues: [],
    statusInvalid: false,
    bodyStartLine: 1,
    bodyLines: [],
    sections: [],
    requirements: [],
    questions: [],
    stateMachines: [],
    events: [],
    eventIssues: [],
    evidenceRefs: [],
    roleTable: [],
    anchorOccurrences: {},
    blockErrors: []
  }
}

export function parseSpec(raw: string | Uint8Array, filePath = 'spec.md'): ParsedSpec {
  const decoded = decodeUtf8Fatal(raw)
  const spec = createBaseParsedSpec(filePath, decoded.rawSha256, decoded.byteLength)

  if (decoded.byteLength > MAX_SPEC_BYTES) {
    spec.lineCount = decoded.ok ? splitMarkdownLines(normalizeSpecText(decoded.text)).length : 0
    spec.sizeLimitExceeded = true
    return spec
  }
  if (!decoded.ok) {
    spec.frontmatterError = decoded.error
    return spec
  }
  const lines = splitMarkdownLines(normalizeSpecText(decoded.text))
  spec.lineCount = lines.length
  if (lines.length > MAX_SPEC_LINES) {
    spec.sizeLimitExceeded = true
    return spec
  }

  const fm = extractFrontmatter(lines, filePath)
  spec.frontmatter = fm.frontmatter
  spec.frontmatterError = fm.error
  spec.frontmatterIssues = fm.issues
  spec.statusInvalid = fm.statusInvalid
  spec.bodyStartLine = fm.bodyStartIndex + 1
  spec.bodyLines = lines.slice(fm.bodyStartIndex)

  const recordAnchor = (anchor: string, range: SourceRange): void => {
    const list = spec.anchorOccurrences[anchor]
    if (list) {
      list.push(range)
    } else {
      spec.anchorOccurrences[anchor] = [range]
    }
  }

  let openSection: { anchor: string; title: string; startLine: number; lines: string[] } | null =
    null
  let openReq: {
    id: string
    number: number
    title: string
    priority: 'P0' | 'P1' | 'P2' | null
    assumption: boolean
    startLine: number
    lines: string[]
    criteria: AcceptanceCriterion[]
  } | null = null
  let openFence: {
    char: '`' | '~'
    length: number
    lang: string
    startLine: number
    lines: string[]
  } | null = null
  let roleState: 'inactive' | 'seeking' | 'separator' | 'rows' | 'done' = 'inactive'

  const closeReq = (endLine: number): void => {
    if (!openReq) {
      return
    }
    spec.requirements.push({
      id: openReq.id,
      number: openReq.number,
      title: openReq.title,
      priority: openReq.priority,
      assumption: openReq.assumption,
      bodyMarkdown: openReq.lines.join('\n').trim(),
      criteria: openReq.criteria,
      range: { startLine: openReq.startLine, endLine }
    })
    openReq = null
  }

  const closeSection = (endLine: number): void => {
    if (!openSection) {
      return
    }
    spec.sections.push({
      anchor: openSection.anchor,
      title: openSection.title,
      bodyMarkdown: openSection.lines.join('\n').trim(),
      range: { startLine: openSection.startLine, endLine }
    })
    openSection = null
    if (roleState !== 'done') {
      roleState = 'inactive'
    }
  }

  const finishFence = (endLine: number): void => {
    if (!openFence) {
      return
    }
    const range: SourceRange = { startLine: openFence.startLine, endLine }
    const yamlText = openFence.lines.join('\n')
    if (openFence.lang === 'pmspec-states') {
      const res = parseStateMachineBlock(yamlText, range)
      if (res.ok) {
        spec.stateMachines.push(res.machine)
        recordAnchor(`SM-${res.machine.machine}`, range)
      } else {
        if (res.anchor) {
          recordAnchor(res.anchor, range)
        }
        spec.blockErrors.push({ anchor: res.anchor, message: res.message, range })
      }
    } else if (openFence.lang === 'pmspec-events') {
      parseEventsBlock(yamlText, range, spec.events, spec.eventIssues, recordAnchor)
    }
    openFence = null
  }

  for (let i = fm.bodyStartIndex; i < lines.length; i += 1) {
    const line = lines[i]!
    const lineNum = i + 1

    if (openFence) {
      openSection?.lines.push(line)
      openReq?.lines.push(line)
      const trimmed = line.trim()
      const isClose =
        trimmed.startsWith(openFence.char.repeat(openFence.length)) &&
        trimmed.split('').every((ch) => ch === openFence!.char)
      if (isClose) {
        finishFence(lineNum)
      } else {
        openFence.lines.push(line)
      }
      continue
    }

    const fenceMatch = FENCE_OPEN_RE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]!
      const info = fenceMatch[2]!.trim()
      const char = marker[0] === '~' ? '~' : '`'
      if (!(char === '`' && info.includes('`'))) {
        openSection?.lines.push(line)
        openReq?.lines.push(line)
        openFence = {
          char,
          length: marker.length,
          lang: info.split(/\s+/)[0] ?? '',
          startLine: lineNum,
          lines: []
        }
        continue
      }
    }

    if (line.startsWith('## ')) {
      closeReq(lineNum - 1)
      closeSection(lineNum - 1)
      const title = line.slice(3).trim()
      openSection = {
        anchor: `S-${String(spec.sections.length + 1).padStart(2, '0')}`,
        title,
        startLine: lineNum,
        lines: []
      }
      if (title === '角色与权限' && roleState !== 'done') {
        roleState = 'seeking'
      }
      continue
    }

    if (line.startsWith('### ')) {
      closeReq(lineNum - 1)
      openSection?.lines.push(line)
      const reqMatch = REQ_HEADING_REGEX.exec(line.trimEnd())
      if (reqMatch) {
        const id = reqMatch[1]!
        recordAnchor(id, { startLine: lineNum, endLine: lineNum })
        const rawPriority = reqMatch[3]
        const priority =
          rawPriority === 'P0' || rawPriority === 'P1' || rawPriority === 'P2' ? rawPriority : null
        openReq = {
          id,
          number: Number(reqMatch[2]),
          title: reqMatch[5]!.trim(),
          priority,
          assumption: Boolean(reqMatch[4]),
          startLine: lineNum,
          lines: [],
          criteria: []
        }
      }
      continue
    }

    openSection?.lines.push(line)
    openReq?.lines.push(line)

    const acMatch = AC_ITEM_REGEX.exec(line.trimEnd())
    if (acMatch) {
      const acId = acMatch[1]!
      const text = acMatch[4]!.trim()
      const range: SourceRange = { startLine: lineNum, endLine: lineNum }
      recordAnchor(acId, range)
      openReq?.criteria.push({
        id: acId,
        reqNumber: Number(acMatch[2]),
        text,
        hasGivenWhenThen: hasGivenWhenThenOrder(text),
        range
      })
    }

    const qMatch = QUESTION_ITEM_REGEX.exec(line.trimEnd())
    if (qMatch) {
      const qId = qMatch[1]!
      const range: SourceRange = { startLine: lineNum, endLine: lineNum }
      recordAnchor(qId, range)
      spec.questions.push({
        id: qId,
        status: qMatch[2] === 'resolved' ? 'resolved' : 'open',
        ...parseQuestionContent(qMatch[3]!),
        range
      })
    }

    const codeRefRe = new RegExp(CODE_REF_PATTERN, 'g')
    let codeMatch: RegExpExecArray | null
    while ((codeMatch = codeRefRe.exec(line)) !== null) {
      spec.evidenceRefs.push({
        repo: codeMatch[1]!,
        path: codeMatch[2]!,
        startLine: codeMatch[3] ? Number(codeMatch[3]) : null,
        endLine: codeMatch[4] ? Number(codeMatch[4]) : null,
        range: { startLine: lineNum, endLine: lineNum }
      })
    }

    if (roleState === 'seeking' && line.trimStart().startsWith('|')) {
      roleState = parseTableCells(line)[0] === '角色' ? 'separator' : 'done'
    } else if (roleState === 'separator') {
      const cells = parseTableCells(line)
      const isSep =
        line.trimStart().startsWith('|') &&
        cells.length > 0 &&
        cells.every((c) => TABLE_SEP_RE.test(c))
      roleState = isSep ? 'rows' : 'done'
    } else if (roleState === 'rows') {
      if (line.trimStart().startsWith('|')) {
        const firstCell = parseTableCells(line)[0] ?? ''
        if (firstCell.length > 0) {
          spec.roleTable.push(firstCell)
        }
      } else {
        roleState = 'done'
      }
    }
  }

  finishFence(lines.length)
  closeReq(lines.length)
  closeSection(lines.length)
  return spec
}
