import { computed, ref } from "vue";

const STORAGE_KEY = "schedule-automator-theme";
const theme = ref("light");

function normalizeTheme(value) {
  return value === "dark" ? "dark" : "light";
}

function applyTheme(value) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = value;
  root.classList.toggle("dark", value === "dark");
  root.style.colorScheme = value;
}

export function initTheme() {
  let savedTheme = "light";
  try {
    savedTheme = normalizeTheme(localStorage.getItem(STORAGE_KEY));
  } catch {
    // В закрытом хранилище остаёмся на предсказуемой светлой теме.
  }
  theme.value = savedTheme;
  applyTheme(savedTheme);
  return savedTheme;
}

export function setTheme(value) {
  const nextTheme = normalizeTheme(value);
  theme.value = nextTheme;
  applyTheme(nextTheme);
  try {
    localStorage.setItem(STORAGE_KEY, nextTheme);
  } catch {
    // Тема действует до закрытия приложения, даже если хранилище недоступно.
  }
}

export function useTheme() {
  return {
    theme,
    isDark: computed(() => theme.value === "dark"),
    toggleTheme: () => setTheme(theme.value === "dark" ? "light" : "dark"),
  };
}
