import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  EmptyState,
  Heading,
  plugin,
  Progress,
  read,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Text,
  update,
  type Atom
} from 'orca'
import type { RunView } from '../protocol.ts'

export type PrecheckTabProps = {
  specId: string
  lintErrorCount: number
  runs: RunView[]
  onRunsChanged: () => Promise<void>
  onRunPatched: (run: RunView) => void
  onError: (error: unknown, context?: { specId?: string }) => void
  onNotify: (message: string) => void
  onClearFeedback: () => void
}

type Finding = RunView['findings'][number]

const startingRunAtom = atom(false)
const cancellingRunAtom = atom(false)
const decidingFindingIdAtom = atom<string | null>(null)
const selectedRunBySpecAtom = atom<Record<string, string>>({})
const ACTIVE_STATUSES = new Set<RunView['status']>(['launching', 'running', 'collecting'])
const SEVERITY_ORDER: readonly Finding['severity'][] = ['blocker', 'major', 'minor']

const RUN_STATUS_META: Record<
  RunView['status'],
  { label: string; progress: number; tone: 'success' | 'danger' | 'warning' | 'accent' }
> = {
  launching: { label: '正在启动智能体', progress: 20, tone: 'accent' },
  running: { label: '智能体分析中', progress: 60, tone: 'accent' },
  collecting: { label: '正在核验证据并收集结果', progress: 85, tone: 'accent' },
  succeeded: { label: '已完成', progress: 100, tone: 'success' },
  tainted: { label: '完成（代码仓存在改动）', progress: 100, tone: 'danger' },
  failed: { label: '失败', progress: 100, tone: 'danger' },
  timed_out: { label: '已超时', progress: 100, tone: 'warning' },
  cancelled: { label: '已取消', progress: 100, tone: 'warning' }
}

const SEVERITY_META: Record<
  Finding['severity'],
  { label: string; tone: 'danger' | 'warning' | 'neutral' }
> = {
  blocker: { label: '严重阻断', tone: 'danger' },
  major: { label: '重要问题', tone: 'warning' },
  minor: { label: '轻微建议', tone: 'neutral' }
}

const CONFIDENCE_META: Record<
  Finding['confidence'],
  { label: string; tone: 'success' | 'warning' | 'neutral' }
> = {
  verified: { label: '已查证', tone: 'success' },
  inferred: { label: '推断', tone: 'warning' },
  assumption: { label: '假设', tone: 'neutral' }
}

const DOWNGRADE_REASONS: Record<string, string> = {
  'no-evidence': '未提供支撑证据，已从「已查证」降级为「推断」',
  'unknown-repo': '引用的代码仓未在 pmspec.json 中声明，证据已作废并降级',
  'path-escape': '证据路径超出关联代码仓根目录，证据已作废并降级',
  'not-found': '证据文件不存在，证据已作废并降级',
  'line-out-of-range': '证据行号超出文件范围，证据已作废并降级',
  'quote-mismatch': '原文摘录与文件实际内容不匹配，证据已作废并降级'
}

function isUnguardedRun(run: RunView): boolean {
  if ((run.agent !== 'pi' && run.agent !== 'claude') || run.error?.code === 'W_UNGUARDED') {
    return true
  }
  return 'guard' in run && Object.getOwnPropertyDescriptor(run, 'guard')?.value === 'unguarded'
}

async function runPrecheckAction(
  props: PrecheckTabProps,
  pendingAtom: Atom<boolean>,
  fn: () => Promise<RunView>,
  onSuccess: (run: RunView) => string
): Promise<void> {
  if (read(pendingAtom)) {
    return
  }
  props.onClearFeedback()
  set(pendingAtom, true)
  try {
    const run = await fn()
    props.onRunPatched(run)
    await props.onRunsChanged()
    props.onNotify(onSuccess(run))
  } catch (error) {
    props.onError(error, { specId: props.specId })
  } finally {
    set(pendingAtom, false)
  }
}

async function decideFinding(
  props: PrecheckTabProps,
  runId: string,
  findingId: string,
  decision: 'accepted' | 'rejected' | null
): Promise<void> {
  if (read(decidingFindingIdAtom) !== null) {
    return
  }
  props.onClearFeedback()
  set(decidingFindingIdAtom, findingId)
  try {
    await plugin.request('review.decide', { runId, findingId, decision })
    await props.onRunsChanged()
  } catch (error) {
    props.onError(error, { specId: props.specId })
  } finally {
    set(decidingFindingIdAtom, null)
  }
}

