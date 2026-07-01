@echo off
chcp 65001 >nul
rem ============================================================
rem  Запуск актуальной версии конструктора расписаний (Windows).
rem  Двойной клик по этому файлу. Требуется Node.js 20 или 22 LTS.
rem ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Установите Node.js 20 или 22 LTS с https://nodejs.org и запустите снова.
  pause
  exit /b 1
)

rem Включаем pnpm (входит в Node через corepack)
where pnpm >nul 2>nul
if errorlevel 1 (
  echo Включаю pnpm...
  call corepack enable pnpm
)

if not exist node_modules (
  echo Первый запуск: устанавливаю зависимости (это может занять несколько минут)...
  call pnpm install
  if errorlevel 1 (
    echo Ошибка установки зависимостей. Проверьте версию Node.js (нужна 20 или 22 LTS).
    pause
    exit /b 1
  )
)

echo Запускаю сервер API в отдельном окне...
start "Schedule API" cmd /k "set PORT=8080&& pnpm --filter @workspace/api-server run dev"

echo Жду запуск API...
timeout /t 6 >nul

start "" http://localhost:5173

echo Запускаю интерфейс (не закрывайте это окно, пока работаете)...
set PORT=5173
set BASE_PATH=/
call pnpm --filter @workspace/schedule run dev

pause
