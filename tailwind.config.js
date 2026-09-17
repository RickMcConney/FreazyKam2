/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontSize: {
        label: ['12px', { lineHeight: '1.2' }],
        body:  ['14px', { lineHeight: '1.4' }],
      },
    },
  },
  plugins: [],
}
