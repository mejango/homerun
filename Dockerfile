# The digest is the multi-platform index of the tag: docker buildx imagetools inspect node:26.7-alpine
FROM node:26.7-alpine@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019 AS base
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Next embeds public configuration into the browser bundle during this stage.
# Railway forwards matching service variables as Docker build arguments.
ARG NEXT_PUBLIC_SITE_URL=https://homerun.money
ARG NEXT_PUBLIC_JBCENTER_URL=https://juicebox.center
ARG NEXT_PUBLIC_BENDYSTRAW_URL=https://bendystraw.up.railway.app
ARG NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL=https://testnet.bendystraw.xyz
ARG NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID
ARG NEXT_PUBLIC_CENTER_WALLET_ENABLED=false
ARG NEXT_PUBLIC_CENTER_WALLET_ISSUER=https://signa.center
ARG NEXT_PUBLIC_CENTER_WALLET_AUDIENCE=https://api.signa.center
ARG NEXT_PUBLIC_CENTER_WALLET_MANIFEST_ID
ARG NEXT_PUBLIC_CENTER_WALLET_MANIFEST_REVISION
ARG NEXT_PUBLIC_CENTER_WALLET_MAXIMUM_NETWORK_FEE_WEI
# The build's revision, which /api/healthz reports: the build argument, else the commit Railway builds.
ARG NEXT_PUBLIC_VERSION
ARG RAILWAY_GIT_COMMIT_SHA
ENV NEXT_PUBLIC_VERSION=${NEXT_PUBLIC_VERSION:-${RAILWAY_GIT_COMMIT_SHA}}
RUN npm run build

FROM base
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
