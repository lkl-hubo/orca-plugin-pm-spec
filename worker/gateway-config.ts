export const GATEWAY_TOKEN_SECRET_KEY = 'gateway:token'
export const HOST_SHARE_GATEWAY_SECRET_KEY = '__pmstudio_host__:share-gateway-auth'

export type GatewayAuthMode = 'static' | 'none'
export type GatewayConfigSource = 'host' | 'plugin' | 'none'

export type GatewayCreateReviewResponse = {
  version: number
  slug: string
  status: 'open' | 'closed'
  specId: string
  specVersion: number
  reviewUrl: string
  reviewerKey: string
  editToken: string
  createdAt: string
  expiresAt: string
}

export type GatewayReviewDetailResponse = {
  slug: string
  specId: string
  title: string
  specVersion: number
  snapshotSha256: string
  status: 'open' | 'closed'
  expired: boolean
  requiredSignoffRoles: string[]
  signoffs: {
    id: string
    reviewerName: string
    role: string
    decision: 'approve' | 'request_changes'
    note: string
    createdAt: string
  }[]
  createdAt: string
  updatedAt: string
  expiresAt: string
  closedAt: string | null
}

export type GatewayCommentDto = {
  id: string
  anchor: string
  authorName: string
  authorRole: string
  kind: 'issue' | 'suggestion' | 'question'
  body: string
  status: 'open' | 'resolved' | 'wont_fix'
  resolutionNote: string | null
  createdAt: string
  updatedAt: string
}

export function parseRetryAfterMs(headerVal: string | null): number {
  if (!headerVal) {
    return 1000
  }
  const sec = Number.parseInt(headerVal.trim(), 10)
  if (Number.isFinite(sec) && sec > 0) {
    return Math.min(sec, 60) * 1000
  }
  const targetMs = Date.parse(headerVal)
  return Number.isFinite(targetMs)
    ? Math.min(Math.max(Math.ceil((targetMs - Date.now()) / 1000), 1), 60) * 1000
    : 1000
}

export type HostShareGatewaySnapshot = {
  gatewayUrl: string | null
  authMode: GatewayAuthMode
  token: string | null
  connected: boolean
  envOverrideActive: boolean
  unreadableError: string | null
}

export type EffectiveGatewayConfig = {
  gatewayUrl: string
  token: string | null
  authMode: GatewayAuthMode
  source: GatewayConfigSource
  configured: boolean
  tokenStored: boolean
  hasPluginOverride: boolean
  pluginGatewayUrl: string
  pluginTokenStored: boolean
  hostGatewayUrl: string | null
  hostAuthMode: GatewayAuthMode | null
  hostConnected: boolean
  hostEnvOverrideActive: boolean
  hostUnreadableError: string | null
}

export function normalizeGatewayUrl(raw: unknown): string {
  if (typeof raw !== 'string') {
    return ''
  }
  const trimmed = raw.trim().replace(/\/+$/, '')
  try {
    const u = trimmed ? new URL(trimmed) : null
    return u && (u.protocol === 'http:' || u.protocol === 'https:') ? trimmed : ''
  } catch {
    return ''
  }
}

export function parseHostShareGatewaySnapshot(
  raw: string | null | undefined
): HostShareGatewaySnapshot | null {
  if (typeof raw !== 'string' || !raw.trim()) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null
    }
    const obj = Object.fromEntries(Object.entries(parsed))
    const gatewayUrl = normalizeGatewayUrl(obj.gatewayUrl) || null
    const authMode: GatewayAuthMode = obj.authMode === 'none' ? 'none' : 'static'
    const token = typeof obj.token === 'string' && obj.token.trim() ? obj.token.trim() : null
    const unreadableError =
      typeof obj.unreadableError === 'string' && obj.unreadableError.trim()
        ? obj.unreadableError.trim()
        : null
    return {
      gatewayUrl,
      authMode,
      token,
      connected: obj.connected === true,
      envOverrideActive: obj.envOverrideActive === true,
      unreadableError
    }
  } catch {
    return null
  }
}

export function resolveEffectiveGatewayConfig(input: {
  pluginGatewayUrl: unknown
  pluginToken: string | null | undefined
  hostSnapshotRaw: string | null | undefined
}): EffectiveGatewayConfig {
  const pluginGatewayUrl = normalizeGatewayUrl(input.pluginGatewayUrl)
  const pluginToken = input.pluginToken?.trim() || null
  const host = parseHostShareGatewaySnapshot(input.hostSnapshotRaw)
  const hostGatewayUrl = host?.gatewayUrl ?? null
  const hasPluginOverride = Boolean(pluginGatewayUrl || pluginToken)

  let gatewayUrl = ''
  let token: string | null = null
  let authMode: GatewayAuthMode = 'static'
  let source: GatewayConfigSource = 'none'

  if (pluginGatewayUrl) {
    gatewayUrl = pluginGatewayUrl
    if (pluginToken) {
      token = pluginToken
      source = 'plugin'
    } else if (host && hostGatewayUrl === pluginGatewayUrl) {
      token = host.token
      authMode = host.authMode
      source = 'host'
    } else {
      token = null
      source = 'plugin'
    }
  } else if (host && hostGatewayUrl) {
    gatewayUrl = hostGatewayUrl
    if (pluginToken) {
      token = pluginToken
      source = 'plugin'
    } else {
      token = host.token
      authMode = host.authMode
      source = 'host'
    }
  } else {
    token = pluginToken
  }

  const tokenStored = Boolean(token)
  const configured = Boolean(gatewayUrl && (authMode === 'none' || tokenStored))

  return {
    gatewayUrl,
    token,
    authMode,
    source,
    configured,
    tokenStored,
    hasPluginOverride,
    pluginGatewayUrl,
    pluginTokenStored: Boolean(pluginToken),
    hostGatewayUrl,
    hostAuthMode: host ? host.authMode : null,
    hostConnected: host?.connected ?? false,
    hostEnvOverrideActive: host?.envOverrideActive ?? false,
    hostUnreadableError: host?.unreadableError ?? null
  }
}
