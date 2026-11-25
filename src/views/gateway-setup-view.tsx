import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Field,
  Heading,
  Input,
  KeyValue,
  plugin,
  read,
  Row,
  set,
  settings,
  Spinner,
  Stack,
  Text
} from 'orca'

export type GatewayStatusInfo = {
  configured: boolean
  tokenStored: boolean
  protection: 'os-keyring' | 'unavailable'
  source: 'host' | 'plugin' | 'none'
  authMode: 'static' | 'none'
  effectiveGatewayUrl: string
  hasPluginOverride: boolean
  hostGatewayUrl: string | null
  hostConnected: boolean
  hostEnvOverrideActive: boolean
  hostUnreadableError: string | null
}

export type GatewaySetupViewProps = {
  gatewayUrl: string
  gatewayStatus: GatewayStatusInfo | null
  onBack: () => void
  onGatewayChanged: () => Promise<void>
  onError: (error: unknown) => void
  onNotify: (message: string) => void
  onClearFeedback: () => void
}

type GatewayTestResult = {
  ok: boolean
  backend: string | null
  latencyMs: number
  errorCode: string | null
}

const urlDraftAtom = atom<string | null>(null)
const tokenDraftAtom = atom('')
const savingUrlAtom = atom(false)
const savingTokenAtom = atom(false)
const clearingOverrideAtom = atom(false)
const testingAtom = atom(false)
const testResultAtom = atom<GatewayTestResult | null>(null)

function sourceLabel(status: GatewayStatusInfo | null): string {
  if (!status) {
    return '检测中…'
  }
  if (status.source === 'host') {
    return status.hostEnvOverrideActive ? '共享宿主网关（环境变量）' : '共享宿主分享网关'
  }
  return status.source === 'plugin' ? '需求中心独立覆盖' : '未配置'
}

function tokenLabel(status: GatewayStatusInfo | null): string {
  if (!status) {
    return '检测中…'
  }
  if (status.authMode === 'none') {
    return '无需令牌（内网无鉴权模式）'
  }
  if (!status.tokenStored) {
    return '未保存'
  }
  return status.source === 'host' ? '已复用宿主令牌' : '已保存（独立覆盖）'
}

async function clearOverride(props: GatewaySetupViewProps): Promise<void> {
  if (read(clearingOverrideAtom)) {
    return
  }
  props.onClearFeedback()
  set(clearingOverrideAtom, true)
  try {
    await plugin.request('gateway.clearOverride', {})
    set(urlDraftAtom, null)
    set(tokenDraftAtom, '')
    await props.onGatewayChanged()
    props.onNotify('已清除插件独立覆盖，恢复共享宿主分享网关配置')
  } catch (error) {
    props.onError(error)
  } finally {
    set(clearingOverrideAtom, false)
  }
}

async function saveGatewayUrl(props: GatewaySetupViewProps, value: string): Promise<void> {
  if (read(savingUrlAtom)) {
    return
  }
  props.onClearFeedback()
  set(savingUrlAtom, true)
  try {
    await settings.set('gatewayUrl', value.trim())
    set(urlDraftAtom, null)
    await props.onGatewayChanged()
    props.onNotify('已保存分享网关地址')
  } catch (error) {
    props.onError(error)
  } finally {
    set(savingUrlAtom, false)
  }
}

async function saveToken(props: GatewaySetupViewProps): Promise<void> {
  if (read(savingTokenAtom)) {
    return
  }
  const token = read(tokenDraftAtom).trim()
  if (!token) {
    return
  }
  props.onClearFeedback()
  set(savingTokenAtom, true)
  try {
    await plugin.request('gateway.saveToken', { token })
    set(tokenDraftAtom, '')
    await props.onGatewayChanged()
    props.onNotify('访问令牌已加密保存至系统密钥库')
  } catch (error) {
    props.onError(error)
  } finally {
    set(savingTokenAtom, false)
  }
}

