import { REPO_KEY_REGEX, SPECS_DIR_REGEX } from './id-format.ts'
import type {
  CodeRepoConfig,
  LintSeverity,
  SignoffRole,
  WorkspaceConfig,
  WorkspaceConfigError
} from './spec-types.ts'
import { isPlainRecord } from './yaml-frontmatter.ts'

const TOP_LEVEL_KEYS = new Set([
  'version',
  'product',
  'specsDir',
  'codeRepos',
  'roles',
  'review',
  'lint'
])
const REPO_KEYS = new Set(['key', 'path', 'description'])
const REVIEW_KEYS = new Set(['requiredSignoffRoles'])
const LINT_KEYS = new Set(['disabled', 'severityOverrides'])
function toSignoffRole(value: unknown): SignoffRole | null {
  switch (value) {
    case '产品':
    case '研发':
    case '测试':
    case '业务':
    case '风控':
    case '其他':
      return value
    default:
      return null
  }
}
const OVERRIDABLE_RULE_REGEX = /^PMS-L0(0[3-5]|0[7-9]|1[0-9]|2[0-3])$/

function checkExtraKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
  errors: WorkspaceConfigError[]
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      errors.push({
        path: prefix ? `${prefix}.${key}` : key,
        message: `不允许的未知字段 ${key}`
      })
    }
  }
}

