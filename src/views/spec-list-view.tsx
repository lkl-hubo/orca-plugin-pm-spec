import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Field,
  Heading,
  IconButton,
  Input,
  plugin,
  read,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Table,
  Text,
  type TableSort
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

const SPEC_ID_PATTERN = /^[\p{L}0-9][\p{L}0-9_-]{1,63}$/u
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i
const isValidDraftSpecId = (value: string): boolean =>
  SPEC_ID_PATTERN.test(value) && !WINDOWS_RESERVED_NAME_PATTERN.test(value)
const MAX_LIST_CAP = 500

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

const createFormOpenAtom = atom(false)
const draftSpecIdAtom = atom('')
const draftTitleAtom = atom('')
const creatingSpecAtom = atom(false)
const refreshingListAtom = atom(false)
const selectingSpecIdAtom = atom<string | null>(null)
const searchQueryAtom = atom('')
const statusFilterAtom = atom<'all' | SpecSummary['status']>('all')
const sortAtom = atom<TableSort>({ column: 'specId', direction: 'asc' })

function statusLabel(status: SpecSummary['status']): string {
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

function lintSummaryText(lint: SpecSummary['lint']): string {
  if (!lint) {
    return '未校验'
  }
  return `${lint.error} 错 / ${lint.warning} 警`
}

function reviewSummaryText(spec: SpecSummary): string {
  if (spec.openReview) {
    return `评审中 (${spec.openReview.openIssues} 待处理)`
  }
  if (spec.lastRun) {
    return `预检: ${spec.lastRun.status}`
  }
  return '-'
}

function sortSpecs(specs: readonly SpecSummary[], sort: TableSort): SpecSummary[] {
  const dir = sort.direction === 'asc' ? 1 : -1
  return [...specs].sort((a, b) => {
    switch (sort.column) {
      case 'title':
        return a.title.localeCompare(b.title) * dir
      case 'status':
        return a.status.localeCompare(b.status) * dir
      case 'version':
        return (a.version - b.version) * dir
      default:
        return a.specId.localeCompare(b.specId) * dir
    }
  })
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

export function SpecListView(props: SpecListViewProps) {
  const createOpen = read(createFormOpenAtom)
  const draftId = read(draftSpecIdAtom)
  const draftTitle = read(draftTitleAtom)
  const creating = read(creatingSpecAtom)
  const refreshing = read(refreshingListAtom)
  const openingId = read(selectingSpecIdAtom)
  const search = read(searchQueryAtom)
  const statusFilter = read(statusFilterAtom)
  const sort = read(sortAtom)

  const trimmedId = draftId.trim().normalize('NFC')
  const idFormatHint =
    trimmedId.length > 0 && !isValidDraftSpecId(trimmedId)
      ? '支持 2～64 位中文、字母、数字、- 或 _，且不能以 -、_ 开头或含空格/符号'
      : undefined

  const keyword = search.trim().toLowerCase()
  const filtered = props.specs.filter((spec) => {
    const matchesStatus = statusFilter === 'all' || spec.status === statusFilter
    const matchesText =
      keyword.length === 0 ||
      spec.specId.toLowerCase().includes(keyword) ||
      spec.title.toLowerCase().includes(keyword)
    return matchesStatus && matchesText
  })
  const ordered = sortSpecs(filtered, sort)
  const rows = ordered.map((spec) => ({
    key: spec.specId,
    cells: {
      specId: spec.specId,
      title: spec.title,
      status: statusLabel(spec.status),
      version: `v${spec.version}`,
      lint: lintSummaryText(spec.lint),
      review: reviewSummaryText(spec)
    }
  }))

  return (
    <Stack gap="md">
      <Row justify="between" align="center" wrap gap="xs">
        <Row gap="xs" align="center" wrap>
          <Heading level={2}>需求中心</Heading>
          <Badge tone="neutral">{props.workspace.name}</Badge>
          {!props.gatewayConfigured ? <Badge tone="warning">网关未配置</Badge> : null}
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

      {createOpen ? (
        <Card title="新建产品需求" description="在 specs/<ID>/spec.md 生成结构化模板并自动打开">
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
          <Row gap="xs" wrap align="center">
            <Input
              label="搜索需求"
              labelHidden
              type="search"
              placeholder="按 ID 或标题搜索…"
              value={search}
              onChange={(value) => set(searchQueryAtom, value)}
            />
            <Select
              label="状态筛选"
              labelHidden
              value={statusFilter}
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'draft', label: '草稿' },
                { value: 'in-review', label: '评审中' },
                { value: 'approved', label: '已批准' },
                { value: 'superseded', label: '已替代' }
              ]}
              onChange={(value) => {
                if (
                  value === 'all' ||
                  value === 'draft' ||
                  value === 'in-review' ||
                  value === 'approved' ||
                  value === 'superseded'
                ) {
                  set(statusFilterAtom, value)
                }
              }}
            />
          </Row>

          <Table
            label="需求列表"
            columns={[
              { key: 'specId', label: '需求 ID', minWidth: 'sm', sortable: true },
              { key: 'title', label: '标题', minWidth: 'md', sortable: true },
              { key: 'status', label: '状态', width: 'sm', sortable: true, hideBelow: 'sm' },
              {
                key: 'version',
                label: '版本',
                width: 'xs',
                align: 'end',
                sortable: true,
                hideBelow: 'sm'
              },
              { key: 'lint', label: '校验', width: 'sm' },
              { key: 'review', label: '状态/预检', width: 'md', hideBelow: 'md' }
            ]}
            rows={rows}
            sort={sort}
            selectionMode="single"
            loading={refreshing}
            emptyText="没有匹配的需求"
            maxHeight="lg"
            onSortChange={(next) => set(sortAtom, next)}
            onSelectionChange={({ keys }) => {
              const target = keys[0]
              if (target) {
                void handleOpenSpec(props, target)
              }
            }}
            onRowAction={({ key }) => void handleOpenSpec(props, key)}
          />
        </Stack>
      )}
    </Stack>
  )
}
