import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces climb from the page background up to raised panels; the
        // whole UI is dark because it sits next to video previews all day.
        canvas: '#0A0C11',
        surface: {
          DEFAULT: '#11141C',
          raised: '#171B26',
          hover: '#1E2330',
        },
        line: {
          DEFAULT: '#242A38',
          strong: '#333B4D',
        },
        ink: {
          DEFAULT: '#E8EBF2',
          muted: '#98A1B5',
          faint: '#5F6879',
        },
        brand: {
          DEFAULT: '#6366F1',
          hover: '#7C7FF5',
          subtle: '#1E2140',
        },
        accent: '#00D3A7',
        warn: '#F5A524',
        danger: '#F04E56',
        ok: '#28C76F',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        lg: '0.625rem',
        xl: '0.875rem',
      },
      keyframes: {
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.6s infinite',
        'fade-in': 'fade-in 180ms ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
