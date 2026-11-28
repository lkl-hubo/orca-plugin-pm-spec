import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Input,
  plugin,
  read,
  Row,
  Select,
  set,
  shell,
  Stack,
  Text,
  update,
  type Atom,
  type IconName
} from 'orca'
import type { ReviewView, SpecSummary } from '../protocol.ts'
import {
  BusyRow,
  COMMENT_STATUS_META,
  getResolutionNote,
  ReviewApproveCard,
  ReviewCommentsSection,
  ReviewSignoffsSection
} from './review-comments.tsx'

export type ReviewTabProps = {
  specId: string
  specStatus: SpecSummary['status']
  snapshots: { version: number; sha256: string; createdAt: string }[]
  reviews: ReviewView[]
  gatewayConfigured: boolean
  bumpingVersion: boolean
  onBumpVersion: () => Promise<void>
  onOpenGateway: () => void
  onReviewsChanged: () => Promise<void>
  onError: (error: unknown, context?: { specId?: string }) => void
  onNotify: (message: string) => void
  onClearFeedback: () => void
}

type BusyKind = 'sync' | 'rotate' | 'close' | 'approve'

const publishingAtom = atom(false)
const busySlugAtom = atom<{ kind: BusyKind; slug: string } | null>(null)
const resolvingIdAtom = atom<string | null>(null)
const selectedSlugBySpecAtom = atom<Record<string, string>>({})
const publishVersionBySpecAtom = atom<Record<string, string>>({})
const copyNoticeAtom = atom<string | null>(null)

function reviewStatusBadge(review: ReviewView): {
  label: string
  tone: 'accent' | 'warning' | 'neutral'
} {
  if (review.status === 'closed') {
    return { label: '已关闭', tone: 'neutral' }
  }
  return review.expired ? { label: '已过期', tone: 'warning' } : { label: '评审中', tone: 'accent' }
}

async function runBusy<T>(
  props: ReviewTabProps,
  busyAtom: Atom<T>,
  busyValue: T,
  idleValue: T,
  fn: () => Promise<string>
): Promise<void> {
  if (read(busyAtom) !== idleValue) {
    return
  }
  props.onClearFeedback()
  set(busyAtom, busyValue)
  try {
    const message = await fn()
    await props.onReviewsChanged()
    props.onNotify(message)
  } catch (error) {
    props.onError(error, { specId: props.specId })
  } finally {
    set(busyAtom, idleValue)
  }
}

async function copyReviewUrl(url: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(url)
      set(copyNoticeAtom, '已复制评审链接到剪贴板')
      return
    }
  } catch {
    // Clipboard access can be unavailable in isolated frames.
  }
  set(copyNoticeAtom, '请直接选中上方评审链接输入框内容复制（Cmd/Ctrl+C）')
}

