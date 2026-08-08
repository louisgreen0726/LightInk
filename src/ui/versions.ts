/**
 * `versions` — 本地版本快照 UI（R13）：版本历史弹层（列表/预览/恢复/手动存档）。
 *
 * 后端 `snapshot::list_versions/read_version/restore_version/create_version`
 * 负责存储（每文件版本集、上限淘汰、恢复前自动存档）；本模块仅渲染弹层并
 * 经注入的 [`VersionActions`] 与后端 + 编辑器交互。纯逻辑 [`newestFirst`] 可单测。
 */

export interface VersionMeta {
  id: string;
  created_at_ms: number;
}

export interface VersionActions {
  /** 列出全部版本（后端已最新在前；此处不再排序以保证与后端一致）。 */
  list(): Promise<VersionMeta[]>;
  /** 读取某版本完整内容（预览）。 */
  read(id: string): Promise<string>;
  /** 恢复某版本：后端先存当前内容再返回目标，前端写回编辑器并置脏。 */
  restore(id: string): Promise<void>;
  /** 手动把当前内容存为一个新版本。 */
  saveCurrent(): Promise<void>;
}

/** 纯逻辑：按 created_at_ms 降序（最新在前）。后端已降序返回，本函数作契约保证。 */
export function newestFirst(metas: readonly VersionMeta[]): VersionMeta[] {
  return [...metas].sort((a, b) => b.created_at_ms - a.created_at_ms);
}

/** 创建版本历史弹层并挂载到 document.body。 */
export function showVersionsModal(doc: Document, actions: VersionActions): void {
  const overlay = doc.createElement('div');
  overlay.className = 'lightink-modal-overlay';
  const dialog = doc.createElement('div');
  dialog.className = 'lightink-modal-dialog lightink-versions-dialog';
  const title = doc.createElement('div');
  title.className = 'lightink-modal-title';
  title.textContent = '版本历史';
  const listEl = doc.createElement('div');
  listEl.className = 'lightink-versions-list';
  listEl.textContent = '加载中…';
  const preview = doc.createElement('pre');
  preview.className = 'lightink-versions-preview';
  preview.textContent = '选择左侧版本以预览';
  const restoreBtn = doc.createElement('button');
  restoreBtn.type = 'button';
  restoreBtn.className = 'lightink-versions-restore';
  restoreBtn.textContent = '恢复此版本';
  restoreBtn.disabled = true;
  const saveBtn = doc.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'lightink-versions-save';
  saveBtn.textContent = '保存当前为新版本';
  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'lightink-modal-close';
  closeBtn.textContent = '关闭';
  const footer = doc.createElement('div');
  footer.className = 'lightink-versions-footer';
  footer.append(restoreBtn, saveBtn, closeBtn);
  dialog.append(title, listEl, preview, footer);
  overlay.appendChild(dialog);

  let selectedId: string | null = null;

  function dismiss(): void {
    doc.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      dismiss();
    }
  }
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) {
      dismiss();
    }
  });
  closeBtn.addEventListener('click', dismiss);
  restoreBtn.addEventListener('click', () => {
    if (selectedId === null) {
      return;
    }
    const id = selectedId;
    dismiss();
    void actions.restore(id);
  });
  saveBtn.addEventListener('click', () => {
    void actions.saveCurrent();
  });

  function selectRow(id: string, row: HTMLButtonElement): void {
    selectedId = id;
    for (const el of listEl.querySelectorAll('.lightink-versions-item')) {
      el.classList.remove('selected');
    }
    row.classList.add('selected');
    restoreBtn.disabled = false;
    preview.textContent = '加载中…';
    void actions
      .read(id)
      .then((content) => {
        preview.textContent = content;
      })
      .catch(() => {
        preview.textContent = '（无法读取该版本）';
      });
  }

  function renderRows(metas: readonly VersionMeta[]): void {
    listEl.replaceChildren();
    if (metas.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'lightink-versions-empty';
      empty.textContent = '暂无版本';
      listEl.appendChild(empty);
      return;
    }
    for (const meta of newestFirst(metas)) {
      const row = doc.createElement('button');
      row.type = 'button';
      row.className = 'lightink-versions-item';
      row.textContent = formatVersionTime(meta.created_at_ms);
      row.addEventListener('click', () => selectRow(meta.id, row));
      listEl.appendChild(row);
    }
  }

  doc.addEventListener('keydown', onKey);
  doc.body.appendChild(overlay);
  closeBtn.focus();
  void actions
    .list()
    .then(renderRows)
    .catch(() => renderRows([]));
}

/** 把毫秒时间戳格式化为本地可读串（运行时 UI，非单测对象）。 */
function formatVersionTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return `版本 ${ms}`;
  }
}
