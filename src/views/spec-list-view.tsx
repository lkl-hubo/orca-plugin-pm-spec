import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  EmptyState,
  Field,
  Grid,
  Heading,
  IconButton,
  Input,
  plugin,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Text,
  type Tone
} from 'orca'
import type { SpecSummary, WorkspaceInfo } from '../protocol.ts'

export type SpecListViewProps = {
  workspace: WorkspaceInfo
  specs: SpecSummary[]
  gatewayConfigured: boolean
  onSelectSpec: (specId: string) => Promise<void>
  onSpecCreated: (specId: string) => Promise<void>
  onRefresh: () => Promise<void>
  onOpenGateway: () => void
  onError: (error: unknown, context?: { specId?: string }) => void
  onNotify: (message: string) => void
  onClearFeedback: () => void
}

type StatusFilter = 'all' | SpecSummary['status']
type SortKey = 'specId:asc' | 'specId:desc' | 'version:desc' | 'title:asc' | 'status:asc'

const SPEC_ID_PATTERN = /^[\p{L}0-9][\p{L}0-9_-]{1,63}$/u
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i
const isValidDraftSpecId = (value: string): boolean =>
  SPEC_ID_PATTERN.test(value) && !WINDOWS_RESERVED_NAME_PATTERN.test(value)
const MAX_LIST_CAP = 500
const PAGE_SIZE = 50

const STATUS_META: Record<SpecSummary['status'], { label: string; tone: Tone }> = {
  draft: { label: '草稿', tone: 'neutral' },
  'in-review': { label: '评审中', tone: 'accent' },
  approved: { label: '已批准', tone: 'success' },
  superseded: { label: '已替代', tone: 'warning' }
}

const RUN_STATUS_META: Record<string, { label: string; tone: Tone }> = {
  launching: { label: '预检启动中', tone: 'accent' },
  running: { label: '预检进行中', tone: 'accent' },
  collecting: { label: '预检核验中', tone: 'accent' },
  succeeded: { label: '预检通过', tone: 'success' },
  tainted: { label: '预检有改动', tone: 'danger' },
  failed: { label: '预检失败', tone: 'danger' },
  timed_out: { label: '预检超时', tone: 'warning' },
  cancelled: { label: '预检已取消', tone: 'neutral' }
}

const SORT_OPTIONS: readonly { value: SortKey; label: string }[] = [
  { value: 'specId:asc', label: '按需求 ID 升序' },
  { value: 'specId:desc', label: '按需求 ID 降序' },
  { value: 'version:desc', label: '按版本号从高到低' },
  { value: 'title:asc', label: '按标题 A-Z' },
  { value: 'status:asc', label: '按状态分组' }
]

const STATUS_FILTERS: readonly { value: StatusFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'draft', label: '草稿' },
  { value: 'in-review', label: '评审中' },
  { value: 'approved', label: '已批准' },
  { value: 'superseded', label: '已替代' }
]

const createFormOpenAtom = atom(false)
const draftSpecIdAtom = atom('')
const draftTitleAtom = atom('')
const creatingSpecAtom = atom(false)
const refreshingListAtom = atom(false)
const selectingSpecIdAtom = atom<string | null>(null)
const openingFileSpecIdAtom = atom<string | null>(null)
const searchQueryAtom = atom('')
const statusFilterAtom = atom<StatusFilter>('all')
const sortKeyAtom = atom<SortKey>('specId:asc')
const visibleLimitAtom = atom(PAGE_SIZE)

function suggestNextSpecId(specs: readonly SpecSummary[]): string {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const existing = new Set(specs.map((spec) => spec.specId.toLowerCase()))
  for (let seq = 1; seq <= specs.length + 100; seq += 1) {
    const candidate = `REQ-${stamp}-${String(seq).padStart(2, '0')}`
    if (!existing.has(candidate.toLowerCase())) {
      return candidate
    }
  }
  return `REQ-${stamp}-${specs.length + 1}`
}

function openCreateForm(specs: readonly SpecSummary[]): void {
  set(createFormOpenAtom, true)
  if (read(draftSpecIdAtom).trim().length === 0) {
    set(draftSpecIdAtom, suggestNextSpecId(specs))
  }
}

