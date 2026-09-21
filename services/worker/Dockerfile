FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts/build-services.mjs scripts/build-services.mjs
COPY src src
COPY packages packages
COPY services/worker services/worker
RUN node scripts/build-services.mjs worker

FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -g 1001 nexus && adduser -D -u 1001 -G nexus nexus
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist/worker.cjs ./dist/worker.cjs
USER 1001:1001
# Compose supplies a writable /tmp tmpfs with an otherwise read-only root.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 CMD ["node", "dist/worker.cjs", "--healthcheck"]
CMD ["node", "dist/worker.cjs"]
