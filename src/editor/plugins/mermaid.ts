/**
 * Mermaid diagram rendering plugin (T9 / R9).
 *
 * Design (per docs/sakullla-workflow/.../02-technical-solution.md「图表：
 * Mermaid，按需加载」):
 *
 *   - Fenced code blocks with language `mermaid` (```mermaid … ```) are
 *     rendered as diagrams (flowchart / sequence / …) via mermaid's
 *     `mermaid.render(id, definition)` → `{ svg }`. Detection follows the
 *     same info-string convention as code-highlight.ts (`resolveLanguage`):
 *     first whitespace-separated token, case-normalized — so `Mermaid` and
 *     ```mermaid {config} are treated as mermaid too (documented leniency;
 *     mermaid's own directive syntax is `%%{init:…}%%` inside the source).
 *
 *   - Coexistence with code-highlight.ts: `mermaid` is NOT a registered
 *     hljs language, so `resolveLanguage('mermaid')` returns null and the
 *     highlight pass emits no decorations for mermaid blocks — no conflict.
 *     This plugin is the sole decorator of mermaid code_blocks.
 *
 *   - mermaid (~500KB+) is loaded **lazily**: `createMermaidLoader` wraps a
 *     memoized dynamic `import('mermaid')`, invoked by the ProseMirror
 *     plugin view only when the document actually contains a mermaid block
 *     (same pattern as math.ts `createKatexLoader`). Vite splits it into an
 *     async chunk; documents without mermaid never pay the cost.
 *     `initialize({ startOnLoad: false, securityLevel: 'strict' })` runs
 *     once inside the loader: `startOnLoad:false` is required because we
 *     drive `render` manually; `strict` is mermaid's default and keeps its
 *     built-in sanitization for user-authored diagrams (XSS surface).
 *
 *   - Error isolation (R9: 语法错误隔离): `mermaid.render` rejects on
 *     parse errors; `renderMermaidSvg` catches and returns an error
 *     outcome. The PM layer then marks only that block with
 *     `lightink-mermaid-error` (raw source stays visible and editable,
 *     carrying the error message in a data attribute) — siblings and the
 *     rest of the document are never affected, and no SVG widget is
 *     inserted for the failed block.
 *
 *   - The pure logic layer is headless-testable:
 *       isMermaidBlock(infoString)                    — fence → boolean
 *       renderMermaidSvg(definition, mermaidModule)   — async → outcome
 *       createMermaidLoader(load?)                    — memoized loader
 *       buildMermaidDecorations(doc, results)         — doc → DecorationSet
 *     `renderMermaidSvg` takes the mermaid module as a parameter, so unit
 *     tests inject a fake (`{ render: async (id, def) => ({ svg }) }` or a
 *     throwing stub) and never touch the real module — real
 *     `mermaid.render` needs DOM/SVG measure APIs that don't exist
 *     headlessly.
 *
 *   - Async wiring (same pattern as math.ts): decorations are rebuilt
 *     synchronously from plugin state; the view kicks off the lazy import
 *     and per-block renders, then re-dispatches transactions carrying the
 *     loaded module / per-definition outcomes as plugin-key meta, which
 *     triggers a decoration rebuild. Until a block's render resolves it
 *     shows as `lightink-mermaid-pending` source.
 */
import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { Node as PMNode } from '@milkdown/prose/model';
import { Decoration, DecorationSet } from '@milkdown/prose/view';

// ---------------------------------------------------------------------------
// 纯逻辑层：mermaid 代码块识别
// ---------------------------------------------------------------------------

/**
 * fence info-string（或 PM code_block 的 language attr）是否标记为
 * mermaid 代码块。与 code-highlight 的 `resolveLanguage` 同约定：取首个
 * 空白分隔 token 并小写化，因此 `Mermaid` / ```mermaid {…} 也算 mermaid。
 */
export function isMermaidBlock(infoString: string | null | undefined): boolean {
  if (infoString === null || infoString === undefined) return false;
  const tag = infoString.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return tag === 'mermaid';
}

// ---------------------------------------------------------------------------
// 纯逻辑层：渲染与错误隔离（mermaid 模块注入，测试永不触碰真实模块）
// ---------------------------------------------------------------------------

/** mermaid 模块的最小契约（真实模块与测试替身共用这个形状）。 */
export interface MermaidModule {
  initialize(config?: Record<string, unknown>): void;
  render(id: string, definition: string): Promise<{ svg: string }>;
}

/** 渲染结果：成功 → SVG 字符串；失败 → 错误消息（不产出任何 SVG）。 */
export type MermaidRenderOutcome =
  | { readonly ok: true; readonly svg: string }
  | { readonly ok: false; readonly message: string };

/** 渲染 id 计数器：mermaid.render 要求每次调用一个唯一 id。 */
let nextRenderId = 0;

/**
 * 渲染一段 mermaid 定义为 SVG。语法错误 / 渲染异常被捕获并转为 error
 * 结果（隔离在该块内），绝不向上抛。空定义直接判错，不调用 mermaid。
 */
