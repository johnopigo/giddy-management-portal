# syntax=docker/dockerfile:1
# One image: the API, which also serves the built web app.
# Behind a proxy that re-signs TLS, pass its CA without baking it in:
#   docker build --build-arg HTTPS_PROXY=… --secret id=npm_ca,src=/path/to/ca.crt .

# ---- build the web app ----
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export npm_config_cafile=/run/secrets/npm_ca; fi; \
    npm ci --workspace web --include-workspace-root=false
COPY web/ web/
RUN npm run build --workspace web

# ---- runtime ----
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=4000 \
    WEB_DIST=/app/web/dist \
    RUN_MIGRATIONS=true \
    ACCESS_LOG=true
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export npm_config_cafile=/run/secrets/npm_ca; fi; \
    npm ci --omit=dev --workspace server --include-workspace-root=false && npm cache clean --force
COPY server/src server/src
COPY server/migrations server/migrations
COPY server/scripts server/scripts
COPY --from=web /app/web/dist web/dist
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/api/ready >/dev/null || exit 1
CMD ["node", "server/src/index.js"]
