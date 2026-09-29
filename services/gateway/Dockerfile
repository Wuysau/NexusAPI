FROM golang:1.27-alpine AS builder
WORKDIR /src
COPY services/gateway/go.mod services/gateway/go.sum ./
RUN go mod download
COPY services/gateway/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/nexus-gateway .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/nexus-healthcheck ./cmd/nexus-healthcheck

FROM alpine:3.23 AS runner
RUN apk add --no-cache ca-certificates && addgroup -g 1001 nexus && adduser -D -u 1001 -G nexus nexus
WORKDIR /app
COPY --from=builder --chown=1001:1001 /out/nexus-gateway /app/nexus-gateway
COPY --from=builder --chown=1001:1001 /out/nexus-healthcheck /app/nexus-healthcheck
ENV GATEWAY_ENV=production GATEWAY_ADDR=:8080
USER 1001:1001
EXPOSE 8080
# Probe local /readyz using the configured port and verified TLS when enabled.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["/app/nexus-healthcheck"]
ENTRYPOINT ["/app/nexus-gateway"]
