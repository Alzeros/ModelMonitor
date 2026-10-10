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
    // 显式绑定 IPv4 回环：host 缺省为 'localhost'，在部分环境下只解析到 ::1，
    // 结果是服务仅监听 [::1]:22555，用 http://127.0.0.1:22555 访问不通。
    // 与后端 HOST 默认值（127.0.0.1）保持一致的 IPv4 口径。
    host: '127.0.0.1',
    proxy: {
      "/api": `http://127.0.0.1:${process.env.API_PORT || 3000}`,
    },
  },
});
