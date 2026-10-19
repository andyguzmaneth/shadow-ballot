import { defineConfig } from 'vitest/config';
// The spike (Ch6 §6.8) is explored, not evaluated: it is kept out of the main
// suite so Ch4's test counts describe only the implementation under evaluation.
export default defineConfig({ test: { include: ['spike/**/*.test.ts'] } });
