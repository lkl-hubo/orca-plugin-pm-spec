import { Button, Callout, Code, EmptyState, Row, Select, Spinner, Stack, Text } from 'orca'
import type { UnsupportedReason, WorkspaceInfo } from './protocol.ts'
import type { DetailTabKey } from './views/spec-detail-view.tsx'

export type HelpKind = 'none' | 'config' | 'agent' | 'secrets'
export type PanelErrorInfo = { code: string; message: string; specId: string | null }
type ErrorActionItem = { label: string; tone?: 'accent' | 'neutral'; run: () => void }

const ERROR_CODE_REGEX = /^(E_[A-Z0-9_]+)\s*[:：]\s*(.*)$/
const SPEC_ID_IN_MSG_REGEX = /(?:规格|需求)\s+([\p{L}0-9][\p{L}0-9_-]{1,63})/u

const AGENT_OPTIONS = [
  { value: 'pi', label: 'Pi（强制只读保护）' },
  { value: 'claude', label: 'Claude Code（写操作拦截）' },
  { value: 'opencode', label: 'OpenCode（仅改动检测）' },
  { value: 'codebuddy', label: 'CodeBuddy（仅改动检测）' },
  { value: 'qwen-code', label: 'Qwen Code（仅改动检测）' },
  { value: 'kimi', label: 'Kimi（仅改动检测）' },
  { value: 'mimo-code', label: 'MiMo Code（仅改动检测）' }
] as const

const DEFAULT_ERROR_MESSAGES: Record<string, string> = {
  E_NO_WORKSPACE: '请先在左侧选择一个工作区',
  E_REMOTE_HOST: '需求中心 v1 仅支持本机工作区',
  E_PMSPEC_INVALID: 'pmspec.json 配置校验失败',
  E_SPEC_ID_INVALID: '需求 ID 需为 2～64 位中文、字母、数字、- 或 _（不能以 - 或 _ 开头）',
  E_SPEC_EXISTS: '该规格已存在',
  E_LINT_ERRORS: '当前规格存在校验错误，修复后才能继续',
  E_SENSITIVE_DATA: '发布阶段命中敏感信息，请脱敏后再发布',
  E_REVIEW_BUSY: '该规格已有进行中的预检',
  E_REVIEW_LIMIT: '已达到同时运行的 AI 预检并发上限',
  E_AGENT_UNAVAILABLE: '智能体无法启动',
  E_NO_FINDINGS: '智能体未产出结果文件',
  E_FINDINGS_SCHEMA: '结果文件格式错误',
  E_FINDINGS_MISMATCH: '结果文件不属于本次预检',
  E_SNAPSHOT_VERSION_EXISTS: '当前版本已有不同内容的快照',
  E_GATEWAY_NOT_CONFIGURED: '请先配置分享网关',
  E_GATEWAY_AUTH: '网关令牌无效或无权限',
  E_GATEWAY_UNREACHABLE: '无法连接分享网关',
  E_GATEWAY_CONFLICT: '该版本已发布过评审',
  E_SECRETS_UNAVAILABLE: '本机没有可用的系统密钥库，无法安全保存令牌',
  E_RATE_LIMITED: '请求过于频繁，请稍候片刻再试',
  E_TIMEOUT: '请求超时，请检查分享网关或网络状态后重试',
  E_UNAVAILABLE: '后台服务暂不可用，请稍后重试',
  E_CAPABILITY_DENIED: '缺少所需宿主权限，请在插件设置中确认授权',
  E_CONSENT_REQUIRED: '需要用户授权确认后才能继续',
  E_NOT_PERMITTED: '当前页面无权执行该操作',
  E_UNKNOWN_METHOD: '后台尚未注册该操作接口，请尝试重载插件',
  E_INVALID_PARAMS: '请求参数格式无效',
  E_INVALID_REQUEST: '请求格式无效',
  E_TOO_LARGE: '请求或返回内容超出传输限制',
  E_CONFLICT: '数据发生冲突，请刷新后重试',
  E_CANCELLED: '操作已取消',
  E_ACTION_FAILED: '操作执行失败'
}

