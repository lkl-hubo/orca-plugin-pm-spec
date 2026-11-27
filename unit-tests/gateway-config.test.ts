import { describe, expect, it } from './test-kit.ts'
import { parseCliArgs } from '../scripts/spec-review-load.mjs'
import { resolveEffectiveGatewayConfig } from '../worker/gateway-config.ts'

describe('gateway-config env precedence & isolation', () => {
  it('uses ORCA_ARTIFACTS_API_URL and ORCA_CLOUD_AUTH_TOKEN with zero plugin/host config', () => {
    const cfg = resolveEffectiveGatewayConfig({
      pluginGatewayUrl: '',
      pluginToken: null,
      hostSnapshotRaw: null,
      env: {
        ORCA_ARTIFACTS_API_URL: 'https://env-gw.example.com///',
        ORCA_CLOUD_AUTH_TOKEN: '  env-secret-tok  '
      }
    })

    expect(cfg.configured).toBe(true)
    expect(cfg.source).toBe('env')
    expect(cfg.gatewayUrl).toBe('https://env-gw.example.com')
    expect(cfg.token).toBe('env-secret-tok')
    expect(cfg.tokenStored).toBe(true)
    expect(cfg.authMode).toBe('static')
    expect(cfg.envUrlVar).toBe('ORCA_ARTIFACTS_API_URL')
    expect(cfg.envTokenVar).toBe('ORCA_CLOUD_AUTH_TOKEN')
  })

  it('prefers ORCA_* vars over PMSPEC_* fallback aliases and env over plugin/host', () => {
    const cfg = resolveEffectiveGatewayConfig({
      pluginGatewayUrl: 'https://plugin-gw.example.com',
      pluginToken: 'plugin-tok',
      hostSnapshotRaw: JSON.stringify({
        gatewayUrl: 'https://host-gw.example.com',
        authMode: 'static',
        token: 'host-tok',
        connected: true,
        envOverrideActive: false,
        unreadableError: null
      }),
      env: {
        ORCA_ARTIFACTS_API_URL: 'https://orca-env.example.com',
        PMSPEC_GATEWAY_URL: 'https://pmspec-env.example.com',
        ORCA_CLOUD_AUTH_TOKEN: 'orca-tok',
        PMSPEC_BEARER_TOKEN: 'pmspec-tok'
      }
    })

    expect(cfg.source).toBe('env')
    expect(cfg.gatewayUrl).toBe('https://orca-env.example.com')
    expect(cfg.token).toBe('orca-tok')
    expect(cfg.envUrlVar).toBe('ORCA_ARTIFACTS_API_URL')
    expect(cfg.envTokenVar).toBe('ORCA_CLOUD_AUTH_TOKEN')

    const aliasCfg = resolveEffectiveGatewayConfig({
      pluginGatewayUrl: 'https://plugin-gw.example.com',
      pluginToken: 'plugin-tok',
      hostSnapshotRaw: null,
      env: {
        PMSPEC_GATEWAY_URL: 'https://pmspec-env.example.com/',
        PMSPEC_BEARER_TOKEN: 'pmspec-tok'
      }
    })

    expect(aliasCfg.source).toBe('env')
    expect(aliasCfg.gatewayUrl).toBe('https://pmspec-env.example.com')
    expect(aliasCfg.token).toBe('pmspec-tok')
    expect(aliasCfg.envUrlVar).toBe('PMSPEC_GATEWAY_URL')
    expect(aliasCfg.envTokenVar).toBe('PMSPEC_BEARER_TOKEN')
  })

  it('isolates token when only ORCA_ARTIFACTS_API_URL is set for a different URL', () => {
    const cfg = resolveEffectiveGatewayConfig({
      pluginGatewayUrl: 'https://plugin-gw.example.com',
      pluginToken: 'plugin-tok',
      hostSnapshotRaw: JSON.stringify({
        gatewayUrl: 'https://host-gw.example.com',
        authMode: 'static',
        token: 'host-tok',
        connected: true,
        envOverrideActive: false,
        unreadableError: null
      }),
      env: {
        ORCA_ARTIFACTS_API_URL: 'https://new-env-gw.example.com'
      }
    })

    expect(cfg.source).toBe('env')
    expect(cfg.gatewayUrl).toBe('https://new-env-gw.example.com')
    expect(cfg.token).toBeNull()
    expect(cfg.tokenStored).toBe(false)
    expect(cfg.configured).toBe(false)
  })

  it('reuses same-URL plugin or host token when only ORCA_ARTIFACTS_API_URL is set', () => {
    const samePlugin = resolveEffectiveGatewayConfig({
      pluginGatewayUrl: 'https://shared-gw.example.com/',
      pluginToken: 'plugin-tok',
      hostSnapshotRaw: JSON.stringify({
        gatewayUrl: 'https://shared-gw.example.com',
        authMode: 'static',
        token: 'host-tok',
        connected: true,
        envOverrideActive: false,
        unreadableError: null
      }),
      env: { ORCA_ARTIFACTS_API_URL: 'https://shared-gw.example.com' }
    })
    expect(samePlugin.configured).toBe(true)
    expect(samePlugin.source).toBe('env')
    expect(samePlugin.token).toBe('plugin-tok')

    const sameHost = resolveEffectiveGatewayConfig({
      pluginGatewayUrl: '',
      pluginToken: null,
      hostSnapshotRaw: JSON.stringify({
        gatewayUrl: 'https://shared-gw.example.com',
        authMode: 'static',
        token: 'host-tok',
        connected: true,
        envOverrideActive: false,
        unreadableError: null
      }),
      env: { ORCA_ARTIFACTS_API_URL: 'https://shared-gw.example.com' }
    })
    expect(sameHost.configured).toBe(true)
    expect(sameHost.source).toBe('env')
    expect(sameHost.token).toBe('host-tok')
  })

  it('supports ORCA_SHARE_GATEWAY_AUTH_MODE=none without a token', () => {
    const cfg = resolveEffectiveGatewayConfig({
      pluginGatewayUrl: '',
      pluginToken: null,
      hostSnapshotRaw: null,
      env: {
        ORCA_ARTIFACTS_API_URL: 'http://127.0.0.1:8787',
        ORCA_SHARE_GATEWAY_AUTH_MODE: 'none'
      }
    })

    expect(cfg.configured).toBe(true)
    expect(cfg.source).toBe('env')
    expect(cfg.authMode).toBe('none')
    expect(cfg.token).toBeNull()
    expect(cfg.tokenStored).toBe(false)
  })

  it('falls back cleanly when env vars are empty or whitespace', () => {
    const cfg = resolveEffectiveGatewayConfig({
      pluginGatewayUrl: 'https://plugin-gw.example.com',
      pluginToken: 'plugin-tok',
      hostSnapshotRaw: null,
      env: {
        ORCA_ARTIFACTS_API_URL: '   ',
        PMSPEC_GATEWAY_URL: '',
        ORCA_CLOUD_AUTH_TOKEN: ' ',
        PMSPEC_BEARER_TOKEN: ''
      }
    })

    expect(cfg.source).toBe('plugin')
    expect(cfg.gatewayUrl).toBe('https://plugin-gw.example.com')
    expect(cfg.token).toBe('plugin-tok')
    expect(cfg.envUrlVar).toBeNull()
    expect(cfg.envTokenVar).toBeNull()
  })

  it('rejects non-http/https env URLs via normalizeGatewayUrl and falls back', () => {
    const cfg = resolveEffectiveGatewayConfig({
      pluginGatewayUrl: '',
      pluginToken: null,
      hostSnapshotRaw: JSON.stringify({
        gatewayUrl: 'https://host-gw.example.com',
        authMode: 'static',
        token: 'host-tok',
        connected: true,
        envOverrideActive: false,
        unreadableError: null
      }),
      env: {
        ORCA_ARTIFACTS_API_URL: 'ftp://invalid-gw.example.com'
      }
    })

    expect(cfg.source).toBe('host')
    expect(cfg.gatewayUrl).toBe('https://host-gw.example.com')
    expect(cfg.envUrlVar).toBeNull()
  })
})

