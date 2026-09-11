'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Brand } from './Brand';
import { RotatingAssetHeadline } from './RotatingAssetHeadline';
import {
  mountBallpark,
  type BallparkController,
  type BallparkMotion,
  type BallparkOptions,
} from '../lib/ballpark';

const DEFAULT_COLORS: BallparkOptions = {
  mode: 'shapes',
  intensity: 100,
  pace: 2.5,
  grouping: 11,
};

type AcidColors = Pick<BallparkOptions, 'intensity' | 'grouping'>;

function savedAcidColors(colors: BallparkOptions): AcidColors | null {
  try {
    const saved = JSON.parse(localStorage.getItem('homerun:acid-colors') ?? 'null');
    if (saved && typeof saved.intensity === 'number' && Number.isFinite(saved.intensity)
      && typeof saved.grouping === 'number' && Number.isFinite(saved.grouping)) {
      return {
        intensity: Math.max(0, Math.min(100, saved.intensity)),
        grouping: Math.max(0, Math.min(100, saved.grouping)),
      };
    }
  } catch {
    // Existing Acid users retain their current settings if preferences cannot be read.
  }
  return colors.mode === 'acid' ? { intensity: colors.intensity, grouping: colors.grouping } : null;
}

function savedColors(): BallparkOptions {
  const colors = { ...DEFAULT_COLORS };
  try {
    const mode = localStorage.getItem('homerun:color-mode');
    if (mode === 'acid' || mode === 'shapes') colors.mode = mode;
    for (const [key, minimum, maximum] of [
      ['intensity', 0, 100],
      ['pace', 0.25, 4],
      ['grouping', 0, 100],
    ] as const) {
      const value = localStorage.getItem(`homerun:color-${key}`);
      if (value?.trim() && Number.isFinite(Number(value))) {
        colors[key] = Math.max(minimum, Math.min(maximum, Number(value)));
      }
    }
  } catch {
    // The controls remain usable when browser storage is unavailable.
  }
  return colors;
}

export function HomePage() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const renderer = useRef<BallparkController | null>(null);
  const acidColors = useRef<AcidColors | null>(null);
  const [colors, setColors] = useState(DEFAULT_COLORS);
  const [motion, setMotion] = useState<BallparkMotion>('running');

  useEffect(() => {
    if (!canvas.current || !copy.current) return;
    const initialColors = savedColors();
    acidColors.current = savedAcidColors(initialColors);
    if (initialColors.mode === 'acid' && acidColors.current) Object.assign(initialColors, acidColors.current);
    setColors(initialColors);
    const ballpark = mountBallpark(canvas.current, copy.current, initialColors, setMotion);
    renderer.current = ballpark;
    return () => {
      ballpark.destroy();
      renderer.current = null;
    };
  }, []);

  function updateColors<Key extends keyof BallparkOptions>(key: Key, value: BallparkOptions[Key]) {
    const next = { ...colors, [key]: value };
    if (key === 'mode' && value === 'acid' && colors.mode !== 'acid') {
      Object.assign(next, acidColors.current ?? { intensity: 20, grouping: 20 });
    }
    if (next.mode === 'acid') acidColors.current = { intensity: next.intensity, grouping: next.grouping };
    setColors(next);
    renderer.current?.setOptions(next);
    try {
      for (const setting of ['mode', 'intensity', 'pace', 'grouping'] as const) {
        localStorage.setItem(`homerun:color-${setting}`, String(next[setting]));
      }
      if (acidColors.current) localStorage.setItem('homerun:acid-colors', JSON.stringify(acidColors.current));
    } catch {
      // Persistence is optional; the visible controls are the source of truth.
    }
  }

  return (
    <div className="home-page">
      <a className="skip-link" href="#main">Skip to content</a>
      <main id="main" className="home-main" tabIndex={-1}>
        <section className="ballpark-hero" aria-labelledby="home-title">
          <header className="site-header"><Brand /></header>
          <div className="home-copy" ref={copy}>
            <h1 id="home-title" aria-label="Run your home's investments and revenues">
              <RotatingAssetHeadline playing={motion === 'running'} />
              <em className="home-title-revenues">investments and revenues</em>
            </h1>
            <div className="home-actions">
              <Link className="create-homerun" href="/create">Begin</Link>
              <Link className="see-demo" href="/founderhaus">See Founder Haus demo</Link>
            </div>
          </div>
          <canvas
            id="ballpark"
            ref={canvas}
            role="img"
            aria-label="A colored-pencil ballpark with houses, a bakery, rooftop solar, a tractor, a UFO coffee kiosk and teammates on benches, overlooking the ocean and sunset cliffs."
          >
            A neighborhood ballpark above the ocean, with houses, trees, mountains and sunset cliffs.
          </canvas>
        </section>
      </main>
      <footer className="home-footer">
        <div className="home-color-controls">
          <div className="home-color-control">
            <label htmlFor="color-mode">Color mode</label>
            <select
              id="color-mode"
              value={colors.mode}
              onChange={event => updateColors('mode', event.target.value === 'acid' ? 'acid' : 'shapes')}
            >
              <option value="acid">Acid</option>
              <option value="shapes">Shapes</option>
            </select>
          </div>
          <div className="home-color-control">
            <label htmlFor="color-intensity">Intensity</label>
            <input
              id="color-intensity" type="range" min="0" max="100" step="1"
              value={colors.intensity}
              onChange={event => updateColors('intensity', event.target.valueAsNumber)}
            />
            <output id="color-intensity-value" htmlFor="color-intensity">{colors.intensity}</output>
          </div>
          <div className="home-color-control">
            <label htmlFor="color-pace">Pace</label>
            <input
              id="color-pace" type="range" min="0.25" max="4" step="0.25"
              value={colors.pace}
              onChange={event => updateColors('pace', event.target.valueAsNumber)}
            />
            <output id="color-pace-value" htmlFor="color-pace">{colors.pace}×</output>
          </div>
          <div className="home-color-control">
            <label htmlFor="color-grouping">Color grouping</label>
            <input
              id="color-grouping" type="range" min="0" max="100" step="1"
              value={colors.grouping}
              aria-describedby="color-grouping-help"
              onChange={event => updateColors('grouping', event.target.valueAsNumber)}
            />
            <output id="color-grouping-value" htmlFor="color-grouping">{colors.grouping}</output>
            <span id="color-grouping-help" hidden>
              Zero shifts individual pixels; higher values create broader color patches.
            </span>
          </div>
          <button
            id="toggle-motion" className="home-motion-toggle" type="button"
            onClick={() => renderer.current?.toggleMotion()}
          >
            {motion === 'reduced' ? 'Play animations' : motion === 'paused' ? 'Resume animations' : 'Pause animations'}
          </button>
        </div>
      </footer>
    </div>
  );
}

export default HomePage;