const HOST_ERROR_CODE_MAP: Record<string, string> = {
  rate_limited: 'E_RATE_LIMITED',
  timeout: 'E_TIMEOUT',
  unavailable: 'E_UNAVAILABLE',
  capability_denied: 'E_CAPABILITY_DENIED',
  consent_required: 'E_CONSENT_REQUIRED',
  not_permitted: 'E_NOT_PERMITTED',
  unknown_method: 'E_UNKNOWN_METHOD',
  invalid_params: 'E_INVALID_PARAMS',
  invalid_request: 'E_INVALID_REQUEST',
  too_large: 'E_TOO_LARGE',
  conflict: 'E_CONFLICT',
  cancelled: 'E_CANCELLED',
  action_failed: 'E_ACTION_FAILED'
}

const GENERIC_HOST_MESSAGES = new Set([
  'host call failed',
  'too many panel requests',
  'too many calls in flight',
  'timeout',
  'rate_limited',
  'unavailable',
  'action_failed'
])

function extractRawErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  return String(error)
}

const NAV_ACTIONS: Record<string, [string, DetailTabKey?]> = {
  E_SPEC_EXISTS: ['打开该规格'],
  E_LINT_ERRORS: ['查看校验结果', 'lint'],
  E_REVIEW_BUSY: ['查看进度', 'precheck'],
  E_NO_FINDINGS: ['查看终端', 'precheck'],
  E_FINDINGS_SCHEMA: ['查看原始文件', 'precheck'],
  E_GATEWAY_CONFLICT: ['打开已有评审', 'review']
}
const RETRY_PRECHECK_CODES = new Set(['E_NO_FINDINGS', 'E_FINDINGS_SCHEMA', 'E_FINDINGS_MISMATCH'])
const BUMP_VERSION_CODES: Record<string, string> = {
  E_SNAPSHOT_VERSION_EXISTS: '可重新保存快照',
  E_GATEWAY_CONFLICT: '请保存快照后发布'
}
const GATEWAY_NAV_CODES: Record<string, string> = {
  E_GATEWAY_NOT_CONFIGURED: '打开网关设置',
  E_GATEWAY_AUTH: '重新填写令牌'
}
const HELP_CODES: Record<string, [string, Exclude<HelpKind, 'none'>]> = {
  E_PMSPEC_INVALID: ['打开 pmspec.json', 'config'],
  E_AGENT_UNAVAILABLE: ['打开设置', 'agent'],
  E_SECRETS_UNAVAILABLE: ['查看帮助', 'secrets']
}

export function parseErrorInfo(error: unknown, fallbackSpecId: string | null): PanelErrorInfo {
  const rawMessage = extractRawErrorMessage(error).trim()
  const rawCode =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : ''
  const matched = ERROR_CODE_REGEX.exec(rawMessage)
  const mappedHostCode = rawCode ? HOST_ERROR_CODE_MAP[rawCode] : undefined
  const code =
    matched?.[1] ?? (rawCode.startsWith('E_') ? rawCode : (mappedHostCode ?? 'E_UNKNOWN'))
  const detailFromPrefix = matched?.[2]?.trim()
  const detail =
    detailFromPrefix ||
    (mappedHostCode &&
    (!rawMessage || GENERIC_HOST_MESSAGES.has(rawMessage.toLowerCase()))
      ? ''
      : rawMessage)
  const specId = SPEC_ID_IN_MSG_REGEX.exec(detail)?.[1] ?? fallbackSpecId
  return { code, message: detail || DEFAULT_ERROR_MESSAGES[code] || '操作失败', specId }
}

