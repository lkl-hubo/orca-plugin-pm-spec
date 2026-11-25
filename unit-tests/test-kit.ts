import assert from 'node:assert/strict'
export { afterEach, describe, it } from 'node:test'

function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true
  if (expected === null || typeof expected !== 'object') return false
  if (actual === null || typeof actual !== 'object') return false
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false
    return expected.every((item, idx) => matchesSubset(actual[idx], item))
  }
  for (const [k, v] of Object.entries(expected)) {
    const rec = actual as Record<string, unknown>
    if (!(k in rec) || !matchesSubset(rec[k], v)) return false
  }
  return true
}

function makeMatchers(actual: unknown, negated: boolean) {
  const pass = (cond: boolean, msg: string) => {
    if (negated ? cond : !cond) {
      assert.fail(msg)
    }
  }
  return {
    toBe(expected: unknown) {
      if (negated) {
        assert.notStrictEqual(actual, expected)
      } else {
        assert.strictEqual(actual, expected)
      }
    },
    toEqual(expected: unknown) {
      if (negated) {
        assert.notDeepStrictEqual(actual, expected)
      } else {
        assert.deepStrictEqual(actual, expected)
      }
    },
    toBeNull() {
      pass(actual === null, `Expected ${String(actual)} ${negated ? "not " : ""}to be null`)
    },
    toBeUndefined() {
      pass(actual === undefined, `Expected ${String(actual)} ${negated ? "not " : ""}to be undefined`)
    },
    toBeGreaterThan(expected: number) {
      const ok = typeof actual === 'number' && actual > expected
      pass(ok, `Expected ${String(actual)} ${negated ? "not " : ""}to be > ${expected}`)
    },
    toContain(expected: unknown) {
      const ok =
        typeof actual === 'string'
          ? actual.includes(String(expected))
          : Array.isArray(actual)
            ? actual.includes(expected)
            : false
      pass(ok, `Expected ${JSON.stringify(actual)} ${negated ? "not " : ""}to contain ${JSON.stringify(expected)}`)
    },
    toHaveLength(expected: number) {
      const len = (actual as { length?: number } | null | undefined)?.length
      pass(len === expected, `Expected length ${String(len)} ${negated ? "not " : ""}to be ${expected}`)
    },
    toMatch(pattern: RegExp | string) {
      const text = String(actual)
      const re = typeof pattern === 'string' ? new RegExp(pattern) : pattern
      pass(re.test(text), `Expected ${text} ${negated ? "not " : ""}to match ${String(pattern)}`)
    },
    toMatchObject(expected: Record<string, unknown>) {
      pass(
        matchesSubset(actual, expected),
        `Expected ${JSON.stringify(actual)} ${negated ? "not " : ""}to match object ${JSON.stringify(expected)}`
      )
    }
  }
}

export function expect(actual: unknown) {
  return {
    ...makeMatchers(actual, false),
    not: makeMatchers(actual, true),
    rejects: {
      async toThrow(pattern?: RegExp | string) {
        await assert.rejects(
          Promise.resolve(actual),
          pattern instanceof RegExp ? pattern : pattern ? new RegExp(pattern) : undefined
        )
      }
    }
  }
}
