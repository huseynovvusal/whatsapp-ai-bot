/**
 * Validation for emoji reactions.
 *
 * WhatsApp rejects arbitrary text as a reaction, and models asked for an emoji
 * will sometimes answer "none", ":)", "smile", or several emoji at once. This is
 * applied both where a model response is parsed and again immediately before
 * sending, so an invalid value cannot reach WhatsApp by any path.
 */
export function sanitiseEmoji(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined

  const trimmed = value.trim()
  if (!trimmed) return undefined

  // Reject anything with ASCII letters or digits: "none", "smile", ":)", "<3".
  if (/[A-Za-z0-9]/.test(trimmed)) return undefined

  // Reject bare ASCII punctuation, which is never a valid reaction.
  if (/^[\x20-\x7F]+$/.test(trimmed)) return undefined

  // A reaction is one emoji; allow a few code points for skin-tone modifiers,
  // variation selectors and ZWJ sequences (e.g. 👍🏽, ❤️, 🧑‍🚀).
  const codePoints = Array.from(trimmed)
  if (codePoints.length === 0 || codePoints.length > 6) return undefined

  return trimmed
}
