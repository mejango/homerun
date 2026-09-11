'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const ASSETS = [
  'homes', 'businesses', 'farms', 'equipment', 'energy',
  'coffee carts', 'bakeries', 'solar farms', 'robot fleets',
  'moonbases', 'neighborhoods', 'food trucks', 'dream labs',
  'lemonade stands', 'gardens', 'spaceships', 'treehouses',
  'bike shops', 'corner stores', 'art studios', 'islands',
];

const possessive = (asset: string) => `${asset}'${asset.endsWith('s') ? '' : 's'}`;

/** Reserve every wrapping case while the shared prefix moves without fading. */
export function RotatingAssetHeadline({ playing }: { playing: boolean }) {
  const [selected, setSelected] = useState(0);
  const element = useRef<HTMLSpanElement>(null);
  const prefix = useRef<HTMLSpanElement>(null);
  const position = useRef<{ x: number; y: number } | null>(null);
  const slide = useRef<Animation | null>(null);
  const hasRotated = useRef(false);

  useLayoutEffect(() => {
    const node = prefix.current;
    const container = element.current;
    if (!node || !container) return;
    slide.current?.cancel();
    const bounds = node.getBoundingClientRect();
    const parent = container.getBoundingClientRect();
    const next = { x: bounds.left - parent.left, y: bounds.top - parent.top };
    const previous = position.current;
    position.current = next;
    if (previous && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const x = previous.x - next.x;
      const y = previous.y - next.y;
      if (x || y) slide.current = node.animate([
        { transform: `translate(${x}px, ${y}px)` },
        { transform: 'translate(0, 0)' },
      ], { duration: 320, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    }
    return () => slide.current?.cancel();
  }, [selected]);

  useLayoutEffect(() => {
    const node = prefix.current;
    const container = element.current;
    if (!node || !container) return;
    let active = true;
    const measure = () => {
      if (!active) return;
      slide.current?.cancel();
      const bounds = node.getBoundingClientRect();
      const parent = container.getBoundingClientRect();
      position.current = { x: bounds.left - parent.left, y: bounds.top - parent.top };
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(node);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion.addEventListener('change', measure);
    void document.fonts.ready.then(measure);
    return () => {
      active = false;
      observer.disconnect();
      reducedMotion.removeEventListener('change', measure);
    };
  }, []);

  useEffect(() => {
    const node = element.current;
    if (!node) return;
    let inView = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const advance = () => {
      hasRotated.current = true;
      setSelected(index => (index + 1) % ASSETS.length);
      timeout = setTimeout(advance, 3200);
    };
    const sync = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = undefined;
      const running = playing && inView && !document.hidden;
      node.dataset.rotating = String(running);
      if (running) timeout = setTimeout(advance, hasRotated.current ? 3200 : 8000);
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
      if (timeout !== undefined) clearTimeout(timeout);
      node.dataset.rotating = 'false';
    };
  }, [playing]);

  return <span ref={element} className="home-title-subject" data-current-asset={ASSETS[selected]} aria-hidden="true">
    {ASSETS.map(asset => <span key={asset} className="home-asset-line home-asset-reserve"><span>Run your</span> {possessive(asset)}</span>)}
    <span className="home-asset-line is-current"><span ref={prefix} className="home-title-prefix">Run your</span>{' '}<span key={selected} className="home-asset-word">{possessive(ASSETS[selected])}</span></span>
  </span>;
}
