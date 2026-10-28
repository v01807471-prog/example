import { defineConfig } from "vite";

export default defineConfig({
  base: "/example/",
  server: {
    port: 8080,
    open: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  esbuild: {
    target: "es2022",
  },
});