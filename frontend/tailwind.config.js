/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./pages/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: '#0f172a',
        mist: '#e2e8f0',
        accent: '#06b6d4',
        accentSoft: '#cffafe',
        panel: '#0b1224',
      },
      boxShadow: {
        soft: '0 20px 60px -25px rgba(15,23,42,0.45)',
      },
    },
  },
  plugins: [],
}
