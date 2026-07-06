import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/renderer/**/*.{ts,tsx,html}', './electron/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Semantic aliases mapped to the zinc scale used across the app.
        surface: {
          DEFAULT: '#0f1115',
          raised: '#18181b',
          border: '#27272a',
        },
      },
    },
  },
  plugins: [],
};

export default config;
