import {
  atom,
  Badge,
  Button,
  Heading,
  plugin,
  read,
  Row,
  set,
  Skeleton,
  Spinner,
  Stack,
  Tab,
  Tabs,
  Text
} from 'orca'
import type { LintIssueView, ReviewView, RunView, SpecSummary } from '../protocol.ts'
import { LintTab } from './lint-tab.tsx'
import { PrecheckTab } from './precheck-tab.tsx'
import { ReviewTab } from './review-tab.tsx'
import { SnapshotTab } from './snapshot-tab.tsx'

export type SpecDetailData = {
  summary: SpecSummary
  lint: { issues: LintIssueView[]; durationMs: number }
  snapshots: { version: number; sha256: string; createdAt: string }[]
  currentSha256: string
  runs: RunView[]
  reviews: ReviewView[]
}

export type DetailTabKey = 'lint' | 'precheck' | 'snapshot' | 'review'

export type SpecDetailViewProps = {
  specId: string
  loading: boolean
  detail: SpecDetailData | null
  activeTab: DetailTabKey
  gatewayConfigured: boolean
  onTabChange: (tab: DetailTabKey) => void
  onBack: () => void
  onOpenGateway: () => void
  onRefreshDetail: () => Promise<void>
  onRefreshList: () => Promise<void>
  onRunPatched: (run: RunView) => void
  onError: (error: unknown, context?: { specId?: string }) => void
  onNotify: (message: string) => void
  onClearFeedback: () => void
}

const openingFileAtom = atom(false)
const bumpingVersionAtom = atom(false)
const refreshingDetailAtom = atom(false)

function specStatusLabel(status: SpecSummary['status']): string {
  switch (status) {
    case 'draft':
      return '草稿'
    case 'in-review':
      return '评审中'
    case 'approved':
      return '已批准'
    case 'superseded':
      return '已替代'
  }
}

function specStatusTone(status: SpecSummary['status']): 'neutral' | 'accent' | 'success' {
  switch (status) {
    case 'draft':
      return 'neutral'
    case 'in-review':
      return 'accent'
    case 'approved':
      return 'success'
    case 'superseded':
      return 'neutral'
  }
}

async function openSpecFile(props: SpecDetailViewProps): Promise<void> {
  if (read(openingFileAtom)) {
    return
  }
  props.onClearFeedback()
  set(openingFileAtom, true)
  try {
    await plugin.request('spec.open', { specId: props.specId })
  } catch (error) {
    props.onError(error, { specId: props.specId })
  } finally {
    set(openingFileAtom, false)
  }
}

async function bumpSpecVersion(props: SpecDetailViewProps): Promise<void> {
  if (read(bumpingVersionAtom)) {
    return
  }
  props.onClearFeedback()
  set(bumpingVersionAtom, true)
  try {
    const res = await plugin.request('spec.bumpVersion', { specId: props.specId })
    await Promise.all([props.onRefreshDetail(), props.onRefreshList()])
    props.onNotify(`已将 ${props.specId} 版本号递增至 v${res.version}（状态重置为草稿）`)
  } catch (error) {
    props.onError(error, { specId: props.specId })
  } finally {
    set(bumpingVersionAtom, false)
  }
}

async function refreshCurrentDetail(props: SpecDetailViewProps): Promise<void> {
  if (read(refreshingDetailAtom)) {
    return
  }
  props.onClearFeedback()
  set(refreshingDetailAtom, true)
  try {
    await props.onRefreshDetail()
  } finally {
    set(refreshingDetailAtom, false)
  }
}

