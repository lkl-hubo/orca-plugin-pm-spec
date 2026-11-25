import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { LintIssueView, UnsupportedReason, WorkspaceInfo } from '../src/protocol.ts'
import { decodeUtf8Fatal, isValidSpecId } from '../core/id-format.ts'
import { lintSpec } from '../core/spec-lint.ts'
import { parseSpec } from '../core/spec-parser.ts'
import type {
  EvidenceCheckResult,
  LintIssue,
  LintReport,
  ParsedSpec,
  WorkspaceConfig
} from '../core/spec-types.ts'
import { validateWorkspaceConfig } from '../core/workspace-config.ts'
import { verifySpecEvidenceRefs } from './evidence-verify.ts'

export const MAX_WORKSPACE_SPECS = 500
const TEMPLATES_DIR = join(import.meta.dirname, '..', 'templates')

export type ResolvedWorkspace =
  | { ok: true; workspace: WorkspaceInfo; config: WorkspaceConfig; configPath: string }
  | {
      ok: false
      workspace: WorkspaceInfo | null
      unsupportedReason: UnsupportedReason
      configErrors: string[]
    }

export const toLintIssueView = (issue: LintIssue): LintIssueView => ({
  ruleId: issue.ruleId,
  severity: issue.severity,
  message: issue.message,
  hint: issue.hint,
  anchor: issue.anchor,
  line: issue.range?.startLine ?? null
})

export function assertLintCleanForPublish(report: LintReport, actionLabel: string): void {
  const l023 = report.issues.filter((i) => i.ruleId === 'PMS-L023' && i.severity === 'error')
  if (l023.length > 0) {
    throw new Error(
      `E_SENSITIVE_DATA: ${l023.map((i) => i.message).join('；')}，脱敏后再${actionLabel}`
    )
  }
  const otherErrors = report.issues.filter((i) => i.severity === 'error')
  if (otherErrors.length > 0) {
    throw new Error(
      `E_LINT_ERRORS: 当前规格有 ${otherErrors.length} 个错误，修复后才能${actionLabel}`
    )
  }
}

export function getSpecFilePaths(workspacePath: string, config: WorkspaceConfig, specId: string) {
  if (!specId || specId.includes('/') || specId.includes('\\') || specId.includes('..')) {
    throw new Error(
      'E_SPEC_ID_INVALID: 需求 ID 需为 2～64 位中文、字母、数字、- 或 _（不能以 - 或 _ 开头）'
    )
  }
  const specDir = join(workspacePath, config.specsDir, specId)
  return {
    specDir,
    specPath: join(specDir, 'spec.md'),
    relPosixPath: `${config.specsDir}/${specId}/spec.md`
  }
}

const failResolved = (
  workspace: WorkspaceInfo | null,
  unsupportedReason: UnsupportedReason,
  configErrors: string[] = []
): ResolvedWorkspace => ({ ok: false, workspace, unsupportedReason, configErrors })