function FindingCard(p: {
  runId: string
  finding: Finding
  decidingId: string | null
  onDecide: (findingId: string, decision: 'accepted' | 'rejected' | null) => void
}) {
  const { finding, decidingId, runId } = p
  const isDeciding = decidingId === finding.id
  const sev = SEVERITY_META[finding.severity]
  const conf = CONFIDENCE_META[finding.confidence]
  const nextAccept = finding.pmDecision === 'accepted' ? null : 'accepted'
  const nextReject = finding.pmDecision === 'rejected' ? null : 'rejected'
  return (
    <Card
      title={`${finding.id} · ${finding.title}`}
      description={`类别：${finding.category} · 锚点：${finding.anchor ?? '整体规格'}`}
    >
      <Stack gap="sm">
        <Row gap="xs" wrap align="center">
          <Badge tone={sev.tone}>{sev.label}</Badge>
          <Badge tone={conf.tone}>{conf.label}</Badge>
          {finding.pmDecision ? (
            <Badge tone={finding.pmDecision === 'accepted' ? 'success' : 'neutral'}>
              {finding.pmDecision === 'accepted' ? '已采纳' : '已忽略'}
            </Badge>
          ) : null}
        </Row>
        <Text size="sm">{finding.detail}</Text>
        <Text size="sm" weight="medium">
          修改建议：{finding.suggestion}
        </Text>
        {finding.downgradeReason ? (
          <Callout tone="warning" title="证据核验降级" icon="warning">
            <Text size="sm">
              {DOWNGRADE_REASONS[finding.downgradeReason] ?? finding.downgradeReason}
            </Text>
          </Callout>
        ) : null}
        {finding.evidence.map((ev, idx) => (
          <Box
            key={`${runId}-${finding.id}-ev-${idx}`}
            padding="xs"
            border
            radius="sm"
            background="muted"
          >
            <Stack gap="xs">
              <Text size="xs" weight="semibold">
                {ev.label}
              </Text>
              <Code block>{ev.quote}</Code>
            </Stack>
          </Box>
        ))}
        <Row gap="xs" align="center" wrap>
          <Button
            size="xs"
            variant={finding.pmDecision === 'accepted' ? 'solid' : 'outline'}
            tone="success"
            icon="check"
            disabled={isDeciding}
            onPress={() => p.onDecide(finding.id, nextAccept)}
          >
            采纳
          </Button>
          <Button
            size="xs"
            variant={finding.pmDecision === 'rejected' ? 'solid' : 'outline'}
            tone="neutral"
            icon="close"
            disabled={isDeciding}
            onPress={() => p.onDecide(finding.id, nextReject)}
          >
            忽略
          </Button>
          {isDeciding ? <Spinner label="正在更新发现处理状态" /> : null}
        </Row>
      </Stack>
    </Card>
  )
}

function RunStatusBanners({ run }: { run: RunView }) {
  const repos = run.taintedRepos.length > 0 ? run.taintedRepos.join('、') : '关联仓库'
  return (
    <Stack gap="sm">
      {isUnguardedRun(run) ? (
        <Callout tone="warning" title="只读保护未启用" icon="warning">
          <Text size="sm">本次预检未能启用只读保护，已改为事后改动检测。</Text>
        </Callout>
      ) : null}
      {run.status === 'tainted' || run.taintedRepos.length > 0 ? (
        <Callout tone="danger" title="代码仓存在改动（tainted）" icon="error">
          <Text size="sm">
            以下关联代码仓在预检期间发生变动：{repos}。请在终端执行 git status
            检查后再决定是否采用结果。
          </Text>
        </Callout>
      ) : null}
      {run.status === 'failed' && run.error && run.error.code !== 'W_UNGUARDED' ? (
        <Callout tone="danger" title={`预检失败 (${run.error.code})`} icon="error">
          <Text size="sm">{run.error.message}</Text>
        </Callout>
      ) : null}
      {run.status === 'timed_out' ? (
        <Callout tone="warning" title="AI 预检超时" icon="warning">
          <Text size="sm">
            预检已超过超时限制并停止等待，智能体终端（{run.agent}）已保留，可切换到终端查看输出。
          </Text>
        </Callout>
      ) : null}
      {run.status === 'cancelled' ? (
        <Callout tone="neutral" title="AI 预检已取消" icon="info">
          <Text size="sm">本次预检已由用户手动取消。</Text>
        </Callout>
      ) : null}
    </Stack>
  )
}

