import type { Metadata } from 'next';
import HomePage from '../components/HomePage';

export const metadata: Metadata = {
  title: { absolute: 'Homerun — Fund and earn together' },
  description: 'Fund and earn together. Explore how Homerun brings people together to fund assets and share their income.',
  alternates: { canonical: '/' },
};

export default function Page() {
  return <HomePage />;
}
