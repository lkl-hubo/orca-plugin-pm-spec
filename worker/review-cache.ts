import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { CommentView, ReviewView } from '../src/protocol.ts'
import type {
  GatewayClient,
  GatewayCommentDto,
  GatewayReviewDetailResponse
} from './gateway-client.ts'
import { writeJsonAtomic } from './review-prompt.ts'

export type CachedReviewMeta = {
  slug: string
  specId: string
  title: string
  specVersion: number
  snapshotSha256: string
  status: 'open' | 'closed'
  expired: boolean
  expiresAt: string
  requiredSignoffRoles: string[]
  signoffs: ReviewView['signoffs']
  commentsCursor: string | null
  lastSyncedAt: string | null
  createdAt: string
  closedAt: string | null
}

export const editTokenKey = (slug: string): string => `review:${slug}:editToken`
export const reviewerSecretKey = (slug: string): string => `review:${slug}:reviewerKey`
const reviewDir = (wsPath: string, slug: string): string => join(wsPath, '.pmspec', 'reviews', slug)

export const countOpenIssues = (comments: readonly CommentView[]): number =>
  comments.filter((c) => c.kind === 'issue' && c.status === 'open').length

export const toCommentView = (d: GatewayCommentDto): CommentView => ({
  id: d.id,
  anchor: d.anchor,
  authorName: d.authorName,
  authorRole: d.authorRole,
  kind: d.kind,
  body: d.body,
  status: d.status,
  resolutionNote: d.resolutionNote,
  createdAt: d.createdAt
})

export async function saveReviewFiles(
  wsPath: string,
  slug: string,
  meta?: CachedReviewMeta,
  comments?: CommentView[]
): Promise<void> {
  const dir = reviewDir(wsPath, slug)
  await mkdir(dir, { recursive: true })
  if (meta) {
    await writeJsonAtomic(join(dir, 'review.json'), meta)
  }
  if (comments) {
    await writeJsonAtomic(join(dir, 'comments.json'), comments)
  }
}

export async function readReviewRecord(wsPath: string, slug: string) {
  const dir = reviewDir(wsPath, slug)
  const metaPath = join(dir, 'review.json')
  if (!existsSync(metaPath)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: review.json is written strictly by saveReviewRecord using CachedReviewMeta.
  const meta = JSON.parse(await readFile(metaPath, 'utf8')) as CachedReviewMeta
  const commentsPath = join(dir, 'comments.json')
  const comments = existsSync(commentsPath)
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: comments.json is written strictly by saveReviewRecord using CommentView[].
      (JSON.parse(await readFile(commentsPath, 'utf8')) as CommentView[])
    : []
  return { meta, comments }
}

function computeReadiness(
  meta: CachedReviewMeta,
  comments: readonly CommentView[],
  currentSha256: string
) {
  const stale = currentSha256 !== meta.snapshotSha256
  const blockingReasons: string[] = []
  if (meta.status !== 'open') {
    blockingReasons.push('评审已关闭')
  }
  if (stale) {
    blockingReasons.push('规格已修改，需发布新版本')
  }
  const latestByRole = new Map<string, 'approve' | 'request_changes'>()
  meta.signoffs.forEach((s) => latestByRole.set(s.role, s.decision))
  for (const role of meta.requiredSignoffRoles) {
    const decision = latestByRole.get(role)
    if (!decision) {
      blockingReasons.push(`缺少「${role}」签核通过`)
    } else if (decision !== 'approve') {
      blockingReasons.push(`「${role}」签核为需修改`)
    }
  }
  const openIssues = countOpenIssues(comments)
  if (openIssues > 0) {
    blockingReasons.push(`仍有 ${openIssues} 条未解决的问题意见`)
  }
  return { stale, readyToApprove: blockingReasons.length === 0, blockingReasons }
}

export async function toReviewView(
  orca: OrcaWorkerApi,
  gateway: GatewayClient,
  meta: CachedReviewMeta,
  comments: CommentView[],
  currentSha256: string
): Promise<ReviewView> {
  const [{ gatewayUrl }, reviewerKey] = await Promise.all([
    gateway.readConfig(),
    orca.secrets.get(reviewerSecretKey(meta.slug))
  ])
  const baseUrl = gatewayUrl || ''
  return {
    slug: meta.slug,
    specVersion: meta.specVersion,
    status: meta.status,
    expired: meta.expired || Date.parse(meta.expiresAt) <= Date.now(),
    reviewUrl: reviewerKey
      ? `${baseUrl}/r/${meta.slug}?k=${reviewerKey}`
      : `${baseUrl}/r/${meta.slug}`,
    expiresAt: meta.expiresAt,
    requiredSignoffRoles: meta.requiredSignoffRoles,
    signoffs: meta.signoffs,
    comments,
    lastSyncedAt: meta.lastSyncedAt,
    ...computeReadiness(meta, comments, currentSha256)
  }
}

export async function listCachedReviews(
  wsPath: string,
  specId?: string
): Promise<CachedReviewMeta[]> {
  const root = join(wsPath, '.pmspec', 'reviews')
  if (!existsSync(root)) {
    return []
  }
  const out: CachedReviewMeta[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const rec = await readReviewRecord(wsPath, entry.name).catch(() => null)
    if (rec && (!specId || rec.meta.specId === specId)) {
      out.push(rec.meta)
    }
  }
  return out.sort((a, b) => b.specVersion - a.specVersion || b.createdAt.localeCompare(a.createdAt))
}

export async function listReviewsForSpec(
  orca: OrcaWorkerApi,
  gateway: GatewayClient,
  wsPath: string,
  specId: string,
  currentSha256: string
): Promise<ReviewView[]> {
  const views: ReviewView[] = []
  for (const meta of await listCachedReviews(wsPath, specId)) {
    const rec = await readReviewRecord(wsPath, meta.slug)
    views.push(await toReviewView(orca, gateway, meta, rec?.comments ?? [], currentSha256))
  }
  return views
}

export async function findOpenReviewSummary(wsPath: string, specId: string) {
  const openMeta = (await listCachedReviews(wsPath, specId)).find((m) => m.status === 'open')
  if (!openMeta) {
    return null
  }
  const rec = await readReviewRecord(wsPath, openMeta.slug)
  return {
    slug: openMeta.slug,
    openIssues: countOpenIssues(rec?.comments ?? []),
    expiresAt: openMeta.expiresAt
  }
}

export function mergeMetaFromDetail(
  existing: CachedReviewMeta | undefined,
  detail: GatewayReviewDetailResponse,
  commentsCursor: string | null,
  lastSyncedAt: string | null
): CachedReviewMeta {
  return {
    slug: existing?.slug ?? detail.slug,
    specId: existing?.specId ?? detail.specId,
    title: existing?.title ?? detail.title,
    specVersion: existing?.specVersion ?? detail.specVersion,
    snapshotSha256: existing?.snapshotSha256 ?? detail.snapshotSha256,
    status: detail.status,
    expired: detail.expired,
    expiresAt: detail.expiresAt,
    requiredSignoffRoles: detail.requiredSignoffRoles,
    signoffs: detail.signoffs.map((s) => ({
      reviewerName: s.reviewerName,
      role: s.role,
      decision: s.decision,
      createdAt: s.createdAt
    })),
    commentsCursor,
    lastSyncedAt,
    createdAt: existing?.createdAt ?? detail.createdAt,
    closedAt: detail.closedAt
  }
}
