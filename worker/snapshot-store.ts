import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildSnapshotManifest } from '../core/review-payload.ts'
import { diffSnapshots } from '../core/spec-diff.ts'
import type { ParsedSpec, SnapshotManifest } from '../core/spec-types.ts'

export function getSnapshotsDir(workspacePath: string, specId: string): string {
  return join(workspacePath, '.pmspec', 'snapshots', specId)
}

export async function writeSpecSnapshot(
  workspacePath: string,
  parsed: ParsedSpec,
  rawBytes: Uint8Array | string,
  options: { createdAt?: string; createdBy?: string; lint: { error: number; warning: number } }
): Promise<{ version: number; sha256: string; reused: boolean; manifest: SnapshotManifest }> {
  if (!parsed.frontmatter) {
    throw new Error('E_LINT_ERRORS: 规格缺少有效头信息，无法保存快照')
  }
  const { id: specId, version, owner } = parsed.frontmatter
  const sha256 = parsed.rawSha256
  const dir = getSnapshotsDir(workspacePath, specId)
  const mdPath = join(dir, `v${version}.md`)
  const jsonPath = join(dir, `v${version}.json`)

  if (existsSync(jsonPath)) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: snapshot manifests under .pmspec/snapshots are written atomically by writeSpecSnapshot.
    const existing = JSON.parse(await readFile(jsonPath, 'utf8')) as SnapshotManifest
    if (existing.sha256 === sha256 && existsSync(mdPath)) {
      return { version, sha256, reused: true, manifest: existing }
    }
    throw new Error(`E_SNAPSHOT_VERSION_EXISTS: 版本 ${version} 已有不同内容的快照`)
  }

  const manifest = buildSnapshotManifest(parsed, {
    createdAt: options.createdAt ?? new Date().toISOString(),
    createdBy: options.createdBy ?? owner,
    lint: options.lint
  })
  await mkdir(dir, { recursive: true })
  const suffix = `.tmp-${process.pid}-${Date.now()}`
  const mdTmp = `${mdPath}${suffix}`
  const jsonTmp = `${jsonPath}${suffix}`
  try {
    await writeFile(mdTmp, rawBytes)
    await writeFile(jsonTmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await rename(mdTmp, mdPath)
    await rename(jsonTmp, jsonPath)
    return { version, sha256, reused: false, manifest }
  } catch (error) {
    await unlink(mdTmp).catch(() => undefined)
    await unlink(jsonTmp).catch(() => undefined)
    throw error
  }
}

export async function listSpecSnapshots(
  workspacePath: string,
  specId: string
): Promise<SnapshotManifest[]> {
  const dir = getSnapshotsDir(workspacePath, specId)
  if (!existsSync(dir)) {
    return []
  }
  const entries = await readdir(dir, { withFileTypes: true })
  const manifests: SnapshotManifest[] = []
  for (const entry of entries) {
    if (entry.isFile() && /^v\d+\.json$/.test(entry.name)) {
      try {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: snapshot manifests under .pmspec/snapshots are written atomically by writeSpecSnapshot.
        const parsed = JSON.parse(await readFile(join(dir, entry.name), 'utf8')) as SnapshotManifest
        if (parsed && typeof parsed.version === 'number') {
          manifests.push(parsed)
        }
      } catch {
        // Skip corrupted snapshot manifest files.
      }
    }
  }
  return manifests.sort((a, b) => a.version - b.version)
}

export async function readSpecSnapshot(
  workspacePath: string,
  specId: string,
  version: number
): Promise<{ manifest: SnapshotManifest; markdown: string } | null> {
  const dir = getSnapshotsDir(workspacePath, specId)
  const jsonPath = join(dir, `v${version}.json`)
  const mdPath = join(dir, `v${version}.md`)
  if (!existsSync(jsonPath) || !existsSync(mdPath)) {
    return null
  }
  const [manifestRaw, markdown] = await Promise.all([
    readFile(jsonPath, 'utf8'),
    readFile(mdPath, 'utf8')
  ])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: snapshot manifests under .pmspec/snapshots are written atomically by writeSpecSnapshot.
  return { manifest: JSON.parse(manifestRaw) as SnapshotManifest, markdown }
}

export async function diffSpecSnapshotVersions(
  workspacePath: string,
  specId: string,
  fromVersion: number,
  toVersion: number
) {
  const [fromSnap, toSnap] = await Promise.all([
    readSpecSnapshot(workspacePath, specId, fromVersion),
    readSpecSnapshot(workspacePath, specId, toVersion)
  ])
  if (!fromSnap || !toSnap) {
    throw new Error('E_LINT_ERRORS: 所选快照版本不存在')
  }
  const diff = diffSnapshots(
    { manifest: fromSnap.manifest, markdown: fromSnap.markdown },
    { manifest: toSnap.manifest, markdown: toSnap.markdown }
  )
  return { added: diff.added, removed: diff.removed, modified: diff.modified }
}

export async function computePreviousSnapshotDiffSummary(
  workspacePath: string,
  specId: string,
  version: number
): Promise<{ fromVersion: number; added: number; modified: number; removed: number } | undefined> {
  const snapshots = await listSpecSnapshots(workspacePath, specId)
  let prevMeta: (typeof snapshots)[number] | undefined
  for (let idx = snapshots.length - 1; idx >= 0; idx -= 1) {
    if (snapshots[idx]!.version < version) {
      prevMeta = snapshots[idx]
      break
    }
  }
  if (!prevMeta) {
    return undefined
  }
  const diff = await diffSpecSnapshotVersions(
    workspacePath,
    specId,
    prevMeta.version,
    version
  ).catch(() => null)
  if (!diff) {
    return undefined
  }
  return {
    fromVersion: prevMeta.version,
    added: diff.added.length,
    modified: diff.modified.length,
    removed: diff.removed.length
  }
}
