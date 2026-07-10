import { existsSync, readFileSync } from "node:fs";
import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const API_PATH = "/api/v1";

function readEnvFile(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {};

  const values: Record<string, string> = {};
  const content = readFileSync(envPath, "utf8");

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (match) values[match[1]] = unquoteEnvValue(match[2]);
  }

  return values;
}

function unquoteEnvValue(rawValue: string): string {
  const value = rawValue.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeBasePath(value: string | undefined): string {
  const trimmed = value?.trim();

  if (!trimmed || trimmed === "." || trimmed === "./" || /^\/+$/.test(trimmed)) {
    return "";
  }

  const normalized = trimmed
    .replace(/^\.\//, "")
    .split("/")
    .filter(Boolean)
    .join("/");
  return normalized ? `/${normalized}` : "";
}

function joinPaths(...paths: string[]): string {
  const joined = paths
    .map((path) => normalizeBasePath(path))
    .filter(Boolean)
    .join("");

  return joined || "/";
}

function firstEnvValue(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.trim());
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const webEnv = loadEnv(mode, __dirname, "");
  const apiEnv = readEnvFile(path.resolve(__dirname, "../server/.env"));
  const appBasePath = normalizeBasePath(
    firstEnvValue(
      process.env.VITE_APP_BASE_PATH,
      webEnv.VITE_APP_BASE_PATH,
      apiEnv.AGEWORK_CONTEXT,
    ),
  );
  const apiContext = normalizeBasePath(
    firstEnvValue(
      process.env.VITE_APP_API_CONTEXT,
      webEnv.VITE_APP_API_CONTEXT,
      apiEnv.AGEWORK_CONTEXT,
    ),
  );
  const apiPort = process.env.PORT ?? apiEnv.PORT ?? "3000";
  const apiBasePath = joinPaths(apiContext, API_PATH);

  return {
    base: appBasePath ? `${appBasePath}/` : "/",
    define: {
      "import.meta.env.VITE_APP_API_CONTEXT": JSON.stringify(apiContext),
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (id.includes("node_modules")) {
              if (id.includes("react-dom") || id.includes("/react/")) {
                return "vendor-react";
              }
              if (id.includes("@tanstack/react-router")) {
                return "vendor-router";
              }
              if (id.includes("@tanstack/react-query")) {
                return "vendor-query";
              }
              if (id.includes("radix-ui") || id.includes("@radix-ui")) {
                return "vendor-ui";
              }
              if (id.includes("@assistant-ui") || id.includes("assistant-stream") || id.includes("streamdown")) {
                return "vendor-assistant";
              }
              if (id.includes("zustand")) {
                return "vendor-state";
              }
              if (id.includes("i18next") || id.includes("react-i18next")) {
                return "vendor-i18n";
              }
            }
          },
        },
      },
    },
    server: {
      host: true,
      proxy: {
        [apiBasePath]: {
          target: `http://localhost:${apiPort}`,
        },
      },
    },
  };
});
