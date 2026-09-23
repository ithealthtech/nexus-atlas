# syntax=docker/dockerfile:1
# Override with --build-arg NODE_IMAGE=... to use a registry mirror.
ARG NODE_IMAGE=node:22-alpine
# ---- build ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# Behind a TLS-inspecting proxy? Pass its CA with --secret id=ca_cert,src=proxy-ca.pem (not stored in the image).
RUN --mount=type=secret,id=ca_cert,required=false \
    if [ -f /run/secrets/ca_cert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca_cert; fi; \
    npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM ${NODE_IMAGE}
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4318 ATLAS_DATA_DIR=/data
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/packages/shared/package.json packages/shared/
COPY --from=build --chown=node:node /app/packages/shared/dist packages/shared/dist
COPY --from=build --chown=node:node /app/packages/db/package.json packages/db/
COPY --from=build --chown=node:node /app/packages/db/dist packages/db/dist
COPY --from=build --chown=node:node /app/packages/db/drizzle packages/db/drizzle
COPY --from=build --chown=node:node /app/apps/server/package.json apps/server/
COPY --from=build --chown=node:node /app/apps/server/dist apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/dist apps/web/dist
USER node
VOLUME /data
EXPOSE 4318
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:4318/healthz || exit 1
# Atlas handles SIGTERM/SIGINT itself for a clean shutdown.
CMD ["node", "apps/server/dist/index.js"]
