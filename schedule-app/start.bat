@echo off
chcp 65001 >nul
rem Запуск приложения "Расписание" (Windows). Двойной клик по файлу.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Установите Node.js 20 или 22 LTS с https://nodejs.org и запустите снова.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Первый запуск: устанавливаю зависимости (это может занять пару минут)...
  call npm install
  if errorlevel 1 (
    echo Ошибка установки зависимостей. Проверьте версию Node.js (нужна 20 или 22 LTS).
    pause
    exit /b 1
  )
)

echo Запуск приложения...
call npm run dev
pause