describe('spec-review-load CLI env precedence', () => {
  it('prefers ORCA_ARTIFACTS_API_URL and ORCA_CLOUD_AUTH_TOKEN while letting --base and --token win', () => {
    const fromEnv = parseCliArgs([], {
      ORCA_ARTIFACTS_API_URL: 'https://env-gw.example.com/',
      PMSPEC_GATEWAY_URL: 'https://legacy-gw.example.com',
      ORCA_CLOUD_AUTH_TOKEN: 'orca-tok',
      PMSPEC_BEARER_TOKEN: 'pmspec-tok',
      GATEWAY_BEARER_TOKEN: 'gw-tok',
      AUTH_TOKEN: 'auth-tok'
    })
    expect(fromEnv.baseUrl).toBe('https://env-gw.example.com')
    expect(fromEnv.token).toBe('orca-tok')

    const fromFlags = parseCliArgs(
      ['--base', 'https://cli-gw.example.com/', '--token', 'cli-tok'],
      {
        ORCA_ARTIFACTS_API_URL: 'https://env-gw.example.com',
        ORCA_CLOUD_AUTH_TOKEN: 'orca-tok'
      }
    )
    expect(fromFlags.baseUrl).toBe('https://cli-gw.example.com')
    expect(fromFlags.token).toBe('cli-tok')

    const fallback = parseCliArgs([], {
      ORCA_ARTIFACTS_API_URL: '   ',
      ORCA_CLOUD_AUTH_TOKEN: '',
      PMSPEC_BEARER_TOKEN: 'pmspec-tok'
    })
    expect(fallback.baseUrl).toBe('http://127.0.0.1:8787')
    expect(fallback.token).toBe('pmspec-tok')
  })
})
