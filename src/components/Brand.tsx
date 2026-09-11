import Link from 'next/link';

type BrandProps = {
  tagline?: boolean;
  className?: string;
};

/** The baseball is artwork, so phones cannot substitute an emoji glyph. */
export function Brand({ tagline = true, className = '' }: BrandProps) {
  return (
    <div className={`brand-lockup${className ? ` ${className}` : ''}`}>
      <Link className="brand" href="/" aria-label="Homerun home">
        <span className="brand-ball" aria-hidden="true">
          <svg viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg" focusable="false">
            <circle cx="18" cy="18" r="16" />
            <path
              d="M8 5 C16 12 16 24 8 31 M28 5 C20 12 20 24 28 31"
              strokeDasharray="2.5 2.2"
              strokeLinecap="round"
            />
          </svg>
        </span>
        {' '}
        <span className="brand-word">Homerun</span>
      </Link>
      {tagline && <p className="brand-tagline">Run your home&apos;s investments and revenues</p>}
    </div>
  );
}

export default Brand;
