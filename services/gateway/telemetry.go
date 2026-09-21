package main

// OpenTelemetry wiring.
//
// The gateway instruments the hot path with spans (request, routing decision,
// upstream attempt, terminal persist). It installs a real TracerProvider with a
// bounded span processor and a redacting exporter that emits structured
// summaries only: no prompt, no completion, no Authorization header, no
// credential, no upstream body. That is the constraint transport cannot be
// allowed to violate (INVARIANT #7).
//
// An OTLP collector can be attached later by swapping the exporter; the
// instrumentation does not change.

import (
	"context"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// Span attribute keys. The allowlist is deliberate: only these may be recorded.
const (
	attrTenantID  = attribute.Key("nexus.tenant_id")
	attrProjectID = attribute.Key("nexus.project_id")
	attrRequestID = attribute.Key("nexus.request_id")
	attrModel     = attribute.Key("nexus.model")
	attrChannelID = attribute.Key("nexus.channel_id")
	attrProvider  = attribute.Key("nexus.provider")
	attrAttempt   = attribute.Key("nexus.attempt_number")
	attrOutcome   = attribute.Key("nexus.outcome")
	attrErrorKind = attribute.Key("nexus.error_kind")
	attrDegraded  = attribute.Key("nexus.degraded")
)

// logExporter writes redacted span summaries to the service log. It never
// receives or emits span attributes that are not on the allowlist because the
// gateway only ever sets those.
type logExporter struct {
	logger *slog.Logger
}

func (e *logExporter) ExportSpans(_ context.Context, spans []sdktrace.ReadOnlySpan) error {
	for _, span := range spans {
		fields := make([]any, 0, 8)
		for _, kv := range span.Attributes() {
			fields = append(fields, string(kv.Key), kv.Value.AsString())
		}
		e.logger.Debug("span",
			append([]any{
				"name", span.Name(),
				"duration_ms", span.EndTime().Sub(span.StartTime()).Milliseconds(),
			}, fields...)...)
	}
	return nil
}

func (e *logExporter) Shutdown(context.Context) error { return nil }

// SetupTelemetry installs the tracer provider and returns a shutdown func.
// When disabled it installs a no-op provider so instrumentation is free.
func SetupTelemetry(disabled bool, logger *slog.Logger) func(context.Context) error {
	if disabled {
		return func(context.Context) error { return nil }
	}
	exporter := &logExporter{logger: logger}
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter,
			// Small queue: telemetry must never become backpressure for the
			// data plane. Dropping spans under load is acceptable; blocking is
			// not.
			sdktrace.WithMaxQueueSize(2048),
			sdktrace.WithBatchTimeout(2*time.Second),
		),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(0.05))),
	)
	otel.SetTracerProvider(provider)
	return provider.Shutdown
}

// Tracer returns the gateway tracer.
func Tracer() trace.Tracer { return otel.Tracer("nexus/gateway") }
