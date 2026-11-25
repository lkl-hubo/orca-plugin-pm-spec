import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  CodeView,
  EmptyState,
  Heading,
  List,
  ListItem,
  plugin,
  read,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Text,
  update
} from 'orca'

type DiffLineOp = { op: 'equal' | 'add' | 'del'; text: string }

type SpecDiffData = {
  fromVersion: number
  toVersion: number
  added: { anchor: string; title: string }[]
  removed: { anchor: string; title: string }[]
  modified: { anchor: string; title: string; lines: DiffLineOp[] | null }[]
}

export type SnapshotTabProps = {
  specId: string
  currentSha256: string
  snapshots: { version: number; sha256: string; createdAt: string }[]
  onSnapshotsChanged: () => Promise<void>
  onError: (error: unknown, context?: { specId?: string }) => void
  onNotify: (message: string) => void
  onClearFeedback: () => void
}

const savingSnapshotAtom = atom(false)
const diffingAtom = atom(false)
const fromVersionBySpecAtom = atom<Record<string, string>>({})
const toVersionBySpecAtom = atom<Record<string, string>>({})
const diffBySpecAtom = atom<Record<string, SpecDiffData>>({})

function formatDiffLines(lines: DiffLineOp[]): string {
  return lines
    .map((line) => {
      const prefix = line.op === 'add' ? '+' : line.op === 'del' ? '-' : ' '
      return `${prefix} ${line.text}`
    })
    .join('\n')
}

async function saveSnapshot(props: SnapshotTabProps): Promise<void> {
  if (read(savingSnapshotAtom)) {
    return
  }
  props.onClearFeedback()
  set(savingSnapshotAtom, true)
  try {
    const res = await plugin.request('spec.snapshot', { specId: props.specId })
    await props.onSnapshotsChanged()
    props.onNotify(
      res.reused
        ? `版本 v${res.version} 快照内容一致，已复用现有快照`
        : `已保存不可变快照 v${res.version}`
    )
  } catch (error) {
    props.onError(error, { specId: props.specId })
  } finally {
    set(savingSnapshotAtom, false)
  }
}

async function computeDiff(
  props: SnapshotTabProps,
  fromVersion: number,
  toVersion: number
): Promise<void> {
  if (read(diffingAtom)) {
    return
  }
  props.onClearFeedback()
  set(diffingAtom, true)
  try {
    const res = await plugin.request('spec.diff', {
      specId: props.specId,
      fromVersion,
      toVersion
    })
    update(diffBySpecAtom, (prev) => ({
      ...prev,
      [props.specId]: { fromVersion, toVersion, ...res }
    }))
  } catch (error) {
    props.onError(error, { specId: props.specId })
  } finally {
    set(diffingAtom, false)
  }
}

