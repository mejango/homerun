FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY scripts/build.mjs scripts/build.mjs
COPY web web
COPY docs docs
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY scripts/serve.mjs ./scripts/serve.mjs
USER node
EXPOSE 3000
CMD ["npm", "start"]