export async function resolveActiveWorkspace(orca: OrcaWorkerApi): Promise<ResolvedWorkspace> {
  const [ctx, list] = await Promise.all([
    orca.host.call('workspace.readContext'),
    orca.host.call('workspace.list')
  ])
  if (!ctx) {
    return failResolved(null, 'no-workspace')
  }
  const byId = ctx.workspaceId ? list.workspaces.find((w) => w.id === ctx.workspaceId) : undefined
  const byName =
    !byId && !ctx.workspaceId ? list.workspaces.filter((w) => w.name === ctx.displayName) : []
  const matched = byId ?? (byName.length === 1 ? byName[0] : undefined)
  if (!matched) {
    return failResolved(null, 'no-workspace')
  }
  const workspace: WorkspaceInfo = {
    id: matched.id,
    name: matched.name,
    path: matched.path,
    hostId: matched.hostId
  }
  if (matched.hostId !== null && matched.hostId !== 'local') {
    return failResolved(workspace, 'remote-host')
  }
  const configPath = join(matched.path, 'pmspec.json')
  if (!existsSync(configPath)) {
    return failResolved(workspace, 'no-pmspec')
  }
  try {
    const rawConfig: unknown = JSON.parse(await readFile(configPath, 'utf8'))
    const validation = validateWorkspaceConfig(rawConfig)
    if (validation.ok) {
      return { ok: true, workspace, config: validation.config, configPath }
    }
    return failResolved(
      workspace,
      'invalid-pmspec',
      validation.errors.map((e) => `${e.path || 'root'}: ${e.message}`)
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return failResolved(workspace, 'invalid-pmspec', [`pmspec.json JSON 解析失败: ${msg}`])
  }
}

export async function requireLocalWorkspace(orca: OrcaWorkerApi) {
  const resolved = await resolveActiveWorkspace(orca)
  if (resolved.ok) {
    return resolved
  }
  const messages: Record<UnsupportedReason, string> = {
    'no-workspace': 'E_NO_WORKSPACE: 请先在左侧选择一个工作区',
    'remote-host': 'E_REMOTE_HOST: 需求中心 v1 仅支持本机工作区',
    'no-pmspec': 'E_PMSPEC_INVALID: 当前工作区尚未初始化 pmspec.json',
    'invalid-pmspec': `E_PMSPEC_INVALID: ${resolved.configErrors[0] ?? 'pmspec.json 无效'}`
  }
  throw new Error(messages[resolved.unsupportedReason])
}

export async function initSpecWorkspace(orca: OrcaWorkerApi): Promise<{ created: boolean }> {
  const resolved = await resolveActiveWorkspace(orca)
  if (
    !resolved.ok &&
    (resolved.unsupportedReason === 'no-workspace' || resolved.unsupportedReason === 'remote-host')
  ) {
    await requireLocalWorkspace(orca)
  }
  const ws = resolved.workspace!
  const configPath = join(ws.path, 'pmspec.json')
  const created = !existsSync(configPath)
  if (created) {
    await writeFile(
      configPath,
      await readFile(join(TEMPLATES_DIR, 'pmspec-template.json'), 'utf8'),
      'utf8'
    )
    await mkdir(join(ws.path, 'specs'), { recursive: true })
  }
  const gitignorePath = join(ws.path, '.gitignore')
  const existing = existsSync(gitignorePath) ? await readFile(gitignorePath, 'utf8') : ''
  const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()))
  const toAdd = ['.pmspec/runs/', '.pmspec/reviews/'].filter((line) => !existingLines.has(line))
  if (toAdd.length > 0) {
    const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`
    await writeFile(gitignorePath, `${prefix}${toAdd.join('\n')}\n`, 'utf8')
  }
  return { created }
}

export async function loadAndLintSpec(
  workspacePath: string,
  config: WorkspaceConfig,
  specId: string,
  stage: 'edit' | 'publish' = 'edit'
): Promise<{
  specPath: string
  relPosixPath: string
  rawBytes: Uint8Array
  rawText: string
  parsed: ParsedSpec
  evidence: EvidenceCheckResult[]
  report: LintReport
}> {
  const { specPath, relPosixPath } = getSpecFilePaths(workspacePath, config, specId)
  const rawBytes = await readFile(specPath)
  const decoded = decodeUtf8Fatal(rawBytes)
  const parsed = parseSpec(rawBytes, relPosixPath)
  const evidence = await verifySpecEvidenceRefs(parsed.evidenceRefs, workspacePath, config)
  return {
    specPath,
    relPosixPath,
    rawBytes,
    rawText: decoded.ok ? decoded.text : '',
    parsed,
    evidence,
    report: lintSpec(parsed, config, { stage, evidence })
  }
}

export async function createSpecFile(
  workspacePath: string,
  config: WorkspaceConfig,
  input: { specId: string; title: string }
): Promise<{ specId: string; path: string }> {
  const specId = input.specId.trim().normalize('NFC')
  const title = input.title.trim()
  if (!isValidSpecId(specId)) {
    throw new Error(
      'E_SPEC_ID_INVALID: 需求 ID 需为 2～64 位中文、字母、数字、- 或 _（不能以 - 或 _ 开头）'
    )
  }
  if (title.length < 2 || title.length > 80) {
    throw new Error('E_SPEC_ID_INVALID: 需求标题需为 2～80 个字符')
  }
  const { specDir, specPath, relPosixPath } = getSpecFilePaths(workspacePath, config, specId)
  if (existsSync(specDir)) {
    throw new Error(`E_SPEC_EXISTS: 规格 ${specId} 已存在`)
  }
  const template = await readFile(join(TEMPLATES_DIR, 'spec-template.md'), 'utf8')
  let owner = 'PM'
  try {
    owner = userInfo().username.trim().slice(0, 40) || 'PM'
  } catch {
    owner = 'PM'
  }
  const now = new Date()
  const updated = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const rendered = template
    .replaceAll('{{id}}', specId)
    .replaceAll('{{title}}', title)
    .replaceAll('{{owner}}', owner)
    .replaceAll('{{updated}}', updated)
  await mkdir(specDir, { recursive: true })
  const tmpPath = `${specPath}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(tmpPath, rendered, 'utf8')
    await rename(tmpPath, specPath)
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined)
    throw error
  }
  return { specId, path: relPosixPath }
}

export async function scanWorkspaceSpecEntries(workspacePath: string, config: WorkspaceConfig) {
  const root = join(workspacePath, config.specsDir)
  if (!existsSync(root)) {
    return []
  }
  const found: { specId: string; specPath: string; relPosixPath: string; mtimeMs: number }[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const specPath = join(root, entry.name, 'spec.md')
    try {
      const st = await stat(specPath)
      if (st.isFile()) {
        const specId = entry.name.normalize('NFC')
        found.push({
          specId,
          specPath,
          relPosixPath: `${config.specsDir}/${specId}/spec.md`,
          mtimeMs: st.mtimeMs
        })
      }
    } catch {
      // Ignore directories without spec.md.
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_WORKSPACE_SPECS)
}

export async function resolveCurrentSpecId(
  orca: OrcaWorkerApi,
  wsId: string,
  wsPath: string,
  config: WorkspaceConfig
): Promise<string> {
  const stored = await orca.storage.get(`selectedSpec:${wsId}`)
  if (typeof stored === 'string' && stored) {
    return stored
  }
  const entries = await scanWorkspaceSpecEntries(wsPath, config)
  if (entries[0]) {
    return entries[0].specId
  }
  throw new Error('E_LINT_ERRORS: 当前工作区没有规格文件')
}
