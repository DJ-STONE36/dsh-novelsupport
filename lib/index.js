/**
 * dsh-novel host half — the thin, stable shell.
 *
 * This file is deliberately tiny and should almost never change, because it is
 * the only part of the host half that a host restart is required to reload: the
 * cordis loader imports it once and Node's ESM cache keeps that copy for the
 * life of the process (verified — re-composing the loader does not re-import
 * it).
 *
 * Everything else lives under `lib/impl/` and is imported through `load()`
 * below, which appends the file's mtime as a query string. That gives each impl
 * module a distinct module identity per revision, so an edit takes effect on
 * the next request. Node never garbage-collects those old module instances, so
 * a long editing session accumulates a few hundred kilobytes — an acceptable
 * price for not interrupting a writing session with a restart.
 *
 * The route is registered as `prefix`, not as one route per endpoint, for the
 * same reason: adding an endpoint must not require touching this file.
 */

import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'dsh-novel'

const implDir = join(dirname(fileURLToPath(import.meta.url)), 'impl')

/** absPath -> { mtimeMs, mod }, keyed per file so one edit reloads one module. */
const cache = new Map()

async function load(relative) {
  const abs = join(implDir, relative)
  const { mtimeMs } = statSync(abs)
  const hit = cache.get(abs)
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.mod
  const mod = await import(`${pathToFileURL(abs).href}?v=${mtimeMs}`)
  cache.set(abs, { mtimeMs, mod })
  return mod
}

export function apply(ctx) {
  /**
   * Optional host services, resolved INDEPENDENTLY of route mounting.
   *
   * One combined `ctx.inject([...])` is the obvious shape and the wrong one: a
   * service that is not composed on this host never fires the callback, so the
   * route would never mount and the whole plugin would vanish over one missing
   * dependency. Bound apart, a missing service costs exactly one endpoint,
   * which reports itself unavailable.
   */
  const services = Object.create(null)
  const bind = (name) => ctx.inject([name], (scoped) => {
    services[name] = scoped[name]
    return () => {
      delete services[name]
    }
  })
  bind('workspaceRegistry')
  bind('llm')
  bind('sessionController')

  ctx.inject(['webServer'], (hostCtx) => {
    const dispose = hostCtx.webServer.register({
      kind: 'prefix',
      // NO trailing slash. The host matches a prefix as
      //   pathname === prefix || pathname.startsWith(prefix + '/')
      // so registering '/dsh-novel/' would require '/dsh-novel//health' and
      // silently never match anything — every request 404s with no error.
      path: '/dsh-novel',
      handler: async (request, response) => {
        // The host awaits the handler (webserver lib/index.js `await
        // route.handler(req, res)`), so a plain async function is safe here.
        // Errors are still absorbed locally: whatever escapes reaches the
        // host's own catch, which answers a bodyless 400 and logs a warning.
        try {
          const router = await load('./router.js')
          await router.handle(request, response, load, services)
        } catch (error) {
          hostCtx.logger?.warn?.(`[dsh-novel] dispatch failed: ${error?.message ?? error}`)
          if (!response.headersSent) {
            response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          }
          response.end(JSON.stringify({
            ok: false,
            code: 'dispatch-failed',
            error: String(error?.message ?? error),
          }))
        }
      },
    })

    hostCtx.logger?.info?.('[dsh-novel] mounted prefix route /dsh-novel (impl modules hot-reload on edit)')

    return () => {
      try {
        dispose?.()
      } catch {
        /* already disposed */
      }
    }
  })
}
