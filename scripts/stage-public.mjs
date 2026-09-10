import { cp, mkdir } from 'node:fs/promises'
await mkdir('public', { recursive: true })
await cp('web/assets', 'public/assets', { recursive: true })
await cp('docs', 'public/docs', { recursive: true })
