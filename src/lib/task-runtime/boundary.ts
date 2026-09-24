export const resourceFailures = new Set([
  'quota_exhausted',
  'rate_limit',
  'provider_unavailable',
  'authentication_failure',
])
export function boundaryDecision(input: {
  state: 'idle' | 'running' | 'failed' | 'stopped'
  reason: string | null
  autoFailover: boolean
}): 'wait' | 'switch' | 'pause' | 'fail' | 'complete' {
  if (input.state === 'running') return 'wait'
  if (input.reason === 'near_limit' || input.reason === 'auto_return') return 'wait'
  if (
    [
      'approval_required',
      'supervisor_interrupted',
      'supervisor_error',
      'routing_policy_missing',
      'runtime_uncertain',
    ].includes(input.reason ?? '')
  )
    return 'pause'
  if (input.reason === 'manual_switch') return 'switch'
  if (resourceFailures.has(input.reason ?? '')) return input.autoFailover ? 'switch' : 'pause'
  return input.reason ? 'fail' : 'complete'
}
