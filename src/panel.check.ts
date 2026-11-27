import { defineCheck } from 'orca/testing'

const LOCAL_WS = {
  id: 'folder:pm-spec-demo',
  name: 'pay-specs',
  path: '/Users/pm/pay-specs',
  hostId: 'local'
}

const SAMPLE_SPECS = [
  {
    specId: 'PAY-REFUND-001',
    title: '商户自助退款',
    status: 'in-review' as const,
    version: 3,
    path: 'specs/PAY-REFUND-001/spec.md',
    lint: { error: 0, warning: 1 },
    lastRun: {
      runId: 'R-20261121-163012-a3f9',
      status: 'succeeded',
      finishedAt: '2026-11-21T08:36:51.904Z'
    },
    openReview: {
      slug: 'q7Zk3VbN0pW2xYfA9cLm1g',
      openIssues: 1,
      expiresAt: '2026-12-05T08:40:03.512Z'
    }
  },
  {
    specId: 'PAY-SETTLE-002',
    title: '清结算手续费返还',
    status: 'draft' as const,
    version: 1,
    path: 'specs/PAY-SETTLE-002/spec.md',
    lint: { error: 2, warning: 0 },
    lastRun: null,
    openReview: null
  },
  {
    specId: 'MERCH-ONBOARD-003',
    title: '特约商户进件复核',
    status: 'approved' as const,
    version: 2,
    path: 'specs/MERCH-ONBOARD-003/spec.md',
    lint: { error: 0, warning: 0 },
    lastRun: {
      runId: 'R-20261120-110200-b12e',
      status: 'succeeded',
      finishedAt: '2026-11-20T03:10:00.000Z'
    },
    openReview: null
  }
]

const OK_LIST = {
  workspace: LOCAL_WS,
  unsupportedReason: null,
  configErrors: [],
  specs: SAMPLE_SPECS
}
const gwStatus = (configured: boolean) => ({
  configured,
  tokenStored: configured,
  protection: 'os-keyring' as const,
  source: configured ? ('host' as const) : ('none' as const),
  authMode: 'static' as const,
  effectiveGatewayUrl: configured ? 'https://share.example.com' : '',
  hasPluginOverride: false,
  envGatewayUrl: '',
  envTokenStored: false,
  envUrlVar: null,
  envTokenVar: null,
  hostGatewayUrl: configured ? 'https://share.example.com' : null,
  hostConnected: configured,
  hostEnvOverrideActive: false,
  hostUnreadableError: null
})
const GATEWAY_OK = gwStatus(true)
const GATEWAY_UNCONFIGURED = gwStatus(false)
const listScenario = (
  workspace: Record<string, unknown> | null,
  unsupportedReason: string | null,
  specs: typeof SAMPLE_SPECS = [],
  gateway = GATEWAY_OK
) => ({
  requests: {
    'spec.list': { workspace, unsupportedReason, configErrors: [], specs },
    'gateway.status': gateway
  }
})
const SNAPSHOTS = [
  {
    version: 3,
    sha256: '4f0c3b9d2a17e6c58b1f0e9a7d3c2b6e5f4a1d0c9b8e7f6a5d4c3b2a1f0e9d8c',
    createdAt: '2026-11-21T08:40:00.000Z'
  },
  {
    version: 2,
    sha256: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809',
    createdAt: '2026-11-20T10:15:00.000Z'
  }
]
const BASE_DETAIL = {
  summary: SAMPLE_SPECS[0],
  lint: { issues: [], durationMs: 12 },
  snapshots: SNAPSHOTS,
  currentSha256: SNAPSHOTS[0].sha256,
  runs: [],
  reviews: []
}

function detailScenario(activeTab: string, overrides: Record<string, unknown>) {
  return {
    persisted: {
      plugin: { 'pmspec.route': 'detail', 'pmspec.activeTab': activeTab },
      workspace: { 'pmspec.selectedSpecId': 'PAY-REFUND-001' }
    },
    requests: {
      'spec.list': OK_LIST,
      'gateway.status': GATEWAY_OK,
      'spec.detail': { ...BASE_DETAIL, ...overrides }
    }
  }
}

