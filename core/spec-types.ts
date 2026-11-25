export type SpecStatus = 'draft' | 'in-review' | 'approved' | 'superseded'
export type LintSeverity = 'error' | 'warning'
export type LintStage = 'edit' | 'publish'

/** 1-based inclusive line numbers in the raw file. */
export type SourceRange = { startLine: number; endLine: number }

export type SpecFrontmatter = {
  id: string
  title: string
  owner: string
  status: SpecStatus
  version: number
  product: string | null
  reviewers: string[]
  codeRefs: string[]
  supersedes: string | null
  updated: string | null
  range: SourceRange
}

export type AcceptanceCriterion = {
  id: string
  reqNumber: number
  text: string
  hasGivenWhenThen: boolean
  range: SourceRange
}

export type Requirement = {
  id: string
  number: number
  title: string
  priority: 'P0' | 'P1' | 'P2' | null
  assumption: boolean
  bodyMarkdown: string
  criteria: AcceptanceCriterion[]
  range: SourceRange
}

export type OpenQuestion = {
  id: string
  status: 'open' | 'resolved'
  text: string
  conclusion: string | null
  range: SourceRange
}

export type StateTransition = {
  from: string
  to: string
  trigger: string | null
  actor: string | null
  line: number
}

export type StateMachine = {
  machine: string
  initial: string
  states: Record<string, { label: string; terminal: boolean }>
  transitions: StateTransition[]
  range: SourceRange
}

export type EventProperty = {
  name: string
  type: 'string' | 'integer' | 'number' | 'boolean' | 'enum'
  required: boolean
  values: string[]
}

export type TrackingEvent = {
  event: string
  trigger: string | null
  anchor: string | null
  properties: EventProperty[]
  range: SourceRange
}

export type EvidenceRef = {
  repo: string
  path: string
  startLine: number | null
  endLine: number | null
  range: SourceRange
}

export type SpecSection = {
  anchor: string
  title: string
  bodyMarkdown: string
  range: SourceRange
}

export type FrontmatterIssue = {
  ruleId: 'PMS-L002' | 'PMS-L003' | 'PMS-L004'
  field: string
  message: string
  hint: string
  range: SourceRange
}

export type EventBlockIssue = {
  anchor: string | null
  message: string
  hint: string
  range: SourceRange
}

export type ParsedSpec = {
  filePath: string
  rawSha256: string
  byteLength: number
  lineCount: number
  sizeLimitExceeded: boolean
  frontmatter: SpecFrontmatter | null
  frontmatterError: string | null
  frontmatterIssues: FrontmatterIssue[]
  statusInvalid: boolean
  bodyStartLine: number
  bodyLines: string[]
  sections: SpecSection[]
  requirements: Requirement[]
  questions: OpenQuestion[]
  stateMachines: StateMachine[]
  events: TrackingEvent[]
  eventIssues: EventBlockIssue[]
  evidenceRefs: EvidenceRef[]
  roleTable: string[]
  anchorOccurrences: Record<string, SourceRange[]>
  blockErrors: { anchor: string | null; message: string; range: SourceRange }[]
}

export type LintIssue = {
  ruleId: string
  severity: LintSeverity
  message: string
  hint: string
  anchor: string | null
  range: SourceRange | null
}

export type LintReport = {
  specId: string | null
  filePath: string
  rawSha256: string
  stage: LintStage
  issues: LintIssue[]
  counts: { error: number; warning: number }
  durationMs: number
}

export type EvidenceCheckResult = {
  ref: EvidenceRef
  ok: boolean
  reason: 'unknown-repo' | 'path-escape' | 'not-found' | 'line-out-of-range' | null
}

export type SignoffRole = '产品' | '研发' | '测试' | '业务' | '风控' | '其他'

export type CodeRepoConfig = {
  key: string
  path: string
  description?: string
}

export type LintConfig = {
  disabled: string[]
  severityOverrides: Record<string, LintSeverity>
}

export type WorkspaceConfig = {
  version: 1
  product: string
  specsDir: string
  codeRepos: CodeRepoConfig[]
  roles: string[]
  review: { requiredSignoffRoles: SignoffRole[] }
  lint: LintConfig
}

export type WorkspaceConfigError = { path: string; message: string }

export type SpecItemKind = 'section' | 'req' | 'question' | 'states' | 'events'

export type ExtractedSpecItem = {
  anchor: string
  kind: SpecItemKind
  parent: string | null
  title: string
  markdown: string
  sha256: string
}

export type SnapshotManifestItem = {
  anchor: string
  kind: SpecItemKind
  title: string
  sha256: string
  markdown?: string
}

export type SnapshotManifest = {
  schemaVersion: 1
  specId: string
  version: number
  sha256: string
  createdAt: string
  createdBy: string
  lint: { error: number; warning: number }
  items: SnapshotManifestItem[]
}

export type DiffLineOp = { op: 'equal' | 'add' | 'del'; text: string }

export type SpecDiff = {
  specId: string
  fromVersion: number
  toVersion: number
  added: { anchor: string; title: string }[]
  removed: { anchor: string; title: string }[]
  modified: {
    anchor: string
    title: string
    lines: DiffLineOp[] | null
  }[]
}

export type FindingCategory =
  | 'reverse-flow'
  | 'idempotency'
  | 'concurrency'
  | 'permission'
  | 'state-machine'
  | 'data-consistency'
  | 'compatibility'
  | 'boundary-value'
  | 'ambiguity'
  | 'code-conflict'
  | 'missing-nfr'
  | 'tracking'

export type FindingSeverity = 'blocker' | 'major' | 'minor'
export type FindingConfidence = 'verified' | 'inferred' | 'assumption'

export type FindingCodeEvidence = {
  kind: 'code'
  repo: string
  path: string
  startLine: number
  endLine: number
  quote: string
}

export type FindingSpecEvidence = {
  kind: 'spec'
  anchor: string
  quote: string
}

export type FindingEvidence = FindingCodeEvidence | FindingSpecEvidence

export type FindingInput = {
  id: string
  anchor: string | null
  category: FindingCategory
  severity: FindingSeverity
  title: string
  detail: string
  suggestion: string
  confidence: FindingConfidence
  evidence: FindingEvidence[]
}

export type NormalizedFinding = FindingInput & {
  anchorUnknown: boolean
  downgradeReason: string | null
  verifiedEvidenceCount: number
  pmDecision: 'accepted' | 'rejected' | null
}

export type FindingsSummary = {
  total: number
  verified: number
  inferred: number
  assumption: number
  downgraded: number
  blocker: number
  major: number
  minor: number
  duplicateCount: number
  truncated: boolean
}

export type RunStatus =
  | 'launching'
  | 'running'
  | 'collecting'
  | 'succeeded'
  | 'tainted'
  | 'failed'
  | 'timed_out'
  | 'cancelled'

export type RunRepoRecord = {
  key: string
  path: string
  git: boolean
  headBefore: string | null
  porcelainBeforeSha256: string | null
  headAfter: string | null
  porcelainAfterSha256: string | null
  skippedReason: string | null
}

export type RunRecord = {
  schemaVersion: 1
  runId: string
  specId: string
  specPath: string
  specSha256: string
  agent: string
  terminalId: string | null
  status: RunStatus
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  timeoutAt: string | null
  repos: RunRepoRecord[]
  guard: 'enforced' | 'unguarded'
  toolViolations: { tool: string; detail: string; at: string }[]
  taint: { changed: boolean; repos: string[] }
  error: { code: string; message: string; detail?: string } | null
  summary: FindingsSummary | null
}
