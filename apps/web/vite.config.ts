import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // 固定 dev 端口：5173/5174 常被其它项目占用，改为专用 22555
    port: 22555,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.API_PORT || 3000}`,
    },
  },
});
