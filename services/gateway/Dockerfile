FROM golang:1.27-alpine AS builder
WORKDIR /src
COPY services/gateway/go.mod services/gateway/go.sum ./
RUN go mod download
COPY services/gateway/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/nexus-gateway .

FROM alpine:3.23 AS runner
RUN apk add --no-cache ca-certificates jq && addgroup -g 1001 nexus && adduser -D -u 1001 -G nexus nexus
WORKDIR /app
COPY --from=builder --chown=1001:1001 /out/nexus-gateway /app/nexus-gateway
ENV GATEWAY_ENV=production GATEWAY_ADDR=:8080
USER 1001:1001
EXPOSE 8080
# Container readiness requires all dependencies; /readyz HTTP status alone checks only snapshot availability.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD wget -qO- http://127.0.0.1:8080/readyz | jq -e ' .status == "ready" and .checks.snapshot == true and .checks.database == true and .checks.redis == true' > /dev/null || exit 1
ENTRYPOINT ["/app/nexus-gateway"]
