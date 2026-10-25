import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals:     true,
    environment: 'node',
    include:     ['src/test/**/*.test.js', 'tests/**/*.test.js'],
    // Run test files serially so each seeds its own DB without conflicts
    pool:        'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30000,
    hookTimeout: 30000,
    sequence:    { concurrent: false }
  }
});
