/**
 * `reader-view` — 只读阅读视图（ebook-reader T3 骨架 + T4 流式渲染）。
 *
 * 在标签宿主内挂载两种宿主——
 *   - 滚动容器（流式格式 EPUB/MOBI/FB2/TXT，T4 渲染章节化 HTML）；
 *   - 页容器（页式格式 PDF/CBZ，T5 渲染逐页）；
 * 并只消费主题令牌 `var(--lightink-*)` 与字号缩放 `var(--lightink-font-scale)`，
 * 亮/暗/自定义主题切换与字号调节即时生效。
 *
 * `load(path)` 读取字节（注入的 readBytes）→ 经 formats 调度解析为章节化内容 →
 * 消毒后渲染到滚动宿主；解析失败 reject 由调用方提示。`destroy` 移除视图 DOM。
 */

import './reader.css';
import { parseReaderContent } from './formats/index.js';
import type { ReaderChapter } from './formats/types.js';
import type { ReaderInstance } from './types.js';

export interface ReaderViewDeps {
  /** 读取文件原始字节（生产为 invoke read_file_bytes → base64 → Uint8Array）。 */
  readBytes?: (filePath: string) => Promise<Uint8Array>;
  /** 翻译 i18n key（生产为 i18n.t）；默认返回 key 本身（headless/测试）。 */
  t?: (key: string, vars?: Readonly<Record<string, string>>) => string;
}

/**
 * 在宿主元素内创建阅读视图并返回 ReaderInstance。
 * `load` 渲染章节；`destroy` 移除视图 DOM（对应 markdown 标签的 `editor.destroy`）。
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

  // 空态占位：load 成功后移除。
  const empty = document.createElement('div');
  empty.className = 'lightink-reader-empty';
  empty.textContent = t('reader.empty');
  scrollHost.appendChild(empty);

  root.append(scrollHost, pageHost);
  host.appendChild(root);

  const renderChapters = (chapters: ReaderChapter[]): void => {
    scrollHost.replaceChildren();
    let chapterIndex = 0;
    for (const chapter of chapters) {
      const article = document.createElement('article');
      article.className = 'lightink-reader-chapter';
      const heading = document.createElement('h1');
      heading.className = 'lightink-reader-chapter-title';
      heading.textContent = chapter.title || t('reader.chapter', { n: String(chapterIndex + 1) });
      const body = document.createElement('div');
      body.className = 'lightink-reader-chapter-body';
      body.innerHTML = chapter.html;
      article.append(heading, body);
      scrollHost.appendChild(article);
      chapterIndex += 1;
    }
  };

  return {
    async load(filePath: string): Promise<void> {
      const readBytes = deps.readBytes;
      if (readBytes === undefined) {
        throw new Error('reader-view load requires the readBytes dependency');
      }
      const bytes = await readBytes(filePath);
      const content = await parseReaderContent(filePath, bytes);
      renderChapters(content.chapters);
    },
    async destroy(): Promise<void> {
      root.remove();
    },
  };
}
