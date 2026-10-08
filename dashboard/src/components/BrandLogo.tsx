import { BRAND } from '../brand';

interface BrandLogoProps {
  className?: string;
}

// Inline rather than an <img> so the mark follows the active theme through --primary-text.
export function BrandLogo({ className }: BrandLogoProps) {
  return (
    <svg className={`brand-logo ${className ?? ''}`.trim()} viewBox="0 0 48 48" role="img" aria-label={BRAND.name}>
      <path
        d="M40 24a16 16 0 1 0-6.2 12.6L41 40l-2.2-7.6A15.9 15.9 0 0 0 40 24z"
        fill="none"
        stroke="currentColor"
        strokeWidth={5}
        strokeLinejoin="round"
      />
      <circle cx={24} cy={24} r={4.5} fill="currentColor" />
    </svg>
  );
}
