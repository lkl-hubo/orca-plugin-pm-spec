import { findDuplicateFindingId, findFindingsSchemaIssue } from './findings-validate.ts'

export function isToolAllowed(toolName: string, allowed: readonly string[]): boolean {
  return allowed.includes(toolName)
}

export function validateSubmittedFindings(findings: unknown): string | null {
  const schemaIssue = findFindingsSchemaIssue(findings, true)
  if (schemaIssue) {
    return schemaIssue.message
  }
  if (!Array.isArray(findings)) {
    return 'findings 必须是数组'
  }
  const duplicate = findDuplicateFindingId(findings)
  if (duplicate) {
    return `findings[${duplicate.index}].id 重复`
  }
  return null
}
