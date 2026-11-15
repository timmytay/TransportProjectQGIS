@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PYEXE="
set "PYOPT="

rem ---- 1. Python из QGIS, если QGIS установлена: в нём уже есть GDAL и геобиблиотеки ----
set "QGIS="
set "PYDIR="
for /d %%D in ("C:\Program Files\QGIS*") do set "QGIS=%%D"
if defined QGIS for /d %%P in ("%QGIS%\apps\Python3*") do set "PYDIR=%%P"
if defined PYDIR set "PYEXE=%PYDIR%\python.exe"
if defined PYDIR set "QGIS_PREFIX=%QGIS%"
if defined PYDIR set "PYTHONPATH=%QGIS%\apps\qgis\python;%QGIS%\apps\qgis\python\plugins"
if defined PYDIR set "PATH=%PYDIR%;%PYDIR%\Scripts;%QGIS%\bin;%QGIS%\apps\qgis\bin;%QGIS%\apps\Qt5\bin;%QGIS%\apps\Qt6\bin;%PATH%"
if defined PYDIR set "QT_PLUGIN_PATH=%QGIS%\apps\qgis\qtplugins;%QGIS%\apps\Qt5\plugins;%QGIS%\apps\Qt6\plugins"

rem ---- 2. Иначе обычный Python 3.10+ с компьютера (py или python) ----
if not defined PYEXE (
  where py >nul 2>nul && set "PYEXE=py" && set "PYOPT=-3"
)
if not defined PYEXE (
  where python >nul 2>nul && set "PYEXE=python"
)
if not defined PYEXE (
  echo Не найден Python. Установите Python 3.10 или новее с python.org - галочка Add python to PATH,
  echo либо установите QGIS 3.x с qgis.org, и снова запустите этот файл.
  pause
  exit /b
)

if defined PYDIR (echo Python из QGIS: %PYDIR%) else (echo Python: %PYEXE% %PYOPT%)

rem ---- 3. Проверка библиотек; при необходимости - установка ----
"%PYEXE%" %PYOPT% -c "import fastapi, uvicorn, geopandas, pyarrow, scipy, shapely, sklearn" >nul 2>nul
if errorlevel 1 (
  echo Устанавливаю недостающие библиотеки - нужен интернет, 1-3 минуты...
  "%PYEXE%" %PYOPT% -m pip install --user -r requirements.txt
)

rem ---- 4. Сервер уже запущен в другом окне? (порт 8000 занят) ----
"%PYEXE%" %PYOPT% -c "import socket,sys; s=socket.socket(); sys.exit(0 if s.connect_ex(('127.0.0.1',8000))==0 else 1)"
if not errorlevel 1 (
  echo.
  echo Сервер УЖЕ запущен в другом чёрном окне - порт 8000 занят.
  echo Откройте http://127.0.0.1:8000 или закройте старое окно сервера и запустите этот файл снова.
  echo Если окна не видно: Диспетчер задач - вкладка Подробности - завершить python.exe
  pause
  exit /b
)

echo.
echo Сервер запускается - 1-2 минуты. Затем откройте в браузере http://127.0.0.1:8000
echo Журнал сервера пишется в файл server.log. Не закрывайте это окно, пока работаете.
"%PYEXE%" %PYOPT% -u app.py > server.log 2>&1
echo.
echo Сервер остановлен. Если это неожиданно - смотрите server.log
pause
