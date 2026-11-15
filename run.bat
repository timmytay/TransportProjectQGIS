@echo off
chcp 65001 >nul
set PYTHONPATH=C:\Program Files\QGIS 3.44.3\apps\qgis\python;C:\Program Files\QGIS 3.44.3\apps\qgis\python\plugins
set PATH=C:\Program Files\QGIS 3.44.3\apps\Python312;C:\Program Files\QGIS 3.44.3\apps\Python312\Scripts;C:\Program Files\QGIS 3.44.3\bin;%PATH%
"C:\Program Files\QGIS 3.44.3\apps\Python312\python.exe" -u test.py
pause