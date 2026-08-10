/**
 * `reader-view` — 只读阅读视图骨架（ebook-reader T3）。
 *
 * reader 标签的视图实例：在标签宿主内挂载两种宿主——
 *   - 滚动容器（流式格式 EPUB/MOBI/FB2/TXT，T4 渲染章节化 HTML）；
 *   - 页容器（页式格式 PDF/CBZ，T5 渲染逐页）；
 * 并只消费主题令牌 `var(--lightink-*)` 与字号缩放 `var(--lightink-font-scale)`，
 * 亮/暗/自定义主题切换与字号调节即时生效，零新机制。
 *
 * 本骨架不解析任何格式（T4/T5 负责）；当前显示空态占位。后续任务在此
 * ReaderInstance 上扩展 load/navigate/annotate 方法。
 */

import './reader.css';
import type { ReaderInstance } from './types.js';

export interface ReaderViewDeps {
  /** 翻译 i18n key（生产为 i18n.t）；默认返回 key 本身（headless/测试）。 */
  t?: (key: string, vars?: Readonly<Record<string, string>>) => string;
}

/**
 * 在宿主元素内创建阅读视图骨架并返回 ReaderInstance。
 * `destroy` 移除视图 DOM（对应 markdown 标签的 `editor.destroy`）。
 *
 * 返回的实例对外只暴露 `destroy`（T1 契约）；T4/T5 通过扩展 ReaderInstance
 * 接口加载与渲染内容，本函数负责的骨架结构保持稳定。
 */
export function createReaderView(host: HTMLElement, deps: ReaderViewDeps = {}): ReaderInstance {
  const t = deps.t ?? ((key: string) => key);
  const root = document.createElement('div');
  root.className = 'lightink-reader';
  root.setAttribute('role', 'document');

  // 流式格式宿主：垂直滚动阅读。
  const scrollHost = document.createElement('div');
  scrollHost.className = 'lightink-reader-scroll';
  scrollHost.dataset.readerHost = 'scroll';

  // 页式格式宿主：逐页浏览（默认隐藏，T5 切页模式时激活）。
  const pageHost = document.createElement('div');
  pageHost.className = 'lightink-reader-pages';
  pageHost.dataset.readerHost = 'pages';
  pageHost.hidden = true;

  // 空态占位：T4/T5 填充内容前的默认显示。
  const empty = document.createElement('div');
  empty.className = 'lightink-reader-empty';
  empty.textContent = t('reader.empty');
  scrollHost.appendChild(empty);

  root.append(scrollHost, pageHost);
  host.appendChild(root);

  return {
    async destroy(): Promise<void> {
      root.remove();
    },
  };
}
