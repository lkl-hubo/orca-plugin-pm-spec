export type SpecSummary = {
  specId: string
  title: string
  status: 'draft' | 'in-review' | 'approved' | 'superseded'
  version: number
  path: string
  lint: { error: number; warning: number } | null
  lastRun: { runId: string; status: string; finishedAt: string | null } | null
  openReview: { slug: string; openIssues: number; expiresAt: string } | null
}

export type WorkspaceInfo = { id: string; name: string; path: string; hostId: string | null }

export type UnsupportedReason = 'no-workspace' | 'remote-host' | 'no-pmspec' | 'invalid-pmspec'

export type LintIssueView = {
  ruleId: string
  severity: 'error' | 'warning'
  message: string
  hint: string
  anchor: string | null
  line: number | null
}

export type RunView = {
  runId: string
  specId: string
  status:
    | 'launching'
    | 'running'
    | 'collecting'
    | 'succeeded'
    | 'tainted'
    | 'failed'
    | 'timed_out'
    | 'cancelled'
  agent: string
  startedAt: string | null
  finishedAt: string | null
  error: { code: string; message: string } | null
  taintedRepos: string[]
  findings: {
    id: string
    anchor: string | null
    category: string
    severity: 'blocker' | 'major' | 'minor'
    title: string
    detail: string
    suggestion: string
    confidence: 'verified' | 'inferred' | 'assumption'
    downgradeReason: string | null
    evidence: { label: string; quote: string }[]
    pmDecision: 'accepted' | 'rejected' | null
  }[]
}

export type CommentView = {
  id: string
  anchor: string
  authorName: string
  authorRole: string
  kind: 'issue' | 'suggestion' | 'question'
  body: string
  status: 'open' | 'resolved' | 'wont_fix'
  resolutionNote: string | null
  createdAt: string
}

export type ReviewView = {
  slug: string
  specVersion: number
  status: 'open' | 'closed'
  expired: boolean
  reviewUrl: string
  expiresAt: string
  stale: boolean
  requiredSignoffRoles: string[]
  signoffs: {
    reviewerName: string
    role: string
    decision: 'approve' | 'request_changes'
    createdAt: string
  }[]
  comments: CommentView[]
  readyToApprove: boolean
  blockingReasons: string[]
  lastSyncedAt: string | null
}

declare module 'orca' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginRequests {
    'workspace.init': { input: Record<string, never>; output: { created: boolean } }
    'spec.list': {
      input: Record<string, never>
      output: {
        workspace: WorkspaceInfo | null
        unsupportedReason: UnsupportedReason | null
        configErrors: string[]
        specs: SpecSummary[]
      }
    }
    'spec.create': {
      input: { specId: string; title: string }
      output: { specId: string; path: string }
    }
    'spec.select': { input: { specId: string }; output: { specId: string } }
    'spec.detail': {
      input: { specId: string }
      output: {
        summary: SpecSummary
        lint: { issues: LintIssueView[]; durationMs: number }
        snapshots: { version: number; sha256: string; createdAt: string }[]
        currentSha256: string
        runs: RunView[]
        reviews: ReviewView[]
      }
    }
    'spec.lint': {
      input: { specId: string }
      output: { issues: LintIssueView[]; error: number; warning: number; durationMs: number }
    }
    'spec.open': { input: { specId: string }; output: { opened: true } }
    'spec.snapshot': {
      input: { specId: string }
      output: { version: number; sha256: string; reused: boolean }
    }
    'spec.bumpVersion': { input: { specId: string }; output: { version: number } }
    'spec.diff': {
      input: { specId: string; fromVersion: number; toVersion: number }
      output: {
        added: { anchor: string; title: string }[]
        removed: { anchor: string; title: string }[]
        modified: {
          anchor: string
          title: string
          lines: { op: 'equal' | 'add' | 'del'; text: string }[] | null
        }[]
      }
    }
    'review.start': { input: { specId: string }; output: RunView }
    'review.cancel': { input: { runId: string }; output: RunView }
    'review.decide': {
      input: { runId: string; findingId: string; decision: 'accepted' | 'rejected' | null }
      output: { ok: true }
    }
    'review.publish': { input: { specId: string; version: number }; output: ReviewView }
    'review.sync': { input: { slug: string }; output: ReviewView }
    'review.resolveComment': {
      input: {
        slug: string
        commentId: string
        status: 'open' | 'resolved' | 'wont_fix'
        note: string
      }
      output: CommentView
    }
    'review.close': { input: { slug: string }; output: ReviewView }
    'review.rotateKey': { input: { slug: string }; output: { reviewUrl: string } }
    'review.markApproved': {
      input: { specId: string; slug: string }
      output: { status: 'approved' }
    }
    'gateway.status': {
      input: Record<string, never>
      output: {
        configured: boolean
        tokenStored: boolean
        protection: 'os-keyring' | 'unavailable'
        source: 'env' | 'host' | 'plugin' | 'none'
        authMode: 'static' | 'none'
        effectiveGatewayUrl: string
        hasPluginOverride: boolean
        envGatewayUrl: string
        envTokenStored: boolean
        envUrlVar: string | null
        envTokenVar: string | null
        hostGatewayUrl: string | null
        hostConnected: boolean
        hostEnvOverrideActive: boolean
        hostUnreadableError: string | null
      }
    }
    'gateway.saveToken': { input: { token: string }; output: { stored: true } }
    'gateway.clearOverride': { input: Record<string, never>; output: { cleared: true } }
    'gateway.test': {
      input: Record<string, never>
      output: { ok: boolean; backend: string | null; latencyMs: number; errorCode: string | null }
    }
  }

  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginPanelEvents {
    'pmspec.lint.updated': { specId: string; error: number; warning: number }
    'pmspec.run.updated': RunView
    'pmspec.review.updated': { slug: string; newComments: number; openIssues: number }
    'pmspec.workspace.changed': { workspaceId: string | null }
  }
}
