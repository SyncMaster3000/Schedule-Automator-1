#!/usr/bin/env bash
# ============================================================
#  Запуск актуальной версии конструктора расписаний (macOS/Linux).
#  Запуск: bash start.sh   Требуется Node.js 20 или 22 LTS.
# ============================================================
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установите Node.js 20 или 22 LTS с https://nodejs.org и запустите снова."
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "Включаю pnpm..."
  corepack enable pnpm || npm install -g pnpm
fi

if [ ! -d node_modules ]; then
  echo "Первый запуск: устанавливаю зависимости (это может занять несколько минут)..."
  pnpm install || { echo "Ошибка установки зависимостей (нужна Node.js 20 или 22 LTS)."; exit 1; }
fi

# Запуск сервера API в фоне; при выходе (Ctrl+C) — останавливаем его.
echo "Запускаю сервер API (порт 8080)..."
PORT=8080 pnpm --filter @workspace/api-server run dev &
API_PID=$!
trap 'kill $API_PID 2>/dev/null' EXIT INT TERM

echo "Жду запуск API..."
for _ in $(seq 1 30); do
  if curl -sf http://localhost:8080/api/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "Запускаю интерфейс: http://localhost:5173 (Ctrl+C — остановить)"
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/schedule run dev
