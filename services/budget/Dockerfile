FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts/build-services.mjs scripts/build-services.mjs
COPY src src
COPY packages packages
COPY services/budget services/budget
RUN node scripts/build-services.mjs budget

FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-alpine AS runtime
ENV NODE_ENV=production BUDGET_HOST=0.0.0.0 BUDGET_PORT=8081
WORKDIR /app
RUN addgroup -g 1001 nexus && adduser -D -u 1001 -G nexus nexus
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist/budget.cjs ./dist/budget.cjs
USER 1001:1001
EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 CMD ["node", "dist/budget.cjs", "--healthcheck"]
CMD ["node", "dist/budget.cjs"]
