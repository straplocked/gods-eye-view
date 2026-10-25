# syntax=docker/dockerfile:1
#
# Production image: the BUILT app served by `vite preview`, self-contained (no
# bind-mounted source). The development image is ../Dockerfile with
# ../compose.yaml; this one is what .github/workflows/publish.yml publishes to
# ghcr.io/straplocked/gods-eye-view and what deploy/unraid/gods-eye-view.xml runs.
#
# Why `vite preview` and not the dev server: every API provider mounts in
# configurePreviewServer as well as configureServer, so preview is the whole
# app minus the development-only surfaces - Provider Settings (keys come from
# the .env in /data), HMR (no websocket for a reverse proxy to carry) and the
# /mcp endpoint. It is also what `npm run build` + `npm run preview` ship.
#
# Build:  docker build -f deploy/Dockerfile -t gods-eye-view .
# Run:    docker run -p 3650:4173 -v /path/to/appdata:/data gods-eye-view
#
# Same Node as the development image and CI (package.json engines), by digest.
FROM node:24.14.0-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

# Puppeteer is only used by the QA scripts; skip its ~150MB Chromium download.
ENV PUPPETEER_SKIP_DOWNLOAD=1

WORKDIR /app
# /data is the ONE persistent path: .env (provider keys), .gev-cache, .gev-logs.
# World-writable only so an unmapped (anonymous) volume works for any --user;
# a bind mount from the host replaces these permissions with the host's.
RUN chown node:node /app && mkdir /data && chmod 0777 /data
USER node

# `vite` and `vite-plugin-cesium` are devDependencies and are needed at run
# time (preview loads vite.config.js), so install everything.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

COPY --chown=node:node . .

# Browser keys (GOOGLE_MAPS_API_KEY, CESIUM_ION_TOKEN, MAPILLARY_CLIENT_TOKEN)
# are compiled INTO the bundle by design, so they cannot be set at run time and
# must never be baked into a published image. The published image is built
# without them (keyless Esri imagery). To bake your own into a private local
# image, pass your .env as a BuildKit secret - it is mounted for this one step
# and never stored in a layer (uid 1000 is `node`; add --no-cache when only the
# secret changed, because BuildKit does not key its cache on secret contents):
#   docker build -f deploy/Dockerfile --secret id=dotenv,src=.env -t gods-eye-view .
RUN --mount=type=secret,id=dotenv,target=/app/.env,required=false,uid=1000,mode=0400 \
    npm run build

# Point the app's repo-root state at the data volume. The providers write
# .gev-cache and .gev-logs relative to the working directory, and the config
# reads .env from the same root; links reach every one of those paths without
# a code change. -f replaces the empty stub a secret mount can leave behind.
RUN ln -sf /data/.env /app/.env \
 && ln -sfn /data/.gev-cache /app/.gev-cache \
 && ln -sfn /data/.gev-logs /app/.gev-logs

# Bind to all interfaces inside the container's own network namespace; the
# Host allowlist is separate: IP addresses and localhost are accepted, other
# names only via GEV_ALLOWED_HOSTS (build/allowedHosts.js).
ENV HOST=0.0.0.0
ENV PORT=4173
# Defense in depth: scripts/docker-prod-start.mjs pins this to "no peer" too.
# Never trust a reverse proxy's address for key setup (see docs/DEPLOY-UNRAID.md).
ENV GEV_KEY_SETUP_TRUSTED_PEERS=none
VOLUME ["/data"]
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "scripts/docker-prod-start.mjs"]
