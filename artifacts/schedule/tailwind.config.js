/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{vue,js,ts,jsx,tsx,html}"],
  theme: {
    extend: {
      colors: {
        // Спокойный кобальт: уверенный акцент без излишней яркости.
        brand: {
          50: "#f0f4ff",
          100: "#e0e8fb",
          200: "#c4d2f4",
          300: "#9eb3e8",
          400: "#7891d8",
          500: "#5b73c2",
          600: "#465ca8",
          700: "#394a89",
          800: "#303e70",
          900: "#263258",
          950: "#19213c",
        },
      },
      fontFamily: {
        display: [
          "Segoe UI Variable",
          "Segoe UI",
          "Noto Sans",
          "DejaVu Sans",
          "Arial",
          "sans-serif",
        ],
        sans: [
          "Segoe UI Variable",
          "Segoe UI",
          "Noto Sans",
          "DejaVu Sans",
          "Arial",
          "sans-serif",
        ],
      },
      boxShadow: {
        card:
          "0 1px 2px rgba(21, 31, 51, 0.04), 0 8px 24px rgba(31, 42, 73, 0.06)",
        "card-hover":
          "0 2px 5px rgba(21, 31, 51, 0.06), 0 14px 32px rgba(31, 42, 73, 0.1)",
      },
    },
  },
  plugins: [],
};
