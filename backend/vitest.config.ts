import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // The integration suite shares one embedded database, so files must not run
    // in parallel against it.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    include: ['src/**/*.test.ts'],
    reporters: ['default'],
  },
});
