import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
  },
  optimizeDeps: {
    // mupdf is an ESM + wasm package with top-level await; esbuild
    // pre-bundling breaks it
    exclude: ["mupdf"],
  },
  worker: {
    format: "es",
  },
});
