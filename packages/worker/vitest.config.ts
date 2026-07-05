import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: false,
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { decoratorMetadata: true },
        target: "es2023",
      },
    }),
  ],
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
    },
  },
});
