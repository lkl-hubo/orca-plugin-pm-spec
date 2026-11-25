import { diffLines } from './line-diff.ts'
import { extractSpecItems } from './review-payload.ts'
import { parseSpec } from './spec-parser.ts'
import type { SnapshotManifest, SnapshotManifestItem, SpecDiff } from './spec-types.ts'

export type SnapshotDiffSide =
  | SnapshotManifest
  | {
      manifest: SnapshotManifest
      itemsMarkdown?: Readonly<Record<string, string>>
      markdown?: string
    }

function isManifestSide(side: SnapshotDiffSide): side is SnapshotManifest {
  return 'items' in side && Array.isArray(side.items)
}

function resolveSide(side: SnapshotDiffSide): {
  manifest: SnapshotManifest
  textByAnchor: Map<string, string>
} {
  if (isManifestSide(side)) {
    const textByAnchor = new Map<string, string>()
    for (const item of side.items) {
      if (typeof item.markdown === 'string') {
        textByAnchor.set(item.anchor, item.markdown)
      }
    }
    return { manifest: side, textByAnchor }
  }

  const textByAnchor = new Map<string, string>()
  for (const item of side.manifest.items) {
    if (typeof item.markdown === 'string') {
      textByAnchor.set(item.anchor, item.markdown)
    }
  }
  if (side.itemsMarkdown) {
    for (const [anchor, text] of Object.entries(side.itemsMarkdown)) {
      textByAnchor.set(anchor, text)
    }
  } else if (typeof side.markdown === 'string') {
    const parsed = parseSpec(side.markdown, `${side.manifest.specId}/spec.md`)
    for (const item of extractSpecItems(parsed)) {
      textByAnchor.set(item.anchor, item.markdown)
    }
  }
  return { manifest: side.manifest, textByAnchor }
}

export function diffSnapshots(fromSide: SnapshotDiffSide, toSide: SnapshotDiffSide): SpecDiff {
  const from = resolveSide(fromSide)
  const to = resolveSide(toSide)

  const fromByAnchor = new Map<string, SnapshotManifestItem>()
  for (const item of from.manifest.items) {
    fromByAnchor.set(item.anchor, item)
  }

  const toByAnchor = new Map<string, SnapshotManifestItem>()
  for (const item of to.manifest.items) {
    toByAnchor.set(item.anchor, item)
  }

  const added: { anchor: string; title: string }[] = []
  const removed: { anchor: string; title: string }[] = []
  const modified: SpecDiff['modified'] = []

  for (const item of to.manifest.items) {
    const prev = fromByAnchor.get(item.anchor)
    if (!prev) {
      added.push({ anchor: item.anchor, title: item.title })
      continue
    }
    if (prev.sha256 !== item.sha256) {
      const fromText = from.textByAnchor.get(item.anchor)
      const toText = to.textByAnchor.get(item.anchor)
      const lines =
        fromText !== undefined && toText !== undefined ? diffLines(fromText, toText) : null
      modified.push({
        anchor: item.anchor,
        title: item.title,
        lines
      })
    }
  }

  for (const item of from.manifest.items) {
    if (!toByAnchor.has(item.anchor)) {
      removed.push({ anchor: item.anchor, title: item.title })
    }
  }

  return {
    specId: to.manifest.specId,
    fromVersion: from.manifest.version,
    toVersion: to.manifest.version,
    added,
    removed,
    modified
  }
}
