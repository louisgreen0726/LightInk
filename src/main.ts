import { mountEditor } from './editor/index.js';

const app = document.querySelector<HTMLDivElement>('#app');
if (app === null) {
  throw new Error('LightInk: #app root container not found in index.html');
}

const host = document.createElement('div');
host.id = 'lightink-editor';
host.className = 'lightink-editor-host';
app.replaceChildren(host);

void mountEditor(host, {
  initialMarkdown: '# 轻墨 LightInk\n\n开始书写。\n',
}).catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[lightink] mountEditor failed:', err);
});
