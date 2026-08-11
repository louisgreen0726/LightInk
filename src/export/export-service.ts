/**
 * `export-service` — 导出编排层（T10, R5）：活动标签 → 序列化内容 →
 * 内嵌图片 → 装配文档 → 保存对话框 + 原子写（HTML）/ 系统打印（PDF）。
 *
 * 全部副作用（快照提取、主题/CSS 读取、图片读取、对话框、写文件、打印）
 * 经 `ExportServiceDeps` 注入，vitest 在 node 环境以 fake 直测编排分支。
 * DOM 相关的唯一薄点是 `serializeEditorContent`（结构化类型，可用 fake
 * 对象测）。
 */

import {
  buildHtmlDocument,
  embedImages,
  type HtmlExportOptions,
} from './html-export.js';
import { buildPrintHtml, runPrint } from './pdf-export.js';

/** 活动标签的导出快照（由调用方从 TabManager/DOM 现取）。 */
export interface ExportTabSnapshot {
  /** 标签标题（用作 <title> 与默认导出文件名）。 */
  readonly title: string;
  /** 文档路径；null 表示未保存（图片走会话暂存目录解析）。 */
  readonly filePath: string | null;
  /** 会话 id（TabState.syntheticId），未保存文档定位暂存图片用。 */
  readonly sessionId: string;
  /** 编辑器渲染内容的序列化 HTML（见 serializeEditorContent）。 */
  readonly contentHtml: string;
}

export interface ExportServiceDeps {
  /** 现取活动标签快照；无活动标签返回 null。 */
  readonly getActiveSnapshot: () => ExportTabSnapshot | null;
  /** 当前主题 id（<html> 的 data-theme 值）。 */
  readonly getTheme: () => string;
  /** 导出 CSS 全文（生产为 buildExportCss(+自定义主题)）。 */
  readonly getCssText: () => string;
  /**
   * 读取相对路径图片为 base64（生产为 Rust read_image_base64）。
   * docPath 非 null 时相对文档目录解析；否则相对 sessionId 的暂存目录。
   */
  readonly readImageBase64: (
    docPath: string | null,
    sessionId: string | null,
    relPath: string,
  ) => Promise<string>;
  /** 「导出 HTML」保存对话框；用户取消返回 null。 */
  readonly showHtmlSaveDialog: (defaultPath?: string) => Promise<string | null>;
  /** 原子写文件（生产为 file-service 的 writeFile）。 */
  readonly writeFile: (path: string, content: string) => Promise<void>;
  /** 触发打印（生产为 printViaHiddenIframe）。 */
  readonly printHtml: (html: string) => void;
  /** 「导出 PDF」原生保存对话框（生产为 .pdf 过滤）；用户取消返回 null。可选。 */
  readonly showPdfSaveDialog?: (defaultPath?: string) => Promise<string | null>;
  /**
   * 原生矢量 PDF 导出（生产为挂导出根 + invoke('print_webview_to_pdf')）。
   * 可选：提供时优先走原生路径（含可选文字）；失败/缺省回退到 printHtml。
   */
  readonly printPdfNative?: (html: string, path: string) => Promise<void>;
  readonly reportError: (message: string, error: unknown) => void;
}

/** 可序列化的最小宿主结构（生产为标签宿主 HTMLElement）。 */
export interface HostLike {
  querySelector(selector: string): { innerHTML: string } | null;
  readonly innerHTML?: string;
}

/**
 * 提取编辑器渲染内容 HTML：优先取宿主内 `.ProseMirror` 的 innerHTML
 * （编辑区正文），取不到时回退宿主自身 innerHTML。
 */
export function serializeEditorContent(host: HostLike): string {
  const pm = host.querySelector('.ProseMirror');
  return pm?.innerHTML ?? host.innerHTML ?? '';
}

/** 默认导出文件名：标签标题去掉扩展名后加 .html。 */
export function defaultExportFileName(title: string): string {
  const stem = title.replace(/\.[^./\\]+$/, '').trim();
  return `${stem === '' ? '未命名' : stem}.html`;
}

interface AssembledExport {
  readonly options: HtmlExportOptions;
  /** 读取失败、保留原 src 的图片相对路径。 */
  readonly missingImages: readonly string[];
}

/**
 * 装配当前活动标签的导出选项（内容内嵌图片 + 主题 + CSS）。
 * 无活动标签返回 null；图片读取失败不阻断（记入 missingImages）。
 */
async function assembleActiveTab(
  deps: ExportServiceDeps,
): Promise<AssembledExport | null> {
  const snap = deps.getActiveSnapshot();
  if (snap === null) {
    return null;
  }
  const embedded = await embedImages(snap.contentHtml, (relPath) =>
    deps.readImageBase64(
      snap.filePath,
      snap.filePath === null ? snap.sessionId : null,
      relPath,
    ),
  );
  if (embedded.missing.length > 0) {
    deps.reportError(
      `有 ${embedded.missing.length} 张图片读取失败，导出文档中保留原始引用: ${embedded.missing.join(', ')}`,
      null,
    );
  }
  return {
    options: {
      title: snap.title,
      theme: deps.getTheme(),
      bodyHtml: embedded.html,
      cssText: deps.getCssText(),
    },
    missingImages: embedded.missing,
  };
}

/**
 * 导出 HTML：装配 → 保存对话框 → 原子写。用户取消或失败返回 false
 * （失败经 reportError 上报）；成功返回 true。
 */
export async function exportActiveTabHtml(deps: ExportServiceDeps): Promise<boolean> {
  const assembled = await assembleActiveTab(deps);
  if (assembled === null) {
    deps.reportError('没有可导出的活动标签', null);
    return false;
  }
  const target = await deps.showHtmlSaveDialog(
    defaultExportFileName(assembled.options.title),
  );
  if (target === null) {
    return false;
  }
  try {
    await deps.writeFile(target, buildHtmlDocument(assembled.options));
    return true;
  } catch (error) {
    deps.reportError('导出 HTML 失败', error);
    return false;
  }
}

/**
 * 导出 PDF：装配 → 打印管线（隐藏 iframe + window.print → 系统打印
 * 对话框「另存为 PDF」）。无活动标签返回 false；打印触发后返回 true
 * （实际 PDF 生成在系统对话框中完成，见 pdf-export.ts 注释）。
 */
export async function exportActiveTabPdf(deps: ExportServiceDeps): Promise<boolean> {
  const assembled = await assembleActiveTab(deps);
  if (assembled === null) {
    deps.reportError('没有可导出的活动标签', null);
    return false;
  }
  const html = buildPrintHtml(assembled.options);

  // 优先原生矢量 PDF（Windows WebView2 PrintToPdf）：含可选文字、保真度最高。
  if (deps.showPdfSaveDialog !== undefined && deps.printPdfNative !== undefined) {
    const target = await deps.showPdfSaveDialog(
      defaultExportFileName(assembled.options.title).replace(/\.html$/i, '.pdf'),
    );
    if (target === null) {
      return false; // 用户取消
    }
    try {
      await deps.printPdfNative(html, target);
      return true;
    } catch (error) {
      // 原生失败（平台不支持 / 运行时缺接口）→ 回退到打印对话框。
      deps.reportError('原生 PDF 导出失败，改用打印对话框', error);
    }
  }

  // 回退：window.print() 系统对话框（Linux/macOS 主路径；Windows 兜底）。
  runPrint(html, deps.printHtml);
  return true;
}
