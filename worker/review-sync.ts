import { readFile } from 'node:fs/promises'
import type { OrcaWorkerApi } from 'orca/worker'
import type { CommentView, ReviewView } from '../src/protocol.ts'
import { buildReviewIdempotencyKey, decodeUtf8Fatal } from '../core/id-format.ts'
import { buildGatewayReviewPayload } from '../core/review-payload.ts'
import { lintSpec } from '../core/spec-lint.ts'
import { parseSpec } from '../core/spec-parser.ts'
import type { WorkspaceConfig } from '../core/spec-types.ts'
import { verifySpecEvidenceRefs } from './evidence-verify.ts'
import { updateFrontmatterStatusAndVersion } from './frontmatter-write.ts'
import type { GatewayClient } from './gateway-client.ts'
import { appendLocalMetric } from './local-metrics.ts'
import {
  type CachedReviewMeta,
  countOpenIssues,
  editTokenKey,
  findOpenReviewSummary,
  listCachedReviews,
  listReviewsForSpec,
  mergeMetaFromDetail,
  readReviewRecord,
  reviewerSecretKey,
  saveReviewFiles,
  toCommentView,
  toReviewView
} from './review-cache.ts'
import {
  computePreviousSnapshotDiffSummary,
  readSpecSnapshot,
  writeSpecSnapshot
} from './snapshot-store.ts'
import {
  assertLintCleanForPublish,
  getSpecFilePaths,
  loadAndLintSpec,
  scanWorkspaceSpecEntries
} from './spec-workspace.ts'

export { findOpenReviewSummary, listReviewsForSpec }

export async function publishSpecReview(params: {
  orca: OrcaWorkerApi
  gateway: GatewayClient
  wsPath: string
  config: WorkspaceConfig
  specId: string
  version: number
  metricsEnabled: boolean
}): Promise<ReviewView> {
  const { orca, gateway, wsPath, config, specId, version, metricsEnabled } = params
  const snap = await readSpecSnapshot(wsPath, specId, version)
  const { specPath, relPosixPath } = getSpecFilePaths(wsPath, config, specId)
  const loaded = snap ? null : await loadAndLintSpec(wsPath, config, specId, 'publish')
  const parsed = snap ? parseSpec(snap.markdown, relPosixPath) : loaded!.parsed
  const evidence = snap
    ? await verifySpecEvidenceRefs(parsed.evidenceRefs, wsPath, config)
    : loaded!.evidence
  const report = snap ? lintSpec(parsed, config, { stage: 'publish', evidence }) : loaded!.report
  assertLintCleanForPublish(report, '发布')

  let snapshotSha256 = snap?.manifest.sha256 ?? ''
  if (!snap) {
    if (parsed.frontmatter?.version !== version) {
      throw new Error(`E_SNAPSHOT_VERSION_EXISTS: 版本 ${version} 快照不存在，请先保存快照`)
    }
    snapshotSha256 = (
      await writeSpecSnapshot(wsPath, parsed, loaded!.rawBytes, { lint: report.counts })
    ).sha256
  }
  const previousVersionDiff = await computePreviousSnapshotDiffSummary(wsPath, specId, version)
  const expirySetting = Number((await orca.settings.get('reviewExpiryDays')) ?? 14)
  const expiresInDays =
    Number.isInteger(expirySetting) && expirySetting >= 1 && expirySetting <= 90
      ? expirySetting
      : 14
  const payload = buildGatewayReviewPayload(parsed, config, {
    snapshotSha256,
    expiresInDays,
    previousVersionDiff
  })
  const created = await gateway.createSpecReview(
    payload,
    buildReviewIdempotencyKey(specId, version, snapshotSha256)
  )

  await Promise.all([
    orca.secrets.set(editTokenKey(created.slug), created.editToken),
    orca.secrets.set(reviewerSecretKey(created.slug), created.reviewerKey)
  ])
  for (const old of await listCachedReviews(wsPath, specId)) {
    if (old.status === 'open' && old.slug !== created.slug && old.specVersion < version) {
      await closeReviewBySlug(orca, gateway, wsPath, old.slug, snapshotSha256).catch(
        () => undefined
      )
    }
  }
  const meta: CachedReviewMeta = {
    slug: created.slug,
    specId,
    title: payload.title,
    specVersion: created.specVersion,
    snapshotSha256,
    status: 'open',
    expired: false,
    expiresAt: created.expiresAt,
    requiredSignoffRoles: [...config.review.requiredSignoffRoles],
    signoffs: [],
    commentsCursor: null,
    lastSyncedAt: new Date().toISOString(),
    createdAt: created.createdAt,
    closedAt: null
  }
  await saveReviewFiles(wsPath, created.slug, meta, [])
  await updateFrontmatterStatusAndVersion(specPath, {
    expectedSha256: snapshotSha256,
    status: 'in-review'
  }).catch(() => undefined)
  await appendLocalMetric(
    wsPath,
    { event: 'review.published', specId, version, slug: created.slug },
    metricsEnabled
  )
  const currentBytes = await readFile(specPath).catch(() => null)
  return toReviewView(
    orca,
    gateway,
    meta,
    [],
    currentBytes ? decodeUtf8Fatal(currentBytes).rawSha256 : snapshotSha256
  )
}

