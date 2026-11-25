import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Heading,
  Input,
  read,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Table,
  Text,
  update
} from 'orca'
import type { CommentView, ReviewView } from '../protocol.ts'

const KIND_META: Record<
  CommentView['kind'],
  { label: string; tone: 'danger' | 'accent' | 'neutral' }
> = {
  issue: { label: '问题', tone: 'danger' },
  suggestion: { label: '建议', tone: 'accent' },
  question: { label: '疑问', tone: 'neutral' }
}

export const COMMENT_STATUS_META: Record<
  CommentView['status'],
  { label: string; tone: 'warning' | 'success' | 'neutral' }
> = {
  open: { label: '待处理', tone: 'warning' },
  resolved: { label: '已解决', tone: 'success' },
  wont_fix: { label: '不予采纳', tone: 'neutral' }
}

const STATUS_FILTER_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'open', label: '待处理' },
  { value: 'resolved', label: '已解决' },
  { value: 'wont_fix', label: '不予采纳' }
] as const

const KIND_FILTER_OPTIONS = [
  { value: 'all', label: '全部类型' },
  { value: 'issue', label: '问题' },
  { value: 'suggestion', label: '建议' },
  { value: 'question', label: '疑问' }
] as const

const SIGNOFF_COLUMNS = [
  { key: 'role', label: '角色', minWidth: 'xs' },
  { key: 'reviewer', label: '签核人', width: 'sm' },
  { key: 'decision', label: '结论', width: 'sm' },
  { key: 'time', label: '时间', width: 'md', hideBelow: 'sm' }
] as const

const commentStatusFilterAtom = atom<'all' | CommentView['status']>('all')
const commentKindFilterAtom = atom<'all' | CommentView['kind']>('all')
const resolutionNotesAtom = atom<Record<string, string>>({})

export function getResolutionNote(commentId: string): string {
  return (read(resolutionNotesAtom)[commentId] ?? '').trim()
}

function buildSignoffRows(review: ReviewView) {
  const latest = new Map<string, ReviewView['signoffs'][number]>()
  for (const s of review.signoffs) {
    const prev = latest.get(s.role)
    if (!prev || s.createdAt >= prev.createdAt) {
      latest.set(s.role, s)
    }
  }
  const roles = [
    ...review.requiredSignoffRoles,
    ...[...latest.keys()].filter((r) => !review.requiredSignoffRoles.includes(r))
  ]
  return roles.map((role) => {
    const entry = latest.get(role)
    return {
      key: `role-${role}`,
      cells: {
        role: review.requiredSignoffRoles.includes(role) ? `${role}（必需）` : role,
        reviewer: entry?.reviewerName ?? '-',
        decision: entry ? (entry.decision === 'approve' ? '通过' : '需修改') : '待签核',
        time: entry?.createdAt ?? '-'
      }
    }
  })
}

export function ReviewSignoffsSection({ review }: { review: ReviewView }) {
  return (
    <Stack gap="sm">
      <Heading level={3}>必需角色签核</Heading>
      <Table
        label="签核状态表"
        columns={SIGNOFF_COLUMNS}
        rows={buildSignoffRows(review)}
        emptyText="未配置必需签核角色"
      />
    </Stack>
  )
}

function CommentCard({
  comment,
  noteDraft,
  resolvingId,
  onNoteChange,
  onResolve
}: {
  comment: CommentView
  noteDraft: string
  resolvingId: string | null
  onNoteChange: (value: string) => void
  onResolve: (status: CommentView['status']) => void
}) {
  const isResolving = resolvingId === comment.id
  const kind = KIND_META[comment.kind]
  const status = COMMENT_STATUS_META[comment.status]
  return (
    <Card
      title={`${comment.anchor} · ${comment.authorName}（${comment.authorRole}）`}
      description={comment.createdAt}
    >
      <Stack gap="sm">
        <Row gap="xs" wrap align="center">
          <Badge tone={kind.tone}>{kind.label}</Badge>
          <Badge tone={status.tone}>{status.label}</Badge>
        </Row>
        <Text size="sm">{comment.body}</Text>
        {comment.resolutionNote ? (
          <Text muted size="xs">
            处理说明：{comment.resolutionNote}
          </Text>
        ) : null}
        {comment.status === 'open' ? (
          <Stack gap="xs">
            <Input
              label="处理说明"
              labelHidden
              placeholder="填写处理说明（标记「不予采纳」时必填）"
              value={noteDraft}
              disabled={isResolving}
              onChange={onNoteChange}
            />
            <Row gap="xs" align="center" wrap>
              <Button
                size="xs"
                variant="outline"
                tone="success"
                icon="check"
                disabled={isResolving}
                onPress={() => onResolve('resolved')}
              >
                已解决
              </Button>
              <Button
                size="xs"
                variant="outline"
                tone="neutral"
                icon="close"
                disabled={isResolving || noteDraft.trim().length === 0}
                onPress={() => onResolve('wont_fix')}
              >
                不予采纳
              </Button>
              {isResolving ? <Spinner label="正在处理意见" /> : null}
            </Row>
          </Stack>
        ) : (
          <Row gap="xs" align="center">
            <Button
              size="xs"
              variant="ghost"
              disabled={isResolving}
              onPress={() => onResolve('open')}
            >
              重新打开
            </Button>
            {isResolving ? <Spinner label="正在更新意见状态" /> : null}
          </Row>
        )}
      </Stack>
    </Card>
  )
}

