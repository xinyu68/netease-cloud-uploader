const COOKIE_ATTRIBUTE_NAMES = new Set([
  'domain',
  'expires',
  'httponly',
  'max-age',
  'partitioned',
  'path',
  'priority',
  'sameparty',
  'samesite',
  'secure',
])

function addCookieSource(jar, source) {
  if (!source) return
  if (Array.isArray(source)) {
    source.forEach((item) => addCookieSource(jar, item))
    return
  }

  String(source).split(';').forEach((part) => {
    const token = part.trim()
    const separator = token.indexOf('=')
    if (separator <= 0) return
    const name = token.slice(0, separator).trim()
    if (!name || COOKIE_ATTRIBUTE_NAMES.has(name.toLowerCase())) return
    jar.set(name, token.slice(separator + 1).trim())
  })
}

function mergeCookieHeaders(...sources) {
  const jar = new Map()
  sources.forEach((source) => addCookieSource(jar, source))
  return [...jar.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

module.exports = { mergeCookieHeaders }
