/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/**/*.{js,jsx,ts,tsx,vue}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f0f9ff",
          600: "#0284c7",
          700: "#0369a1",
        },
      },
    },
  },
  plugins: [],
};
