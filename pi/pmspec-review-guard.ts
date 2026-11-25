import { execFile } from 'node:child_process'
import { closeSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Type } from 'typebox'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { isToolAllowed, validateSubmittedFindings } from '../core/pi-guard-policy.ts'

const execFileAsync = promisify(execFile)

const CATEGORY = Type.Union(
  [
    'reverse-flow',
    'idempotency',
    'concurrency',
    'permission',
    'state-machine',
    'data-consistency',
    'compatibility',
    'boundary-value',
    'ambiguity',
    'code-conflict',
    'missing-nfr',
    'tracking'
  ].map((value) => Type.Literal(value))
)

const EVIDENCE = Type.Union([
  Type.Object({
    kind: Type.Literal('code'),
    repo: Type.String(),
    path: Type.String({ maxLength: 512 }),
    startLine: Type.Integer({ minimum: 1 }),
    endLine: Type.Integer({ minimum: 1 }),
    quote: Type.String({ minLength: 8, maxLength: 200 })
  }),
  Type.Object({
    kind: Type.Literal('spec'),
    anchor: Type.String(),
    quote: Type.String({ minLength: 4, maxLength: 200 })
  })
])

const FINDING = Type.Object({
  id: Type.String({ pattern: '^F-\\d{3}$' }),
  anchor: Type.Union([Type.String(), Type.Null()]),
  category: CATEGORY,
  severity: Type.Union([Type.Literal('blocker'), Type.Literal('major'), Type.Literal('minor')]),
  title: Type.String({ minLength: 4, maxLength: 80 }),
  detail: Type.String({ minLength: 10, maxLength: 1200 }),
  suggestion: Type.String({ minLength: 4, maxLength: 600 }),
  confidence: Type.Union([
    Type.Literal('verified'),
    Type.Literal('inferred'),
    Type.Literal('assumption')
  ]),
  evidence: Type.Array(EVIDENCE, { maxItems: 5 })
})

export default function pmspecReviewGuard(pi: ExtensionAPI): void {
  const runId = process.env.PMSPEC_RUN_ID
  const runDir = process.env.PMSPEC_RUN_DIR
  const specId = process.env.PMSPEC_SPEC_ID
  if (!runId || !runDir || !specId) {
    return
  }
  let claimFd: number
  try {
    claimFd = openSync(join(runDir, 'guard-claim.json'), 'wx')
  } catch {
    return
  }
  const codegraphRepos: { key: string; path: string }[] = JSON.parse(
    process.env.PMSPEC_CODEGRAPH_REPOS ?? '[]'
  )
  const allowed = ['read', 'grep', 'find', 'ls', 'pmspec_submit_findings']
  if (codegraphRepos.length > 0) {
    allowed.push('pmspec_codegraph_explore')
  }
  writeFileSync(
    claimFd,
    JSON.stringify({ runId, pid: process.pid, claimedAt: new Date().toISOString(), tools: allowed })
  )
  closeSync(claimFd)

  pi.on('tool_call', (event) =>
    isToolAllowed(event.toolName, allowed)
      ? undefined
      : { block: true, reason: `规格预检为只读任务，禁止使用工具 ${event.toolName}` }
  )

  pi.registerTool({
    name: 'pmspec_submit_findings',
    label: '提交预检结果',
    description:
      '提交本次规格预检的全部发现。只能调用一次成功提交；校验失败时根据返回信息修正后重新调用。',
    parameters: Type.Object({ findings: Type.Array(FINDING, { maxItems: 40 }) }),
    async execute(_toolCallId, params) {
      const problem = validateSubmittedFindings(params.findings)
      if (problem) {
        return {
          content: [{ type: 'text', text: `提交失败：${problem}。请修正后重新调用。` }],
          details: { ok: false }
        }
      }
      const body = JSON.stringify(
        { schemaVersion: 1, runId, specId, findings: params.findings },
        null,
        2
      )
      const target = join(runDir, 'findings.json')
      writeFileSync(`${target}.tmp`, body, 'utf8')
      renameSync(`${target}.tmp`, target)
      return {
        content: [
          {
            type: 'text',
            text: `已提交 ${params.findings.length} 条发现。任务完成，请只回复：PMSPEC_REVIEW_DONE ${runId}`
          }
        ],
        details: { ok: true, count: params.findings.length }
      }
    }
  })

  if (codegraphRepos.length > 0) {
    pi.registerTool({
      name: 'pmspec_codegraph_explore',
      label: '代码图谱检索',
      description: '在指定代码仓中用 codegraph explore 只读检索调用链与实现位置。',
      parameters: Type.Object({
        repo: Type.Union(codegraphRepos.map((repo) => Type.Literal(repo.key))),
        question: Type.String({ minLength: 2, maxLength: 300 })
      }),
      async execute(_toolCallId, params, signal) {
        const repo = codegraphRepos.find((entry) => entry.key === params.repo)
        if (!repo) {
          return {
            content: [{ type: 'text', text: `未知代码仓 ${params.repo}` }],
            details: { ok: false }
          }
        }
        const { stdout } = await execFileAsync('codegraph', ['explore', params.question], {
          cwd: repo.path,
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          signal
        })
        return { content: [{ type: 'text', text: stdout.slice(0, 20_000) }], details: { ok: true } }
      }
    })
  }
}
