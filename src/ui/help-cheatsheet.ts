/**
 * `help-cheatsheet` — 快捷键速查表（R5）。纯渲染：输入动作标签→快捷键绑定，
 * 输出可在帮助菜单/对话框挂载的 DOM 列表。无副作用，便于 headless 测试。
 *
 * `doc` 注入（生产默认全局 document），与 outline-view 的可测试性模式一致。
 */

export interface CheatBinding {
  label: string;
  shortcut: string;
}

/** 渲染快捷键速查表为 <ul>。 */
export function renderCheatsheet(
  bindings: readonly CheatBinding[],
  doc: Document = document,
): HTMLUListElement {
  const list = doc.createElement('ul');
  list.className = 'lightink-cheatsheet';
  for (const binding of bindings) {
    const item = doc.createElement('li');
    item.className = 'lightink-cheatsheet-item';
    const label = doc.createElement('span');
    label.className = 'lightink-cheatsheet-label';
    label.textContent = binding.label;
    const shortcut = doc.createElement('kbd');
    shortcut.className = 'lightink-cheatsheet-shortcut';
    shortcut.textContent = binding.shortcut;
    item.append(label, shortcut);
    list.appendChild(item);
  }
  return list;
}