export type GlobalFeedbackProps = {
  workspacePath: string | null
  selectedSpecId: string | null
  errorInfo: PanelErrorInfo | null
  notice: string | null
  helpKind: HelpKind
  pendingAction: boolean
  reviewAgent: string
  onClearFeedback: () => void
  onDismissNotice: () => void
  onToggleHelp: (kind: Exclude<HelpKind, 'none'>) => void
  onNavigateDetail: (specId: string, tab?: DetailTabKey) => void
  onNavigateGateway: () => void
  onOpenSpecFile: (specId: string) => void
  onRetryPrecheck: (specId: string) => void
  onBumpVersion: (specId: string, tip: string) => void
  onRefreshList: () => void
  onTestGateway: () => void
  onSwitchAgent: (agent: string) => void
}

function buildErrorActions(p: GlobalFeedbackProps, info: PanelErrorInfo): ErrorActionItem[] {
  const specId = info.specId ?? p.selectedSpecId
  const actions: ErrorActionItem[] = []
  const nav = NAV_ACTIONS[info.code]
  if (nav && specId) {
    actions.push({ label: nav[0], run: () => p.onNavigateDetail(specId, nav[1]) })
  }
  if (info.code === 'E_SENSITIVE_DATA' && specId) {
    actions.push({ label: '打开规格', run: () => p.onOpenSpecFile(specId) })
  }
  if (RETRY_PRECHECK_CODES.has(info.code) && specId) {
    actions.push({ label: '重试', tone: 'accent', run: () => p.onRetryPrecheck(specId) })
  }
  const bumpTip = BUMP_VERSION_CODES[info.code]
  if (bumpTip && specId) {
    actions.push({ label: '版本号 +1', run: () => p.onBumpVersion(specId, bumpTip) })
  }
  const gwLabel = GATEWAY_NAV_CODES[info.code]
  if (gwLabel) {
    actions.push({ label: gwLabel, run: p.onNavigateGateway })
  }
  if (info.code === 'E_GATEWAY_UNREACHABLE') {
    actions.push({ label: '测试连接', run: p.onTestGateway })
  }
  const help = HELP_CODES[info.code]
  if (help) {
    actions.push({ label: help[0], run: () => p.onToggleHelp(help[1]) })
  }
  if (info.code === 'E_PMSPEC_INVALID') {
    actions.push({ label: '重新检查', run: p.onRefreshList })
  }
  return actions
}

export function GlobalFeedback(props: GlobalFeedbackProps) {
  const actions = props.errorInfo ? buildErrorActions(props, props.errorInfo) : []
  return (
    <Stack gap="sm">
      {props.notice ? (
        <Callout tone="success" title="操作提示" icon="check">
          <Row justify="between" align="center" gap="xs">
            <Text size="sm">{props.notice}</Text>
            <Button size="xs" variant="ghost" onPress={props.onDismissNotice}>
              关闭
            </Button>
          </Row>
        </Callout>
      ) : null}

      {props.errorInfo ? (
        <Callout tone="danger" title={`操作失败 (${props.errorInfo.code})`} icon="error">
          <Stack gap="xs">
            <Text size="sm">{props.errorInfo.message}</Text>
            <Row justify="between" align="center" wrap gap="xs">
              <Row gap="xs" wrap>
                {actions.map((item) => (
                  <Button
                    key={item.label}
                    size="xs"
                    variant={item.tone === 'accent' ? 'solid' : 'outline'}
                    tone={item.tone ?? 'neutral'}
                    disabled={props.pendingAction}
                    onPress={item.run}
                  >
                    {item.label}
                  </Button>
                ))}
              </Row>
              <Button size="xs" variant="ghost" onPress={props.onClearFeedback}>
                收起
              </Button>
            </Row>
            {props.pendingAction ? <Spinner label="正在执行恢复操作" /> : null}
          </Stack>
        </Callout>
      ) : null}

      {props.helpKind === 'config' ? (
        <Callout tone="accent" title="如何修复 pmspec.json" icon="file-text">
          <Stack gap="xs">
            <Text size="sm">请在左侧文件树打开工作区配置文件并修正错误字段：</Text>
            <Code block>
              {props.workspacePath ? `${props.workspacePath}/pmspec.json` : 'pmspec.json'}
            </Code>
          </Stack>
        </Callout>
      ) : null}

      {props.helpKind === 'agent' ? (
        <Callout tone="accent" title="切换 AI 预检智能体" icon="settings">
          <Stack gap="xs">
            <Text size="sm">请确认智能体已在左下角「设置 → 智能体」启用并登录，或在此切换：</Text>
            <Select
              label="预检智能体"
              value={props.reviewAgent}
              options={AGENT_OPTIONS}
              onChange={props.onSwitchAgent}
            />
          </Stack>
        </Callout>
      ) : null}

      {props.helpKind === 'secrets' ? (
        <Callout tone="warning" title="系统密钥库帮助" icon="info">
          <Text size="sm">
            仅允许写入系统安全密钥库（macOS 钥匙串、Windows DPAPI、Linux Secret Service）。若 Linux
            处于 basic_text 后端，请安装并解锁 gnome-keyring 后重启客户端。
          </Text>
        </Callout>
      ) : null}
    </Stack>
  )
}

