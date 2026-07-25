import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
    plugins: [react()],
    base: "./",
    server: { port: 4173 },
    build: { target: "chrome100", sourcemap: true },
    test: { environment: "jsdom" },
});
