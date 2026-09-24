FROM node:26.7-alpine AS build
WORKDIR /app
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
RUN npm run build
FROM node:26.7-alpine
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
