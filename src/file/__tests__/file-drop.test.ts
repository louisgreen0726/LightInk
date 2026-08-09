/**
 * file-drop 分类逻辑测试：拖入路径按 开标签 / 插图 / 不支持 分组，
 * 扩展名大小写与路径分隔符（/ 与 \）不敏感，组内保持原顺序。
 */

import { describe, expect, it } from 'vitest';

import { planDroppedFiles } from '../file-drop.js';

describe('planDroppedFiles', () => {
  it('Markdown 开标签、图片插入、其他不支持', () => {
    const plan = planDroppedFiles([
      'C:\\docs\\笔记.md',
      'D:\\img\\photo.png',
      'C:\\readme.txt',
      '/home/u/paper.markdown',
      '/home/u/pic.JPG',
    ]);
    expect(plan.markdown).toEqual(['C:\\docs\\笔记.md', '/home/u/paper.markdown']);
    expect(plan.images).toEqual(['D:\\img\\photo.png', '/home/u/pic.JPG']);
    expect(plan.unsupported).toEqual(['C:\\readme.txt']);
  });

  it('扩展名大小写不敏感；无扩展名与末尾点归入不支持', () => {
    const plan = planDroppedFiles(['a.MD', 'b.PnG', 'noext', 'dot.']);
    expect(plan.markdown).toEqual(['a.MD']);
    expect(plan.images).toEqual(['b.PnG']);
    expect(plan.unsupported).toEqual(['noext', 'dot.']);
  });

  it('隐藏文件（开头点）不误判为扩展名', () => {
    const plan = planDroppedFiles(['.gitignore', '.md']);
    // 「.md」整体是文件名而非扩展名 → 不支持（与 extFromFileName 口径不同，
    // 拖放场景下隐藏文件不该被当作 Markdown 打开）。
    expect(plan.unsupported).toEqual(['.gitignore', '.md']);
  });

  it('空输入返回空计划', () => {
    const plan = planDroppedFiles([]);
    expect(plan.markdown).toEqual([]);
    expect(plan.images).toEqual([]);
    expect(plan.unsupported).toEqual([]);
  });

  it('全部图片扩展名与 asset.rs 白名单一致', () => {
    const plan = planDroppedFiles([
      'a.png',
      'b.jpg',
      'c.jpeg',
      'd.gif',
      'e.webp',
      'f.svg',
    ]);
    expect(plan.images).toHaveLength(6);
    expect(plan.unsupported).toEqual([]);
  });
});
