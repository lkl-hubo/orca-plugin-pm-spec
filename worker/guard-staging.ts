import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const PLUGIN_ROOT_DIR = join(import.meta.dirname, '..')

export const GUARD_EXT_FILES = [
  'pi/pmspec-review-guard.ts',
  'core/pi-guard-policy.ts',
  'core/findings-validate.ts',
  'core/spec-types.ts',
  'core/id-format.ts',
  'core/yaml-frontmatter.ts',
  'vendor/js-yaml.mjs'
] as const

export async function stageGuardExtensionFiles(runDir: string): Promise<void> {
  const extRoot = join(runDir, 'ext')
  for (const rel of GUARD_EXT_FILES) {
    const dst = join(extRoot, rel)
    await mkdir(dirname(dst), { recursive: true })
    await copyFile(join(PLUGIN_ROOT_DIR, rel), dst)
  }
}