export async function renderMermaidSvg(
  definition: string,
  mermaid: MermaidModule,
): Promise<MermaidRenderOutcome> {
  const source = definition.trim();
  if (source === '') {
    return { ok: false, message: 'empty mermaid definition' };
  }
  try {
    const { svg } = await mermaid.render(`lightink-mermaid-${nextRenderId++}`, source);
    return { ok: true, svg };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// 惰性加载：仅当文档确有 mermaid 块时才 import('mermaid')，且只加载一次
// ---------------------------------------------------------------------------

/**
 * 构造一个 memoized 的 mermaid 加载器。`load` 工厂可注入替身以便测试
 * 断言「无 mermaid 块时从不触发 import」。首次加载后执行一次
 * `initialize({ startOnLoad: false, securityLevel: 'strict' })`：
 * 我们手动驱动 render（禁用自动挂载），并保留 mermaid 默认的严格
 * 安全级别（其内置的 SVG 消毒）。加载失败时缓存被清除（`cached = null`），
 * 使下一次 view 更新的重试真正生效。
 */
export function createMermaidLoader(
  load: () => Promise<unknown> = () => import('mermaid'),
): () => Promise<MermaidModule> {
  let cached: Promise<MermaidModule> | null = null;
  return () => {
    if (cached === null) {
      const pending = Promise.resolve()
        .then(load)
        .then((mod) => {
          const shaped = mod as Partial<MermaidModule> & { default?: Partial<MermaidModule> };
          const mermaid = (shaped.default ?? shaped) as Partial<MermaidModule>;
          if (typeof mermaid.render !== 'function') {
            throw new Error('mermaid module does not expose render');
          }
          if (typeof mermaid.initialize === 'function') {
            mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
          }
          return mermaid as MermaidModule;
        });
      // 失败不缓存 rejected promise：让后续调用真正重试。
      pending.catch(() => {
        if (cached === pending) cached = null;
      });
      cached = pending;
    }
    return cached;
  };
}

// ---------------------------------------------------------------------------
// ProseMirror decoration 层
// ---------------------------------------------------------------------------

/** mermaid 插件状态：已加载的模块（未加载为 null）+ 按定义缓存的渲染结果 + 当前 decorations。 */
export interface MermaidPluginState {
  readonly mermaid: MermaidModule | null;
  /** definition（trim 后源码）→ 渲染结果；内容寻址，块移动/增删不影响命中。 */
  readonly results: ReadonlyMap<string, MermaidRenderOutcome>;
  readonly decorations: DecorationSet;
}

export const mermaidPluginKey = new PluginKey<MermaidPluginState>('lightink-mermaid');

/** PM 事务元数据：模块加载完成或单块渲染完成后由 view 回灌触发重装饰。 */
interface MermaidPluginMeta {
  mermaid?: MermaidModule;
  result?: { definition: string; outcome: MermaidRenderOutcome };
}

/** code_block 节点的 mermaid 定义（trim 后的文本内容）；非 mermaid 块或
 * 空块（用户刚敲完 fence 尚未输入内容）返回 null —— 空块按普通代码块
 * 原样展示，不闪现错误样式。 */
function mermaidDefinitionOf(node: PMNode): string | null {
  if (node.type.name !== 'code_block') return null;
  const language = typeof node.attrs['language'] === 'string' ? (node.attrs['language'] as string) : '';
  if (!isMermaidBlock(language)) return null;
  const text = node.textContent.trim();
  return text === '' ? null : text;
}

/** definition 的稳定短哈希（FNV-1a 32-bit hex），用于 widget key 内容寻址。 */
function definitionHash(definition: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < definition.length; i++) {
    hash ^= definition.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 收集文档中全部 mermaid 定义（去重）；惰性加载与渲染的门槛判断。 */
export function collectMermaidDefinitions(doc: PMNode): string[] {
  const defs = new Set<string>();
  doc.descendants((node) => {
    const def = mermaidDefinitionOf(node);
    if (def !== null) defs.add(def);
    return def === null; // mermaid 块只含文本，无需下降
  });
  return [...defs];
}

/** 文档是否含 mermaid 代码块（view 据此决定是否触发惰性 import）。 */
export function docHasMermaid(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (mermaidDefinitionOf(node) !== null) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * 为整篇文档构建 mermaid decorations（同步、纯函数）：
 *   - 渲染成功 → 源码块加 `lightink-mermaid-source` node decoration（CSS
 *     可据此折叠源码），并在块后插入承载 SVG 的 widget；
 *   - 渲染失败 → 仅加 `lightink-mermaid-error`（源码原样可见，错误消息
 *     在 data 属性上），不插入 widget —— 错误被隔离在该块内；
 *   - 尚未渲染（结果未就绪）→ `lightink-mermaid-pending`；
 *   - 非 mermaid 的 code_block / 其他内容完全不产生 decoration。
 * 文档本身不被修改，源码始终可编辑。
 */
export function buildMermaidDecorations(
  doc: PMNode,
  results: ReadonlyMap<string, MermaidRenderOutcome>,
): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    const def = mermaidDefinitionOf(node);
    if (def === null) return true;
    const outcome = results.get(def);
    if (outcome === undefined) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: 'lightink-mermaid-pending',
          'data-mermaid': 'pending',
        }),
      );
      return false;
    }
    if (!outcome.ok) {
      // R9：语法错误 → 原样显示源码 + 错误样式，不渲染、不影响其他内容。
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: 'lightink-mermaid-error',
          'data-mermaid': 'error',
          'data-mermaid-error': outcome.message,
        }),
      );
      return false;
    }
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: 'lightink-mermaid-source',
        'data-mermaid': 'rendered',
      }),
    );
    const svg = outcome.svg;
    decorations.push(
      Decoration.widget(
        pos + node.nodeSize,
        () => {
          const el = document.createElement('div');
          el.className = 'lightink-mermaid';
          // mermaid 在 securityLevel:'strict' 下已对 SVG 消毒。
          el.innerHTML = svg;
          return el;
        },
        { side: 1, key: `lightink-mermaid-${definitionHash(def)}` },
      ),
    );
    return false; // code_block 只含文本，无需下降
  });
  return DecorationSet.create(doc, decorations);
}

