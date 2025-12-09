/**
 * Utilities for working with phone JIDs and normalizing phone numbers
 */
export function cleanPhoneNumber(jid: string | undefined | null): string {
  if (!jid) return "unknown"
  const base = jid.split("@")[0].split(":")[0]
  if (/^\d+$/.test(base)) return `+${base}`
  if (/^\+\d+$/.test(base)) return base
  return base
}

export function baseFromJid(jid: string | undefined | null): string {
  if (!jid) return "unknown"
  return jid.split("@")[0].split(":")[0]
}