export function SpecDetailView(props: SpecDetailViewProps) {
  const opening = read(openingFileAtom)
  const bumping = read(bumpingVersionAtom)
  const refreshing = read(refreshingDetailAtom)
  const detail = props.detail?.summary.specId === props.specId ? props.detail : null

  if (!detail) {
    return (
      <Stack gap="md">
        <Row justify="between" align="center">
          <Button size="sm" variant="ghost" onPress={props.onBack}>
            ← 返回列表
          </Button>
          <Button size="sm" variant="ghost" icon="settings" onPress={props.onOpenGateway}>
            网关设置
          </Button>
        </Row>
        {props.loading ? (
          <Stack gap="sm">
            <Heading level={2}>{props.specId}</Heading>
            <Skeleton shape="block" lines={6} label="正在加载规格详情" />
          </Stack>
        ) : (
          <Row gap="xs" align="center">
            <Text muted>未能加载规格 {props.specId} 的详情，请重试或返回列表。</Text>
            <Button size="sm" variant="outline" onPress={() => void refreshCurrentDetail(props)}>
              重新加载
            </Button>
          </Row>
        )}
      </Stack>
    )
  }

  const { summary, lint, snapshots, currentSha256, runs, reviews } = detail
  const errorCount = lint.issues.filter((i) => i.severity === 'error').length
  const warningCount = lint.issues.filter((i) => i.severity === 'warning').length

  const refreshAll = async (): Promise<void> => {
    await Promise.all([props.onRefreshDetail(), props.onRefreshList()])
  }

  return (
    <Stack gap="md">
      <Row justify="between" align="center" wrap gap="xs">
        <Button size="sm" variant="ghost" onPress={props.onBack}>
          ← 返回列表
        </Button>
        <Row gap="xs" align="center">
          <Button
            size="sm"
            variant="ghost"
            icon="refresh"
            disabled={refreshing}
            onPress={() => void refreshCurrentDetail(props)}
          >
            {refreshing ? '刷新中…' : '刷新'}
          </Button>
          <Button size="sm" variant="ghost" icon="settings" onPress={props.onOpenGateway}>
            网关设置
          </Button>
        </Row>
      </Row>

      <Stack gap="xs">
        <Heading level={2}>
          {summary.specId} · {summary.title}
        </Heading>
        <Row gap="xs" wrap align="center">
          <Badge tone={specStatusTone(summary.status)}>{specStatusLabel(summary.status)}</Badge>
          <Badge tone="neutral">v{summary.version}</Badge>
          <Badge tone={errorCount > 0 ? 'danger' : warningCount > 0 ? 'warning' : 'success'}>
            {errorCount} 错误 · {warningCount} 警告
          </Badge>
        </Row>
        <Row gap="xs" wrap align="center">
          <Button
            size="sm"
            variant="outline"
            icon="file-text"
            disabled={opening}
            onPress={() => void openSpecFile(props)}
          >
            {opening ? '打开中…' : '打开文件'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            icon="add"
            disabled={bumping}
            onPress={() => void bumpSpecVersion(props)}
          >
            {bumping ? '递增中…' : '版本号 +1'}
          </Button>
          {opening || bumping || refreshing ? <Spinner label="正在处理规格操作" /> : null}
        </Row>
      </Stack>

      <Tabs
        label="规格详情功能"
        value={props.activeTab}
        onChange={(value) => {
          if (
            value === 'lint' ||
            value === 'precheck' ||
            value === 'snapshot' ||
            value === 'review'
          ) {
            props.onTabChange(value)
          }
        }}
      >
        <Tab value="lint" label="校验" icon="check">
          <LintTab
            specId={props.specId}
            lint={lint}
            onLintCompleted={refreshAll}
            onError={props.onError}
            onNotify={props.onNotify}
            onClearFeedback={props.onClearFeedback}
          />
        </Tab>
        <Tab value="precheck" label="AI 预检" icon="bot">
          <PrecheckTab
            specId={props.specId}
            lintErrorCount={errorCount}
            runs={runs}
            onRunsChanged={refreshAll}
            onRunPatched={props.onRunPatched}
            onError={props.onError}
            onNotify={props.onNotify}
            onClearFeedback={props.onClearFeedback}
          />
        </Tab>
        <Tab value="snapshot" label="快照与差异" icon="branch">
          <SnapshotTab
            specId={props.specId}
            currentSha256={currentSha256}
            snapshots={snapshots}
            onSnapshotsChanged={refreshAll}
            onError={props.onError}
            onNotify={props.onNotify}
            onClearFeedback={props.onClearFeedback}
          />
        </Tab>
        <Tab value="review" label="评审" icon="globe">
          <ReviewTab
            specId={props.specId}
            specStatus={summary.status}
            snapshots={snapshots}
            reviews={reviews}
            gatewayConfigured={props.gatewayConfigured}
            bumpingVersion={bumping}
            onBumpVersion={() => bumpSpecVersion(props)}
            onOpenGateway={props.onOpenGateway}
            onReviewsChanged={refreshAll}
            onError={props.onError}
            onNotify={props.onNotify}
            onClearFeedback={props.onClearFeedback}
          />
        </Tab>
      </Tabs>
    </Stack>
  )
}
