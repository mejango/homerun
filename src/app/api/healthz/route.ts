export const dynamic = 'force-dynamic'

// A Dockerfile `ENV X=${ARG_X:-${OTHER}}` turns an unset build argument into "", which `??` would keep.
export function GET() {
  return Response.json(
    { status: 'ok', revision: process.env.NEXT_PUBLIC_VERSION?.trim() || 'unknown' },
    { headers: { 'cache-control': 'no-store' } },
  )
}
