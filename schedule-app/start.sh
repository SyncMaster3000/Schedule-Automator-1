#!/usr/bin/env bash
# Запуск приложения "Расписание" (macOS / Linux).
# Двойной клик или: bash start.sh
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установите Node.js 20 или 22 LTS с https://nodejs.org и запустите снова."
  read -r -p "Нажмите Enter для выхода..." _
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Первый запуск: устанавливаю зависимости (это может занять пару минут)..."
  npm install || {
    echo "Ошибка установки зависимостей. Проверьте версию Node.js (нужна 20 или 22 LTS)."
    read -r -p "Нажмите Enter для выхода..." _
    exit 1
  }
fi

echo "Запуск приложения..."
npm run dev