export function SnapshotTab(props: SnapshotTabProps) {
  const saving = read(savingSnapshotAtom)
  const diffing = read(diffingAtom)
  const sorted = [...props.snapshots].sort((a, b) => b.version - a.version)
  const latest = sorted[0] ?? null
  const isCleanMatch = latest !== null && latest.sha256 === props.currentSha256

  const defaultFrom =
    sorted.length >= 2 ? String(sorted[1].version) : String(sorted[0]?.version ?? '')
  const defaultTo = sorted.length >= 1 ? String(sorted[0].version) : ''
  const fromValue = read(fromVersionBySpecAtom)[props.specId] ?? defaultFrom
  const toValue = read(toVersionBySpecAtom)[props.specId] ?? defaultTo
  const diffData = read(diffBySpecAtom)[props.specId] ?? null

  const versionOptions = sorted.map((snap) => ({
    value: String(snap.version),
    label: `v${snap.version} (${snap.sha256.slice(0, 8)})`
  }))

  return (
    <Stack gap="md">
      <Row justify="between" align="center" wrap gap="sm">
        <Stack gap="xs">
          <Text weight="semibold">评审快照与条目差异</Text>
          {latest ? (
            <Badge tone={isCleanMatch ? 'success' : 'warning'}>
              {isCleanMatch
                ? `当前文件与快照 v${latest.version} 一致`
                : `当前文件已修改，尚未保存新快照`}
            </Badge>
          ) : (
            <Text muted size="xs">
              保存不可变快照后可用于版本对比与发布网页评审。
            </Text>
          )}
        </Stack>
        <Button
          size="sm"
          variant="solid"
          tone="accent"
          icon="add"
          disabled={saving}
          onPress={() => void saveSnapshot(props)}
        >
          {saving ? '保存中…' : '保存评审快照'}
        </Button>
      </Row>

      {saving ? (
        <Row gap="xs" align="center">
          <Spinner label="正在保存快照" />
          <Text muted size="sm">
            正在校验敏感信息并写入不可变快照…
          </Text>
        </Row>
      ) : null}

      {sorted.length === 0 ? (
        <EmptyState
          icon="layers"
          title="暂无历史快照"
          description="点击「保存评审快照」记录当前规格版本。"
        />
      ) : (
        <Stack gap="sm">
          <Heading level={3}>快照记录 ({sorted.length})</Heading>
          <List label="快照列表">
            {sorted.map((snap) => (
              <ListItem
                key={`snap-v${snap.version}`}
                icon="layers"
                title={`v${snap.version}`}
                description={`SHA-256 ${snap.sha256.slice(0, 12)} · ${snap.createdAt}`}
              />
            ))}
          </List>
        </Stack>
      )}

      {sorted.length >= 2 ? (
        <Card title="版本差异对比" description="按条目对比两个快照的新增、删除与行级变更">
          <Stack gap="sm">
            <Row gap="sm" wrap align="end">
              <Select
                label="版本 A（基线）"
                value={fromValue}
                options={versionOptions}
                disabled={diffing}
                onChange={(val) =>
                  update(fromVersionBySpecAtom, (prev) => ({ ...prev, [props.specId]: val }))
                }
              />
              <Select
                label="版本 B（目标）"
                value={toValue}
                options={versionOptions}
                disabled={diffing}
                onChange={(val) =>
                  update(toVersionBySpecAtom, (prev) => ({ ...prev, [props.specId]: val }))
                }
              />
              <Button
                size="sm"
                variant="outline"
                icon="search"
                disabled={diffing || !fromValue || !toValue}
                onPress={() => void computeDiff(props, Number(fromValue), Number(toValue))}
              >
                {diffing ? '对比中…' : '查看差异'}
              </Button>
            </Row>

            {diffing ? (
              <Row gap="xs" align="center">
                <Spinner label="正在计算差异" />
                <Text muted size="sm">
                  正在比对快照清单与条目内容…
                </Text>
              </Row>
            ) : null}

            {diffData ? (
              <Stack gap="sm">
                <Row gap="xs" wrap align="center">
                  <Text size="sm" weight="medium">
                    v{diffData.fromVersion} → v{diffData.toVersion}
                  </Text>
                  <Badge tone="success">新增 {diffData.added.length}</Badge>
                  <Badge tone="warning">修改 {diffData.modified.length}</Badge>
                  <Badge tone="danger">删除 {diffData.removed.length}</Badge>
                </Row>

                {diffData.added.length === 0 &&
                diffData.removed.length === 0 &&
                diffData.modified.length === 0 ? (
                  <Callout tone="success" title="两个快照内容完全一致" icon="check">
                    <Text size="sm">所选两个版本之间没有条目变化。</Text>
                  </Callout>
                ) : null}

                {diffData.added.length > 0 ? (
                  <Card title={`新增条目 (${diffData.added.length})`}>
                    <Stack gap="xs">
                      {diffData.added.map((item) => (
                        <Row key={`add-${item.anchor}`} gap="xs" align="center">
                          <Badge tone="success">新增</Badge>
                          <Text size="sm">
                            {item.anchor} · {item.title}
                          </Text>
                        </Row>
                      ))}
                    </Stack>
                  </Card>
                ) : null}

                {diffData.removed.length > 0 ? (
                  <Card title={`删除条目 (${diffData.removed.length})`}>
                    <Stack gap="xs">
                      {diffData.removed.map((item) => (
                        <Row key={`rem-${item.anchor}`} gap="xs" align="center">
                          <Badge tone="danger">删除</Badge>
                          <Text size="sm">
                            {item.anchor} · {item.title}
                          </Text>
                        </Row>
                      ))}
                    </Stack>
                  </Card>
                ) : null}

                {diffData.modified.map((item) => (
                  <Card key={`mod-${item.anchor}`} title={`修改 · ${item.anchor} ${item.title}`}>
                    {item.lines === null ? (
                      <Callout tone="warning" title="内容过长，仅标记为已修改" icon="warning">
                        <Text size="sm">该条目单侧超过 2,000 行，已跳过行级差异计算。</Text>
                      </Callout>
                    ) : (
                      <CodeView
                        code={formatDiffLines(item.lines)}
                        language="diff"
                        label={`${item.anchor} 变更内容`}
                        lineNumbers
                        wrap
                        maxHeight="md"
                      />
                    )}
                  </Card>
                ))}
              </Stack>
            ) : null}
          </Stack>
        </Card>
      ) : null}
    </Stack>
  )
}
