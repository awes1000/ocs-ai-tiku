# syntax=docker/dockerfile:1
# 支持多架构构建：docker buildx build --platform linux/amd64,linux/arm64 -t ocs-tiku:latest .

FROM node:22-bookworm-slim AS builder
WORKDIR /app

# 安装原生模块（better-sqlite3）在无预编译二进制时的回退编译工具链（兼容 x64 / ARM64）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci && npm rebuild better-sqlite3

FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8060 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/tiku.db

COPY --from=builder /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME ["/app/data"]
EXPOSE 8060

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8060) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
