import type { OrcaWorkerApi } from 'orca/worker'
import type { GatewayReviewPayload } from '../core/review-payload.ts'
import {
  GATEWAY_TOKEN_SECRET_KEY,
  HOST_SHARE_GATEWAY_SECRET_KEY,
  normalizeGatewayUrl,
  parseRetryAfterMs,
  resolveEffectiveGatewayConfig,
  type EffectiveGatewayConfig,
  type GatewayCommentDto,
  type GatewayCreateReviewResponse,
  type GatewayReviewDetailResponse
} from './gateway-config.ts'

export {
  GATEWAY_TOKEN_SECRET_KEY,
  HOST_SHARE_GATEWAY_SECRET_KEY,
  normalizeGatewayUrl,
  resolveEffectiveGatewayConfig,
  type EffectiveGatewayConfig,
  type GatewayCommentDto,
  type GatewayCreateReviewResponse,
  type GatewayReviewDetailResponse
}
const GET_DELAYS = [1000, 2000, 4000]
const WRITE_DELAYS = [1000, 2000]
const RETRYABLE_HTTP = new Set([502, 503, 504])

class GatewayRequestError extends Error {
  readonly retryable: boolean
  constructor(message: string, retryable: boolean) {
    super(message)
    this.retryable = retryable
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class GatewayClient {
  private readonly orca: OrcaWorkerApi
  private readonly env?: Record<string, string | undefined>

  constructor(orca: OrcaWorkerApi, env?: Record<string, string | undefined>) {
    this.orca = orca
    this.env = env
  }

  async readConfig(): Promise<EffectiveGatewayConfig> {
    const [rawUrl, pluginToken, hostSnapshotRaw] = await Promise.all([
      this.orca.settings.get('gatewayUrl'),
      this.orca.secrets.get(GATEWAY_TOKEN_SECRET_KEY),
      this.orca.secrets.get(HOST_SHARE_GATEWAY_SECRET_KEY).catch(() => null)
    ])
    return resolveEffectiveGatewayConfig({
      pluginGatewayUrl: rawUrl,
      pluginToken,
      hostSnapshotRaw,
      env: this.env
    })
  }

  async getStatus() {
    const [cfg, protectionRes] = await Promise.all([
      this.readConfig(),
      this.orca.host.call('secrets.protection')
    ])
    return {
      configured: cfg.configured,
      tokenStored: cfg.tokenStored,
      protection: protectionRes.status,
      source: cfg.source,
      authMode: cfg.authMode,
      effectiveGatewayUrl: cfg.gatewayUrl,
      hasPluginOverride: cfg.hasPluginOverride,
      envGatewayUrl: cfg.envGatewayUrl,
      envTokenStored: cfg.envTokenStored,
      envUrlVar: cfg.envUrlVar,
      envTokenVar: cfg.envTokenVar,
      hostGatewayUrl: cfg.hostGatewayUrl,
      hostConnected: cfg.hostConnected,
      hostEnvOverrideActive: cfg.hostEnvOverrideActive,
      hostUnreadableError: cfg.hostUnreadableError
    }
  }

  async saveToken(token: string): Promise<{ stored: true }> {
    const { status } = await this.orca.host.call('secrets.protection')
    if (status === 'unavailable') {
      throw new Error('E_SECRETS_UNAVAILABLE: 本机没有可用的系统密钥库，无法安全保存令牌')
    }
    await this.orca.secrets.set(GATEWAY_TOKEN_SECRET_KEY, token.trim())
    return { stored: true }
  }

  async clearOverride(): Promise<{ cleared: true }> {
    await Promise.all([
      this.orca.settings.set('gatewayUrl', ''),
      this.orca.secrets.delete(GATEWAY_TOKEN_SECRET_KEY)
    ])
    return { cleared: true }
  }

  async testConnection() {
    const { gatewayUrl, token, authMode } = await this.readConfig()
    if (!gatewayUrl) {
      return { ok: false, backend: null, latencyMs: 0, errorCode: 'E_GATEWAY_NOT_CONFIGURED' }
    }
    const start = Date.now()
    const fail = (errorCode: string, backend: string | null = null) => ({
      ok: false,
      backend,
      latencyMs: Date.now() - start,
      errorCode
    })
    try {
      const hRes = await this.fetchWithTimeout(`${gatewayUrl}/healthz`, { method: 'GET' }, 5000)
      if (!hRes.ok) {
        return fail('E_GATEWAY_UNREACHABLE')
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: /healthz returns a JSON object with optional backend and authMode fields.
      const hJson = (await hRes.json()) as { backend?: string; authMode?: string }
      const backend = typeof hJson.backend === 'string' ? hJson.backend : null
      const requiresAuth =
        hJson.authMode === 'static' || (hJson.authMode !== 'none' && authMode !== 'none')
      if (requiresAuth) {
        if (!token) {
          return fail('E_GATEWAY_NOT_CONFIGURED', backend)
        }
        const aRes = await this.fetchWithTimeout(
          `${gatewayUrl}/v1/spec-reviews?limit=1`,
          { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
          5000
        )
        if (aRes.status === 401 || aRes.status === 403) {
          return fail('E_GATEWAY_AUTH', backend)
        }
        if (!aRes.ok) {
          return fail('E_GATEWAY_UNREACHABLE', backend)
        }
      }
      return { ok: true, backend, latencyMs: Date.now() - start, errorCode: null }
    } catch {
      return fail('E_GATEWAY_UNREACHABLE')
    }
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = 15_000
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  private async requestJson<T>(options: {
    method: 'GET' | 'POST' | 'PATCH'
    path: string
    body?: unknown
    headers?: Record<string, string>
    editToken?: string | null
  }): Promise<T> {
    const cfg = await this.readConfig()
    if (!cfg.configured) {
      throw new Error('E_GATEWAY_NOT_CONFIGURED: 请先配置分享网关')
    }
    const delays = options.method === 'GET' ? GET_DELAYS : WRITE_DELAYS
    let rateLimitRetried = false
    const init: RequestInit = {
      method: options.method,
      headers: {
        ...(cfg.authMode !== 'none' && cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
        ...(options.editToken ? { 'X-PMS-Edit-Token': options.editToken } : {}),
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    }
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        const res = await this.fetchWithTimeout(`${cfg.gatewayUrl}${options.path}`, init)
        if (res.status === 401 || res.status === 403) {
          throw new GatewayRequestError('E_GATEWAY_AUTH: 网关令牌无效或无权限', false)
        }
        if (res.status === 429 && !rateLimitRetried) {
          rateLimitRetried = true
          const waitMs = parseRetryAfterMs(res.headers.get('retry-after'))
          this.orca.log(`[pmspec] gateway 429 path=${options.path} retryAfterMs=${waitMs}`)
          await sleep(waitMs)
          attempt -= 1
          continue
        }
        if (RETRYABLE_HTTP.has(res.status)) {
          throw new GatewayRequestError(`HTTP ${res.status}`, true)
        }
        const text = await res.text()
        const rawParsed: unknown = text ? JSON.parse(text) : {}
        const jsonObj =
          typeof rawParsed === 'object' && rawParsed !== null && !Array.isArray(rawParsed)
            ? Object.fromEntries(Object.entries(rawParsed))
            : {}
        if (!res.ok) {
          if (res.status === 409 && jsonObj.code === 'spec_review_version_exists') {
            throw new GatewayRequestError('E_GATEWAY_CONFLICT: 该版本已发布过评审', false)
          }
          const msg =
            res.status >= 500
              ? '网关服务异常'
              : typeof jsonObj.message === 'string'
                ? jsonObj.message
                : `HTTP ${res.status}`
          throw new GatewayRequestError(`E_GATEWAY_UNREACHABLE: ${msg}`, false)
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: requestJson callers define exact gateway response contract T for 2xx JSON responses.
        return jsonObj as T
      } catch (error) {
        if (error instanceof GatewayRequestError && !error.retryable) {
          throw error
        }
        if (attempt < delays.length) {
          const waitMs = delays[attempt]!
          this.orca.log(
            `[pmspec] gateway retry=${attempt + 1} method=${options.method} path=${options.path} waitMs=${waitMs}`
          )
          await sleep(waitMs)
          continue
        }
        throw new Error('E_GATEWAY_UNREACHABLE: 无法连接分享网关')
      }
    }
    throw new Error('E_GATEWAY_UNREACHABLE: 无法连接分享网关')
  }

  createSpecReview(payload: GatewayReviewPayload, idempotencyKey: string) {
    return this.requestJson<GatewayCreateReviewResponse>({
      method: 'POST',
      path: '/v1/spec-reviews',
      body: payload,
      headers: { 'Idempotency-Key': idempotencyKey }
    })
  }

  getSpecReview(slug: string, editToken: string | null) {
    return this.requestJson<GatewayReviewDetailResponse>({
      method: 'GET',
      path: `/v1/spec-reviews/${encodeURIComponent(slug)}`,
      editToken
    })
  }

  listComments(slug: string, since: string | null, editToken: string | null) {
    const query = since ? `?limit=500&since=${encodeURIComponent(since)}` : '?limit=500'
    return this.requestJson<{ comments: GatewayCommentDto[]; nextCursor: string | null }>({
      method: 'GET',
      path: `/v1/spec-reviews/${encodeURIComponent(slug)}/comments${query}`,
      editToken
    })
  }

  patchComment(
    slug: string,
    commentId: string,
    status: 'open' | 'resolved' | 'wont_fix',
    resolutionNote: string,
    editToken: string | null
  ) {
    return this.requestJson<GatewayCommentDto>({
      method: 'PATCH',
      path: `/v1/spec-reviews/${encodeURIComponent(slug)}/comments/${encodeURIComponent(commentId)}`,
      body: { status, resolutionNote },
      editToken
    })
  }

  closeReview(slug: string, editToken: string | null) {
    return this.requestJson<GatewayReviewDetailResponse>({
      method: 'POST',
      path: `/v1/spec-reviews/${encodeURIComponent(slug)}/close`,
      body: {},
      editToken
    })
  }

  rotateKey(slug: string, editToken: string | null) {
    return this.requestJson<{ slug: string; reviewUrl: string; reviewerKey: string }>({
      method: 'POST',
      path: `/v1/spec-reviews/${encodeURIComponent(slug)}/rotate-key`,
      body: {},
      editToken
    })
  }
}
