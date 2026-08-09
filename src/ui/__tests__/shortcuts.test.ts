/**
 * ShortcutRegistry 行为测试（node 环境，fake 事件驱动）：
 *   - 默认键位映射正确（新建/打开/保存/另存为/主题切换）；
 *   - 组合键匹配（Ctrl/Cmd 等价、Shift 区分、错误键不命中）；
 *   - 命中后 preventDefault 并派发到对应处理器；
 *   - 编辑器/输入框焦点下带 Ctrl 的快捷键（尤其保存）仍然生效；
 *   - 无修饰键组合在可编辑目标内被忽略。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SHORTCUTS,
  isEditableTarget,
  matchEvent,
  ShortcutRegistry,
  type KeyboardEventLike,
} from '../shortcuts.js';

function keyEvent(overrides: Partial<KeyboardEventLike> = {}): KeyboardEventLike & {
  prevented: boolean;
} {
  const state = { prevented: false };
  return {
    key: 's',
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: null,
    get prevented() {
      return state.prevented;
    },
    preventDefault() {
      state.prevented = true;
    },
    ...overrides,
  };
}

describe('默认键位映射', () => {
  it('核心操作各有一个快捷键（含 R5 补齐的插入/大纲/源码模式）', () => {
    expect(DEFAULT_SHORTCUTS).toEqual({
      new: 'Ctrl+N',
      open: 'Ctrl+O',
      save: 'Ctrl+S',
      'save-as': 'Ctrl+Shift+S',
      'toggle-theme': 'Ctrl+J',
      'insert-link': 'Ctrl+K',
      'insert-image': 'Ctrl+Alt+I',
      'toggle-outline': 'Ctrl+Shift+L',
      'toggle-source-mode': 'Ctrl+/',
      'toggle-menu-chrome': 'Alt+M',
      'toggle-tabs-chrome': 'Alt+T',
      'toggle-chrome-pin': 'Alt+P',
      'toggle-fullscreen': 'F11',
      'next-tab': 'Ctrl+Tab',
      'prev-tab': 'Ctrl+Shift+Tab',
      'zoom-in': 'Ctrl+=',
      'zoom-out': 'Ctrl+-',
      'zoom-reset': 'Ctrl+0',
    });
  });
});

describe('matchEvent 组合键匹配', () => {
  it('Ctrl+S 命中 Ctrl+S，大小写不敏感', () => {
    expect(matchEvent(keyEvent({ key: 's' }), 'Ctrl+S')).toBe(true);
    expect(matchEvent(keyEvent({ key: 'S' }), 'Ctrl+S')).toBe(true);
  });

  it('macOS Cmd（metaKey）与 Ctrl 等价', () => {
    expect(matchEvent(keyEvent({ ctrlKey: false, metaKey: true }), 'Ctrl+S')).toBe(true);
  });

  it('缺少/多余的修饰键不命中', () => {
    expect(matchEvent(keyEvent({ ctrlKey: false }), 'Ctrl+S')).toBe(false);
    expect(matchEvent(keyEvent({ shiftKey: true }), 'Ctrl+S')).toBe(false);
    expect(matchEvent(keyEvent(), 'Ctrl+Shift+S')).toBe(false);
  });

  it('Ctrl+Shift+S 精确命中另存为', () => {
    expect(matchEvent(keyEvent({ shiftKey: true }), 'Ctrl+Shift+S')).toBe(true);
  });

  it('错误的键不命中', () => {
    expect(matchEvent(keyEvent({ key: 'x' }), 'Ctrl+S')).toBe(false);
  });
});

describe('isEditableTarget', () => {
  it('识别 input/textarea/contentEditable', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'textarea' })).toBe(true);
    expect(isEditableTarget({ isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('ShortcutRegistry 派发', () => {
  function makeRegistry() {
    const handlers = {
      new: vi.fn(),
      open: vi.fn(),
      save: vi.fn(),
      'save-as': vi.fn(),
      'toggle-theme': vi.fn(),
    };
    return { handlers, registry: new ShortcutRegistry(handlers) };
  }

  it('命中组合键：preventDefault + 派发对应处理器，返回 true', () => {
    const { handlers, registry } = makeRegistry();
    const e = keyEvent({ key: 's' });
    expect(registry.handleKeyDown(e)).toBe(true);
    expect(e.prevented).toBe(true);
    expect(handlers.save).toHaveBeenCalledTimes(1);
    expect(handlers.open).not.toHaveBeenCalled();
  });

  it('Ctrl+Shift+S 派发另存为而非保存', () => {
    const { handlers, registry } = makeRegistry();
    expect(registry.handleKeyDown(keyEvent({ key: 's', shiftKey: true }))).toBe(true);
    expect(handlers['save-as']).toHaveBeenCalledTimes(1);
    expect(handlers.save).not.toHaveBeenCalled();
  });

  it('未注册/未命中的键返回 false 且不 preventDefault', () => {
    const { registry } = makeRegistry();
    const e = keyEvent({ key: 'x' });
    expect(registry.handleKeyDown(e)).toBe(false);
    expect(e.prevented).toBe(false);
  });

  it('主题切换（Ctrl+J）派发', () => {
    const { handlers, registry } = makeRegistry();
    expect(registry.handleKeyDown(keyEvent({ key: 'j' }))).toBe(true);
    expect(handlers['toggle-theme']).toHaveBeenCalledTimes(1);
  });

  it('标签 chrome 与切换（Alt+T / Ctrl+Tab / Ctrl+Shift+Tab）派发', () => {
    const handlers = {
      'toggle-tabs-chrome': vi.fn(),
      'next-tab': vi.fn(),
      'prev-tab': vi.fn(),
    };
    const registry = new ShortcutRegistry(handlers);
    expect(
      registry.handleKeyDown(
        keyEvent({ key: 't', ctrlKey: false, altKey: true }),
      ),
    ).toBe(true);
    expect(handlers['toggle-tabs-chrome']).toHaveBeenCalledTimes(1);
    expect(registry.handleKeyDown(keyEvent({ key: 'Tab' }))).toBe(true);
    expect(handlers['next-tab']).toHaveBeenCalledTimes(1);
    expect(registry.handleKeyDown(keyEvent({ key: 'Tab', shiftKey: true }))).toBe(true);
    expect(handlers['prev-tab']).toHaveBeenCalledTimes(1);
  });

  it('固定导航栏（Alt+P）与全屏（F11）派发', () => {
    const handlers = {
      'toggle-chrome-pin': vi.fn(),
      'toggle-fullscreen': vi.fn(),
    };
    const registry = new ShortcutRegistry(handlers);
    expect(
      registry.handleKeyDown(keyEvent({ key: 'p', ctrlKey: false, altKey: true })),
    ).toBe(true);
    expect(handlers['toggle-chrome-pin']).toHaveBeenCalledTimes(1);
    expect(
      registry.handleKeyDown(keyEvent({ key: 'F11', ctrlKey: false })),
    ).toBe(true);
    expect(handlers['toggle-fullscreen']).toHaveBeenCalledTimes(1);
  });

  it('编辑器（contentEditable）焦点下保存等 Ctrl 快捷键仍生效', () => {
    const { handlers, registry } = makeRegistry();
    const editable = { isContentEditable: true };
    expect(registry.handleKeyDown(keyEvent({ key: 's', target: editable }))).toBe(true);
    expect(handlers.save).toHaveBeenCalledTimes(1);
    expect(registry.handleKeyDown(keyEvent({ key: 'n', target: editable }))).toBe(true);
    expect(handlers.new).toHaveBeenCalledTimes(1);
  });

  it('无修饰键的打印键在可编辑目标内被忽略；功能键（F11）仍生效', () => {
    const plain = vi.fn();
    const fullscreen = vi.fn();
    const registry = new ShortcutRegistry(
      { 'toggle-theme': plain, 'toggle-fullscreen': fullscreen },
      { ...DEFAULT_SHORTCUTS, 'toggle-theme': 'x' },
    );
    const inEditor = keyEvent({ key: 'x', ctrlKey: false, target: { isContentEditable: true } });
    expect(registry.handleKeyDown(inEditor)).toBe(false);
    expect(plain).not.toHaveBeenCalled();
    // F11 must work even when focus is in the editor (immersive fullscreen).
    expect(
      registry.handleKeyDown(
        keyEvent({ key: 'F11', ctrlKey: false, target: { isContentEditable: true } }),
      ),
    ).toBe(true);
    expect(fullscreen).toHaveBeenCalledTimes(1);
  });

  it('attach/detach 以捕获阶段注册 keydown 监听', () => {
    const { registry } = makeRegistry();
    const added: Array<{ type: string; capture?: boolean }> = [];
    const target = {
      addEventListener: vi.fn((type: string, _l: unknown, capture?: boolean) => {
        added.push({ type, capture });
      }),
      removeEventListener: vi.fn(),
    };
    registry.attach(target);
    expect(added).toEqual([{ type: 'keydown', capture: true }]);
    registry.detach(target);
    expect(target.removeEventListener).toHaveBeenCalledWith(
      'keydown',
      expect.any(Function),
      true,
    );
  });

  it('entries 列出已注册动作及其组合键（供快捷键速查表）', () => {
    const { registry } = makeRegistry();
    const entries = registry.entries();
    const actions = entries.map((e) => e.action);
    expect(actions).toEqual(['new', 'open', 'save', 'save-as', 'toggle-theme']);
    expect(entries[0]).toEqual({ action: 'new', combo: 'Ctrl+N' });
  });
});
