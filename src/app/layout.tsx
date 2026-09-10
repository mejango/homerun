import type { Metadata, Viewport } from 'next'
import { Providers } from '@/providers/Providers'
import './globals.css'
export const metadata: Metadata = {
 metadataBase: new URL('https://homerun.money'),
 icons: { icon: '/favicon.svg' },
 title: { default: 'Homerun | Fund and earn together', template: '%s | Homerun' },
 description: 'Fund an asset. Share what it earns.',
 openGraph: { type: 'website', siteName: 'Homerun', title: 'Homerun | Fund and earn together', description: 'Fund an asset. Share what it earns.', images: [{ url: '/assets/homerun-share.png', width: 1200, height: 630, alt: 'Homerun’s illustrated neighborhood and baseball field. Fund an asset. Share what it earns.' }] },
 twitter: { card: 'summary_large_image', images: ['/assets/homerun-share.png'] },
}
export const viewport: Viewport = { themeColor: '#204d3c' }
export default function RootLayout({ children }: { children: React.ReactNode }) {
 return <html lang="en"><body><Providers>{children}</Providers></body></html>
}
