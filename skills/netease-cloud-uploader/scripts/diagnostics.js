'use strict'

function sanitizeDiagnosticText(value, options = {}) {
  const maxLines = options.maxLines || 16
  const maxChars = options.maxChars || 2400
  const sanitized = String(value || '')
    .replace(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1***:***@')
    .replace(/\b(MUSIC_U|cookie|authorization|password|passwd|token)\s*[=:]\s*[^\s;,]+/gi, '$1=***')
    .replace(/([?&](?:token|password|auth|key)=)[^&\s]+/gi, '$1***')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-maxLines)
    .join('\n')

  return sanitized.length > maxChars ? sanitized.slice(-maxChars) : sanitized
}

module.exports = { sanitizeDiagnosticText }
