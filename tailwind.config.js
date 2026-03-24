/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        steam: {
          bg: '#1a1b26', // Bleu nuit très sombre
          panel: '#1f2937', // Bleu gris
          card: '#3730a3', // Violet/Bleu
          hover: '#4f46e5', // Indigo hover
          accent: '#8b5cf6', // Violet accent
          muted: '#9ca3af',
          border: '#4338ca', // Bordure violette sombre
          fg: '#f3f4f6',
        },
      },
      fontFamily: {
        sans: ['Segoe UI', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
