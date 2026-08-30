FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock* ./
COPY apps/web/package.json ./apps/web/
RUN bun install --frozen-lockfile --filter=web

FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY apps/web ./apps/web
WORKDIR /app/apps/web
RUN bun run build

FROM oven/bun:1 AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["bun", "server.js"]
