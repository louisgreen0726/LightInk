/**
 * ThemeService 行为测试（node 环境，全依赖注入 fake）：
 *   - 首次启动默认 warm-light（无 localStorage 值、不跟随系统偏好）；
 *   - 上次选择的恢复与非法值回退；
 *   - apply 设置 data-theme 并持久化；
 *   - toggle 浅色 ↔ 深色切换且持久化；
 *   - 自定义主题的注入/热替换/文件重载/重置。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  BUILTIN_THEMES,
  CUSTOM_THEME_ID,
  CUSTOM_THEME_PATH_KEY,
  ThemeService,
  THEME_STORAGE_KEY,
  type StorageLike,
  type ThemeServiceDeps,
} from '../theme-service.js';

interface Harness {
  service: ThemeService;
  attrs: Map<string, string>;
  slot: { css: string | null };
  store: Map<string, string>;
  files: Map<string, string>;
}

function makeHarness(options: { savedTheme?: string; savedCustomPath?: string } = {}): Harness {
  const attrs = new Map<string, string>();
  const slot: { css: string | null } = { css: null };
  const store = new Map<string, string>();
  if (options.savedTheme !== undefined) {
    store.set(THEME_STORAGE_KEY, options.savedTheme);
  }
  if (options.savedCustomPath !== undefined) {
    store.set(CUSTOM_THEME_PATH_KEY, options.savedCustomPath);
  }
  const files = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
  const deps: ThemeServiceDeps = {
    root: {
      setAttribute: (name, value) => {
        attrs.set(name, value);
      },
    },
    customStyleSlot: {
      set: (css) => {
        slot.css = css;
      },
      clear: () => {
        slot.css = null;
      },
    },
    storage,
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`fake fs: no such file ${path}`);
      }
      return content;
    }),
  };
  return { service: new ThemeService(deps), attrs, slot, store, files };
}

describe('ThemeService 内置主题', () => {
  it('首次启动（无存储值）默认 warm-light 并设置 data-theme', () => {
    const h = makeHarness();
    expect(h.service.currentThemeId).toBe('warm-light');
    expect(h.attrs.get('data-theme')).toBe('warm-light');
  });

  it('列出全部内置预设主题（R15：6 套，浅/深各三）', () => {
    const h = makeHarness();
    expect(h.service.builtinThemes().map((t) => t.id)).toEqual([
      'warm-light',
      'cool-light',
      'sepia',
      'dark',
      'midnight',
      'forest',
    ]);
    expect(BUILTIN_THEMES.some((t) => t.id === 'warm-light')).toBe(true);
  });

  it('每个内置主题 id 均可 apply 并切换 data-theme', () => {
    const h = makeHarness();
    for (const theme of BUILTIN_THEMES) {
      h.service.apply(theme.id);
      expect(h.attrs.get('data-theme')).toBe(theme.id);
      expect(h.store.get(THEME_STORAGE_KEY)).toBe(theme.id);
    }
  });

  it('恢复上次保存的合法主题', () => {
    const h = makeHarness({ savedTheme: 'dark' });
    expect(h.service.currentThemeId).toBe('dark');
    expect(h.attrs.get('data-theme')).toBe('dark');
  });

  it('非法存储值回退默认 warm-light', () => {
    const h = makeHarness({ savedTheme: 'neon-pink' });
    expect(h.service.currentThemeId).toBe('warm-light');
    expect(h.attrs.get('data-theme')).toBe('warm-light');
  });

  it('apply 设置 data-theme 属性并持久化，且清除自定义注入', () => {
    const h = makeHarness();
    h.service.loadCustomTheme(':root { --lightink-bg: #000; }');
    h.service.apply('dark');
    expect(h.attrs.get('data-theme')).toBe('dark');
    expect(h.store.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(h.slot.css).toBeNull();
  });

  it('apply 拒绝未知内置主题 id', () => {
    const h = makeHarness();
    expect(() => h.service.apply('blue' as never)).toThrow(/unknown builtin theme/);
  });

  it('toggle 在 warm-light ↔ dark 间切换并持久化', () => {
    const h = makeHarness();
    expect(h.service.toggle()).toBe('dark');
    expect(h.attrs.get('data-theme')).toBe('dark');
    expect(h.store.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(h.service.toggle()).toBe('warm-light');
    expect(h.attrs.get('data-theme')).toBe('warm-light');
    expect(h.store.get(THEME_STORAGE_KEY)).toBe('warm-light');
  });
});

describe('ThemeService 自定义主题（热替换）', () => {
  it('loadCustomTheme 注入样式并标记 custom 激活', () => {
    const h = makeHarness();
    const css = ':root { --lightink-bg: #123456; }';
    h.service.loadCustomTheme(css, '/themes/mine.css');
    expect(h.service.currentThemeId).toBe(CUSTOM_THEME_ID);
    expect(h.service.isCustomThemeActive).toBe(true);
    expect(h.slot.css).toBe(css);
    expect(h.attrs.get('data-theme')).toBe(CUSTOM_THEME_ID);
    expect(h.store.get(THEME_STORAGE_KEY)).toBe(CUSTOM_THEME_ID);
    expect(h.store.get(CUSTOM_THEME_PATH_KEY)).toBe('/themes/mine.css');
  });

  it('重复 loadCustomTheme 覆盖注入内容（热替换，无需重启）', () => {
    const h = makeHarness();
    h.service.loadCustomTheme('/* v1 */ :root { --lightink-bg: #111111; }');
    const v2 = '/* v2 */ :root { --lightink-bg: #222222; }';
    h.service.loadCustomTheme(v2);
    expect(h.slot.css).toBe(v2);
  });

  it('reloadCustomThemeFile 重新读文件并覆盖注入', async () => {
    const h = makeHarness();
    h.files.set('/themes/mine.css', '/* v1 */');
    h.service.loadCustomTheme(h.files.get('/themes/mine.css') as string, '/themes/mine.css');
    // 文件被外部修改后重载 → 注入内容随之更新。
    h.files.set('/themes/mine.css', '/* v2 hot */');
    const ok = await h.service.reloadCustomThemeFile();
    expect(ok).toBe(true);
    expect(h.slot.css).toBe('/* v2 hot */');
  });

  it('无路径且未加载过自定义主题时 reload 返回 false', async () => {
    const h = makeHarness();
    expect(await h.service.reloadCustomThemeFile()).toBe(false);
  });

  it('resetCustomTheme 清除注入并回到默认 warm-light', () => {
    const h = makeHarness();
    h.service.loadCustomTheme('/* x */', '/themes/mine.css');
    h.service.resetCustomTheme();
    expect(h.service.currentThemeId).toBe('warm-light');
    expect(h.service.isCustomThemeActive).toBe(false);
    expect(h.slot.css).toBeNull();
    expect(h.attrs.get('data-theme')).toBe('warm-light');
    expect(h.store.get(THEME_STORAGE_KEY)).toBe('warm-light');
    expect(h.store.has(CUSTOM_THEME_PATH_KEY)).toBe(false);
  });
});
