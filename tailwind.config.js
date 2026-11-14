/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      // LIGHT-THEME TEXT ONE STEP DARKER, for contrast. `textColor` alone, so the gray
      // backgrounds and borders keep the stock scale; dark mode is untouched because every
      // text class there is a `dark:text-neutral-*` override. Each shade takes the next
      // darker stock value (gray-600 renders as stock gray-700), and 700 goes half a step.
      textColor: {
        gray: {
          400: '#6b7280',
          500: '#4b5563',
          600: '#374151',
          700: '#2b3543',
        },
      },
      fontSize: {
        label: ['12px', { lineHeight: '1.2' }],
        body:  ['14px', { lineHeight: '1.4' }],
      },
    },
  },
  plugins: [],
}
