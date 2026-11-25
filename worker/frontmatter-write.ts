import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { decodeUtf8Fatal, sha256Hex } from '../core/id-format.ts'
import type { SpecStatus } from '../core/spec-types.ts'

export type FrontmatterUpdateOptions = {
  expectedSha256: string
  status?: SpecStatus
  version?: number
}

function replaceFrontmatterLines(
  lines: string[],
  endIdx: number,
  options: FrontmatterUpdateOptions
): string[] {
  const fmLines = lines.slice(1, endIdx)
  const applyField = (key: string, value: string | number | undefined): void => {
    if (value === undefined) {
      return
    }
    const nextLine = `${key}: ${value}`
    const idx = fmLines.findIndex((line) => new RegExp(`^${key}:\\s*`).test(line))
    if (idx === -1) {
      fmLines.push(nextLine)
    } else {
      fmLines[idx] = nextLine
    }
  }
  applyField('status', options.status)
  applyField('version', options.version)
  return [lines[0]!, ...fmLines, ...lines.slice(endIdx)]
}

export async function updateFrontmatterStatusAndVersion(
  filePath: string,
  options: FrontmatterUpdateOptions
): Promise<{ sha256: string; bytes: Uint8Array }> {
  const rawBytes = await readFile(filePath)
  if (sha256Hex(rawBytes) !== options.expectedSha256) {
    throw new Error('E_FILE_CHANGED: 规格文件已被外部修改，请刷新后重试')
  }
  const decoded = decodeUtf8Fatal(rawBytes)
  if (!decoded.ok) {
    throw new Error(`E_LINT_ERRORS: ${decoded.error}`)
  }
  const hasBom = decoded.text.startsWith('\uFEFF')
  const withoutBom = hasBom ? decoded.text.slice(1) : decoded.text
  const eol = withoutBom.includes('\r\n') ? '\r\n' : '\n'
  const endsWithEol = withoutBom.endsWith('\n') || withoutBom.endsWith('\r')
  const normalized = withoutBom.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const lines = (endsWithEol ? normalized.slice(0, -1) : normalized).split('\n')
  if (lines.length === 0 || lines[0]?.trimEnd() !== '---') {
    throw new Error('E_LINT_ERRORS: 缺少头信息，无法更新状态与版本')
  }
  const endIdx = lines.findIndex((line, idx) => idx >= 1 && line.trimEnd() === '---')
  if (endIdx === -1) {
    throw new Error('E_LINT_ERRORS: 头信息未闭合，无法更新状态与版本')
  }
  const nextLines = replaceFrontmatterLines(lines, endIdx, options)
  const nextBytes = new TextEncoder().encode(
    `${hasBom ? '\uFEFF' : ''}${nextLines.join(eol)}${endsWithEol ? eol : ''}`
  )
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(tmpPath, nextBytes)
    if (sha256Hex(await readFile(filePath)) !== options.expectedSha256) {
      throw new Error('E_FILE_CHANGED: 规格文件已被外部修改，请刷新后重试')
    }
    await rename(tmpPath, filePath)
    return { sha256: sha256Hex(nextBytes), bytes: nextBytes }
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined)
    throw error
  }
}

export async function bumpSpecVersionOnDisk(
  filePath: string,
  expectedSha256: string,
  currentVersion: number
): Promise<{ version: number }> {
  const nextVersion = currentVersion + 1
  await updateFrontmatterStatusAndVersion(filePath, {
    expectedSha256,
    version: nextVersion,
    status: 'draft'
  })
  return { version: nextVersion }
}
