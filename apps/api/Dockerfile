FROM oven/bun:1.2.17

WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock bunfig.toml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/contracts packages/contracts
RUN bun install --frozen-lockfile

COPY apps/api apps/api
RUN bun run build:api
RUN mkdir -p apps/api/dist/db && cp -R apps/api/src/db/migrations apps/api/dist/db/migrations

RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3333

CMD ["bun", "apps/api/dist/index.js"]