function lintBadgeInfo(lint: SpecSummary['lint']): { label: string; tone: Tone } {
  if (!lint) {
    return { label: '未校验', tone: 'neutral' }
  }
  if (lint.error > 0) {
    return { label: `${lint.error} 错误 · ${lint.warning} 警告`, tone: 'danger' }
  }
  if (lint.warning > 0) {
    return { label: `0 错误 · ${lint.warning} 警告`, tone: 'warning' }
  }
  return { label: '校验通过', tone: 'success' }
}

function sortSpecs(specs: readonly SpecSummary[], sortKey: SortKey): SpecSummary[] {
  return [...specs].sort((a, b) => {
    switch (sortKey) {
      case 'specId:desc':
        return b.specId.localeCompare(a.specId)
      case 'version:desc':
        return b.version - a.version || a.specId.localeCompare(b.specId)
      case 'title:asc':
        return a.title.localeCompare(b.title) || a.specId.localeCompare(b.specId)
      case 'status:asc':
        return a.status.localeCompare(b.status) || a.specId.localeCompare(b.specId)
      default:
        return a.specId.localeCompare(b.specId)
    }
  })
}

function parseTimestampMs(iso: string | null): number | null {
  if (!iso) {
    return null
  }
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

async function handleCreateSpec(props: SpecListViewProps): Promise<void> {
  if (read(creatingSpecAtom)) {
    return
  }
  const specId = read(draftSpecIdAtom).trim().normalize('NFC')
  const title = read(draftTitleAtom).trim()
  if (!specId || !title || !isValidDraftSpecId(specId)) {
    return
  }
  props.onClearFeedback()
  set(creatingSpecAtom, true)
  try {
    const created = await plugin.request('spec.create', { specId, title })
    set(draftSpecIdAtom, '')
    set(draftTitleAtom, '')
    set(createFormOpenAtom, false)
    await props.onSpecCreated(created.specId)
    props.onNotify(`已新建需求 ${created.specId}`)
  } catch (error) {
    props.onError(error, { specId })
  } finally {
    set(creatingSpecAtom, false)
  }
}

async function handleRefreshList(props: SpecListViewProps): Promise<void> {
  if (read(refreshingListAtom)) {
    return
  }
  props.onClearFeedback()
  set(refreshingListAtom, true)
  try {
    await props.onRefresh()
  } finally {
    set(refreshingListAtom, false)
  }
}

async function handleOpenSpec(props: SpecListViewProps, specId: string): Promise<void> {
  if (read(selectingSpecIdAtom) !== null) {
    return
  }
  set(selectingSpecIdAtom, specId)
  try {
    await props.onSelectSpec(specId)
  } finally {
    set(selectingSpecIdAtom, null)
  }
}

async function handleOpenFile(props: SpecListViewProps, specId: string): Promise<void> {
  if (read(openingFileSpecIdAtom) !== null) {
    return
  }
  props.onClearFeedback()
  set(openingFileSpecIdAtom, specId)
  try {
    await plugin.request('spec.open', { specId })
  } catch (error) {
    props.onError(error, { specId })
  } finally {
    set(openingFileSpecIdAtom, null)
  }
}

function MetricTile({
  label,
  value,
  tone,
  hint
}: {
  label: string
  value: number
  tone: Tone
  hint: string
}) {
  return (
    <Box border radius="md" padding="sm" background="card">
      <Stack gap="xs">
        <Row justify="between" align="center" gap="xs">
          <Text muted size="xs">
            {label}
          </Text>
          <Badge tone={tone}>{hint}</Badge>
        </Row>
        <Heading level={2}>{value}</Heading>
      </Stack>
    </Box>
  )
}

function SpecItemCard({
  spec,
  openingId,
  openingFileId,
  onOpenSpec,
  onOpenFile
}: {
  spec: SpecSummary
  openingId: string | null
  openingFileId: string | null
  onOpenSpec: () => void
  onOpenFile: () => void
}) {
  const statusMeta = STATUS_META[spec.status]
  const lintMeta = lintBadgeInfo(spec.lint)
  const runMeta = spec.lastRun
    ? (RUN_STATUS_META[spec.lastRun.status] ?? {
        label: `预检 ${spec.lastRun.status}`,
        tone: 'neutral' as Tone
      })
    : null
  const runFinishedMs = parseTimestampMs(spec.lastRun?.finishedAt ?? null)
  const isOpeningThis = openingId === spec.specId

  return (
    <Box
      border={isOpeningThis ? 'accent' : true}
      radius="md"
      padding="md"
      background="card"
    >
      <Stack gap="sm">
        <Row justify="between" align="center" wrap gap="sm">
          <Row gap="xs" align="center" wrap>
            <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
            <Code>{spec.specId}</Code>
            <Text size="md" weight="semibold">
              {spec.title}
            </Text>
            <Badge tone="neutral">v{spec.version}</Badge>
          </Row>
          <Row gap="xs" align="center">
            <Button
              size="xs"
              variant="ghost"
              icon="file-text"
              disabled={openingFileId !== null || openingId !== null}
              onPress={onOpenFile}
            >
              {openingFileId === spec.specId ? '打开中…' : '打开文档'}
            </Button>
            <Button
              size="xs"
              variant="solid"
              tone="accent"
              icon="next"
              disabled={openingId !== null}
              onPress={onOpenSpec}
            >
              {isOpeningThis ? '进入中…' : '查看详情'}
            </Button>
          </Row>
        </Row>

        <Row justify="between" align="center" wrap gap="sm">
          <Row gap="xs" align="center" wrap>
            <Badge tone={lintMeta.tone}>{lintMeta.label}</Badge>
            {runMeta ? <Badge tone={runMeta.tone}>{runMeta.label}</Badge> : null}
            {runFinishedMs !== null ? (
              <Text muted size="xs">
                预检于 <RelativeTime at={runFinishedMs} format="short" muted />
              </Text>
            ) : null}
            {spec.openReview ? (
              <Badge tone={spec.openReview.openIssues > 0 ? 'warning' : 'accent'}>
                {spec.openReview.openIssues > 0
                  ? `网页评审 · ${spec.openReview.openIssues} 待处理`
                  : '网页评审中'}
              </Badge>
            ) : null}
          </Row>
          <Text muted size="xs">
            {spec.path}
          </Text>
        </Row>
      </Stack>
    </Box>
  )
}

export function SpecListView(props: SpecListViewProps) {
  const createOpen = read(createFormOpenAtom)
  const draftId = read(draftSpecIdAtom)
  const draftTitle = read(draftTitleAtom)
  const creating = read(creatingSpecAtom)
  const refreshing = read(refreshingListAtom)
  const openingId = read(selectingSpecIdAtom)
  const openingFileId = read(openingFileSpecIdAtom)
  const search = read(searchQueryAtom)
  const statusFilter = read(statusFilterAtom)
  const sortKey = read(sortKeyAtom)
  const visibleLimit = read(visibleLimitAtom)

  const trimmedId = draftId.trim().normalize('NFC')
  const idFormatHint =
    trimmedId.length > 0 && !isValidDraftSpecId(trimmedId)
      ? '支持 2～64 位中文、字母、数字、- 或 _，且不能以 -、_ 开头或含空格/符号'
      : undefined

  const statusCounts: Record<StatusFilter, number> = {
    all: props.specs.length,
    draft: 0,
    'in-review': 0,
    approved: 0,
    superseded: 0
  }
  let lintErrorCount = 0
  for (const spec of props.specs) {
    statusCounts[spec.status] += 1
    if ((spec.lint?.error ?? 0) > 0) {
      lintErrorCount += 1
    }
  }

  const keyword = search.trim().toLowerCase()
  const filtered = props.specs.filter((spec) => {
    const matchesStatus = statusFilter === 'all' || spec.status === statusFilter
    const matchesText =
      keyword.length === 0 ||
      spec.specId.toLowerCase().includes(keyword) ||
      spec.title.toLowerCase().includes(keyword) ||
      spec.path.toLowerCase().includes(keyword)
    return matchesStatus && matchesText
  })
  const ordered = sortSpecs(filtered, sortKey)
  const visible = ordered.slice(0, visibleLimit)
  const remainingCount = Math.max(0, ordered.length - visible.length)
  const hasActiveFilter = statusFilter !== 'all' || keyword.length > 0

  return (
    <Stack gap="md">
      <Row justify="between" align="center" wrap gap="sm">
        <Row gap="xs" align="center" wrap>
          <Heading level={2}>需求中心</Heading>
          <Badge tone="neutral">{props.workspace.name}</Badge>
          <Badge tone={props.gatewayConfigured ? 'success' : 'warning'}>
            {props.gatewayConfigured ? '网关已就绪' : '网关未配置'}
          </Badge>
        </Row>
        <Row gap="xs" align="center">
          <IconButton
            icon="refresh"
            label="刷新列表"
            tooltip="刷新需求列表"
            variant="ghost"
            size="sm"
            disabled={refreshing}
            onPress={() => void handleRefreshList(props)}
          />
          <Button size="sm" variant="outline" icon="settings" onPress={props.onOpenGateway}>
            网关设置
          </Button>
          <Button
            size="sm"
            variant="solid"
            tone="accent"
            icon="add"
            disabled={creating}
            onPress={() =>
              createOpen ? set(createFormOpenAtom, false) : openCreateForm(props.specs)
            }
          >
            {createOpen ? '收起新建' : '新建需求'}
          </Button>
        </Row>
      </Row>

      {refreshing || openingId !== null ? (
        <Row gap="xs" align="center">
          <Spinner label="正在加载需求数据" />
          <Text muted size="xs">
            {openingId !== null ? `正在打开 ${openingId}…` : '正在刷新需求列表…'}
          </Text>
        </Row>
      ) : null}

      {props.specs.length > 0 ? (
        <Grid minItemWidth="xs" gap="sm">
          <MetricTile
            label="全部需求"
            value={statusCounts.all}
            tone="neutral"
            hint={`草稿 ${statusCounts.draft}`}
          />
          <MetricTile
            label="评审中"
            value={statusCounts['in-review']}
            tone={statusCounts['in-review'] > 0 ? 'accent' : 'neutral'}
            hint="进行中"
          />
          <MetricTile
            label="已批准"
            value={statusCounts.approved}
            tone={statusCounts.approved > 0 ? 'success' : 'neutral'}
            hint="已定稿"
          />
          <MetricTile
            label="校验待修复"
            value={lintErrorCount}
            tone={lintErrorCount > 0 ? 'danger' : 'success'}
            hint={lintErrorCount > 0 ? '需处理错误' : '全部健康'}
          />
        </Grid>
      ) : null}

      {createOpen ? (
        <Card title="新建产品需求" description="在当前工作区 specs/<ID>/spec.md 生成结构化模板并自动打开">
          <Stack gap="sm">
            <Field
              label="需求 ID"
              description="已自动预填编号，也可改为中文或英文编码（如 商户自助退款、refund-v2）"
              error={idFormatHint}
              required
            >
              <Input
                label="需求 ID"
                labelHidden
                placeholder="商户自助退款 或 REQ-20261122-01"
                value={draftId}
                disabled={creating}
                onChange={(value) => set(draftSpecIdAtom, value)}
              />
            </Field>
            <Field label="需求标题" description="2～80 个字符" required>
              <Input
                label="需求标题"
                labelHidden
                placeholder="例如：商户自助退款"
                value={draftTitle}
                disabled={creating}
                onChange={(value) => set(draftTitleAtom, value)}
                onSubmit={() => void handleCreateSpec(props)}
              />
            </Field>
            <Row justify="end" gap="xs" align="center">
              {creating ? <Spinner label="正在创建需求" /> : null}
              <Button
                size="sm"
                variant="ghost"
                disabled={creating}
                onPress={() => set(createFormOpenAtom, false)}
              >
                取消
              </Button>
              <Button
                size="sm"
                variant="solid"
                tone="accent"
                icon="add"
                disabled={
                  creating ||
                  trimmedId.length === 0 ||
                  Boolean(idFormatHint) ||
                  draftTitle.trim().length === 0
                }
                onPress={() => void handleCreateSpec(props)}
              >
                {creating ? '创建中…' : '创建'}
              </Button>
            </Row>
          </Stack>
        </Card>
      ) : null}

      {props.specs.length >= MAX_LIST_CAP ? (
        <Callout tone="warning" title="列表数量已达上限 (500)" icon="warning">
          <Text size="sm">
            工作区需求达到或超过 500 份，当前仅展示按修改时间最新的 500
            份需求；请通过搜索或状态筛选定位。
          </Text>
        </Callout>
      ) : null}

      {props.specs.length === 0 ? (
        <EmptyState
          icon="file-text"
          title="当前工作区暂无需求"
          description="点击「新建需求」创建第一份结构化产品需求文档。"
        >
          <Button
            size="sm"
            variant="solid"
            tone="accent"
            icon="add"
            onPress={() => openCreateForm(props.specs)}
          >
            新建需求
          </Button>
        </EmptyState>
      ) : (
        <Stack gap="sm">
          <Box border radius="md" padding="sm" background="muted">
            <Stack gap="sm">
              <Row justify="between" align="center" wrap gap="xs">
                <Row gap="xs" wrap align="center">
                  {STATUS_FILTERS.map((item) => {
                    const active = statusFilter === item.value
                    return (
                      <Button
                        key={item.value}
                        size="xs"
                        variant={active ? 'solid' : 'ghost'}
                        tone={active ? 'accent' : 'neutral'}
                        onPress={() => {
                          set(statusFilterAtom, item.value)
                          set(visibleLimitAtom, PAGE_SIZE)
                        }}
                      >
                        {`${item.label} (${statusCounts[item.value]})`}
                      </Button>
                    )
                  })}
                </Row>
                <Select
                  label="排序方式"
                  labelHidden
                  value={sortKey}
                  options={SORT_OPTIONS}
                  onChange={(value) => {
                    if (
                      value === 'specId:asc' ||
                      value === 'specId:desc' ||
                      value === 'version:desc' ||
                      value === 'title:asc' ||
                      value === 'status:asc'
                    ) {
                      set(sortKeyAtom, value)
                    }
                  }}
                />
              </Row>
              <Row justify="between" align="center" wrap gap="xs">
                <Input
                  label="搜索需求"
                  labelHidden
                  type="search"
                  placeholder="按需求 ID、标题或路径搜索…"
                  value={search}
                  onChange={(value) => {
                    set(searchQueryAtom, value)
                    set(visibleLimitAtom, PAGE_SIZE)
                  }}
                />
                <Row gap="xs" align="center">
                  <Text muted size="xs">
                    共 {ordered.length} 份{hasActiveFilter ? '匹配' : ''}需求
                  </Text>
                  {hasActiveFilter ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onPress={() => {
                        set(statusFilterAtom, 'all')
                        set(searchQueryAtom, '')
                        set(visibleLimitAtom, PAGE_SIZE)
                      }}
                    >
                      重置筛选
                    </Button>
                  ) : null}
                </Row>
              </Row>
            </Stack>
          </Box>

          {visible.length === 0 ? (
            <EmptyState
              icon="search"
              title="没有匹配的需求"
              description="请尝试调整搜索关键词或切换状态筛选条件。"
            >
              <Button
                size="sm"
                variant="outline"
                onPress={() => {
                  set(statusFilterAtom, 'all')
                  set(searchQueryAtom, '')
                  set(visibleLimitAtom, PAGE_SIZE)
                }}
              >
                查看全部需求
              </Button>
            </EmptyState>
          ) : (
            <Stack gap="sm">
              {visible.map((spec) => (
                <SpecItemCard
                  key={spec.specId}
                  spec={spec}
                  openingId={openingId}
                  openingFileId={openingFileId}
                  onOpenSpec={() => void handleOpenSpec(props, spec.specId)}
                  onOpenFile={() => void handleOpenFile(props, spec.specId)}
                />
              ))}
              {remainingCount > 0 ? (
                <Row justify="center">
                  <Button
                    size="sm"
                    variant="outline"
                    onPress={() => set(visibleLimitAtom, visibleLimit + PAGE_SIZE)}
                  >
                    {`加载更多（还有 ${remainingCount} 份）`}
                  </Button>
                </Row>
              ) : null}
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  )
}
