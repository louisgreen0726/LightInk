// @vitest-environment jsdom
/**
 * setTabActive 回归：侧栏 portal 到共享 chrome（#lightink-main），不随标签宿主
 * display:none 一起隐藏；切走标签必须显式隐藏，切回按原偏好恢复。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createReaderView } from '../reader-view.js';

describe('setTabActive 覆盖层同步', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('切走隐藏 portal 侧栏，切回恢复（用户偏好不丢）', async () => {
    document.body.innerHTML = '<div id="lightink-main"><div id="host"></div></div>';
    const host = document.getElementById('host')!;
    const view = createReaderView(host, { t: (key) => key });

    view.toggleSidebar(); // 打开侧栏（portal 到 #lightink-main）
    const sidebar = document.querySelector<HTMLElement>('.lightink-reader-sidebar');
    expect(sidebar).not.toBeNull();
    expect(sidebar!.hidden).toBe(false);

    view.setTabActive(false);
    expect(sidebar!.hidden).toBe(true); // 不残留显示

    view.setTabActive(true);
    expect(sidebar!.hidden).toBe(false); // 偏好恢复，无需重新打开

    // 侧栏关闭状态下切走/切回，不会把侧栏带回来。
    view.toggleSidebar();
    view.setTabActive(false);
    view.setTabActive(true);
    expect(sidebar!.hidden).toBe(true);

    await view.destroy();
  });
});
