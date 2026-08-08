/**
 * app-shell buildMenus 生产结构回归测试（R2）：
 * 基于生产 buildMenus 产出（而非手写 spec）断言分隔项与菜单结构，
 * 防止「分隔符漏设 separator:true 而渲染为空白可点击按钮」的回归。
 */

import { describe, expect, it } from 'vitest';

import type { InsertElementId } from '../../editor/insert-commands.js';
import type { BuiltinThemeId } from '../../theme/theme-service.js';
import { buildMenus, type AppShellActions } from '../app-shell.js';

function stubActions(currentThemeId = 'warm-light'): AppShellActions {
  const noop = (): void => undefined;
  return {
    onNew: noop,
    onOpen: noop,
    listRecents: () => Promise.resolve([]),
    openRecent: () => Promise.resolve(false),
    clearRecents: () => Promise.resolve(),
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

  it('文件菜单含「最近打开…」入口（R12）', () => {
    expect(file?.items.some((i) => i.id === 'file-recents' && i.label === '最近打开…')).toBe(true);
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
    const viewMenus = buildMenus(stubActions('sepia'));
    const view = viewMenus.find((m) => m.id === 'view');
    const presetIds = ['warm-light', 'cool-light', 'sepia', 'dark', 'midnight', 'forest'].map(
      (id) => `view-theme-${id}`,
    );
    const presetItems = view?.items.filter(
      (i) => i.separator !== true && i.id !== 'view-theme-toggle' && presetIds.includes(i.id),
    );
    expect(presetItems?.map((i) => i.id)).toEqual(presetIds);
    // 当前主题 sepia 禁用、其余启用。
    expect(presetItems?.find((i) => i.id === 'view-theme-sepia')?.enabled?.()).toBe(false);
    expect(presetItems?.find((i) => i.id === 'view-theme-warm-light')?.enabled?.()).toBe(true);
    // 热重载自定义主题入口存在。
    expect(view?.items.some((i) => i.id === 'view-reload-custom-theme')).toBe(true);
  });
});
