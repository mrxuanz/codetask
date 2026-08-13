# `@codetask/desktop`

Thin Electron host. It owns window policy and the supervised Hono Service child lifecycle.
Business APIs are accessed over loopback HTTP/SSE; this package must not import server-core,
database, Provider runtimes, or `src/server`. Product assembly remains at the repository root;
this workspace owns only the Electron shell source, dependencies, and TypeScript configuration.
