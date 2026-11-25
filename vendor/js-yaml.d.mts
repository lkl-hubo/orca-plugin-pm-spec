export class YAMLException extends Error {
  reason?: string
  mark?: {
    name?: string
    line?: number
    column?: number
    snippet?: string
  }
  constructor(reason?: string, mark?: YAMLException['mark'])
  toString(compact?: boolean): string
}

export const JSON_SCHEMA: unknown

export function load(
  str: string,
  opts?: {
    schema?: unknown
    filename?: string
    json?: boolean
  }
): unknown
