import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Whether the module at `moduleUrl` is the script node was started with: `if (isEntrypoint(import.meta.url))`.
 * process.argv[1] is the path as it was typed and import.meta.url is the real path, so a script started through a
 * symlink never equals itself by plain comparison; the real paths do.
 */
export function isEntrypoint(moduleUrl, startedWith = process.argv[1]) {
  return Boolean(startedWith) && realpathSync(startedWith) === fileURLToPath(moduleUrl)
}
