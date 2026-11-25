import {
  atom,
  Heading,
  plugin,
  read,
  set,
  settings,
  Skeleton,
  Stack,
  update,
  type PanelContext
} from 'orca'
import {
  GlobalFeedback,
  parseErrorInfo,
  UnsupportedWorkspaceView,
  type HelpKind,
  type PanelErrorInfo
} from './panel-error-feedback.tsx'
import type { RunView, SpecSummary, UnsupportedReason, WorkspaceInfo } from './protocol.ts'
import { GatewaySetupView, type GatewayStatusInfo } from './views/gateway-setup-view.tsx'
import {
  SpecDetailView,
  type DetailTabKey,
  type SpecDetailData
} from './views/spec-detail-view.tsx'
import { SpecListView } from './views/spec-list-view.tsx'

type RouteKind = 'list' | 'detail' | 'gateway'
type SpecListData = {
  workspace: WorkspaceInfo | null
  unsupportedReason: UnsupportedReason | null
  configErrors: string[]
  specs: SpecSummary[]
}

const routeAtom = atom<RouteKind>('pmspec.route', 'list', { persist: 'plugin' })
const selectedSpecIdAtom = atom<string | null>('pmspec.selectedSpecId', null, {
  persist: 'workspace'
})
const activeTabAtom = atom<DetailTabKey>('pmspec.activeTab', 'lint', { persist: 'plugin' })
const listStateAtom = atom<{ loading: boolean; data: SpecListData | null }>({
  loading: true,
  data: null
})
const detailStateAtom = atom<{ loading: boolean; data: SpecDetailData | null }>({
  loading: false,
  data: null
})
const gatewayStatusAtom = atom<GatewayStatusInfo | null>(null)
const gatewayUrlAtom = atom('')
const reviewAgentAtom = atom('pi')
const bannerErrorAtom = atom<PanelErrorInfo | null>(null)
const bannerNoticeAtom = atom<string | null>(null)
const pendingInitAtom = atom(false)
const pendingErrorActionAtom = atom(false)
const helpKindAtom = atom<HelpKind>('none')

function clearFeedback(): void {
  set(bannerErrorAtom, null)
  set(bannerNoticeAtom, null)
  set(helpKindAtom, 'none')
}

function reportError(error: unknown, context?: { specId?: string }): void {
  set(bannerNoticeAtom, null)
  set(bannerErrorAtom, parseErrorInfo(error, context?.specId ?? read(selectedSpecIdAtom)))
}

async function loadGatewayInfo(signal?: AbortSignal): Promise<void> {
  try {
    const [allSettings, status] = await Promise.all([
      settings.get(),
      plugin.request('gateway.status', {})
    ])
    if (signal?.aborted) {
      return
    }
    set(gatewayUrlAtom, typeof allSettings.gatewayUrl === 'string' ? allSettings.gatewayUrl : '')
    set(
      reviewAgentAtom,
      typeof allSettings.reviewAgent === 'string' ? allSettings.reviewAgent : 'pi'
    )
    set(gatewayStatusAtom, status)
  } catch {
    if (!signal?.aborted) {
      set(gatewayStatusAtom, null)
    }
  }
}

async function loadSpecList(signal?: AbortSignal): Promise<SpecListData | null> {
  try {
    const data = await plugin.request('spec.list', {})
    if (signal?.aborted) {
      return null
    }
    set(listStateAtom, { loading: false, data })
    return data
  } catch (error) {
    if (!signal?.aborted) {
      update(listStateAtom, (prev) => ({ loading: false, data: prev.data }))
      reportError(error)
    }
    return null
  }
}

async function loadSpecDetail(specId: string, signal?: AbortSignal): Promise<void> {
  update(detailStateAtom, (prev) => ({ loading: true, data: prev.data }))
  try {
    const detail = await plugin.request('spec.detail', { specId })
    if (!signal?.aborted) {
      set(detailStateAtom, { loading: false, data: detail })
    }
  } catch (error) {
    if (!signal?.aborted) {
      update(detailStateAtom, (prev) => ({ loading: false, data: prev.data }))
      reportError(error, { specId })
    }
  }
}

async function openSpecDetail(specId: string, tab?: DetailTabKey): Promise<void> {
  clearFeedback()
  set(selectedSpecIdAtom, specId)
  if (tab) {
    set(activeTabAtom, tab)
  }
  set(routeAtom, 'detail')
  await plugin.request('spec.select', { specId }).catch(() => undefined)
  await loadSpecDetail(specId)
}

