/**
 * Image handling plugin entry point.
 *
 * T2 covers R3 only at a stub level: pasted/dropped images are turned into
 * relative-path references inside the document's eventual `assets/` folder.
 * Real asset persistence + relative-path resolution are delivered by T4.
 *
 * For now, this module just describes the contract the editor uses:
 *   - a deterministic placeholder asset id (`assets/<uuid>.png`)
 *   - an MDAST-friendly `alt`/`title`/`url` triple to be handed to Milkdown's
 *     `image` node
 */

import { nanoid } from '@milkdown/utils';

export interface ImageAsset {
  readonly id: string;
  readonly url: string;
  readonly alt: string;
  readonly title?: string;
}

export interface ImageInsertOptions {
  readonly assetsDir?: string;
  readonly alt?: string;
  readonly title?: string;
}

/**
 * Build an image descriptor for an in-memory paste/drop payload.
 *
 * The implementation deliberately avoids touching the filesystem: T4 owns
 * that concern. We expose a stable `assets/<id>` relative path so the
 * resulting doc round-trips through standard markdown tooling.
 */
export function describePastedImage(
  opts: ImageInsertOptions = {},
): ImageAsset {
  const id = nanoid();
  const assetsDir = opts.assetsDir ?? 'assets';
  const normalized = assetsDir.endsWith('/')
    ? assetsDir.slice(0, -1)
    : assetsDir;
  const url = `${normalized}/${id}.png`;
  return {
    id,
    url,
    alt: opts.alt ?? '',
    title: opts.title,
  };
}

/**
 * Markdown fragment for an image asset. Used by `paste.ts` when the paste
 * contains an `![alt](url)` shape: re-renders with the canonical URL so the
 * editor's stored source matches the `ImageAsset.url`.
 */
export function imageMarkdownSnippet(asset: ImageAsset): string {
  const titlePart =
    typeof asset.title === 'string' && asset.title.length > 0
      ? ` "${asset.title.replace(/"/g, '\\"')}"`
      : '';
  return `![${asset.alt}](${asset.url}${titlePart})`;
}
