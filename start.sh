#!/usr/bin/env bash
# ============================================================
#  Запуск актуальной версии конструктора расписаний (macOS/Linux).
#  Запуск: bash start.sh   Требуется Node.js 20 или 22 LTS.
# ============================================================
cd "$(dirname "$0")" || exit 1
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установите Node.js 20 или 22 LTS с https://nodejs.org и запустите снова."
  exit 1
fi

# Если pnpm есть в системе — используем его, иначе через corepack (без прав root).
if command -v pnpm >/dev/null 2>&1; then
  PNPM="pnpm"
else
  PNPM="corepack pnpm@10.33.0"
fi

echo "Проверяю и устанавливаю зависимости (первый раз — несколько минут)..."
$PNPM install || { echo "Ошибка установки зависимостей (нужна Node.js 20 или 22 LTS)."; exit 1; }

echo "Запускаю сервер API (порт 8080)..."
PORT=8080 $PNPM --filter @workspace/api-server run dev &
API_PID=$!
trap 'kill $API_PID 2>/dev/null' EXIT INT TERM

echo "Жду запуск сервера..."
for _ in $(seq 1 30); do
  if curl -sf http://localhost:8080/api/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "Интерфейс: http://localhost:5173 (Ctrl+C — остановить)"
PORT=5173 BASE_PATH=/ $PNPM --filter @workspace/schedule run dev
