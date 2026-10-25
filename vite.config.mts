import { defineConfig } from "vite";

export default defineConfig({
  root: "renderer",
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: false,
  },
  build: {
    outDir: "../dist/renderer",
    emptyOutDir: true,
  },
});