export default defineCheck({
  'empty-workspace': listScenario(null, 'no-workspace', [], GATEWAY_UNCONFIGURED),
  'no-pmspec': listScenario(LOCAL_WS, 'no-pmspec'),
  'remote-host': listScenario(
    { id: 'ssh:dev-box:ws', name: 'pay-specs', path: '/srv/pay-specs', hostId: 'ssh:dev-box' },
    'remote-host'
  ),
  'spec-list': listScenario(LOCAL_WS, null, SAMPLE_SPECS),
  'lint-errors': detailScenario('lint', {
    lint: {
      durationMs: 18,
      issues: [
        {
          ruleId: 'PMS-L007',
          severity: 'error',
          message: 'REQ-003 没有验收标准',
          hint: '至少补充 1 条 AC',
          anchor: 'REQ-003',
          line: 42
        },
        {
          ruleId: 'PMS-L010',
          severity: 'error',
          message: '状态机 refund_order 的状态 manual_review 不可达',
          hint: '补充进入该状态的迁移或删除该状态',
          anchor: 'SM-refund_order',
          line: 61
        },
        {
          ruleId: 'PMS-L008',
          severity: 'warning',
          message: 'AC-001-01 不是“假如、当、那么”三段结构',
          hint: '改写为前置条件、动作、结果',
          anchor: 'AC-001-01',
          line: 24
        }
      ]
    }
  }),
  'precheck-running': detailScenario('precheck', {
    runs: [
      {
        runId: 'R-20261121-163012-a3f9',
        specId: 'PAY-REFUND-001',
        status: 'running',
        agent: 'pi',
        startedAt: '2026-11-21T08:30:14.210Z',
        finishedAt: null,
        error: null,
        taintedRepos: [],
        findings: []
      }
    ]
  }),
  'precheck-results': detailScenario('precheck', {
    runs: [
      {
        runId: 'R-20261121-163012-a3f9',
        specId: 'PAY-REFUND-001',
        status: 'tainted',
        agent: 'opencode',
        startedAt: '2026-11-21T08:30:14.210Z',
        finishedAt: '2026-11-21T08:36:51.904Z',
        error: { code: 'W_UNGUARDED', message: '本次预检未能启用只读保护，已改为事后改动检测' },
        taintedRepos: ['merchant-api'],
        findings: [
          {
            id: 'F-001',
            anchor: 'REQ-002',
            category: 'reverse-flow',
            severity: 'blocker',
            title: '渠道回调丢失时退款单永久停留在退款中',
            detail: 'REQ-002 未定义渠道回调超时主动查询机制，资金将持续冻结。',
            suggestion: '补充 30 分钟主动查询与 24 小时转人工策略。',
            confidence: 'verified',
            downgradeReason: null,
            evidence: [
              {
                label: 'merchant-api:src/refund/RefundCallbackHandler.java#L31-L47',
                quote: 'public void onRefundCallback(RefundCallback callback)'
              }
            ],
            pmDecision: 'accepted'
          },
          {
            id: 'F-002',
            anchor: 'REQ-001',
            category: 'code-conflict',
            severity: 'major',
            title: '金额单位未统一明确为分',
            detail: '现网接口参数使用整数分，正文部分描述未注明单位。',
            suggestion: '在 AC-001-01 显式约定金额单位为分。',
            confidence: 'inferred',
            downgradeReason: 'quote-mismatch',
            evidence: [],
            pmDecision: null
          },
          {
            id: 'F-003',
            anchor: null,
            category: 'missing-nfr',
            severity: 'minor',
            title: '建议明确对账文件生成频次',
            detail: '非功能需求未提及日终对账批次时间窗口。',
            suggestion: '补充 T+1 日终对账说明。',
            confidence: 'assumption',
            downgradeReason: null,
            evidence: [],
            pmDecision: null
          }
        ]
      }
    ]
  }),
  'review-open': detailScenario('review', {
    reviews: [
      {
        slug: 'q7Zk3VbN0pW2xYfA9cLm1g',
        specVersion: 3,
        status: 'open',
        expired: false,
        reviewUrl: 'https://share.example.com/r/q7Zk3VbN0pW2xYfA9cLm1g?k=demoKey',
        expiresAt: '2026-12-05T08:40:03.512Z',
        stale: false,
        requiredSignoffRoles: ['研发', '测试'],
        signoffs: [
          {
            reviewerName: '王五',
            role: '测试',
            decision: 'approve',
            createdAt: '2026-11-22T02:10:44.019Z'
          }
        ],
        comments: [
          {
            id: 'c_0mi8jq4t',
            anchor: 'REQ-002',
            authorName: '李四',
            authorRole: '研发',
            kind: 'issue',
            body: '需补充渠道回调丢失时的主动查询规则。',
            status: 'open',
            resolutionNote: null,
            createdAt: '2026-11-21T09:12:30.004Z'
          },
          {
            id: 'c_0mi8k1ab',
            anchor: 'REQ-001',
            authorName: '王五',
            authorRole: '测试',
            kind: 'suggestion',
            body: '建议补充部分退款最小金额 1 分限制。',
            status: 'resolved',
            resolutionNote: '已补充 AC-001-03',
            createdAt: '2026-11-21T10:00:00.000Z'
          }
        ],
        readyToApprove: false,
        blockingReasons: ['存在 1 条未解决的「问题」意见', '必需角色「研发」尚未签核通过'],
        lastSyncedAt: '2026-11-22T02:15:00.000Z'
      }
    ]
  }),
  'gateway-unconfigured': {
    persisted: { plugin: { 'pmspec.route': 'gateway' } },
    settings: { gatewayUrl: '' },
    requests: { 'spec.list': OK_LIST, 'gateway.status': GATEWAY_UNCONFIGURED }
  },
  'gateway-env': {
    persisted: { plugin: { 'pmspec.route': 'gateway' } },
    settings: { gatewayUrl: '' },
    requests: {
      'spec.list': OK_LIST,
      'gateway.status': {
        configured: true,
        tokenStored: true,
        protection: 'os-keyring' as const,
        source: 'env' as const,
        authMode: 'static' as const,
        effectiveGatewayUrl: 'https://env-gw.example.com',
        hasPluginOverride: false,
        envGatewayUrl: 'https://env-gw.example.com',
        envTokenStored: true,
        envUrlVar: 'ORCA_ARTIFACTS_API_URL',
        envTokenVar: 'ORCA_CLOUD_AUTH_TOKEN',
        hostGatewayUrl: null,
        hostConnected: false,
        hostEnvOverrideActive: false,
        hostUnreadableError: null
      }
    }
  }
})
