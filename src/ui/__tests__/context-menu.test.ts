/**
 * context-menu 纯逻辑测试（R3）：按上下文决定菜单项 enabled。
 *
 * 不覆盖（需 DOM/挂载）：createContextMenu 的浮层渲染/定位/关闭 —— 属挂载态（仅断言工厂形态）。
 */
import { describe, expect, it } from 'vitest';

import {
  buildEditorContextMenuItems,
  buildTabContextMenuItems,
  createContextMenu,
  type EditorMenuActions,
  type TabMenuActions,
} from '../context-menu.js';

const noopActions = (): EditorMenuActions => ({
  cut: () => undefined,
  copy: () => undefined,
  paste: () => undefined,
  pastePlain: () => undefined,
  bold: () => undefined,
  italic: () => undefined,
  link: () => undefined,
  openLink: () => undefined,
  copyLinkAddress: () => undefined,
});

const noopTabActions = (): TabMenuActions => ({
  close: () => undefined,
  closeOthers: () => undefined,
  copyPath: () => undefined,
  revealInFiles: () => undefined,
});

function enabledMap(items: ReturnType<typeof buildEditorContextMenuItems>): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const item of items) {
    if (item.separator === true) continue;
    map[item.id] = item.enabled ? item.enabled() : true;
  }
  return map;
}

describe('buildEditorContextMenuItems (R3)', () => {
  it('disables cut/copy and format actions when there is no selection', () => {
    const m = enabledMap(buildEditorContextMenuItems({ hasSelection: false, hasLink: false }, noopActions()));
    expect(m['cut']).toBe(false);
    expect(m['copy']).toBe(false);
    expect(m['bold']).toBe(false);
    expect(m['italic']).toBe(false);
    expect(m['link']).toBe(false);
    // paste 始终可用
    expect(m['paste']).toBe(true);
    expect(m['paste-plain']).toBe(true);
  });

  it('enables cut/copy/format when there is a selection', () => {
    const m = enabledMap(buildEditorContextMenuItems({ hasSelection: true, hasLink: false }, noopActions()));
    expect(m['cut']).toBe(true);
    expect(m['copy']).toBe(true);
    expect(m['bold']).toBe(true);
    expect(m['italic']).toBe(true);
    expect(m['link']).toBe(true);
  });

  it('disables link open/copy when not on a link, enables when on a link', () => {
    const off = enabledMap(buildEditorContextMenuItems({ hasSelection: true, hasLink: false }, noopActions()));
    expect(off['open-link']).toBe(false);
    expect(off['copy-link']).toBe(false);
    const on = enabledMap(buildEditorContextMenuItems({ hasSelection: true, hasLink: true }, noopActions()));
    expect(on['open-link']).toBe(true);
    expect(on['copy-link']).toBe(true);
  });

  it('includes separators between the clipboard / format / link groups', () => {
    const items = buildEditorContextMenuItems({ hasSelection: true, hasLink: true }, noopActions());
    const seps = items.filter((i) => i.separator === true);
    expect(seps.length).toBe(2);
  });
});

describe('buildTabContextMenuItems (R3)', () => {
  function tabEnabledMap(ctx: { hasFile: boolean }): Record<string, boolean> {
    const map: Record<string, boolean> = {};
    for (const item of buildTabContextMenuItems(ctx, noopTabActions())) {
      if (item.separator === true) continue;
      map[item.id] = item.enabled ? item.enabled() : true;
    }
    return map;
  }

  it('always enables close/close-others', () => {
    expect(tabEnabledMap({ hasFile: false })['close']).toBe(true);
    expect(tabEnabledMap({ hasFile: false })['close-others']).toBe(true);
    expect(tabEnabledMap({ hasFile: true })['close']).toBe(true);
  });

  it('disables copy-path/reveal for unsaved tabs (no file path)', () => {
    const m = tabEnabledMap({ hasFile: false });
    expect(m['copy-path']).toBe(false);
    expect(m['reveal']).toBe(false);
  });

  it('enables copy-path/reveal when a file path exists', () => {
    const m = tabEnabledMap({ hasFile: true });
    expect(m['copy-path']).toBe(true);
    expect(m['reveal']).toBe(true);
  });
});

describe('createContextMenu (factory shape)', () => {
  it('exposes the createContextMenu function', () => {
    expect(typeof createContextMenu).toBe('function');
  });
});