export async function syncReviewBySlug(
  orca: OrcaWorkerApi,
  gateway: GatewayClient,
  wsPath: string,
  slug: string,
  currentSha256?: string
): Promise<ReviewView> {
  const existing = await readReviewRecord(wsPath, slug)
  const editToken = await orca.secrets.get(editTokenKey(slug))
  const detail = await gateway.getSpecReview(slug, editToken)
  let cursor = existing?.meta.commentsCursor ?? null
  const byId = new Map((existing?.comments ?? []).map((c) => [c.id, c]))
  let newComments = 0
  for (let page = 0; page < 20; page += 1) {
    const res = await gateway.listComments(slug, cursor, editToken)
    for (const dto of res.comments) {
      if (!byId.has(dto.id)) {
        newComments += 1
      }
      byId.set(dto.id, toCommentView(dto))
    }
    const prev = cursor
    cursor = res.nextCursor
    if (res.comments.length < 500 || !cursor || cursor === prev) {
      break
    }
  }
  const comments = [...byId.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  )
  const nextMeta = mergeMetaFromDetail(existing?.meta, detail, cursor, new Date().toISOString())
  await saveReviewFiles(wsPath, slug, nextMeta, comments)
  orca.panels.post('pmspec.review.updated', {
    slug,
    newComments,
    openIssues: countOpenIssues(comments)
  })
  return toReviewView(orca, gateway, nextMeta, comments, currentSha256 ?? nextMeta.snapshotSha256)
}

export async function resolveReviewComment(params: {
  orca: OrcaWorkerApi
  gateway: GatewayClient
  wsPath: string
  slug: string
  commentId: string
  status: 'open' | 'resolved' | 'wont_fix'
  note: string
  metricsEnabled: boolean
}): Promise<CommentView> {
  const { orca, gateway, wsPath, slug, commentId, status, note, metricsEnabled } = params
  const updated = toCommentView(
    await gateway.patchComment(
      slug,
      commentId,
      status,
      note,
      await orca.secrets.get(editTokenKey(slug))
    )
  )
  const rec = await readReviewRecord(wsPath, slug)
  const comments = [...(rec?.comments ?? []).filter((c) => c.id !== commentId), updated].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  )
  await saveReviewFiles(wsPath, slug, undefined, comments)
  if (rec?.meta && status === 'resolved') {
    await appendLocalMetric(
      wsPath,
      {
        event: 'comment.resolved',
        specId: rec.meta.specId,
        slug,
        commentId,
        status,
        kind: updated.kind
      },
      metricsEnabled
    )
  }
  orca.panels.post('pmspec.review.updated', {
    slug,
    newComments: 0,
    openIssues: countOpenIssues(comments)
  })
  return updated
}

export async function closeReviewBySlug(
  orca: OrcaWorkerApi,
  gateway: GatewayClient,
  wsPath: string,
  slug: string,
  currentSha256?: string
): Promise<ReviewView> {
  const existing = await readReviewRecord(wsPath, slug)
  const detail = await gateway.closeReview(slug, await orca.secrets.get(editTokenKey(slug)))
  const meta = mergeMetaFromDetail(
    existing?.meta,
    detail,
    existing?.meta.commentsCursor ?? null,
    existing?.meta.lastSyncedAt ?? null
  )
  await saveReviewFiles(wsPath, slug, meta)
  return toReviewView(
    orca,
    gateway,
    meta,
    existing?.comments ?? [],
    currentSha256 ?? meta.snapshotSha256
  )
}

export async function rotateReviewKeyBySlug(
  orca: OrcaWorkerApi,
  gateway: GatewayClient,
  slug: string
) {
  const res = await gateway.rotateKey(slug, await orca.secrets.get(editTokenKey(slug)))
  await orca.secrets.set(reviewerSecretKey(slug), res.reviewerKey)
  return { reviewUrl: res.reviewUrl }
}

export async function markSpecApproved(params: {
  orca: OrcaWorkerApi
  gateway: GatewayClient
  wsPath: string
  config: WorkspaceConfig
  specId: string
  slug: string
  metricsEnabled: boolean
}): Promise<{ status: 'approved' }> {
  const { orca, gateway, wsPath, config, specId, slug, metricsEnabled } = params
  const { specPath } = getSpecFilePaths(wsPath, config, specId)
  const currentSha256 = decodeUtf8Fatal(await readFile(specPath)).rawSha256
  const synced = await syncReviewBySlug(orca, gateway, wsPath, slug, currentSha256)
  if (!synced.readyToApprove) {
    throw new Error(`E_LINT_ERRORS: 尚不满足批准条件：${synced.blockingReasons.join('；')}`)
  }
  await closeReviewBySlug(orca, gateway, wsPath, slug, currentSha256)
  await updateFrontmatterStatusAndVersion(specPath, {
    expectedSha256: currentSha256,
    status: 'approved'
  })
  await appendLocalMetric(wsPath, { event: 'spec.approved', specId, slug }, metricsEnabled)
  return { status: 'approved' }
}

export async function syncOpenWorkspaceReviews(
  orca: OrcaWorkerApi,
  gateway: GatewayClient,
  wsPath: string,
  config: WorkspaceConfig
): Promise<void> {
  for (const entry of (await scanWorkspaceSpecEntries(wsPath, config).catch(() => [])).slice(
    0,
    20
  )) {
    const open = await findOpenReviewSummary(wsPath, entry.specId).catch(() => null)
    if (open) {
      await syncReviewBySlug(orca, gateway, wsPath, open.slug).catch(() => undefined)
    }
  }
}