export function validateWorkspaceConfig(
  raw: unknown
): { ok: true; config: WorkspaceConfig } | { ok: false; errors: WorkspaceConfigError[] } {
  const errors: WorkspaceConfigError[] = []
  if (!isPlainRecord(raw)) {
    return { ok: false, errors: [{ path: '', message: 'pmspec.json 必须是 JSON 对象' }] }
  }
  checkExtraKeys(raw, TOP_LEVEL_KEYS, '', errors)

  if (raw.version !== 1) {
    errors.push({ path: 'version', message: 'version 必须为 1' })
  }
  if (typeof raw.product !== 'string' || raw.product.length < 1 || raw.product.length > 80) {
    errors.push({ path: 'product', message: 'product 需为 1～80 个字符的字符串' })
  }

  let specsDir = 'specs'
  if (raw.specsDir !== undefined) {
    if (typeof raw.specsDir !== 'string' || !SPECS_DIR_REGEX.test(raw.specsDir)) {
      errors.push({ path: 'specsDir', message: 'specsDir 格式无效' })
    } else {
      specsDir = raw.specsDir
    }
  }

  const codeRepos: CodeRepoConfig[] = []
  const seenRepoKeys = new Set<string>()
  if (!Array.isArray(raw.codeRepos)) {
    errors.push({ path: 'codeRepos', message: 'codeRepos 必须是数组' })
  } else {
    if (raw.codeRepos.length > 10) {
      errors.push({ path: 'codeRepos', message: 'codeRepos 最多声明 10 个代码仓' })
    }
    for (const [index, entry] of raw.codeRepos.entries()) {
      const prefix = `codeRepos[${index}]`
      if (!isPlainRecord(entry)) {
        errors.push({ path: prefix, message: '代码仓条目必须是对象' })
        continue
      }
      checkExtraKeys(entry, REPO_KEYS, prefix, errors)
      if (typeof entry.key !== 'string' || !REPO_KEY_REGEX.test(entry.key)) {
        errors.push({ path: `${prefix}.key`, message: '仓库 key 格式无效' })
      } else if (seenRepoKeys.has(entry.key)) {
        errors.push({ path: `${prefix}.key`, message: `仓库 key ${entry.key} 重复` })
      } else {
        seenRepoKeys.add(entry.key)
      }
      if (typeof entry.path !== 'string' || entry.path.length < 1 || entry.path.length > 1024) {
        errors.push({ path: `${prefix}.path`, message: 'path 需为 1～1024 个字符' })
      }
      if (
        entry.description !== undefined &&
        (typeof entry.description !== 'string' || entry.description.length > 200)
      ) {
        errors.push({ path: `${prefix}.description`, message: 'description 长度不能超过 200' })
      }
      if (typeof entry.key === 'string' && typeof entry.path === 'string') {
        codeRepos.push({
          key: entry.key,
          path: entry.path,
          ...(typeof entry.description === 'string' ? { description: entry.description } : {})
        })
      }
    }
  }

  const roles: string[] = []
  if (!Array.isArray(raw.roles)) {
    errors.push({ path: 'roles', message: 'roles 必须是数组' })
  } else {
    if (raw.roles.length < 1 || raw.roles.length > 30) {
      errors.push({ path: 'roles', message: 'roles 需包含 1～30 项' })
    }
    const seenRoles = new Set<string>()
    for (const [index, role] of raw.roles.entries()) {
      if (typeof role !== 'string' || role.length < 1 || role.length > 20) {
        errors.push({ path: `roles[${index}]`, message: '角色名称需为 1～20 个字符' })
      } else if (seenRoles.has(role)) {
        errors.push({ path: `roles[${index}]`, message: `角色 ${role} 重复` })
      } else {
        seenRoles.add(role)
        roles.push(role)
      }
    }
  }

  const requiredSignoffRoles: SignoffRole[] = []
  if (!isPlainRecord(raw.review)) {
    errors.push({ path: 'review', message: 'review 必须是对象' })
  } else {
    checkExtraKeys(raw.review, REVIEW_KEYS, 'review', errors)
    const signoffList = raw.review.requiredSignoffRoles
    if (!Array.isArray(signoffList)) {
      errors.push({
        path: 'review.requiredSignoffRoles',
        message: 'requiredSignoffRoles 必须是数组'
      })
    } else {
      if (signoffList.length > 6) {
        errors.push({ path: 'review.requiredSignoffRoles', message: '最多选择 6 个签核角色' })
      }
      const seenSignoffs = new Set<string>()
      for (const [index, role] of signoffList.entries()) {
        const parsedRole = toSignoffRole(role)
        if (!parsedRole) {
          errors.push({
            path: `review.requiredSignoffRoles[${index}]`,
            message: '签核角色必须是 产品/研发/测试/业务/风控/其他 之一'
          })
        } else if (seenSignoffs.has(parsedRole)) {
          errors.push({
            path: `review.requiredSignoffRoles[${index}]`,
            message: `签核角色 ${parsedRole} 重复`
          })
        } else {
          seenSignoffs.add(parsedRole)
          requiredSignoffRoles.push(parsedRole)
        }
      }
    }
  }

  const disabled: string[] = []
  const severityOverrides: Record<string, LintSeverity> = {}
  if (raw.lint !== undefined) {
    if (!isPlainRecord(raw.lint)) {
      errors.push({ path: 'lint', message: 'lint 必须是对象' })
    } else {
      checkExtraKeys(raw.lint, LINT_KEYS, 'lint', errors)
      if (raw.lint.disabled !== undefined) {
        if (!Array.isArray(raw.lint.disabled)) {
          errors.push({ path: 'lint.disabled', message: 'lint.disabled 必须是数组' })
        } else {
          const seenDisabled = new Set<string>()
          for (const [index, ruleId] of raw.lint.disabled.entries()) {
            if (typeof ruleId !== 'string' || !OVERRIDABLE_RULE_REGEX.test(ruleId)) {
              errors.push({
                path: `lint.disabled[${index}]`,
                message: `规则 ${String(ruleId)} 不存在或不允许禁用`
              })
            } else if (seenDisabled.has(ruleId)) {
              errors.push({ path: `lint.disabled[${index}]`, message: `规则 ${ruleId} 重复` })
            } else {
              seenDisabled.add(ruleId)
              disabled.push(ruleId)
            }
          }
        }
      }
      if (raw.lint.severityOverrides !== undefined) {
        if (!isPlainRecord(raw.lint.severityOverrides)) {
          errors.push({
            path: 'lint.severityOverrides',
            message: 'lint.severityOverrides 必须是对象'
          })
        } else {
          for (const [ruleId, severity] of Object.entries(raw.lint.severityOverrides)) {
            if (!OVERRIDABLE_RULE_REGEX.test(ruleId)) {
              errors.push({
                path: `lint.severityOverrides.${ruleId}`,
                message: `规则 ${ruleId} 不存在或不允许调整级别`
              })
            } else if (severity !== 'error' && severity !== 'warning') {
              errors.push({
                path: `lint.severityOverrides.${ruleId}`,
                message: '级别只能是 error 或 warning'
              })
            } else {
              severityOverrides[ruleId] = severity
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  const product = typeof raw.product === 'string' ? raw.product : ''
  return {
    ok: true,
    config: {
      version: 1,
      product,
      specsDir,
      codeRepos,
      roles,
      review: { requiredSignoffRoles },
      lint: { disabled, severityOverrides }
    }
  }
}

export function resolveWorkspaceRepoPath(workspaceRoot: string, repoPath: string): string {
  const cleanRepo = repoPath.replaceAll('\\', '/')
  if (cleanRepo.startsWith('/') || /^[A-Za-z]:\//.test(cleanRepo)) {
    return cleanRepo
  }
  const cleanRoot = workspaceRoot.replaceAll('\\', '/').replace(/\/+$/, '')
  const rootPrefixMatch = /^([A-Za-z]:)?(\/)?/.exec(cleanRoot)
  const drive = rootPrefixMatch?.[1] ?? ''
  const isAbs = Boolean(rootPrefixMatch?.[2])
  const baseBody = cleanRoot.slice(drive.length + (isAbs ? 1 : 0))
  const parts = baseBody ? baseBody.split('/').filter((s) => s !== '' && s !== '.') : []

  for (const segment of cleanRepo.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (parts.length > 0 && parts.at(-1) !== '..') {
        parts.pop()
      } else if (!isAbs) {
        parts.push('..')
      }
    } else {
      parts.push(segment)
    }
  }

  return `${drive}${isAbs ? '/' : ''}${parts.join('/')}`
}
