import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "apps/web",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    // OJ-028: the lazy 3D field stays out of the entry bundle. three.js is
    // isolated in its own cacheable vendor chunk (it is not tree-shakeable
    // under @react-three/fiber, ~700 kB minified); the explicit budget is
    // enforced by scripts/check-bundle.mjs instead of a generic warning.
    chunkSizeWarningLimit: 760,
    rolldownOptions: {
      output: {
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [
            { name: "three-vendor", test: /node_modules[\\/]three[\\/]/ },
            {
              name: "r3f-vendor",
              test: /node_modules[\\/](@react-three|react-reconciler|its-fine|zustand|suspend-react)[\\/]/,
            },
          ],
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    proxy: { "/api": { target: "http://127.0.0.1:3001", changeOrigin: false } },
  },
});