export function PrecheckTab(props: PrecheckTabProps) {
  const starting = read(startingRunAtom)
  const cancelling = read(cancellingRunAtom)
  const decidingId = read(decidingFindingIdAtom)
  const selectedId = read(selectedRunBySpecAtom)[props.specId]
  const activeRun = props.runs.find((run) => ACTIVE_STATUSES.has(run.status)) ?? null
  const displayedRun =
    props.runs.find((run) => run.runId === selectedId) ?? activeRun ?? props.runs[0] ?? null
  const launchBlockedByLint = props.lintErrorCount > 0
  const handleStart = () =>
    void runPrecheckAction(
      props,
      startingRunAtom,
      () => plugin.request('review.start', { specId: props.specId }),
      (run) => {
        update(selectedRunBySpecAtom, (prev) => ({ ...prev, [props.specId]: run.runId }))
        return `已启动 AI 预检 ${run.runId}`
      }
    )
  const handleCancel = (runId: string) =>
    void runPrecheckAction(
      props,
      cancellingRunAtom,
      () => plugin.request('review.cancel', { runId }),
      (run) => `已取消预检 ${run.runId}`
    )

  return (
    <Stack gap="md">
      <Row justify="between" align="center" wrap gap="sm">
        <Stack gap="xs">
          <Text weight="semibold">AI 现状感知预检</Text>
          <Text
            tone={launchBlockedByLint ? 'warning' : 'neutral'}
            muted={!launchBlockedByLint}
            size="xs"
          >
            {launchBlockedByLint
              ? `当前规格存在 ${props.lintErrorCount} 个校验错误，修复为 0 个错误后才可发起预检。`
              : '只读分析关联代码仓，检查逆向流程、幂等、并发与状态机一致性。'}
          </Text>
        </Stack>
        <Button
          size="sm"
          variant="solid"
          tone="accent"
          icon="play"
          disabled={launchBlockedByLint || starting || activeRun !== null}
          onPress={handleStart}
        >
          {starting ? '启动中…' : '发起预检'}
        </Button>
      </Row>

      {starting ? (
        <Row gap="xs" align="center">
          <Spinner label="正在启动 AI 预检" />
          <Text muted size="sm">
            正在记录代码仓基线并启动智能体…
          </Text>
        </Row>
      ) : null}

      {props.runs.length > 1 && displayedRun ? (
        <Select
          label="预检记录"
          value={displayedRun.runId}
          options={props.runs.map((run) => ({
            value: run.runId,
            label: `${run.runId} · ${RUN_STATUS_META[run.status].label} (${run.agent})`
          }))}
          onChange={(runId) =>
            update(selectedRunBySpecAtom, (prev) => ({ ...prev, [props.specId]: runId }))
          }
        />
      ) : null}

      {!displayedRun ? (
        <EmptyState
          icon="bot"
          title="尚未运行过 AI 预检"
          description="规格校验 0 错误后，点击上方「发起预检」让智能体分析潜在缺陷。"
        />
      ) : (
        <Stack gap="md">
          <RunStatusBanners run={displayedRun} />
          {ACTIVE_STATUSES.has(displayedRun.status) ? (
            <Card
              title={`运行中 · ${displayedRun.runId}`}
              description={`智能体：${displayedRun.agent} · ${RUN_STATUS_META[displayedRun.status].label}`}
            >
              <Stack gap="sm">
                <Progress
                  label="AI 预检进度"
                  value={RUN_STATUS_META[displayedRun.status].progress}
                />
                <Row justify="between" align="center" wrap gap="sm">
                  <Row gap="xs" align="center">
                    <Spinner label="智能体运行中" />
                    <Text size="sm">{RUN_STATUS_META[displayedRun.status].label}…</Text>
                  </Row>
                  <Button
                    size="sm"
                    variant="outline"
                    tone="danger"
                    icon="stop"
                    disabled={cancelling}
                    onPress={() => handleCancel(displayedRun.runId)}
                  >
                    {cancelling ? '取消中…' : '取消预检'}
                  </Button>
                </Row>
              </Stack>
            </Card>
          ) : (
            <Row gap="xs" wrap align="center">
              <Badge tone={RUN_STATUS_META[displayedRun.status].tone}>
                {RUN_STATUS_META[displayedRun.status].label}
              </Badge>
              <Text muted size="xs">
                运行 {displayedRun.runId} · 智能体 {displayedRun.agent} · 发现{' '}
                {displayedRun.findings.length} 条
              </Text>
            </Row>
          )}

          {!ACTIVE_STATUSES.has(displayedRun.status) && displayedRun.findings.length === 0 ? (
            <EmptyState
              icon="check"
              title="本次预检无发现项"
              description="智能体未报告问题，可继续保存快照或发布网页评审。"
            />
          ) : null}

          {SEVERITY_ORDER.map((severity) => {
            const group = displayedRun.findings.filter((item) => item.severity === severity)
            if (group.length === 0) {
              return null
            }
            return (
              <Stack key={`${displayedRun.runId}-${severity}`} gap="sm">
                <Heading level={3}>
                  {SEVERITY_META[severity].label} ({group.length})
                </Heading>
                {group.map((finding) => (
                  <FindingCard
                    key={`${displayedRun.runId}-${finding.id}`}
                    runId={displayedRun.runId}
                    finding={finding}
                    decidingId={decidingId}
                    onDecide={(findingId, decision) =>
                      void decideFinding(props, displayedRun.runId, findingId, decision)
                    }
                  />
                ))}
              </Stack>
            )
          })}
        </Stack>
      )}
    </Stack>
  )
}
