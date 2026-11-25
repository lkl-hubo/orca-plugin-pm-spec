import {
  atom,
  Badge,
  Button,
  Card,
  EmptyState,
  Heading,
  plugin,
  read,
  Row,
  set,
  Spinner,
  Stack,
  Text
} from 'orca'
import type { LintIssueView } from '../protocol.ts'

export type LintTabProps = {
  specId: string
  lint: { issues: LintIssueView[]; durationMs: number }
  onLintCompleted: () => Promise<void>
  onError: (error: unknown, context?: { specId?: string }) => void
  onNotify: (message: string) => void
  onClearFeedback: () => void
}

const lintingAtom = atom(false)

async function runLint(props: LintTabProps): Promise<void> {
  if (read(lintingAtom)) {
    return
  }
  props.onClearFeedback()
  set(lintingAtom, true)
  try {
    const result = await plugin.request('spec.lint', { specId: props.specId })
    await props.onLintCompleted()
    props.onNotify(
      `校验完成：${result.error} 个错误，${result.warning} 个警告（${result.durationMs} ms）`
    )
  } catch (error) {
    props.onError(error, { specId: props.specId })
  } finally {
    set(lintingAtom, false)
  }
}

function IssueCard({ issue }: { issue: LintIssueView }) {
  const title = issue.anchor ? `${issue.ruleId} · ${issue.anchor}` : issue.ruleId
  const location = issue.line !== null ? `第 ${issue.line} 行` : '全文件'
  return (
    <Card title={title} description={location}>
      <Stack gap="xs">
        <Text tone={issue.severity === 'error' ? 'danger' : 'warning'} size="sm" weight="medium">
          {issue.message}
        </Text>
        <Text muted size="xs">
          修复建议：{issue.hint}
        </Text>
      </Stack>
    </Card>
  )
}

export function LintTab(props: LintTabProps) {
  const linting = read(lintingAtom)
  const errors = props.lint.issues.filter((issue) => issue.severity === 'error')
  const warnings = props.lint.issues.filter((issue) => issue.severity === 'warning')

  return (
    <Stack gap="md">
      <Row justify="between" align="center" wrap gap="sm">
        <Row gap="xs" align="center" wrap>
          <Badge tone={errors.length > 0 ? 'danger' : 'success'}>错误 {errors.length}</Badge>
          <Badge tone={warnings.length > 0 ? 'warning' : 'neutral'}>警告 {warnings.length}</Badge>
          <Text muted size="xs">
            耗时 {props.lint.durationMs} ms
          </Text>
        </Row>
        <Button
          size="sm"
          variant="outline"
          icon="refresh"
          disabled={linting}
          onPress={() => void runLint(props)}
        >
          {linting ? '校验中…' : '重新校验'}
        </Button>
      </Row>

      {linting ? (
        <Row gap="xs" align="center">
          <Spinner label="正在校验规格" />
          <Text muted size="sm">
            正在执行确定性校验规则…
          </Text>
        </Row>
      ) : null}

      {props.lint.issues.length === 0 ? (
        <EmptyState
          icon="check"
          title="校验全部通过"
          description="当前规格无错误或警告，可继续发起 AI 预检或保存评审快照。"
        />
      ) : null}

      {errors.length > 0 ? (
        <Stack gap="sm">
          <Heading level={3}>错误 ({errors.length})</Heading>
          {errors.map((issue) => (
            <IssueCard
              key={`err-${issue.ruleId}-${issue.anchor ?? ''}-${issue.line ?? 0}-${issue.message}`}
              issue={issue}
            />
          ))}
        </Stack>
      ) : null}

      {warnings.length > 0 ? (
        <Stack gap="sm">
          <Heading level={3}>警告 ({warnings.length})</Heading>
          {warnings.map((issue) => (
            <IssueCard
              key={`warn-${issue.ruleId}-${issue.anchor ?? ''}-${issue.line ?? 0}-${issue.message}`}
              issue={issue}
            />
          ))}
        </Stack>
      ) : null}
    </Stack>
  )
}
