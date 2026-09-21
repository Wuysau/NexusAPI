package main

// Public API error contract v1 (docs/contracts/api-errors.md).
//
// The response shape is frozen: {error:{code,message,type,param,request_id}}.
// Codes are stable and machine-readable; messages never expose channels,
// balances, keys, stacks or internal policy.

import (
	"encoding/json"
	"net/http"
)

// Error type discriminators from the contract.
const (
	TypeAuthentication = "authentication_error"
	TypePermission     = "permission_error"
	TypePolicy         = "policy_error"
	TypeInvalidRequest = "invalid_request_error"
	TypeRateLimit      = "rate_limit_error"
	TypeConflict       = "conflict_error"
	TypeUpstream       = "upstream_error"
	TypeServiceUnavail = "service_unavailable_error"
	TypeTimeout        = "timeout_error"
)

// Stable public error codes.
const (
	CodeInvalidAPIKey         = "invalid_api_key"
	CodeKeyRevoked            = "key_revoked"
	CodeKeyExpired            = "key_expired"
	CodeKeyDisabled           = "key_disabled"
	CodeScopeDenied           = "scope_denied"
	CodeModelNotAllowed       = "model_not_allowed"
	CodeRegionNotAllowed      = "region_not_allowed"
	CodeBudgetExceeded        = "budget_exceeded"
	CodeRateLimitExceeded     = "rate_limit_exceeded"
	CodeConcurrencyExceeded   = "concurrency_exceeded"
	CodeInvalidJSON           = "invalid_json"
	CodeRequestTooLarge       = "request_too_large"
	CodeInvalidParameter      = "invalid_parameter"
	CodeUnsupportedParam      = "unsupported_parameter"
	CodeModelNotFound         = "model_not_found"
	CodeCapabilityUnsupported = "capability_not_supported"
	CodeIdempotencyConflict   = "idempotency_conflict"
	CodeUpstreamProtocol      = "upstream_protocol_error"
	CodeNoHealthyUpstream     = "no_healthy_upstream"
	CodeSnapshotUnavailable   = "snapshot_unavailable"
	CodeSnapshotExpired       = "snapshot_expired"
	CodeStorageUnavailable    = "storage_unavailable"
	CodeUpstreamTimeout       = "upstream_timeout"
	CodeInternal              = "internal_error"
)

// APIError is a contract-shaped public error. It carries no upstream detail.
type APIError struct {
	Status  int
	Code    string
	Type    string
	Message string
	Param   *string
}

func (e *APIError) Error() string { return e.Code }

func newAPIError(status int, code, errType, message string) *APIError {
	return &APIError{Status: status, Code: code, Type: errType, Message: message}
}

