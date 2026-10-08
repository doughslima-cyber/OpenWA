// OpenMsg brand identity. This fork rebrands the upstream OpenWA dashboard; keeping every
// brand constant in this one module (plus brand.css and BrandLogo) means upstream merges
// rarely touch the files that carry the brand.
export const BRAND = {
  name: 'OpenMsg',
  // Recharts takes literal colours, not CSS variables. Indigo 500 clears the 3:1 non-text
  // contrast minimum on both the light (4.47:1) and the dark (3.27:1) card surface.
  chartColor: '#6366f1',
} as const;
