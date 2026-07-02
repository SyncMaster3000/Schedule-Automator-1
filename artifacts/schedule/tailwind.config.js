/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{vue,js,ts,jsx,tsx,html}"],
  theme: {
    extend: {
      colors: {
        // «Чернильный кобальт» — приглушённый официальный синий (не дефолтный
        // яркий blue-600). Спокойный при долгой работе, хорошо читаемый.
        brand: {
          50: "#eef1f9",
          100: "#dbe1f2",
          200: "#bcc8e6",
          300: "#93a5d4",
          400: "#6a80bf",
          500: "#4a61a6",
          600: "#384e8c", // основная кнопка / акцент
          700: "#2f4074", // hover
          800: "#29375f",
          900: "#1f2a49", // тёмная боковая панель
        },
      },
      fontFamily: {
        // Дисплейная гарнитура для заголовков и логотипа — «инструментальный»
        // характер, при этом хорошо читаема. Тело интерфейса — Inter.
        display: [
          "Space Grotesk",
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      boxShadow: {
        // Мягкая многослойная тень для карточек — чётче дефолтной, но не тяжёлая.
        card: "0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06)",
        "card-hover":
          "0 4px 12px rgba(15, 23, 42, 0.08), 0 2px 4px rgba(15, 23, 42, 0.05)",
      },
    },
  },
  plugins: [],
};
