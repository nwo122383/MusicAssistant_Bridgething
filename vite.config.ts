import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const massUrl = env.MASS_URL?.replace(/\/$/, "");
  const massProxy = massUrl
    ? {
        "/mass": {
          target: massUrl,
          changeOrigin: true,
          ws: true,
          rewrite: (path: string) => path.replace(/^\/mass/, ""),
        },
      }
    : undefined;

  return {
    plugins: [react()],
    base: "./",
    server: {
      port: 4173,
      proxy: massProxy,
    },
    preview: {
      port: 4173,
      proxy: massProxy,
    },
    build: { target: mode === "bridgething" ? "es2022" : "chrome69", sourcemap: true },
    test: { environment: "jsdom" },
  };
});