// Convenience constructors keep status/type pairing consistent with the
// contract's HTTP mapping table.
func errInvalidAPIKey() *APIError {
	return newAPIError(http.StatusUnauthorized, CodeInvalidAPIKey, TypeAuthentication, "Invalid API key.")
}
func errKeyRevoked() *APIError {
	return newAPIError(http.StatusUnauthorized, CodeKeyRevoked, TypeAuthentication, "This API key has been revoked.")
}
func errKeyExpired() *APIError {
	return newAPIError(http.StatusUnauthorized, CodeKeyExpired, TypeAuthentication, "This API key has expired.")
}
func errKeyDisabled() *APIError {
	return newAPIError(http.StatusUnauthorized, CodeKeyDisabled, TypeAuthentication, "This API key is disabled.")
}
func errScopeDenied(scope string) *APIError {
	e := newAPIError(http.StatusForbidden, CodeScopeDenied, TypePermission, "This API key is not permitted to perform that operation.")
	e.Param = &scope
	return e
}
func errModelNotAllowed() *APIError {
	return newAPIError(http.StatusForbidden, CodeModelNotAllowed, TypePermission, "This model is not available to this key under the active policy.")
}
func errBudgetExceeded() *APIError {
	return newAPIError(http.StatusTooManyRequests, CodeBudgetExceeded, TypePolicy, "Request cannot be authorized under the active budget policy.")
}
func errRateLimited() *APIError {
	return newAPIError(http.StatusTooManyRequests, CodeRateLimitExceeded, TypeRateLimit, "Rate limit exceeded.")
}
func errConcurrency() *APIError {
	return newAPIError(http.StatusTooManyRequests, CodeConcurrencyExceeded, TypeRateLimit, "Too many concurrent requests for this tenant.")
}
func errInvalidJSON() *APIError {
	return newAPIError(http.StatusBadRequest, CodeInvalidJSON, TypeInvalidRequest, "Request body is not valid JSON.")
}
func errRequestTooLarge() *APIError {
	return newAPIError(http.StatusRequestEntityTooLarge, CodeRequestTooLarge, TypeInvalidRequest, "Request body exceeds the allowed size.")
}
func errInvalidParam(param, message string) *APIError {
	e := newAPIError(http.StatusBadRequest, CodeInvalidParameter, TypeInvalidRequest, message)
	e.Param = &param
	return e
}
func errModelNotFound() *APIError {
	return newAPIError(http.StatusBadRequest, CodeModelNotFound, TypeInvalidRequest, "Model not supported.")
}
func errCapabilityUnsupported(detail string) *APIError {
	return newAPIError(http.StatusUnprocessableEntity, CodeCapabilityUnsupported, TypeInvalidRequest, detail)
}
func errIdempotencyConflict() *APIError {
	return newAPIError(http.StatusConflict, CodeIdempotencyConflict, TypeConflict, "A different request already used this idempotency key.")
}
func errUpstreamProtocol() *APIError {
	return newAPIError(http.StatusBadGateway, CodeUpstreamProtocol, TypeUpstream, "Upstream returned a response this gateway could not process.")
}
func errNoHealthyUpstream() *APIError {
	return newAPIError(http.StatusServiceUnavailable, CodeNoHealthyUpstream, TypeServiceUnavail, "No qualified channel is available for this model.")
}
func errSnapshot(reason string) *APIError {
	if reason == ReasonSnapshotExpired {
		return newAPIError(http.StatusServiceUnavailable, CodeSnapshotExpired, TypeServiceUnavail, "Configuration snapshot expired and the control plane is unreachable.")
	}
	return newAPIError(http.StatusServiceUnavailable, CodeSnapshotUnavailable, TypeServiceUnavail, "Configuration snapshot is not available.")
}
func errStorageUnavailable() *APIError {
	return newAPIError(http.StatusServiceUnavailable, CodeStorageUnavailable, TypeServiceUnavail, "Usage storage is unavailable; managed traffic is refused.")
}

func errUpstreamTimeout() *APIError {
	return newAPIError(http.StatusGatewayTimeout, CodeUpstreamTimeout, TypeTimeout, "Upstream timed out.")
}
func errInternal() *APIError {
	return newAPIError(http.StatusInternalServerError, CodeInternal, TypeServiceUnavail, "Internal gateway error.")
}

// errorEnvelope is the wire shape. Field order is irrelevant to clients but the
// contract fixes the names.
type errorEnvelope struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code      string  `json:"code"`
	Message   string  `json:"message"`
	Type      string  `json:"type"`
	Param     *string `json:"param"`
	RequestID string  `json:"request_id"`
}

// writeAPIError renders a contract error. It never logs and never inspects the
// wrapped cause.
func writeAPIError(w http.ResponseWriter, requestID string, apiErr *APIError) {
	if apiErr == nil {
		apiErr = errInternal()
	}
	body := errorEnvelope{Error: errorBody{
		Code:      apiErr.Code,
		Message:   apiErr.Message,
		Type:      apiErr.Type,
		Param:     apiErr.Param,
		RequestID: requestID,
	}}
	w.Header().Set("content-type", "application/json")
	w.Header().Set("x-request-id", requestID)
	w.WriteHeader(apiErr.Status)
	_ = json.NewEncoder(w).Encode(body)
}

// asAPIError normalises any error into a public shape, defaulting to 502 for
// upstream failures and 500 otherwise.
func asAPIError(err error) *APIError {
	if err == nil {
		return nil
	}
	if apiErr, ok := err.(*APIError); ok {
		return apiErr
	}
	var se *SnapshotError
	if asSnapshotError(err, &se) {
		return errSnapshot(se.Reason)
	}
	return errInternal()
}

func asSnapshotError(err error, target **SnapshotError) bool {
	for err != nil {
		if se, ok := err.(*SnapshotError); ok {
			*target = se
			return true
		}
		unwrapper, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = unwrapper.Unwrap()
	}
	return false
}
