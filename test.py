import sys
import os

# Настраиваем пути
sys.path.insert(0, r"C:\Program Files\QGIS 3.44.3\apps\qgis\python")
sys.path.insert(0, r"C:\Program Files\QGIS 3.44.3\apps\qgis\python\plugins")

print("=== Запуск app.py напрямую ===")
print("Текущая директория:", os.getcwd())

try:
    # Пытаемся импортировать app как модуль
    import app
    print("✅ app.py импортирован как модуль")
except Exception as e:
    print("❌ Ошибка импорта app.py:", e)
    import traceback
    traceback.print_exc()

print("=== Готово ===")
input("Нажмите Enter...")