import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // R7：共享模块图降低全量测试时长——isolate:false 复用单 worker 模块加载，
    // 显著减少 91 个测试文件的重复 import/transform 开销。
    pool: 'forks',
    isolate: false,
    coverage: { enabled: false },
  },
});
