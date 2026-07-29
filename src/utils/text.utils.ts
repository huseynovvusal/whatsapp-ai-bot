/**
 * Text shaping helpers for outgoing replies.
 */

/**
 * Trim text to a maximum length without cutting mid-thought.
 *
 * Prefers the last sentence end inside the limit; falls back to the last word
 * break. A model that ignores its length instruction should still produce
 * something that reads as finished rather than truncated.
 */
export function trimToLength(text: string, maxChars: number): string {
  if (!maxChars || maxChars <= 0) return text
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed

  const window = trimmed.slice(0, maxChars)

  // Last sentence terminator (including the common chat habit of no space after)
  const sentenceEnd = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
    window.lastIndexOf("\n"),
    // A terminator at the very end of the window is also a clean stop
    /[.!?]$/.test(window) ? window.length - 1 : -1
  )
  if (sentenceEnd > maxChars * 0.4) {
    return window.slice(0, sentenceEnd + 1).trim()
  }

  const wordBreak = window.lastIndexOf(" ")
  if (wordBreak > maxChars * 0.4) {
    return window.slice(0, wordBreak).trim()
  }

  return window.trim()
}

/** Rough word count, used for style profiling. */
export function countWords(text: string): number {
  const matches = text.trim().match(/\S+/g)
  return matches ? matches.length : 0
}
