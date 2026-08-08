/**
 * Image handling plugin entry point.
 *
 * T4 wires the real flow: a ProseMirror plugin (via `$prose`) intercepts
 * paste/drop events carrying image data, persists the bytes through an
 * injected `AssetSaver` (Rust asset service is the sole owner of asset
 * persistence), and inserts a Milkdown `image` node whose `src` is the
 * returned relative path `assets/<name>.<ext>`. 落盘失败时报错且不插入
 * 引用（R3）。
 *
 * `describePastedImage` / `imageMarkdownSnippet`（T2 引入的契约描述）保留
 * 供测试与纯逻辑复用；真实粘贴/拖拽流程走 saver 路径。
 */

import { $prose, nanoid } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';

import type { AssetSaver } from '../../asset/asset-service.js';
import { clipboardHasImage, extractClipboardImage } from '../../asset/clipboard.js';
import { dropHasImage, extractDroppedImages } from '../../asset/dragdrop.js';

/**
 * mountEditor 的图片资源扩展选项（定义在此而非 types.ts，因为 types.ts
 * 不在 T4 修改范围内；字段全部可选，存量调用不受影响）。
 */
export interface ImageAssetMountOptions {
  /** 图片字节落盘回调；缺省时粘贴/拖拽图片走编辑器默认行为。 */
  readonly assetSaver?: AssetSaver;
  /** 落盘失败上报（生产接到 TabManager 的 reportError）。 */
  readonly onAssetError?: (message: string, error: unknown) => void;
}

/** 事件处理器依赖（与 mount 选项同形，便于内部传递）。 */
export interface ImageAssetDeps {
  readonly saver: AssetSaver;
  readonly onError?: (message: string, error: unknown) => void;
}

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
 * Markdown fragment for an image asset. Currently unwired — T4 will route
 * pasted image content through this once paste/asset persistence lands.
 * Re-renders with the canonical URL so the editor's stored source matches
 * the `ImageAsset.url`.
 */
export function imageMarkdownSnippet(asset: ImageAsset): string {
  const titlePart =
    typeof asset.title === 'string' && asset.title.length > 0
      ? ` "${asset.title.replace(/"/g, '\\"')}"`
      : '';
  return `![${asset.alt}](${asset.url}${titlePart})`;
}

// ---------------------------------------------------------------------------
// T4：粘贴/拖拽 → 落盘 → 插入 image 节点
// ---------------------------------------------------------------------------

/**
 * 在指定位置插入 image 节点（`pos` 为 null 时替换当前选区，用于粘贴；
 * 拖拽时传 `posAtCoords` 得到的落点）。schema 无 image 节点时返回 false。
 */
export function insertImageAt(
  view: EditorView,
  pos: number | null,
  url: string,
  alt: string,
): boolean {
  const imageType = view.state.schema.nodes['image'];
  if (imageType === undefined) {
    return false;
  }
  const node = imageType.create({ src: url, alt });
  const tr = view.state.tr;
  view.dispatch(
    (pos === null ? tr.replaceSelectionWith(node) : tr.insert(pos, node)).scrollIntoView(),
  );
  return true;
}

/**
 * 粘贴图片的异步主流程：提取 → 落盘 → 插入。落盘失败调用 onError 且
 * 不插入任何引用（outcome 3）。返回是否最终插入了图片。
 */
export async function processImagePaste(
  view: EditorView,
  event: ClipboardEvent,
  deps: ImageAssetDeps,
): Promise<boolean> {
  // R16：检测到图片却读取失败（WebView 形状异常/空字节）时明确反馈，不静默无反应。
  const detected = clipboardHasImage(event);
  const image = await extractClipboardImage(event);
  if (image === null) {
    if (detected) {
      deps.onError?.('剪贴板图片读取失败，未插入', undefined);
    }
    return false;
  }
  let url: string;
  try {
    url = await deps.saver(image.bytes, image.ext);
  } catch (error) {
    deps.onError?.('图片保存失败，未插入引用', error);
    return false;
  }
  return insertImageAt(view, null, url, image.alt);
}

/** 拖拽图片的异步主流程：逐张落盘并按落点顺序插入；单张失败不阻断其余。 */
export async function processImageDrop(
  view: EditorView,
  event: DragEvent,
  deps: ImageAssetDeps,
): Promise<number> {
  const images = await extractDroppedImages(event);
  if (images.length === 0) {
    return 0;
  }
  const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
  let pos = coords?.pos ?? view.state.selection.from;
  let inserted = 0;
  for (const image of images) {
    let url: string;
    try {
      url = await deps.saver(image.bytes, image.ext);
    } catch (error) {
      deps.onError?.('图片保存失败，未插入引用', error);
      continue;
    }
    if (insertImageAt(view, pos, url, image.alt)) {
      inserted += 1;
      // 插入后推进落点，保证多张图顺序排列。
      pos += 1;
    }
  }
  return inserted;
}

/**
 * 生成拦截粘贴/拖拽图片的 ProseMirror 插件（经 `$prose` 包装成 Milkdown
 * 插件）。同步探测到图片即拦截（preventDefault + 返回 true），异步完成
 * 落盘与插入；无图片时返回 false 让默认行为（如文本粘贴）继续。
 */
export function imageAssetPlugin(deps: ImageAssetDeps) {
  return $prose(
    () =>
      new Plugin({
        key: new PluginKey('lightink-image-assets'),
        props: {
          handlePaste: (view, event) => {
            if (!clipboardHasImage(event)) {
              return false;
            }
            event.preventDefault();
            void processImagePaste(view, event, deps);
            return true;
          },
          handleDrop: (view, event) => {
            if (!dropHasImage(event)) {
              return false;
            }
            event.preventDefault();
            void processImageDrop(view, event, deps);
            return true;
          },
        },
      }),
  );
}
