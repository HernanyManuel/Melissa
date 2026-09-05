// Diagnostic only: never replaces pnpm audit or decides vulnerability status.
export async function probe(endpoint, fetcher = fetch) {
  const bulk = endpoint === 'bulk';
  const url = bulk
    ? 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk'
    : 'https://registry.npmjs.org/-/ping';
  const started = Date.now();
  try {
    const response = await fetcher(url, {
      method: bulk ? 'POST' : 'GET',
      headers: bulk ? { 'content-type': 'application/json' } : {},
      ...(bulk ? { body: JSON.stringify({ '@nestjs/core': ['11.2.3'] }) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    // Do not print response bodies, headers, credentials, proxy settings or environment.
    await response.body?.cancel();
    return { endpoint, status: response.status, elapsedMs: Date.now() - started };
  } catch (error) {
    const failure = error?.name === 'TimeoutError' ? 'timeout' : 'request_failed';
    return { endpoint, failure, elapsedMs: Date.now() - started };
  }
}

if (process.argv.includes('--run')) {
  for (const endpoint of ['ping', 'bulk']) console.log(JSON.stringify(await probe(endpoint)));
}
