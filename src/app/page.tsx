import type { Metadata } from 'next';
import HomePage from '../components/HomePage';

export const metadata: Metadata = {
  title: { absolute: "Homerun \u2014 Run your home's investments and revenues" },
  description: "Run your home's investments and revenues. Explore how Homerun brings people together to fund assets and share their income.",
  alternates: { canonical: '/' },
};

export default function Page() {
  return <HomePage />;
}
