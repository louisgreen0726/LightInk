/**
 * app-shell buildMenus 生产结构回归测试（R2）：
 * 基于生产 buildMenus 产出（而非手写 spec）断言分隔项与菜单结构，
 * 防止「分隔符漏设 separator:true 而渲染为空白可点击按钮」的回归。
 */

import { describe, expect, it } from 'vitest';

import type { InsertElementId } from '../../editor/insert-commands.js';
import type { BuiltinThemeId } from '../../theme/theme-service.js';
import { buildMenus, buildRecentsMenuItems, pathBaseName, pathDirName, type AppShellActions } from '../app-shell.js';

function stubActions(currentThemeId = 'warm-light'): AppShellActions {
  const noop = (): void => undefined;
  return {
    onNew: noop,
    onOpen: noop,
    listRecents: () => Promise.resolve([]),
    openRecent: () => Promise.resolve(false),
    clearRecents: () => Promise.resolve(),
    onShowVersions: noop,
    hasActiveFile: () => false,
    onSave: noop,
    onSaveAs: noop,
    onExportHtml: noop,
    onExportPdf: noop,
    onUndo: noop,
    onRedo: noop,
    onCut: noop,
    onCopy: noop,
    onPaste: noop,
    onInsertElement: (_id: InsertElementId) => undefined,
    onToggleTheme: noop,
    onApplyTheme: (_id: BuiltinThemeId) => undefined,
    getCurrentThemeId: () => currentThemeId,
    onReloadCustomTheme: noop,
    canReloadCustomTheme: () => false,
    onToggleOutline: noop,
    onToggleSourceMode: noop,
  };
}

describe('buildMenus 生产结构', () => {
  const menus = buildMenus(stubActions());
  const file = menus.find((m) => m.id === 'file');
  const edit = menus.find((m) => m.id === 'edit');

  it('五个顶级菜单齐全', () => {
    expect(menus.map((m) => m.id)).toEqual(['file', 'edit', 'insert', 'view', 'help']);
  });

  it('文件/编辑菜单的分隔项带 separator:true（P2[blocking] 回归）', () => {
    expect(file?.items.filter((i) => i.separator === true).length).toBeGreaterThanOrEqual(2);
    expect(edit?.items.some((i) => i.separator === true)).toBe(true);
  });

  it('文件菜单含「最近打开」子菜单入口（R12，VS Code 式）', () => {
    const item = file?.items.find((i) => i.id === 'file-recents');
    expect(item?.label).toBe('最近打开');
    expect(typeof item?.submenu).toBe('function');
  });

  it('文件菜单含「版本历史…」入口，无活动文件时禁用（R13）', () => {
    const item = file?.items.find((i) => i.id === 'file-versions');
    expect(item?.label).toBe('版本历史…');
    expect(item?.enabled?.()).toBe(false); // stub hasActiveFile → false
  });

  it('非分隔项不带 separator 且有非空 label（无空白按钮）', () => {
    for (const menu of menus) {
      for (const item of menu.items) {
        if (item.separator === true) {
          continue;
        }
        expect(item.separator ?? false).toBe(false);
        expect(item.label).not.toBe('');
      }
    }
  });

  it('视图菜单逐项列出全部预设主题，当前主题项禁用（R15）', () => {
    const viewMenus = buildMenus(stubActions('midnight'));
    const view = viewMenus.find((m) => m.id === 'view');
    const presetIds = ['warm-light', 'cool-light', 'dark', 'midnight'].map(
      (id) => `view-theme-${id}`,
    );
    const presetItems = view?.items.filter(
      (i) => i.separator !== true && i.id !== 'view-theme-toggle' && presetIds.includes(i.id),
    );
    expect(presetItems?.map((i) => i.id)).toEqual(presetIds);
    // 当前主题 midnight 禁用、其余启用。
    expect(presetItems?.find((i) => i.id === 'view-theme-midnight')?.enabled?.()).toBe(false);
    expect(presetItems?.find((i) => i.id === 'view-theme-warm-light')?.enabled?.()).toBe(true);
    // 热重载自定义主题入口存在。
    expect(view?.items.some((i) => i.id === 'view-reload-custom-theme')).toBe(true);
  });
});

describe('buildRecentsMenuItems（R12 最近打开子菜单）', () => {
  it('路径拆分为文件名 + 目录（兼容 / 与 \\）', () => {
    expect(pathBaseName('C:\\docs\\笔记.md')).toBe('笔记.md');
    expect(pathBaseName('/home/u/a.md')).toBe('a.md');
    expect(pathDirName('C:\\docs\\笔记.md')).toBe('C:\\docs');
    expect(pathDirName('/home/u/a.md')).toBe('/home/u');
    // 无目录段 → 空串（hint 不渲染）。
    expect(pathDirName('a.md')).toBe('');
  });

  it('空列表返回占位禁用项', () => {
    const items = buildRecentsMenuItems([], { open: () => undefined, clear: () => undefined });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('recents-empty');
    expect(items[0].enabled?.()).toBe(false);
  });

  it('每项 = 文件名 + 目录提示，末尾接清空入口；open/clear 正确派发', () => {
    const opened: string[] = [];
    let cleared = 0;
    const items = buildRecentsMenuItems(['C:\\docs\\a.md', '/home/u/b.md'], {
      open: (p) => opened.push(p),
      clear: () => {
        cleared += 1;
      },
    });
    expect(items.map((i) => i.id)).toEqual(['recent-0', 'recent-1', 'recents-sep', 'recents-clear']);
    expect(items[0].label).toBe('a.md');
    expect(items[0].hint).toBe('C:\\docs');
    expect(items[1].label).toBe('b.md');
    expect(items[2].separator).toBe(true);
    items[0].action();
    items[3].action();
    expect(opened).toEqual(['C:\\docs\\a.md']);
    expect(cleared).toBe(1);
  });
});