function ReviewLinkCard({
  review,
  busy,
  copyNotice,
  props
}: {
  review: ReviewView
  busy: { kind: BusyKind; slug: string } | null
  copyNotice: string | null
  props: ReviewTabProps
}) {
  const statusBadge = reviewStatusBadge(review)
  const closed = review.status === 'closed'
  const slugActions: {
    kind: 'sync' | 'rotate' | 'close'
    label: string
    busyLabel: string
    icon: IconName
    tone?: 'danger'
    lockClosed: boolean
    run: () => Promise<string>
  }[] = [
    {
      kind: 'sync',
      label: '同步意见',
      busyLabel: '同步中…',
      icon: 'refresh',
      lockClosed: false,
      run: async () => {
        await plugin.request('review.sync', { slug: review.slug }, { timeoutMs: 60_000 })
        return '已完成评审意见同步'
      }
    },
    {
      kind: 'rotate',
      label: '轮换密钥',
      busyLabel: '轮换中…',
      icon: 'link',
      lockClosed: true,
      run: async () => {
        await plugin.request('review.rotateKey', { slug: review.slug })
        return '已生成新评审链接，旧链接已立即失效'
      }
    },
    {
      kind: 'close',
      label: '关闭评审',
      busyLabel: '关闭中…',
      icon: 'close',
      tone: 'danger',
      lockClosed: true,
      run: async () => {
        await plugin.request('review.close', { slug: review.slug })
        return '已关闭当前评审'
      }
    }
  ]

  return (
    <Card
      title={`评审 v${review.specVersion}`}
      description={`截止时间：${review.expiresAt}${review.lastSyncedAt ? ` · 上次同步：${review.lastSyncedAt}` : ''}`}
    >
      <Stack gap="sm">
        <Row gap="xs" align="center" wrap>
          <Badge tone={statusBadge.tone}>{statusBadge.label}</Badge>
          <Badge tone="neutral">意见 {review.comments.length}</Badge>
        </Row>
        <Input label="评审链接" value={review.reviewUrl} />
        <Row gap="xs" wrap align="center">
          <Button
            size="xs"
            variant="outline"
            icon="copy"
            onPress={() => void copyReviewUrl(review.reviewUrl)}
          >
            复制链接
          </Button>
          <Button
            size="xs"
            variant="outline"
            icon="open-external"
            onPress={() => void shell.openExternal(review.reviewUrl).catch(() => undefined)}
          >
            浏览器打开
          </Button>
          {slugActions.map((a) => (
            <Button
              key={a.kind}
              size="xs"
              variant="outline"
              tone={a.tone}
              icon={a.icon}
              disabled={busy !== null || (a.lockClosed && closed)}
              onPress={() =>
                void runBusy(props, busySlugAtom, { kind: a.kind, slug: review.slug }, null, a.run)
              }
            >
              {busy?.slug === review.slug && busy.kind === a.kind ? a.busyLabel : a.label}
            </Button>
          ))}
        </Row>
        <BusyRow
          show={busy?.slug === review.slug && busy.kind !== 'approve'}
          label="正在与分享网关同步状态"
        />
        {copyNotice ? (
          <Text tone="success" size="xs">
            {copyNotice}
          </Text>
        ) : null}
      </Stack>
    </Card>
  )
}