function patchRunInDetail(run: RunView): void {
  update(detailStateAtom, (prev) => {
    if (!prev.data || prev.data.summary.specId !== run.specId) {
      return prev
    }
    const idx = prev.data.runs.findIndex((item) => item.runId === run.runId)
    const runs =
      idx === -1
        ? [run, ...prev.data.runs]
        : prev.data.runs.map((item, i) => (i === idx ? run : item))
    return { ...prev, data: { ...prev.data, runs } }
  })
}

async function runBusyTask(fn: () => Promise<void>): Promise<void> {
  if (read(pendingErrorActionAtom)) {
    return
  }
  set(pendingErrorActionAtom, true)
  try {
    await fn()
  } catch (error) {
    reportError(error)
  } finally {
    set(pendingErrorActionAtom, false)
  }
}

function toggleHelp(kind: Exclude<HelpKind, 'none'>): void {
  set(helpKindAtom, read(helpKindAtom) === kind ? 'none' : kind)
}

function startWorkspaceInit(): void {
  if (read(pendingInitAtom)) {
    return
  }
  clearFeedback()
  set(pendingInitAtom, true)
  void plugin
    .request('workspace.init', {})
    .then(() => loadSpecList())
    .then(() => set(bannerNoticeAtom, '已初始化规格工作区'))
    .catch((error) => reportError(error))
    .finally(() => set(pendingInitAtom, false))
}

function FeedbackHeader({ workspacePath }: { workspacePath: string | null }) {
  return (
    <GlobalFeedback
      workspacePath={workspacePath}
      selectedSpecId={read(selectedSpecIdAtom)}
      errorInfo={read(bannerErrorAtom)}
      notice={read(bannerNoticeAtom)}
      helpKind={read(helpKindAtom)}
      pendingAction={read(pendingErrorActionAtom)}
      reviewAgent={read(reviewAgentAtom)}
      onClearFeedback={clearFeedback}
      onDismissNotice={() => set(bannerNoticeAtom, null)}
      onToggleHelp={toggleHelp}
      onNavigateDetail={(specId, tab) => void runBusyTask(() => openSpecDetail(specId, tab))}
      onNavigateGateway={() => {
        clearFeedback()
        set(routeAtom, 'gateway')
        void loadGatewayInfo()
      }}
      onOpenSpecFile={(specId) =>
        void runBusyTask(() => plugin.request('spec.open', { specId }).then(() => undefined))
      }
      onRetryPrecheck={(specId) =>
        void runBusyTask(async () => {
          patchRunInDetail(await plugin.request('review.start', { specId }))
          clearFeedback()
          await openSpecDetail(specId, 'precheck')
        })
      }
      onBumpVersion={(specId, tip) =>
        void runBusyTask(async () => {
          const res = await plugin.request('spec.bumpVersion', { specId })
          clearFeedback()
          await Promise.all([loadSpecDetail(specId), loadSpecList()])
          set(bannerNoticeAtom, `已递增版本号至 v${res.version}，${tip}`)
        })
      }
      onRefreshList={() => void runBusyTask(() => loadSpecList().then(() => undefined))}
      onTestGateway={() =>
        void runBusyTask(async () => {
          const res = await plugin.request('gateway.test', {})
          if (res.ok) {
            clearFeedback()
            set(bannerNoticeAtom, `网关连接正常（${res.latencyMs} ms）`)
          } else {
            set(routeAtom, 'gateway')
          }
        })
      }
      onSwitchAgent={(agent) => {
        set(reviewAgentAtom, agent)
        void settings.set('reviewAgent', agent).then(() => {
          set(bannerNoticeAtom, `已将 AI 预检智能体切换为 ${agent}`)
          set(helpKindAtom, 'none')
        })
      }}
    />
  )
}

