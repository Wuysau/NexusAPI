interface ChannelConfiguration {
  enabled: boolean
  credential: { enabled: boolean | null } | null
}

/** Stored configuration describes a reference, never live provider or routing health. */
export function channelConfigurationState(channel: ChannelConfiguration) {
  if (!channel.enabled) return 'disabled'
  if (!channel.credential) return 'missing_credential'
  if (channel.credential.enabled === false) return 'credential_disabled'
  if (channel.credential.enabled !== true) return 'credential_unknown'
  return 'reference_recorded'
}
