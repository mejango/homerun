'use client';

import { useEffect, useRef, useState } from 'react';

const ASSETS = [
  'home', 'business', 'equipment', 'energy',
  'coffee cart', 'bakery', 'solar farm', 'robot fleet',
  'moonbase', 'neighborhood', 'food truck', 'dream lab',
  'lemonade stand', 'garden', 'spaceship', 'treehouse',
  'bike shop', 'corner store', 'art studio', 'island',
];

/** The complete phrase reserves its widest/tallest wrapping case without a gap before “’s”. */
export function RotatingAssetHeadline({ playing }: { playing: boolean }) {
  const [selected, setSelected] = useState(0);
  const element = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = element.current;
    if (!node) return;
    let inView = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
      const running = playing && inView && !document.hidden;
      node.dataset.rotating = String(running);
      if (running) interval = setInterval(() => setSelected(index => (index + 1) % ASSETS.length), 3200);
    };
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? false;
      sync();
    });
    observer.observe(node);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', sync);
      if (interval !== undefined) clearInterval(interval);
      node.dataset.rotating = 'false';
    };
  }, [playing]);

  return <span ref={element} className="home-title-subject" data-current-asset={ASSETS[selected]} aria-hidden="true">
    {ASSETS.map((asset, index) => <span key={asset} className={`home-asset-line${index === selected ? ' is-current' : ''}`}>Run your {asset}&apos;s</span>)}
  </span>;
}