// ---------------------------------------------------------------------------
// Milkdown 插件
// ---------------------------------------------------------------------------

/**
 * Milkdown 插件（`$prose`）：mermaid 代码块即时渲染 + 语法错误隔离。
 * 在 mountEditor 中于 code-highlight / math 之后注册。
 *
 * 加载与渲染策略（同 math.ts 的异步回灌模式）：`view` 在挂载与每次更新
 * 后检查文档；仅当存在 mermaid 块且模块未加载时触发一次动态 import；
 * 模块就绪后对每个尚无结果且未在渲染中的定义发起异步 render，完成后
 * 通过带 meta 的事务回灌插件状态并重建 decorations。加载或渲染失败都
 * 只影响对应块自身，编辑永不阻塞。
 */
export const mermaidPlugin = $prose(() => {
  const loadMermaid = createMermaidLoader();
  let loadRequested = false;
  /** 正在异步渲染中的定义（避免 update 风暴重复发起）。 */
  const inflight = new Set<string>();

  return new Plugin<MermaidPluginState>({
    key: mermaidPluginKey,
    state: {
      init: (_config, state) => ({
        mermaid: null,
        results: new Map<string, MermaidRenderOutcome>(),
        decorations: buildMermaidDecorations(state.doc, new Map()),
      }),
      apply: (tr, old, _oldState, newState) => {
        const meta = tr.getMeta(mermaidPluginKey) as MermaidPluginMeta | undefined;
        const mermaid = meta?.mermaid ?? old.mermaid;
        let results = old.results;
        if (meta?.result !== undefined) {
          const next = new Map(old.results);
          next.set(meta.result.definition, meta.result.outcome);
          results = next;
        }
        if (meta !== undefined || tr.docChanged) {
          return { mermaid, results, decorations: buildMermaidDecorations(newState.doc, results) };
        }
        return { mermaid, results, decorations: old.decorations.map(tr.mapping, tr.doc) };
      },
    },
    view: (view) => {
      const ensureRendered = (): void => {
        const pluginState = mermaidPluginKey.getState(view.state);
        if (pluginState === undefined) return;
        const pending = collectMermaidDefinitions(view.state.doc).filter(
          (def) => !pluginState.results.has(def) && !inflight.has(def),
        );
        if (pending.length === 0) return;
        if (pluginState.mermaid === null) {
          if (loadRequested) return;
          loadRequested = true;
          loadMermaid()
            .then((mermaid) => {
              // 视图可能已销毁；dispatch 前状态检查由 PM 自身保证安全。
              view.dispatch(view.state.tr.setMeta(mermaidPluginKey, { mermaid }));
            })
            .catch(() => {
              // 加载失败：保持源码显示，不打扰编辑；loader 不缓存失败，
              // 下次 view 更新会真正重试 import。
              loadRequested = false;
            });
          return;
        }
        const mermaid = pluginState.mermaid;
        for (const def of pending) {
          inflight.add(def);
          renderMermaidSvg(def, mermaid)
            .then((outcome) => {
              inflight.delete(def);
              view.dispatch(
                view.state.tr.setMeta(mermaidPluginKey, {
                  result: { definition: def, outcome },
                } satisfies MermaidPluginMeta),
              );
            })
            .catch(() => {
              // renderMermaidSvg 自身已捕获渲染错误；这里兜底（如视图销毁）。
              inflight.delete(def);
            });
        }
      };
      ensureRendered();
      return { update: () => ensureRendered() };
    },
    props: {
      decorations(state) {
        return mermaidPluginKey.getState(state)?.decorations;
      },
    },
  });
});
