import swc from "unplugin-swc";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: false,
  plugins: [
    swc.vite({
      jsc: {
        parser: {
          syntax: "typescript",
          decorators: true,
        },
        transform: {
          decoratorMetadata: true,
        },
        target: "es2023",
      },
    }),
  ],
  test: {
    globals: true,
    environment: "node",
    env: {
      AGEWORK_DATA_DIR: join(tmpdir(), "agework-server-tests"),
    },
    include: ["src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
    },
  },
});