export function ReviewCommentsSection({
  comments,
  resolvingId,
  onResolve
}: {
  comments: CommentView[]
  resolvingId: string | null
  onResolve: (commentId: string, status: CommentView['status']) => void
}) {
  const statusFilter = read(commentStatusFilterAtom)
  const kindFilter = read(commentKindFilterAtom)
  const notes = read(resolutionNotesAtom)
  const filtered = comments.filter(
    (c) =>
      (statusFilter === 'all' || c.status === statusFilter) &&
      (kindFilter === 'all' || c.kind === kindFilter)
  )

  return (
    <Stack gap="sm">
      <Row justify="between" align="center" wrap gap="sm">
        <Heading level={3}>评审意见 ({comments.length})</Heading>
        <Row gap="xs" wrap>
          <Select
            label="处理状态筛选"
            labelHidden
            value={statusFilter}
            options={STATUS_FILTER_OPTIONS}
            onChange={(value) => {
              if (
                value === 'all' ||
                value === 'open' ||
                value === 'resolved' ||
                value === 'wont_fix'
              ) {
                set(commentStatusFilterAtom, value)
              }
            }}
          />
          <Select
            label="意见类型筛选"
            labelHidden
            value={kindFilter}
            options={KIND_FILTER_OPTIONS}
            onChange={(value) => {
              if (
                value === 'all' ||
                value === 'issue' ||
                value === 'suggestion' ||
                value === 'question'
              ) {
                set(commentKindFilterAtom, value)
              }
            }}
          />
        </Row>
      </Row>
      {filtered.length === 0 ? (
        <EmptyState
          icon="info"
          title="暂无符合条件的评审意见"
          description="评审人在网页端提交意见后，可在此逐条标记为「已解决」或「不予采纳」。"
        />
      ) : (
        filtered.map((comment) => (
          <CommentCard
            key={comment.id}
            comment={comment}
            noteDraft={notes[comment.id] ?? ''}
            resolvingId={resolvingId}
            onNoteChange={(value) =>
              update(resolutionNotesAtom, (prev) => ({ ...prev, [comment.id]: value }))
            }
            onResolve={(status) => onResolve(comment.id, status)}
          />
        ))
      )}
    </Stack>
  )
}

export function BusyRow({ show, label }: { show: boolean; label: string }) {
  return show ? (
    <Row gap="xs" align="center">
      <Spinner label={label} />
      <Text muted size="xs">
        {label}…
      </Text>
    </Row>
  ) : null
}

export function ReviewApproveCard(props: {
  readyToApprove: boolean
  blockingReasons: string[]
  disabled: boolean
  approved: boolean
  approving: boolean
  onApprove: () => void
}) {
  return (
    <Card title="定稿批准">
      <Stack gap="sm">
        {!props.readyToApprove && props.blockingReasons.length > 0 ? (
          <Callout tone="warning" title="尚未满足批准条件" icon="warning">
            <Stack gap="xs">
              {props.blockingReasons.map((r) => (
                <Text key={`block-${r}`} size="sm">
                  • {r}
                </Text>
              ))}
            </Stack>
          </Callout>
        ) : null}
        <Row justify="between" align="center" wrap gap="sm">
          <Text muted size="xs">
            需满足：文件未改动、必需角色全部签核通过、未解决问题意见为 0。
          </Text>
          <Button
            size="sm"
            variant="solid"
            tone="success"
            icon="check"
            disabled={props.disabled}
            onPress={props.onApprove}
          >
            {props.approving ? '提交中…' : props.approved ? '已批准' : '标记为已批准'}
          </Button>
        </Row>
        <BusyRow show={props.approving} label="正在关闭评审并回写规格状态" />
      </Stack>
    </Card>
  )
}
