import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  build: {
    // 字体资产一律内联为 data URI：导出的独立 HTML（T10, R5）经 file://
    // 打开时没有任何 /assets/ 基座，KaTeX @font-face 的 url() 必须随 CSS
    // 文本自包含，否则公式字体 404。本地桌面应用内联成本可接受。
    assetsInlineLimit: (filePath: string) =>
      /\.(?:woff2?|ttf|otf|eot)(?:\?.*)?$/.test(filePath) || undefined,
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
