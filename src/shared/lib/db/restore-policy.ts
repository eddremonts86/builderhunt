const testDatabasePattern = /^builderhunt_security_test_[A-Za-z0-9_]+$/

export function assertRestoreTestTargets(
  sourceUrl: string,
  targetUrl: string,
  options: { allowCrossHost?: boolean } = {},
) {
  const source = parse(sourceUrl, 'source')
  const target = parse(targetUrl, 'target')
  if (source.href === target.href) throw new Error('Restore source and target must be different databases')
  if (source.host !== target.host && !options.allowCrossHost) {
    throw new Error('Restore rehearsal must stay on one explicitly controlled test server (pass { allowCrossHost: true } to opt in for a cross-major rehearsal)')
  }
}

function parse(value: string, label: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Restore ${label} URL is invalid`)
  }
  const databaseName = url.pathname.slice(1)
  if (!testDatabasePattern.test(databaseName)) {
    throw new Error(`Restore ${label} must be a builderhunt_security_test database`)
  }
  return url
}