export function UnsupportedWorkspaceView(props: {
  workspace: WorkspaceInfo | null
  unsupportedReason: UnsupportedReason | null
  configErrors: string[]
  pendingInit: boolean
  onInitWorkspace: () => void
  onOpenGateway: () => void
  onOpenConfigHelp: () => void
  onRefreshList: () => void
}) {
  if (!props.unsupportedReason || props.unsupportedReason === 'no-workspace' || !props.workspace) {
    return (
      <EmptyState
        icon="folder"
        title="未选择工作区"
        description="请先在左侧选择一个工作区（支持本机文件夹或 Git 仓库）。"
      />
    )
  }
  if (props.unsupportedReason === 'remote-host') {
    return (
      <Callout tone="warning" title="暂不支持远程主机工作区" icon="warning">
        <Text size="sm">
          需求中心 v1 仅支持本机工作区（当前工作区「{props.workspace.name}」位于{' '}
          {props.workspace.hostId ?? 'remote'}）。请在左侧切换到本机工作区后使用。
        </Text>
      </Callout>
    )
  }
  if (props.unsupportedReason === 'no-pmspec') {
    return (
      <Stack gap="sm">
        <EmptyState
          icon="layers"
          title="尚未初始化规格工作区"
          description={`工作区「${props.workspace.name}」缺少 pmspec.json。初始化后将生成配置模板并更新 .gitignore。`}
        >
          <Row gap="xs" align="center" wrap>
            <Button
              size="sm"
              variant="solid"
              tone="accent"
              icon="add"
              disabled={props.pendingInit}
              onPress={props.onInitWorkspace}
            >
              {props.pendingInit ? '初始化中…' : '初始化规格工作区'}
            </Button>
            <Button size="sm" variant="outline" icon="settings" onPress={props.onOpenGateway}>
              网关设置
            </Button>
          </Row>
        </EmptyState>
        {props.pendingInit ? (
          <Row gap="xs" align="center">
            <Spinner label="正在初始化规格工作区" />
            <Text muted size="sm">
              正在写入 pmspec.json 与 .gitignore…
            </Text>
          </Row>
        ) : null}
      </Stack>
    )
  }
  return (
    <Callout tone="danger" title="pmspec.json 配置无效" icon="error">
      <Stack gap="xs">
        <Text size="sm">请修正工作区根目录下的 pmspec.json 后重新检查：</Text>
        {props.configErrors.map((errText) => (
          <Text key={`cfg-err-${errText}`} size="xs">
            • {errText}
          </Text>
        ))}
        <Row gap="xs" wrap>
          <Button size="xs" variant="outline" onPress={props.onOpenConfigHelp}>
            打开 pmspec.json
          </Button>
          <Button size="xs" variant="outline" icon="refresh" onPress={props.onRefreshList}>
            重新检查
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}