export function setup(ctx: PanelContext): void {
  const reloadDetail = (specId?: string) => {
    const active = read(selectedSpecIdAtom)
    if (read(routeAtom) === 'detail' && active && (!specId || active === specId)) {
      void loadSpecDetail(active, ctx.signal)
    }
  }
  ctx.subscriptions.push(
    plugin.on('pmspec.lint.updated', ({ specId }) => {
      void loadSpecList(ctx.signal)
      reloadDetail(specId)
    }),
    plugin.on('pmspec.run.updated', (run) => {
      patchRunInDetail(run)
      void loadSpecList(ctx.signal)
      if (run.status !== 'launching' && run.status !== 'running' && run.status !== 'collecting') {
        reloadDetail(run.specId)
      }
    }),
    plugin.on('pmspec.review.updated', ({ slug }) => {
      void loadSpecList(ctx.signal)
      const detail = read(detailStateAtom).data
      if (detail?.reviews.some((rev) => rev.slug === slug)) {
        reloadDetail(detail.summary.specId)
      }
    }),
    plugin.on('pmspec.workspace.changed', () => {
      clearFeedback()
      void loadSpecList(ctx.signal).then((list) => {
        if (ctx.signal.aborted) {
          return
        }
        const selected = read(selectedSpecIdAtom)
        const exists = Boolean(
          list &&
          !list.unsupportedReason &&
          selected &&
          list.specs.some((s) => s.specId === selected)
        )
        if (!exists && read(routeAtom) === 'detail') {
          set(routeAtom, 'list')
          set(detailStateAtom, { loading: false, data: null })
        } else if (exists && selected && read(routeAtom) === 'detail') {
          void loadSpecDetail(selected, ctx.signal)
        }
      })
    }),
    settings.onDidChange(() => void loadGatewayInfo(ctx.signal))
  )
  void loadGatewayInfo(ctx.signal)
  void loadSpecList(ctx.signal)
  const initialSpecId = read(selectedSpecIdAtom)
  if (initialSpecId) {
    void loadSpecDetail(initialSpecId, ctx.signal)
  }
}

export default function Panel() {
  const route = read(routeAtom)
  const selectedSpecId = read(selectedSpecIdAtom)
  const listState = read(listStateAtom)
  const detailState = read(detailStateAtom)
  const gatewayStatus = read(gatewayStatusAtom)
  const workspacePath = listState.data?.workspace?.path ?? null
  const shared = {
    onOpenGateway: () => {
      clearFeedback()
      set(routeAtom, 'gateway')
      void loadGatewayInfo()
    },
    onError: reportError,
    onNotify: (message: string) => set(bannerNoticeAtom, message),
    onClearFeedback: clearFeedback
  }

  if (route === 'gateway') {
    return (
      <Stack gap="md">
        <FeedbackHeader workspacePath={workspacePath} />
        <GatewaySetupView
          gatewayUrl={read(gatewayUrlAtom)}
          gatewayStatus={gatewayStatus}
          onBack={() => {
            clearFeedback()
            set(routeAtom, selectedSpecId ? 'detail' : 'list')
          }}
          onGatewayChanged={() => loadGatewayInfo()}
          {...shared}
        />
      </Stack>
    )
  }
  if (listState.loading && !listState.data) {
    return (
      <Stack gap="md">
        <Heading level={2}>需求中心</Heading>
        <Skeleton shape="block" lines={4} label="正在加载规格工作区" />
      </Stack>
    )
  }
  const listData = listState.data
  if (!listData || listData.unsupportedReason !== null || !listData.workspace) {
    return (
      <Stack gap="md">
        <FeedbackHeader workspacePath={workspacePath} />
        <UnsupportedWorkspaceView
          workspace={listData?.workspace ?? null}
          unsupportedReason={listData?.unsupportedReason ?? 'no-workspace'}
          configErrors={listData?.configErrors ?? []}
          pendingInit={read(pendingInitAtom)}
          onInitWorkspace={startWorkspaceInit}
          onOpenGateway={shared.onOpenGateway}
          onOpenConfigHelp={() => toggleHelp('config')}
          onRefreshList={() => void loadSpecList()}
        />
      </Stack>
    )
  }
  const gatewayConfigured = gatewayStatus?.configured ?? false
  if (route === 'detail' && selectedSpecId) {
    return (
      <Stack gap="md">
        <FeedbackHeader workspacePath={workspacePath} />
        <SpecDetailView
          specId={selectedSpecId}
          loading={detailState.loading}
          detail={detailState.data}
          activeTab={read(activeTabAtom)}
          gatewayConfigured={gatewayConfigured}
          onTabChange={(tab) => set(activeTabAtom, tab)}
          onBack={() => {
            clearFeedback()
            set(routeAtom, 'list')
          }}
          onRefreshDetail={() => loadSpecDetail(selectedSpecId)}
          onRefreshList={() => loadSpecList().then(() => undefined)}
          onRunPatched={patchRunInDetail}
          {...shared}
        />
      </Stack>
    )
  }
  return (
    <Stack gap="md">
      <FeedbackHeader workspacePath={workspacePath} />
      <SpecListView
        workspace={listData.workspace}
        specs={listData.specs}
        gatewayConfigured={gatewayConfigured}
        onSelectSpec={(specId) => openSpecDetail(specId)}
        onSpecCreated={async (specId) => {
          await loadSpecList()
          await openSpecDetail(specId, 'lint')
        }}
        onRefresh={() => loadSpecList().then(() => undefined)}
        {...shared}
      />
    </Stack>
  )
}
