import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL(process.env.NODE_ENV === 'production' ? '../dist/' : '../web/', import.meta.url)));
const port = Number(process.env.PORT || 3010);
const mime = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.md': 'text/plain' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (['/founderhause', '/founderhause/', '/founderhause/index.html'].includes(pathname)) {
      res.writeHead(308, { Location: '/founderhaus' + url.search }).end(); return;
    }
    let path = resolve(root, '.' + pathname);
    if (path !== root && !path.startsWith(root.endsWith(sep) ? root : root + sep)) {
      res.writeHead(403).end('Forbidden'); return;
    }
    if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
    const content = await readFile(path);
    const etag = `"${createHash('sha256').update(content).digest('base64url')}"`;
    const production = process.env.NODE_ENV === 'production';
    const cacheHeaders = { 'Cache-Control': production ? 'public, no-cache' : 'no-store', ...(production ? { ETag: etag } : {}) };
    if (production && req.headers['if-none-match'] === etag) { res.writeHead(304, cacheHeaders).end(); return; }
    res.writeHead(200, { ...cacheHeaders, 'Content-Type': `${mime[extname(path)] || 'application/octet-stream'}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff' });
    res.end(content);
  } catch { res.writeHead(404).end('Not found'); }
});
server.listen(port, process.env.HOST || '127.0.0.1', () => process.stdout.write(`Homerun preview: http://localhost:${port}\n`));
