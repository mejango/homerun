import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Whether the module at `moduleUrl` is the script node was started with: `if (isEntrypoint(import.meta.url))`.
 * process.argv[1] is the path as it was typed and import.meta.url is the real path (unless node runs with
 * --preserve-symlinks-main), so a script started through a symlink never equals itself by plain comparison; the real
 * paths do. Something with no file behind it (`node -` reads stdin, a data: URL) is not an entry point.
 */
export function isEntrypoint(moduleUrl, startedWith = process.argv[1]) {
  if (!startedWith) return false
  try {
    return realpathSync(startedWith) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}