async function testConnection(props: GatewaySetupViewProps): Promise<void> {
  if (read(testingAtom)) {
    return
  }
  props.onClearFeedback()
  set(testingAtom, true)
  set(testResultAtom, null)
  try {
    const result = await plugin.request('gateway.test', {})
    set(testResultAtom, result)
  } catch (error) {
    props.onError(error)
  } finally {
    set(testingAtom, false)
  }
}

export function GatewaySetupView(props: GatewaySetupViewProps) {
  const urlDraft = read(urlDraftAtom) ?? props.gatewayUrl
  const tokenDraft = read(tokenDraftAtom)
  const savingUrl = read(savingUrlAtom)
  const savingToken = read(savingTokenAtom)
  const clearingOverride = read(clearingOverrideAtom)
  const testing = read(testingAtom)
  const testResult = read(testResultAtom)

  const status = props.gatewayStatus
  const protectionUnavailable = status?.protection === 'unavailable'
  const effectiveUrl = status?.effectiveGatewayUrl || props.gatewayUrl.trim()

  return (
    <Stack gap="md">
      <Row justify="between" align="center" gap="xs">
        <Button size="sm" variant="ghost" onPress={props.onBack}>
          ← 返回
        </Button>
        <Badge tone={status?.configured ? 'success' : 'warning'}>
          {status?.configured ? '已配置' : '未完成配置'}
        </Badge>
      </Row>

      <Heading level={2}>分享网关配置</Heading>

      {protectionUnavailable ? (
        <Callout tone="danger" title="系统密钥库不可用" icon="warning">
          <Text size="sm">
            当前环境缺少可用的系统密钥库（例如 Linux 处于 basic_text
            后端），无法安全保存网关访问令牌。请安装或解锁系统 Secret Service / 钥匙串后重启
            LKL-PMStudio。
          </Text>
        </Callout>
      ) : null}

      {status?.hostUnreadableError ? (
        <Callout tone="warning" title="宿主分享网关令牌读取失败" icon="warning">
          <Text size="sm">
            {status.hostUnreadableError}。请前往「设置 → 成果物 / 技能共享 →
            自托管分享网关」重新连接，或在下方填写需求中心独立网关与令牌。
          </Text>
        </Callout>
      ) : null}

      {status?.source === 'host' && status.configured ? (
        <Callout tone="accent" title="已自动共享宿主分享网关配置" icon="info">
          <Text size="sm">
            当前直接复用 LKL-PMStudio 的自托管分享网关，无需重复填写；如需全局修改，请前往「设置 →
            成果物 / 技能共享 →
            自托管分享网关」。仅当需求中心需要使用独立网关或令牌时再填写下方表单。
          </Text>
        </Callout>
      ) : null}

      <Card title="当前状态" description="优先读取需求中心独立配置，未填写时自动继承宿主分享网关">
        <KeyValue
          label="网关配置摘要"
          items={[
            {
              label: '配置来源',
              value: sourceLabel(status),
              tone:
                status?.source === 'host'
                  ? 'success'
                  : status?.source === 'plugin'
                    ? 'neutral'
                    : 'warning'
            },
            {
              label: '当前生效地址',
              value: effectiveUrl || '未填写',
              tone: effectiveUrl ? 'neutral' : 'warning',
              code: Boolean(effectiveUrl)
            },
            {
              label: '访问令牌',
              value: tokenLabel(status),
              tone: status?.authMode === 'none' || status?.tokenStored ? 'success' : 'warning'
            },
            {
              label: '密钥保护机制',
              value: status
                ? status.protection === 'os-keyring'
                  ? '系统密钥库 (os-keyring)'
                  : '不可用 (unavailable)'
                : '检测中…',
              tone: protectionUnavailable ? 'danger' : 'success'
            }
          ]}
        />
      </Card>

      <Card
        title="独立覆盖配置（可选）"
        description="留空即自动继承宿主「自托管分享网关」；填写则仅覆盖需求中心"
      >
        <Stack gap="sm">
          <Field
            label="分享网关地址"
            description="留空即共享宿主分享网关；也可在「设置 → 插件 → 需求中心 → 分享网关地址」中覆盖"
          >
            <Input
              label="分享网关地址"
              labelHidden
              placeholder={status?.hostGatewayUrl || 'https://share.example.com'}
              value={urlDraft}
              disabled={savingUrl || clearingOverride}
              onChange={(value) => set(urlDraftAtom, value)}
              onSubmit={(value) => void saveGatewayUrl(props, value)}
            />
          </Field>
          <Row justify="end" gap="xs" align="center" wrap>
            {clearingOverride ? <Spinner label="正在恢复宿主配置" /> : null}
            {status?.hasPluginOverride ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={clearingOverride || savingUrl || savingToken}
                onPress={() => void clearOverride(props)}
              >
                {clearingOverride ? '恢复中…' : '恢复共享宿主配置'}
              </Button>
            ) : null}
            {savingUrl ? <Spinner label="正在保存网关地址" /> : null}
            <Button
              size="sm"
              variant="outline"
              disabled={savingUrl || clearingOverride}
              onPress={() => void saveGatewayUrl(props, urlDraft)}
            >
              {savingUrl ? '保存中…' : '保存地址'}
            </Button>
          </Row>
        </Stack>
      </Card>

      <Card title="访问令牌" description="Bearer 令牌仅存储在系统密钥库中，不会写入工作区文件">
        <Stack gap="sm">
          <Field label="Bearer 访问令牌" required>
            <Input
              label="Bearer 访问令牌"
              labelHidden
              type="password"
              placeholder="输入或粘贴分享网关分配的 Bearer Token"
              value={tokenDraft}
              disabled={savingToken || protectionUnavailable}
              onChange={(value) => set(tokenDraftAtom, value)}
              onSubmit={() => void saveToken(props)}
            />
          </Field>
          <Row justify="end" gap="xs" align="center">
            {savingToken ? <Spinner label="正在保存令牌" /> : null}
            <Button
              size="sm"
              variant="solid"
              tone="accent"
              icon="check"
              disabled={savingToken || tokenDraft.trim().length === 0 || protectionUnavailable}
              onPress={() => void saveToken(props)}
            >
              {savingToken ? '保存中…' : '保存令牌'}
            </Button>
          </Row>
        </Stack>
      </Card>

      <Card title="连通性测试" description="验证分享网关健康状态、鉴权与响应延迟">
        <Stack gap="sm">
          <Row justify="between" align="center" wrap gap="sm">
            <Text muted size="xs">
              发起请求至网关健康检查及鉴权接口，确认发布前可用。
            </Text>
            <Button
              size="sm"
              variant="outline"
              icon="refresh"
              disabled={testing}
              onPress={() => void testConnection(props)}
            >
              {testing ? '测试中…' : '测试连接'}
            </Button>
          </Row>

          {testing ? (
            <Row gap="xs" align="center">
              <Spinner label="正在测试网关连接" />
              <Text muted size="sm">
                正在连接分享网关…
              </Text>
            </Row>
          ) : null}

          {testResult ? (
            testResult.ok ? (
              <Callout tone="success" title="连接测试通过" icon="check">
                <Text size="sm">
                  延迟：{testResult.latencyMs} ms · 后端：{testResult.backend ?? 'share-gateway'}
                </Text>
              </Callout>
            ) : (
              <Callout tone="danger" title="连接测试失败" icon="error">
                <Text size="sm">
                  错误码：{testResult.errorCode ?? '未知错误'} · 耗时：{testResult.latencyMs} ms
                </Text>
              </Callout>
            )
          ) : null}
        </Stack>
      </Card>
    </Stack>
  )
}
