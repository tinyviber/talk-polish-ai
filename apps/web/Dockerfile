ARG BUN_BASE_IMAGE=ccr.ccs.tencentyun.com/kotoba/oven-bun:1.2.17
ARG NODE_RUNTIME_IMAGE=ccr.ccs.tencentyun.com/kotoba/node:22-alpine

FROM ${BUN_BASE_IMAGE} AS build

WORKDIR /app
ENV NODE_ENV=production
ARG VITE_APP_MODE=api
ARG VITE_API_URL=
ENV VITE_APP_MODE=$VITE_APP_MODE
ENV VITE_API_URL=$VITE_API_URL

COPY package.json bun.lock bunfig.toml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/contracts packages/contracts
RUN sed -i 's#https://europe-west1-npm.pkg.dev/lovable-core-prod/sandbox-npm-cache/#https://registry.npmmirror.com/#g' bun.lock \
    && printf '\nregistry = "https://registry.npmmirror.com"\n' >> bunfig.toml \
    && bun install --frozen-lockfile

COPY apps/web apps/web
RUN bun run build:web

FROM ${NODE_RUNTIME_IMAGE} AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY --from=build /app/apps/web/.output apps/web/.output

EXPOSE 3000
CMD ["bun", "apps/web/.output/server/index.mjs"]
