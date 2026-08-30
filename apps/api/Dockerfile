FROM oven/bun:1 AS base
WORKDIR /app

# Chromium for the CA-invoice PDF route (puppeteer-core drives an existing
# browser rather than downloading its own — keeps the image smaller).
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium

COPY package.json bun.lock* ./
COPY apps/api/package.json ./apps/api/
RUN bun install --frozen-lockfile --filter=@command-center/api

COPY apps/api ./apps/api

WORKDIR /app/apps/api
EXPOSE 3001
CMD ["bun", "index.ts"]
