import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { sha256Hex } from '../core/id-format.ts'
import type { CodeRepoConfig, RunRepoRecord } from '../core/spec-types.ts'
import { resolveWorkspaceRepoPath } from '../core/workspace-config.ts'

const execFileAsync = promisify(execFile)

const GIT_EXEC_OPTIONS = {
  windowsHide: true,
  timeout: 10_000,
  maxBuffer: 8 * 1024 * 1024
} as const

async function runGit(
  cwd: string,
  args: string[]
): Promise<{ ok: true; stdout: string } | { ok: false; code?: string }> {
  try {
    const { stdout } = await execFileAsync('git', args, { ...GIT_EXEC_OPTIONS, cwd })
    return { ok: true, stdout }
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined
    return { ok: false, code }
  }
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    return (await stat(dirPath)).isDirectory()
  } catch {
    return false
  }
}

async function readGitDigest(
  repoPath: string
): Promise<
  { ok: true; head: string; porcelainSha256: string } | { ok: false; skippedReason: string }
> {
  const inside = await runGit(repoPath, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok) {
    return {
      ok: false,
      skippedReason: inside.code === 'ENOENT' ? 'git-not-found' : 'not-git-repo'
    }
  }
  if (inside.stdout.trim() !== 'true') {
    return { ok: false, skippedReason: 'not-git-repo' }
  }
  const headRes = await runGit(repoPath, ['rev-parse', 'HEAD'])
  const statusRes = await runGit(repoPath, ['status', '--porcelain=v1', '-uall'])
  if (!statusRes.ok) {
    return { ok: false, skippedReason: 'git-status-failed' }
  }
  return {
    ok: true,
    head: headRes.ok ? headRes.stdout.trim() : 'UNBORN',
    porcelainSha256: sha256Hex(statusRes.stdout)
  }
}

export async function captureRepoSnapshotsBefore(
  workspacePath: string,
  codeRepos: readonly CodeRepoConfig[]
): Promise<RunRepoRecord[]> {
  const records: RunRepoRecord[] = []
  for (const repo of codeRepos) {
    const absPath = resolveWorkspaceRepoPath(workspacePath, repo.path)
    if (!(await isDirectory(absPath))) {
      records.push({
        key: repo.key,
        path: absPath,
        git: false,
        headBefore: null,
        porcelainBeforeSha256: null,
        headAfter: null,
        porcelainAfterSha256: null,
        skippedReason: 'repo-not-found'
      })
      continue
    }
    const digest = await readGitDigest(absPath)
    if (!digest.ok) {
      records.push({
        key: repo.key,
        path: absPath,
        git: false,
        headBefore: null,
        porcelainBeforeSha256: null,
        headAfter: null,
        porcelainAfterSha256: null,
        skippedReason: digest.skippedReason
      })
      continue
    }
    records.push({
      key: repo.key,
      path: absPath,
      git: true,
      headBefore: digest.head,
      porcelainBeforeSha256: digest.porcelainSha256,
      headAfter: null,
      porcelainAfterSha256: null,
      skippedReason: null
    })
  }
  return records
}

export async function compareRepoSnapshotsAfter(
  records: readonly RunRepoRecord[]
): Promise<{ repos: RunRepoRecord[]; taint: { changed: boolean; repos: string[] } }> {
  const taintedRepos: string[] = []
  const updated: RunRepoRecord[] = []
  for (const record of records) {
    if (!record.git) {
      updated.push({ ...record })
      continue
    }
    const after = await readGitDigest(record.path)
    if (!after.ok) {
      taintedRepos.push(record.key)
      updated.push({ ...record, skippedReason: after.skippedReason })
      continue
    }
    const changed =
      after.head !== record.headBefore || after.porcelainSha256 !== record.porcelainBeforeSha256
    if (changed) {
      taintedRepos.push(record.key)
    }
    updated.push({
      ...record,
      headAfter: after.head,
      porcelainAfterSha256: after.porcelainSha256
    })
  }
  return {
    repos: updated,
    taint: { changed: taintedRepos.length > 0, repos: taintedRepos }
  }
}
