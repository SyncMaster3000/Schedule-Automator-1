@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "COREPACK_ENABLE_DOWNLOAD_PROMPT=0"

rem ============================================================
rem  Запуск актуальной версии конструктора расписаний (Windows).
rem  Двойной клик по этому файлу. Требуется Node.js 20 или 22 LTS.
rem  Права администратора НЕ нужны.
rem ============================================================

where node >nul 2>nul
if errorlevel 1 goto no_node

rem Определяем, как вызывать pnpm: если он есть в системе — напрямую,
rem иначе через corepack (входит в Node, ставит pnpm в пользовательскую папку).
set "PNPM=pnpm"
where pnpm >nul 2>nul
if not errorlevel 1 goto have_pnpm
set "PNPM=corepack pnpm@10.33.0"
:have_pnpm

echo Проверяю и устанавливаю зависимости (первый раз — несколько минут)...
call %PNPM% install
if errorlevel 1 goto install_failed

:run
echo Запускаю сервер API в отдельном окне...
start "Schedule API" cmd /k "set PORT=8080&& %PNPM% --filter @workspace/api-server run dev"

echo Жду запуск сервера...
timeout /t 8 >nul

start "" http://localhost:5173

echo.
echo Интерфейс запускается: http://localhost:5173
echo НЕ закрывайте это окно, пока работаете с программой.
echo.
set PORT=5173
set BASE_PATH=/
call %PNPM% --filter @workspace/schedule run dev
goto end

:no_node
echo.
echo Node.js не найден. Установите Node.js 20 или 22 LTS с https://nodejs.org и запустите снова.
goto end

:install_failed
echo.
echo Не удалось установить зависимости. Проверьте, что установлена Node.js 20 или 22 LTS.
goto end

:end
echo.
pause