export function ReviewTab(props: ReviewTabProps) {
  const publishing = read(publishingAtom)
  const busy = read(busySlugAtom)
  const resolvingId = read(resolvingIdAtom)
  const sortedSnapshots = [...props.snapshots].sort((a, b) => b.version - a.version)
  const storedPublishVersion = read(publishVersionBySpecAtom)[props.specId]
  const selectedPublishVersion = sortedSnapshots.some(
    (s) => String(s.version) === storedPublishVersion
  )
    ? storedPublishVersion!
    : String(sortedSnapshots[0]?.version ?? '')
  const selectedSlug = read(selectedSlugBySpecAtom)[props.specId]
  const currentReview =
    props.reviews.find((r) => r.slug === selectedSlug) ??
    props.reviews.find((r) => r.status === 'open') ??
    props.reviews[0] ??
    null
  const approving = currentReview
    ? busy?.slug === currentReview.slug && busy.kind === 'approve'
    : false

  return (
    <Stack gap="md">
      {!props.gatewayConfigured ? (
        <Callout tone="warning" title="分享网关尚未配置" icon="warning">
          <Stack gap="xs">
            <Text size="sm">发布网页评审前，请先配置内网分享网关地址与访问令牌。</Text>
            <Row gap="xs">
              <Button size="sm" variant="outline" icon="settings" onPress={props.onOpenGateway}>
                打开网关设置
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}

      <Card title="发布网页评审" description="将不可变快照发布至自托管分享网关">
        {sortedSnapshots.length === 0 ? (
          <Text muted size="sm">
            暂无快照，请先切换到「快照与差异」页签保存快照。
          </Text>
        ) : (
          <Stack gap="sm">
            <Row gap="sm" wrap align="end">
              <Select
                label="选择快照版本"
                value={selectedPublishVersion}
                options={sortedSnapshots.map((s) => ({
                  value: String(s.version),
                  label: `v${s.version} (${s.sha256.slice(0, 8)})`
                }))}
                disabled={publishing}
                onChange={(val) =>
                  update(publishVersionBySpecAtom, (prev) => ({ ...prev, [props.specId]: val }))
                }
              />
              <Button
                size="sm"
                variant="solid"
                tone="accent"
                icon="upload"
                disabled={publishing || !selectedPublishVersion}
                onPress={() =>
                  void runBusy(props, publishingAtom, true, false, async () => {
                    const review = await plugin.request(
                      'review.publish',
                      {
                        specId: props.specId,
                        version: Number(selectedPublishVersion)
                      },
                      { timeoutMs: 60_000 }
                    )
                    update(selectedSlugBySpecAtom, (prev) => ({
                      ...prev,
                      [props.specId]: review.slug
                    }))
                    return `已发布 v${review.specVersion} 网页评审链接`
                  })
                }
              >
                {publishing ? '发布中…' : '发布评审链接'}
              </Button>
            </Row>
            <BusyRow show={publishing} label="正在校验敏感信息并上传到分享网关" />
          </Stack>
        )}
      </Card>

      {props.reviews.length > 1 && currentReview ? (
        <Select
          label="评审记录"
          value={currentReview.slug}
          options={props.reviews.map((rev) => ({
            value: rev.slug,
            label: `v${rev.specVersion} · ${reviewStatusBadge(rev).label} (${rev.comments.length} 条意见)`
          }))}
          onChange={(slug) =>
            update(selectedSlugBySpecAtom, (prev) => ({ ...prev, [props.specId]: slug }))
          }
        />
      ) : null}

      {!currentReview ? (
        <EmptyState
          icon="globe"
          title="尚未发布网页评审"
          description="保存快照后发布链接，即可邀请研发、测试与业务方在浏览器中批注签核。"
        />
      ) : (
        <Stack gap="md">
          {currentReview.stale ? (
            <Callout tone="warning" title="规格已修改，需发布新版本" icon="warning">
              <Stack gap="xs">
                <Text size="sm">
                  当前 spec.md 内容与已发布快照 v{currentReview.specVersion}{' '}
                  不一致，建议递增版本号后重新快照发布。
                </Text>
                <Row gap="xs">
                  <Button
                    size="sm"
                    variant="outline"
                    icon="add"
                    disabled={props.bumpingVersion}
                    onPress={() => void props.onBumpVersion()}
                  >
                    {props.bumpingVersion ? '处理中…' : '版本号 +1'}
                  </Button>
                </Row>
              </Stack>
            </Callout>
          ) : null}

          <ReviewLinkCard
            review={currentReview}
            busy={busy}
            copyNotice={read(copyNoticeAtom)}
            props={props}
          />
          <ReviewSignoffsSection review={currentReview} />
          <ReviewCommentsSection
            comments={currentReview.comments}
            resolvingId={resolvingId}
            onResolve={(commentId, status) =>
              void runBusy(props, resolvingIdAtom, commentId, null, async () => {
                await plugin.request('review.resolveComment', {
                  slug: currentReview.slug,
                  commentId,
                  status,
                  note: getResolutionNote(commentId)
                })
                return `已更新意见状态为「${COMMENT_STATUS_META[status].label}」`
              })
            }
          />

          <ReviewApproveCard
            readyToApprove={currentReview.readyToApprove}
            blockingReasons={currentReview.blockingReasons}
            disabled={
              !currentReview.readyToApprove || busy !== null || props.specStatus === 'approved'
            }
            approved={props.specStatus === 'approved'}
            approving={approving}
            onApprove={() =>
              void runBusy(
                props,
                busySlugAtom,
                { kind: 'approve', slug: currentReview.slug },
                null,
                async () => {
                  await plugin.request('review.markApproved', {
                    specId: props.specId,
                    slug: currentReview.slug
                  })
                  return '规格已标记为「已批准」'
                }
              )
            }
          />
        </Stack>
      )}
    </Stack>
  )
}
