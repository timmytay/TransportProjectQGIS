import os
import json
import math
from fastapi import FastAPI
from fastapi.responses import JSONResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from clustering_engine import ClusteringEngine  # импортируем новый модуль
from geometry_utils import GeometryUtils  # импортируем новый модуль
from clustering_polygons import ClusteringPolygonGenerator, PolygonExporter
from pydantic import BaseModel

from typing import List, Dict, Any, Optional  # <-- ДОБАВИТЬ ЭТУ СТРОКУ
# ----------------------------
# QGIS больше не обязательна: слои читаются через GeoPandas (pyogrio/GDAL).
# Если QGIS установлена, она используется только как запасной способ — когда GeoPandas
# не смог прочитать файл (например, нет драйвера). Инициализация QGIS — при первой необходимости.
# ----------------------------
_qgis_state = {"ready": None}


def _qgis_ready():
    """Ленивая инициализация QGIS. Возвращает True, если QGIS доступна."""
    if _qgis_state["ready"] is not None:
        return _qgis_state["ready"]
    try:
        from qgis.core import QgsApplication, QgsSettings
        QgsApplication.setPrefixPath(os.environ.get("QGIS_PREFIX", r"C:\Program Files\QGIS 3.44.3"), True)
        _qgis_state["app"] = QgsApplication([], False)
        _qgis_state["app"].initQgis()
        QgsSettings().setValue("SHAPE_RESTORE_SHX", "YES")  # автосоздание .shx
        _qgis_state["ready"] = True
        print("QGIS подключена как запасной способ чтения слоёв")
    except Exception as e:
        _qgis_state["ready"] = False
        print(f"QGIS не используется ({e.__class__.__name__}) — слои читаются через GeoPandas")
    return _qgis_state["ready"]


# ----------------------------
# FastAPI
# ----------------------------
app = FastAPI()

# Разрешаем CORS для разработки
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
# Сжатие ответов: тяжёлые слои (центроиды зданий ~60 МБ) уходят в браузер в разы меньше
app.add_middleware(GZipMiddleware, minimum_size=1000)

# Монтаж статических папок
app.mount("/css", StaticFiles(directory="css"), name="css")
app.mount("/js", StaticFiles(directory="js"), name="js")


# ----------------------------
# Папка с данными
# ----------------------------
BASE_DIR = os.path.dirname(__file__)
DATA_DIR = os.path.join(BASE_DIR, "data")
SHAPEFILE = os.path.join(DATA_DIR, "attract.shp")
GPX_FILE = os.path.join(DATA_DIR, "water.gpx")
PARKS_FILE = os.path.join(DATA_DIR, "parks.gpx")
GRAVE_FILE = os.path.join(DATA_DIR, "grave_yard.gpx")
POLYGONS_FILE = os.path.join(DATA_DIR, "polygons.geojson")
BUILDINGS_POP = os.path.join(DATA_DIR, "buildings_pop.shp")
ROADS_FILE = os.path.join(DATA_DIR, "magistrali.gpkg")
LANDSCAPE_FILE = os.path.join(DATA_DIR, "ландшафты.gpkg")
AGGLOMERATIONS_FILE = os.path.join(DATA_DIR, "агломерация.gpkg")

GRAPH_FILE = os.path.join(DATA_DIR, "граф.gpkg")           # или .shp, .geojson
WATER_FILE = os.path.join(DATA_DIR, "воды.gpkg")           # или .shp, .geojson
SETTLEMENTS_FILE = os.path.join(DATA_DIR, "нас.пункты.gpkg") # или .shp, .geojson

BUILDINGS_GEN_FILE = os.path.join(DATA_DIR, "здания_генерация.parquet")
# ----------------------------
# Преобразуем QVariant в Python типы
# ----------------------------
def variant_to_python(value):
    """Конвертирует QVariant в Python тип"""
    # Если это QVariant (значение из QGIS) - берем значение
    if hasattr(value, "value") and value.__class__.__name__ == "QVariant":
        value = value.value()
    
    # Если значение None - возвращаем None
    if value is None:
        return None
    
    # Пробуем конвертировать
    try:
        # Пробуем как int
        return int(value)
    except (ValueError, TypeError):
        try:
            # Пробуем как float
            f = float(value)
            # Проверяем на NaN и бесконечность
            if math.isnan(f) or math.isinf(f):
                return None
            return f
        except (ValueError, TypeError):
            try:
                # Пробуем как строку
                return str(value)
            except:
                return None

# ----------------------------
# Функция загрузки слоя и конвертации в GeoJSON
# ----------------------------
def _qgis_layer_to_geojson(file_path, layer_name=None, encoding="CP1251"):
    """Старый способ чтения слоя через QGIS (используется только как запасной)."""
    if not _qgis_ready():
        return {"error": f"Cannot read layer without QGIS: {file_path}"}
    from qgis.core import (QgsVectorLayer, QgsCoordinateTransform, QgsProject,
                           QgsCoordinateReferenceSystem, QgsGeometry)
    if layer_name:
        layer_path = f"{file_path}|layername={layer_name}"
    else:
        layer_path = file_path

    # Загружаем слой без автоматического определения CRS
    layer = QgsVectorLayer(layer_path, "layer", "ogr")
    
    if not layer.isValid():
        return {"error": f"Layer not valid: {file_path}"}

    # 1. Жестко говорим, что исходные данные в МЕТРАХ (3857)
    
    # 2. Указываем кодировку, чтобы не было кракозябр
    layer.setProviderEncoding(encoding)

    # 3. Настраиваем трансформатор В ГРАДУСЫ
    target_crs = QgsCoordinateReferenceSystem("EPSG:4326")
    context = QgsProject.instance()
    
    
    transformer = QgsCoordinateTransform(layer.crs(), target_crs, context)

    features_geojson = []
    for feat in layer.getFeatures():
        geom = feat.geometry()
        if geom.isNull():
            continue
            
        # Клонируем геометрию, чтобы не испортить исходник, и трансформируем
        temp_geom = QgsGeometry(geom)
        error_code = temp_geom.transform(transformer)
        
        # Если трансформация прошла успешно
        if error_code == 0:
            geom_json = json.loads(temp_geom.asJson())
            properties = {f.name(): variant_to_python(feat[f.name()]) for f in layer.fields()}
            
            features_geojson.append({
                "type": "Feature",
                "geometry": geom_json,
                "properties": properties
            })

    return {"type": "FeatureCollection", "features": features_geojson}

def layer_to_geojson(file_path, layer_name=None):
    """
    Чтение векторного слоя (GPKG, GPX, SHP, GeoJSON) через GeoPandas и перевод в GeoJSON (EPSG:4326).
    Кодировка shapefile берётся из файла .cpg (у attract и buildings_pop — 1251).
    Если GeoPandas не справился, а QGIS установлена — читается через QGIS.
    """
    try:
        import geopandas as gpd
        kw = {"layer": layer_name} if layer_name else {}
        gdf = gpd.read_file(file_path, **kw)
        gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]
        if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
            gdf = gdf.to_crs(4326)
        for col in gdf.columns:
            if col != gdf.geometry.name and gdf[col].dtype.kind in "Mm":   # даты и время -> строка
                gdf[col] = gdf[col].astype(str)
        return json.loads(gdf.to_json(na="null", drop_id=True))
    except Exception as e:
        print(f"GeoPandas не прочитал {os.path.basename(file_path)}: {e}")
        return _qgis_layer_to_geojson(file_path, layer_name)


def _layer_response(file_path, layer_names=(None,), label="layer"):
    """Ответ сервера для слоя: перебирает возможные имена слоя внутри файла."""
    print(f"=== load {label} ===")
    if not os.path.exists(file_path):
        return JSONResponse(status_code=404, content={"error": f"File not found: {file_path}"})
    data = None
    for name in layer_names:
        data = layer_to_geojson(file_path, name)
        if data.get("features"):
            break
    if not data or data.get("error") or not data.get("features"):
        return JSONResponse(status_code=500, content={"error": (data or {}).get("error", f"No features: {file_path}")})
    print(f"✅ {label}: {len(data['features'])} объектов")
    return JSONResponse(content=data)

@app.get("/load-buildings-pop")
def load_buildings_pop():
    if not os.path.exists(BUILDINGS_POP):
        return {"error": "Buildings file not found"}
    # Используем функцию конвертации
    return JSONResponse(content=layer_to_geojson(BUILDINGS_POP))
# ----------------------------
# Endpoint для shapefile
# ----------------------------
@app.get("/load-shapefile")
def load_shapefile():
    if not os.path.exists(SHAPEFILE):
        return {"error": "Shapefile not found"}
    return JSONResponse(content=layer_to_geojson(SHAPEFILE))

# ----------------------------
# Endpoint для GPX
# ----------------------------
@app.get("/load-gpx")
def load_gpx():
    if not os.path.exists(GPX_FILE):
        return {"error": "GPX file not found"}
   
    return JSONResponse(content=layer_to_geojson(GPX_FILE, layer_name="tracks"))

@app.get("/load-parks")
def load_parks():
    if not os.path.exists(PARKS_FILE):
        return {"error": "parks.gpx not found"}

    return JSONResponse(content=layer_to_geojson(PARKS_FILE, layer_name="tracks"))

@app.get("/load-graveyard")
def load_graveyard():
    if not os.path.exists(GRAVE_FILE):
        return {"error": "grave_yard.gpx not found"}

    return JSONResponse(content=layer_to_geojson(GRAVE_FILE, layer_name="tracks"))

@app.get("/load-polygons")
def load_polygons():

    if not os.path.exists(POLYGONS_FILE):
        return {"error": "polygons.geojson not found"}

    with open(POLYGONS_FILE, encoding="utf-8") as f:
        data = json.load(f)

    return JSONResponse(content=data)
# ----------------------------
# Endpoint для магистралей (Сеть_link.SHP)
# ----------------------------
@app.get("/load-roads")
def load_roads():
    """Магистрали (magistrali.gpkg)"""
    return _layer_response(ROADS_FILE, (None, "magistrali"), "roads")


@app.get("/load-landscape")
def load_landscape():
    """Ландшафты (ландшафты.gpkg)"""
    return _layer_response(LANDSCAPE_FILE, ("ландшафты", None), "landscape")


@app.get("/load-graph")
def load_graph():
    """Граф улично-дорожной сети (граф.gpkg)"""
    return _layer_response(GRAPH_FILE, (None, "граф", "graph", "edges", "network"), "graph")


@app.get("/load-water-bodies")
def load_water_bodies():
    """Водные объекты (воды.gpkg)"""
    return _layer_response(WATER_FILE, (None, "воды"), "water_bodies")


@app.get("/load-settlements")
def load_settlements():
    """Населённые пункты (нас.пункты.gpkg)"""
    return _layer_response(SETTLEMENTS_FILE, (None, "нас_пункты", "нас.пункты"), "settlements")


@app.post("/generate-cluster-polygons")
async def generate_cluster_polygons(request: dict):
    """
    Генерирует полигоны на основе кластеризованных данных
    """
    try:
        clustered_features = request.get('clustered_features', [])
        method = request.get('method', 'convex_hull')
        use_alpha = request.get('use_alpha_shape', False)
        alpha = request.get('alpha', 0.5)
        
        print(f"=== generate-cluster-polygons ===")
        print(f"Получено features: {len(clustered_features)}")
        print(f"Метод: {method}")
        
        if not clustered_features:
            return JSONResponse(
                status_code=400,
                content={"error": "No clustered features provided"}
            )
        
        # Генерация полигонов (упрощенная версия)
        polygons = generate_cluster_polygons_simple(clustered_features, method)

        # Обрезка полигона района по его части области (грани между барьерами),
        # чтобы выпуклая оболочка не заходила за реку / магистраль
        faces = (request.get('faces') or {}).get('features', [])
        if faces:
            from collections import Counter
            from shapely.geometry import shape, mapping
            face_geom = {f['properties']['face_id']: shape(f['geometry']) for f in faces}
            face_of = {}
            votes = {}
            for f in clustered_features:
                pr = f.get('properties', {})
                if pr.get('face_id') is not None:
                    votes.setdefault(pr.get('cluster_id'), Counter())[pr['face_id']] += 1
            for cid, c in votes.items():
                face_of[cid] = c.most_common(1)[0][0]
            for feat in polygons.get('features', []):
                cid = feat['properties'].get('cluster_id')
                fid = face_of.get(cid)
                if fid in face_geom:
                    clipped = shape(feat['geometry']).intersection(face_geom[fid])
                    if not clipped.is_empty and clipped.geom_type in ('Polygon', 'MultiPolygon'):
                        feat['geometry'] = mapping(clipped)
                        feat['properties']['face_id'] = fid

        return JSONResponse(content=polygons)
        
    except Exception as e:
        print(f"Ошибка: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": f"Error generating polygons: {str(e)}"}
        )

@app.get("/load-buildings-gen")
def load_buildings_gen():
    if not os.path.exists(BUILDINGS_GEN_FILE):
        return JSONResponse(status_code=404, content={"error": "File not found"})
    
    try:
        import geopandas as gpd
        gdf = gpd.read_parquet(BUILDINGS_GEN_FILE)
        if gdf.crs and gdf.crs != "EPSG:4326":
            gdf = gdf.to_crs("EPSG:4326")
        geojson = json.loads(gdf.to_json())
        return JSONResponse(content=geojson)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})
    
BUILDINGS_CENTROIDS_FILE = os.path.join(DATA_DIR, "здания_центроиды.parquet")
_centroids_cache = None  # готовый GeoJSON в памяти, чтобы не собирать его каждый раз


@app.get("/load-buildings-centroids")
def load_buildings_centroids():
    """Центроиды зданий по площади (точки) с весом weight_area для районирования."""
    global _centroids_cache
    if _centroids_cache is not None:
        return JSONResponse(content=_centroids_cache)
    try:
        import geopandas as gpd
        if not os.path.exists(BUILDINGS_CENTROIDS_FILE):
            # файла ещё нет — считаем из полигонов «Здания 2.0»
            if not os.path.exists(BUILDINGS_GEN_FILE):
                return JSONResponse(status_code=404, content={"error": "File not found"})
            from building_centroids import build_centroids
            build_centroids(BUILDINGS_GEN_FILE, BUILDINGS_CENTROIDS_FILE)

        gdf = gpd.read_parquet(BUILDINGS_CENTROIDS_FILE)
        # старый файл без категорий, а рубрики 2ГИС уже есть — пересчитываем
        from building_categories import files_available
        if "in_lng" not in gdf.columns and files_available() and os.path.exists(BUILDINGS_GEN_FILE):
            from building_centroids import build_centroids
            gdf = build_centroids(BUILDINGS_GEN_FILE, BUILDINGS_CENTROIDS_FILE)
        if gdf.crs and gdf.crs != "EPSG:4326":
            gdf = gdf.to_crs("EPSG:4326")
        # высоты зданий по рельефу (relief.py); если файла ещё не пересчитали — берём из DEM на лету
        if "elev" not in gdf.columns:
            try:
                import relief
                if relief.load_dem() is not None:
                    gdf["elev"] = relief.elevation(gdf.geometry.x.values, gdf.geometry.y.values).round(1)
            except Exception as e:
                print(f"Высоты зданий не добавлены: {e}")
        elev = ([None if v != v else round(float(v), 1) for v in gdf["elev"]] if "elev" in gdf.columns
                else [None] * len(gdf))

        # Оставляем только нужные поля — иначе ответ на 360 тыс. точек слишком тяжёлый
        xs = gdf.geometry.x.round(6).tolist()
        ys = gdf.geometry.y.round(6).tolist()
        ids = gdf["bld_id"].tolist()
        area = gdf["area_m2"].round(1).tolist()
        floors = gdf["FLOORS"].fillna(1).astype(int).tolist() if "FLOORS" in gdf else [1] * len(gdf)
        weight = gdf["weight_area"].round(1).tolist()
        inhab = gdf["inhab"].fillna(0).round(2).tolist() if "inhab" in gdf else [0] * len(gdf)
        has_cat = "cat_code" in gdf.columns
        cat = [c if isinstance(c, str) else None for c in gdf["cat_code"]] if has_cat else [None] * len(gdf)
        prio = gdf["cat_priority"].fillna(0).astype(int).tolist() if has_cat else [0] * len(gdf)
        norgs = gdf["n_orgs"].fillna(0).astype(int).tolist() if has_cat else [0] * len(gdf)
        # профиль площади и состав организаций передаём только для зданий с организациями,
        # для остальных браузер восстановит их сам (жильё = вся площадь этажей)
        has_mix = "mix" in gdf.columns
        mix = [m if (has_mix and n > 0) else None for m, n in zip(gdf["mix"] if has_mix else [None] * len(gdf), norgs)]
        has_in = "in_lng" in gdf.columns
        in_ll = ([[round(x, 6), round(y, 6)] if x == x else None for x, y in zip(gdf["in_lng"], gdf["in_lat"])]
                 if has_in else [None] * len(gdf))
        names = [m if (n > 0 and isinstance(m, str)) else None
                 for m, n in zip(gdf["top_org"] if "top_org" in gdf.columns else [None] * len(gdf), norgs)]
        orgc = [m if (n > 0 and isinstance(m, str)) else None
                for m, n in zip(gdf["org_cats"] if "org_cats" in gdf.columns else [None] * len(gdf), norgs)]

        features = [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [xs[i], ys[i]]},
                "properties": {
                    "bld_id": ids[i],
                    "area_m2": area[i],
                    "FLOORS": floors[i],
                    "weight_area": weight[i],
                    "inhab": inhab[i],
                    "cat": cat[i],          # код категории SQ (по приоритету)
                    "prio": prio[i],        # приоритет 1..5, 0 — нет категории
                    "n_orgs": norgs[i],     # организаций 2ГИС в здании
                    "mix": mix[i],          # площадь этажей по категориям «SQ1:2400;SQ2:300»
                    "orgc": orgc[i],        # число организаций по категориям «SQ2:3;SQ10:1»
                    "name": names[i],       # главная организация здания (для центра притяжения)
                    "inpt": in_ll[i],       # точка внутри контура, если центроид снаружи
                    "elev": elev[i],        # высота над уровнем моря по SRTM, м
                },
            }
            for i in range(len(gdf))
        ]
        _centroids_cache = {"type": "FeatureCollection", "features": features}
        return JSONResponse(content=_centroids_cache)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# ==================== РЕЛЬЕФ ====================
RELIEF_DIR = os.path.join(DATA_DIR, "рельеф")
RELIEF_SLOPES_FILE = os.path.join(RELIEF_DIR, "крутые_склоны.gpkg")
_relief_cache = None


@app.get("/load-relief")
def load_relief():
    """Барьер «Рельеф»: крутые склоны (уклон ≥ 12°), полигоны из relief.py."""
    global _relief_cache
    if _relief_cache is not None:
        return JSONResponse(content=_relief_cache)
    if not os.path.exists(RELIEF_SLOPES_FILE):
        return JSONResponse(status_code=404, content={"error": "Нет data/рельеф/крутые_склоны.gpkg — запустите relief.py"})
    try:
        import geopandas as gpd
        g = gpd.read_file(RELIEF_SLOPES_FILE).to_crs(4326)
        g["geometry"] = g.geometry.set_precision(1e-6)
        _relief_cache = json.loads(g[["id", "area_ha", "geometry"]].to_json(drop_id=True))
        return JSONResponse(content=_relief_cache)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/relief/hillshade.png")
def relief_hillshade():
    """Отмывка рельефа (подложка) — картинка из relief.py."""
    from fastapi.responses import FileResponse
    f = os.path.join(RELIEF_DIR, "отмывка.png")
    if not os.path.exists(f):
        return JSONResponse(status_code=404, content={"error": "no hillshade"})
    return FileResponse(f, media_type="image/png")


@app.get("/relief/hillshade.json")
def relief_hillshade_meta():
    f = os.path.join(RELIEF_DIR, "отмывка.json")
    if not os.path.exists(f):
        return JSONResponse(status_code=404, content={"error": "no hillshade"})
    return JSONResponse(content=json.load(open(f, encoding="utf-8")))


@app.get("/load-categories")
def load_categories():
    """Справочник категорий с приоритетами (data/rubriki/prioritety_kategorij.csv)."""
    try:
        from building_categories import load_priorities, PRIORITY_FILE
        if not os.path.exists(PRIORITY_FILE):
            return JSONResponse(status_code=404, content={"error": "File not found"})
        pr = load_priorities().reset_index()
        from building_categories import load_functions
        func = load_functions()
        return JSONResponse(content=[
            {"code": r["Ключ"], "name": r["Название"], "priority": int(r["Приоритет"]),
             "group": r["Группа"], "rank": int(r["Ранг"]), "function": func.get(r["Ключ"], "Прочее")}
            for _, r in pr.iterrows()
        ])
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


def generate_cluster_polygons_simple(clustered_features, method='convex_hull'):
    """Простая генерация полигонов кластеров"""
    from collections import defaultdict
    import math

    print(f"Получено features: {len(clustered_features)}")

    if not clustered_features:
        return {"type": "FeatureCollection", "features": []}
    
    # Группируем точки по кластерам
    clusters = defaultdict(list)
    for feature in clustered_features:
        cluster_id = feature['properties'].get('cluster_id')
        if cluster_id == 'Шум' or cluster_id is None:
            continue
        clusters[cluster_id].append(feature)

    print(f"Найдено кластеров: {len(clusters)}")
    
    polygons = []
    
    for cluster_id, features in clusters.items():
        if len(features) < 3:
            continue
        
        # Собираем координаты
        coords = []
        total_population = 0
        
        for f in features:
            coord = f['geometry']['coordinates']
            coords.append([coord[0], coord[1]])
            total_population += f['properties'].get('Насел', 0)
        
        # Создаем выпуклую оболочку
        polygon = convex_hull(coords)
        
        if polygon and len(polygon) >= 3:
            # Вычисляем площадь
            area = calculate_polygon_area(polygon)
            center = calculate_center(coords)
            
            polygons.append({
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [polygon + [polygon[0]]]
                },
                "properties": {
                    "cluster_id": int(cluster_id),
                    "point_count": len(features),
                    "total_population": total_population,
                    "area_sqkm": round(area, 4),
                    "density_per_sqkm": round(total_population / area if area > 0 else 0, 2),
                    "center_lat": center[1],
                    "center_lon": center[0]
                }
            })
    
    return {
        "type": "FeatureCollection",
        "features": polygons,
        "metadata": {"total_clusters": len(polygons)}
    }

def convex_hull(points):
    """Выпуклая оболочка (алгоритм Грэхема)"""
    if len(points) < 3:
        return points
    
    points = sorted(points)
    
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    
    lower = []
    for p in points:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    
    upper = []
    for p in reversed(points):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    
    return lower[:-1] + upper[:-1]

def calculate_polygon_area(polygon):
    """Вычисление площади полигона в км²"""
    if len(polygon) < 3:
        return 0
    
    area = 0
    n = len(polygon)
    for i in range(n):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % n]
        area += x1 * y2 - x2 * y1
    area = abs(area) / 2
    return area * (111 * 111)  # перевод в км²

def calculate_center(points):
    """Центр масс"""
    if not points:
        return [0, 0]
    sum_x = sum(p[0] for p in points)
    sum_y = sum(p[1] for p in points)
    return [sum_x / len(points), sum_y / len(points)]
@app.post("/export-polygons")
async def export_polygons(request: dict):
    """
    Экспортирует полигоны в файл
    Ожидает: {"polygons": {...}, "format": "geojson", "filename": "output.geojson"}
    """
    try:
        polygons = request.get('polygons')
        format_type = request.get('format', 'geojson')
        filename = request.get('filename', f'clusters.{format_type}')
        
        if not polygons:
            return JSONResponse(
                status_code=400,
                content={"error": "No polygons provided"}
            )
        
        # Сохраняем в папку exports
        export_dir = os.path.join(BASE_DIR, "exports")
        os.makedirs(export_dir, exist_ok=True)
        
        filepath = os.path.join(export_dir, filename)
        
        if format_type == 'geojson':
            PolygonExporter.export_to_geojson(polygons, filepath)
        elif format_type == 'shapefile':
            shapefile_path = filepath.replace('.shp', '') + '.shp'
            success = PolygonExporter.export_to_shapefile(polygons, shapefile_path)
            if not success:
                return JSONResponse(
                    status_code=500,
                    content={"error": "Failed to export to shapefile. Install geopandas: pip install geopandas"}
                )
        elif format_type == 'csv':
            PolygonExporter.export_to_csv(polygons, filepath)
        else:
            return JSONResponse(
                status_code=400,
                content={"error": f"Unsupported format: {format_type}"}
            )
        
        return JSONResponse(content={
            "message": f"Exported successfully",
            "filepath": filepath,
            "format": format_type
        })
        
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": f"Error exporting: {str(e)}"}
        )
    
    

@app.get("/load-agglom")
def load_agglom():
    """Агломерации (агломерация.gpkg)"""
    return _layer_response(AGGLOMERATIONS_FILE, (None,), "agglom")


@app.get("/")
async def root():
    with open("index.html", "r", encoding="utf-8") as f:
        return HTMLResponse(content=f.read())
    # ----------------------------
# Инициализация движков кластеризации
# ----------------------------
clustering_engine = ClusteringEngine()
geometry_utils = GeometryUtils()

# ----------------------------
# Модели данных для запросов
# ----------------------------
class ClusteringRequest(BaseModel):
    points: List[Dict[str, Any]]  # [{'lng': x, 'lat': y, 'population': pop}, ...]
    barriers: List[Dict[str, Any]]  # GeoJSON барьеры
    method: str  # 'kmeans' или 'dbscan'
    k: Optional[int] = 5  # для K-means
    epsilon: Optional[float] = 100  # для DBSCAN (метры)
    min_samples: Optional[int] = 3  # для DBSCAN

class GroupPointsRequest(BaseModel):
    points: List[Dict[str, Any]]
    barriers: List[Dict[str, Any]]

# ----------------------------
# Эндпоинты кластеризации
# ----------------------------

@app.post("/barrier-stats")
async def barrier_stats(barriers: List[Dict[str, Any]]):
    """
    Получает статистику по барьерам
    """
    try:
        stats = geometry_utils.get_barrier_stats(barriers)
        
        return JSONResponse(content={
            "success": True,
            "stats": stats
        })
        
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": f"Stats error: {str(e)}"}
        )

@app.post("/merge-barriers")
async def merge_barriers(barriers: List[Dict[str, Any]]):
    """
    Объединяет все барьеры в один полигон
    """
    try:
        merged = geometry_utils.merge_barriers(barriers)
        
        if merged:
            # Конвертируем в GeoJSON
            from shapely.geometry import mapping
            geojson = mapping(merged)
            
            return JSONResponse(content={
                "success": True,
                "merged_polygon": geojson
            })
        else:
            return JSONResponse(
                status_code=400,
                content={"error": "Could not merge barriers"}
            )
        
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": f"Merge error: {str(e)}"}
        )
# ----------------------------
# Инициализация движков кластеризации
# ----------------------------
clustering_engine = ClusteringEngine()
geometry_utils = GeometryUtils()

# ----------------------------
# Эндпоинты кластеризации (ВЫЗЫВАЮТСЯ ИЗ JavaScript)
# ----------------------------

@app.post("/api/cluster/kmeans")
async def kmeans_cluster(request: dict):
    points = request.get('points', [])
    k = request.get('k', 5)
    barriers = request.get('barriers', [])
    
    print(f"\n=== API /api/cluster/kmeans ===")
    print(f"Получено точек: {len(points)}")
    print(f"Получено барьеров: {len(barriers)}")
    
    if len(points) > 0:
        print(f"Пример точки: {points[0]}")
    
    if len(barriers) > 0:
        print(f"Тип барьера: {type(barriers[0])}")
        print(f"Ключи барьера: {barriers[0].keys() if isinstance(barriers[0], dict) else 'Не словарь'}")
        print(f"Содержимое барьера: {str(barriers[0])[:200]}")
    
    try:
        labels = clustering_engine.kmeans_with_barriers(points, k, barriers)
        print(f"Успешно! Получено меток: {len(labels)}")
        print(f"Уникальные кластеры: {set(labels)}")
        
        return {"labels": labels}
    except Exception as e:
        print(f"ОШИБКА: {e}")
        import traceback
        traceback.print_exc()
        return {"labels": [-1] * len(points), "error": str(e)}

@app.post("/api/cluster/dbscan")
async def dbscan_cluster(request: dict):
    points = request.get('points', [])
    epsilon = request.get('epsilon', 100)
    min_samples = request.get('min_samples', 3)
    barriers = request.get('barriers', [])
    labels = clustering_engine.dbscan_with_barriers(points, epsilon, min_samples, barriers)
    return {"labels": labels}

@app.post("/api/barriers/group-points")
async def group_points(request: dict):
    points = request.get('points', [])
    barriers = request.get('barriers', [])
    groups = geometry_utils.group_points_by_barriers(points, barriers)
    return {"groups": groups}
from shapely.ops import polygonize
from shapely.geometry import shape, MultiLineString, mapping

from shapely.ops import polygonize
from shapely.geometry import shape, MultiLineString, LineString, mapping

@app.post("/api/polygonize")
async def polygonize_endpoint(request: dict):
    """Полигонизация линий (как в QGIS processing.run('native:polygonize'))"""
    try:
        lines_data = request.get('lines', {})
        features = lines_data.get('features', [])
        
        linestrings = []
        for feat in features:
            geom = shape(feat['geometry'])
            
            if geom.geom_type == 'LineString':
                linestrings.append(geom)
            elif geom.geom_type == 'MultiLineString':
                # ИСПРАВЛЕНО: перебираем геометрии MultiLineString
                for line in geom.geoms:
                    linestrings.append(line)
            elif geom.geom_type == 'Polygon':
                # Если уже полигон, берем его границу
                boundary = geom.boundary
                if boundary.geom_type == 'LineString':
                    linestrings.append(boundary)
                elif boundary.geom_type == 'MultiLineString':
                    for line in boundary.geoms:
                        linestrings.append(line)
        
        if not linestrings:
            return {"polygons": []}
        
        # Полигонизация
        polygons = list(polygonize(linestrings))
        
        # Конвертация в GeoJSON
        result = []
        for poly in polygons:
            if poly.is_valid and poly.area > 0:
                result.append({
                    "type": "Feature",
                    "geometry": mapping(poly),
                    "properties": {}
                })
        
        print(f"Полигонизация: {len(linestrings)} линий -> {len(result)} полигонов")
        return {"polygons": result}
        
    except Exception as e:
        print(f"Ошибка полигонизации: {e}")
        import traceback
        traceback.print_exc()
        return {"polygons": []}
    


# ==================== РАЗРЕЗАНИЕ ОБЛАСТИ БАРЬЕРАМИ ====================
@app.post("/api/barrier-faces")
async def barrier_faces(request: dict):
    """
    Делит выделенную область на части (грани), которые барьеры отделяют друг от друга,
    и относит каждую точку (здание) к своей части.

    Вход:  area     — GeoJSON-геометрия выделенной области (EPSG:4326);
           barriers — FeatureCollection барьеров (линии и/или полигоны, EPSG:4326);
           points   — [[lng, lat], ...] точки зданий;
           buffer_m — полуширина «разреза» вдоль барьера, м (по умолчанию 5).
    Алгоритм (в метрах, UTM 48N):
      1) у полигональных барьеров берётся граница (линия): внутренняя часть — отдельная грань;
      2) все линии барьеров объединяются и расширяются на buffer_m — получается «разрез»;
         буфер замыкает мелкие разрывы между отрезками одной реки или дороги (до 2·buffer_m);
      3) грани = область минус разрез, разбитая на отдельные полигоны;
      4) точка относится к грани, внутри которой лежит; если попала в сам разрез —
         к ближайшей грани.
    Выход: faces (GeoJSON-полигоны граней), assign (номер грани для каждой точки), stats.
    """
    try:
        import geopandas as gpd
        import numpy as np
        import shapely
        from shapely.geometry import shape, mapping
        from shapely.ops import unary_union

        area = shape(request["area"]).buffer(0)
        feats = (request.get("barriers") or {}).get("features", [])
        pts = request.get("points") or []
        buf = float(request.get("buffer_m", 5))
        crs_m = "EPSG:32648"

        area_m = gpd.GeoSeries([area], crs=4326).to_crs(crs_m).iloc[0]
        geoms, is_relief = [], []
        for f in feats:
            try:
                g = shape(f["geometry"])
                if not g.is_empty:
                    geoms.append(g)
                    is_relief.append((f.get("properties") or {}).get("layer") == "relief")
            except Exception:
                continue
        n_used = 0
        cut = None
        if geoms:
            lines = []
            # крутые склоны (рельеф) вырезаются целиком: по склону нельзя пройти/проехать,
            # здания на нём относятся к ближайшей части области
            relief_mask = np.array(is_relief, dtype=bool)
            gs_all = gpd.GeoSeries(geoms, crs=4326)
            hit = gs_all.intersects(area.buffer(0.001)).values
            relief_polys = gs_all[hit & relief_mask].to_crs(crs_m).buffer(0)
            gs = gs_all[hit & ~relief_mask].to_crs(crs_m)
            for g in relief_polys:
                if not g.is_empty:
                    lines.append(g)
            for g in gs:
                if g.geom_type in ("Polygon", "MultiPolygon"):
                    lines.append(g.boundary)
                elif g.geom_type in ("LineString", "MultiLineString", "LinearRing"):
                    lines.append(g)
                elif g.geom_type == "GeometryCollection":
                    for p in g.geoms:
                        lines.append(p.boundary if p.geom_type in ("Polygon", "MultiPolygon") else p)
            n_used = len(lines)
            if lines:
                cut = unary_union(lines).buffer(buf, resolution=2)

        faces_geom = area_m.difference(cut) if cut is not None else area_m
        parts = [p for p in getattr(faces_geom, "geoms", [faces_geom]) if p.geom_type == "Polygon" and p.area > 1.0]
        parts.sort(key=lambda p: -p.area)

        assign = []
        if pts and parts:
            P = gpd.GeoSeries(gpd.points_from_xy([p[0] for p in pts], [p[1] for p in pts]), crs=4326).to_crs(crs_m)
            tree = shapely.STRtree(parts)
            a = np.full(len(P), -1, dtype=int)
            pi, fi = tree.query(P.values, predicate="within")
            a[pi] = fi
            miss = np.where(a < 0)[0]
            if len(miss):
                mi, mf = tree.query_nearest(P.values[miss], return_distance=False)
                a[miss[mi]] = mf
            assign = a.tolist()

        counts = np.bincount(np.array(assign, dtype=int), minlength=len(parts)).tolist() if assign else [0] * len(parts)
        faces_ll = gpd.GeoSeries(parts, crs=crs_m).simplify(1.0).to_crs(4326) if parts else []
        faces = [{"type": "Feature", "geometry": mapping(g),
                  "properties": {"face_id": i, "area_km2": round(parts[i].area / 1e6, 4), "points": counts[i]}}
                 for i, g in enumerate(faces_ll)]
        print(f"Барьеры: {len(feats)} объектов, в области {n_used} -> граней {len(parts)}, "
              f"непустых {sum(1 for c in counts if c)}, точек {len(pts)}")
        return {"faces": {"type": "FeatureCollection", "features": faces}, "assign": assign,
                "stats": {"barriers_in_area": n_used, "faces": len(parts),
                          "nonempty_faces": sum(1 for c in counts if c)}}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


# ==================== МОДЕЛЬ ХАФФА ПО УЛИЧНО-ДОРОЖНОЙ СЕТИ ====================
RELIEF_K_H = 8.0       # правило Нейсмита: 1 м подъёма ≈ 8 м горизонтального пути
RELIEF_MAX_GRADE = 0.21  # tg 12° — круче этого соседние здания не считаются связанными
_road_graph_relief = None
_graph_node_elev = None
_road_graph = None   # кэш графа: (координаты узлов, матрица смежности, KD-дерево узлов главной компоненты, их индексы)


def _load_road_graph():
    """Граф УДС из граф.gpkg (VISUM): узлы — концы рёбер (сведены с точностью 5 м), вес ребра — длина, м."""
    global _road_graph
    if _road_graph is not None:
        return _road_graph
    import numpy as np
    import geopandas as gpd
    from shapely.geometry import shape
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    from scipy.spatial import cKDTree
    try:
        g = gpd.read_file(GRAPH_FILE)
    except Exception:
        # без pyogrio/fiona читаем через QGIS (как слой «Граф» на карте)
        gj = layer_to_geojson(GRAPH_FILE)
        g = gpd.GeoDataFrame(geometry=[shape(f["geometry"]) for f in gj["features"]], crs=4326)
    g = g[g.geometry.notna() & ~g.geometry.is_empty].to_crs(32648).explode(index_parts=False)
    g = g[g.geometry.geom_type == "LineString"]
    xy0 = np.array([l.coords[0][:2] for l in g.geometry])
    xy1 = np.array([l.coords[-1][:2] for l in g.geometry])
    n = len(g)
    keys = np.round(np.vstack([xy0, xy1]) / 5.0)
    uniq, inv = np.unique(keys, axis=0, return_inverse=True)
    inv = inv.ravel()
    nodes = uniq * 5.0
    lengths = np.maximum(g.geometry.length.values, 0.1)
    adj = coo_matrix((lengths, (inv[:n], inv[n:])), shape=(len(nodes), len(nodes))).tocsr()
    nc, lab = connected_components(adj, directed=False)
    main = np.where(lab == np.bincount(lab).argmax())[0]
    _road_graph = (nodes, adj, cKDTree(nodes[main]), main)
    print(f"Граф УДС: {n} рёбер, {len(nodes)} узлов, главная компонента {len(main)} узлов")
    # Вариант графа с учётом рельефа: «приведённая длина» ребра по правилу Нейсмита
    #   L' = L + K_H·|Δh|,  K_H = 8 (подъём на 1 м ≈ 8 м пути по ровному)
    # Δh — разность высот концов ребра по SRTM. Граф неориентированный, поэтому подъём и спуск
    # учитываются одинаково (для пешехода и транспорта и то, и другое замедляет движение).
    global _road_graph_relief, _graph_node_elev
    try:
        import relief
        if relief.load_dem() is not None:
            ll = gpd.GeoSeries(gpd.points_from_xy(nodes[:, 0], nodes[:, 1]), crs=32648).to_crs(4326)
            z = relief.elevation(ll.x.values, ll.y.values)
            z = np.where(np.isfinite(z), z, np.nanmedian(z))
            dh = np.abs(z[inv[:n]] - z[inv[n:]])
            _graph_node_elev = z
            _road_graph_relief = coo_matrix((lengths + RELIEF_K_H * dh, (inv[:n], inv[n:])),
                                            shape=(len(nodes), len(nodes))).tocsr()
            print(f"  рельеф: высоты узлов {z.min():.0f}…{z.max():.0f} м, средний перепад на ребре {dh.mean():.1f} м")
    except Exception as e:
        print(f"  рельеф для графа не подключён: {e}")
    return _road_graph



def _make_contiguous(pxy, labels, faces, anchor_idx, radius=150.0, iters=60, elev=None, knn=8, smooth=3):
    """
    Делает каждый район сплошным.
    Граф соседства зданий: у каждого здания — до knn ближайших соседей не дальше radius (м),
    в той же части области между барьерами; с рельефом — без пар, между которыми склон круче 12°.
    Район сплошной, если его здания связаны цепочкой соседей своего же района.
    Для каждого района главный кусок — тот, где стоит здание-центр (если он не крошечный),
    иначе самый большой. Остальные куски района («оторванные») за несколько проходов передаются:
      • району, с главным куском которого у них больше всего связей;
      • если связей нет вовсе (кусок отделён пустырём) — району ближайшего здания из главных кусков
        той же части области; если это свой же район — кусок остаётся (он просто стоит отдельно).
    Возвращает (labels, число_переданных_зданий, пары_соседних_районов).
    """
    import numpy as np
    from scipy.spatial import cKDTree
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    n = len(pxy)
    labels = np.asarray(labels).copy()
    if n < 2:
        return labels, 0, []
    tree = cKDTree(pxy)
    k = min(knn + 1, n)
    dist, nb = tree.query(pxy, k=k, distance_upper_bound=radius)
    src = np.repeat(np.arange(n), k)
    dst = nb.ravel(); dd = dist.ravel()
    ok = np.isfinite(dd) & (dst < n) & (dst != src)
    src, dst, dd = src[ok], dst[ok], dd[ok]
    pairs = np.unique(np.sort(np.c_[src, dst], axis=1), axis=0)
    pairs = pairs[faces[pairs[:, 0]] == faces[pairs[:, 1]]]
    if elev is not None and len(pairs):
        # рельеф: соседи только если перепад высот не круче 12° (уклон ≤ 21 %) —
        # район не «перетекает» с террасы на террасу через крутой откос
        d = np.hypot(*(pxy[pairs[:, 0]] - pxy[pairs[:, 1]]).T)
        dh = np.abs(elev[pairs[:, 0]] - elev[pairs[:, 1]])
        pairs = pairs[~(np.isfinite(dh) & (dh > RELIEF_MAX_GRADE * np.maximum(d, 30.0)))]
    a_all, b_all = pairs[:, 0], pairs[:, 1]
    # сглаживание границ (модальный фильтр): если у здания большинство соседей (≥ 5 из 8) из одного
    # другого района, а своих — меньше трёх, здание переходит к соседям. Убирает «вкрапления»
    # на стыке районов, которые дают узлы дорожной сети. Здание-центр не трогаем.
    if smooth:
        nbm = np.where(np.isfinite(dist[:, 1:]) & (nb[:, 1:] < n), nb[:, 1:], -1)
        nbm = np.where((nbm >= 0) & (faces[np.clip(nbm, 0, n - 1)] == faces[:, None]), nbm, -1)
        fixed = np.zeros(n, bool); fixed[np.asarray(anchor_idx)[np.asarray(anchor_idx) < n]] = True
        moved_s = 0
        for _ in range(smooth):
            L = np.where(nbm >= 0, labels[np.clip(nbm, 0, n - 1)], -1)
            own = (L == labels[:, None]).sum(1)
            best_l = np.full(n, -1); best_c = np.zeros(n, int)
            for col in range(L.shape[1]):
                cand = L[:, col]
                c = (L == cand[:, None]).sum(1)
                upd = (cand >= 0) & (c > best_c)
                best_l[upd] = cand[upd]; best_c[upd] = c[upd]
            ch = (~fixed) & (own < 3) & (best_c >= 5) & (best_l != labels) & (best_l >= 0)
            if not ch.any():
                break
            labels[ch] = best_l[ch]; moved_s += int(ch.sum())
    # «острова» застройки: связные группы зданий без учёта районов (между ними — пустыри > radius)
    _, isl = connected_components(coo_matrix((np.ones(len(a_all)), (a_all, b_all)), shape=(n, n)), directed=False)

    moved_total = moved_s if smooth else 0
    accepted_pts = set()      # куски, которые остаются отдельно (их представитель — номер здания)
    for _ in range(iters):
        same = labels[a_all] == labels[b_all]
        g = coo_matrix((np.ones(same.sum()), (a_all[same], b_all[same])), shape=(n, n))
        _, comp = connected_components(g, directed=False)
        size = np.bincount(comp)
        # главный кусок каждого района
        nl = labels.max() + 1
        best = np.full(nl, -1); best_size = np.zeros(nl)
        order = np.argsort(-size[comp], kind="stable")
        for i in order:              # по убыванию размера куска — первый встреченный и есть самый большой
            l = labels[i]
            if best[l] < 0:
                best[l] = comp[i]; best_size[l] = size[comp[i]]
        for cl, ai in enumerate(anchor_idx):
            if 0 <= ai < n and cl < nl and labels[ai] == cl and size[comp[ai]] >= 0.3 * best_size[cl]:
                best[cl] = comp[ai]
        is_main = np.zeros(len(size), bool); is_main[best[best >= 0]] = True
        acc = {int(comp[p]) for p in accepted_pts}
        orphan = ~is_main[comp]
        if acc:
            orphan &= ~np.isin(comp, list(acc))
        if not orphan.any():
            break
        new = {}
        # 1) голоса: связи оторванного куска с ГЛАВНЫМИ кусками других районов
        for x, y in ((a_all, b_all), (b_all, a_all)):
            m = orphan[x] & is_main[comp[y]]
            if m.any():
                cx, ly = comp[x[m]], labels[y[m]]
                key = cx.astype(np.int64) * (nl + 1) + ly
                u, cnt = np.unique(key, return_counts=True)
                for kk, c in zip(u, cnt):
                    cc, ll = int(kk // (nl + 1)), int(kk % (nl + 1))
                    if cc not in new or c > new[cc][1]:
                        new[cc] = (ll, c)
        new = {c: v[0] for c, v in new.items()}
        voted = bool(new)
        # 2) острова застройки, где нет ни одного главного куска (весь остров — обрезки разных районов):
        #    весь остров целиком — району ближайшего главного куска той же части области;
        #    если голосов не было вовсе — так же поступаем с каждым оставшимся куском
        island_main = np.zeros(isl.max() + 1, bool)
        island_main[isl[is_main[comp]]] = True
        rest = orphan & ~np.isin(comp, list(new.keys()))
        main_pts = np.where(is_main[comp])[0]
        groups = []
        for I in np.unique(isl[rest & ~island_main[isl]]):
            groups.append(np.where(rest & (isl == I))[0])
        if not voted:
            for c in np.unique(comp[rest & island_main[isl]]):
                groups.append(np.where(comp == c)[0])
        trees = {}
        for idx in groups:
            f = faces[idx[0]]
            if f not in trees:
                cand = main_pts[faces[main_pts] == f]
                trees[f] = (cand, cKDTree(pxy[cand]) if len(cand) else None)
            cand, t = trees[f]
            if t is None:
                continue
            dmin, j = t.query(pxy[idx])
            tl = int(labels[cand[j[dmin.argmin()]]])
            if (labels[idx] == tl).all():
                for c in np.unique(comp[idx]):
                    accepted_pts.add(int(np.where(comp == c)[0][0]))
            else:
                for c in np.unique(comp[idx]):
                    new[int(c)] = tl
        if not new:
            break
        idx = np.where(orphan & np.isin(comp, list(new.keys())))[0]
        nl_new = np.array([new[c] for c in comp[idx]])
        moved = int((labels[idx] != nl_new).sum())
        labels[idx] = nl_new
        moved_total += moved
        if moved == 0:
            break
    # соседние районы (для раскраски: соседи — разными цветами)
    adj = set()
    d = labels[a_all] != labels[b_all]
    for x, y in zip(labels[a_all[d]], labels[b_all[d]]):
        adj.add((int(min(x, y)), int(max(x, y))))
    return labels, moved_total, sorted(adj)

@app.post("/api/huff-assign")
async def huff_assign(request: dict):
    """
    Распределение зданий по центрам притяжения по модели Хаффа:
        A_ij = M_j / max(d_ij, d0)^β,  здание i относится к центру с наибольшим A_ij
    d_ij — кратчайшее расстояние по улично-дорожной сети (граф.gpkg) от здания до центра:
        подход к ближайшему узлу графа + путь по графу + подход от узла к центру.
    Здание может относиться только к центру из своей части области (барьеры).
    Вход: points [[lng,lat]], faces [номер части для каждой точки],
          anchors [{lng,lat,mass,face}], beta, d0, network (true/false).
    """
    try:
        import numpy as np
        import geopandas as gpd
        pts = request.get("points") or []
        faces = request.get("faces")
        anchors = request.get("anchors") or []
        beta = float(request.get("beta", 2.0))
        d0 = float(request.get("d0", 100.0))
        use_net = bool(request.get("network", True))
        use_relief = bool(request.get("relief", False))
        if not pts or not anchors:
            return {"labels": [], "method": "none"}

        P = gpd.GeoSeries(gpd.points_from_xy([p[0] for p in pts], [p[1] for p in pts]), crs=4326).to_crs(32648)
        A = gpd.GeoSeries(gpd.points_from_xy([a["lng"] for a in anchors], [a["lat"] for a in anchors]), crs=4326).to_crs(32648)
        pxy = np.c_[P.x.values, P.y.values]
        axy = np.c_[A.x.values, A.y.values]
        mass = np.array([max(float(a.get("mass") or 1), 1.0) for a in anchors])
        pf = np.array(faces if faces else [0] * len(pts))
        p_elev = None
        a_idx_near = None
        if use_relief:
            try:
                import relief
                from scipy.spatial import cKDTree as _KD
                p_elev = relief.elevation([p[0] for p in pts], [p[1] for p in pts])
                a_idx_near = _KD(pxy).query(axy)[1]
            except Exception as e:
                print(f"Высоты не получены: {e}")
        af = np.array([a.get("face", 0) for a in anchors])

        method = "euclid"
        D = None
        if use_net:
            try:
                from scipy.sparse.csgraph import dijkstra
                nodes, adj, tree, main = _load_road_graph()
                if use_relief and _road_graph_relief is not None:
                    adj = _road_graph_relief
                # здание подключается к сети в 3 ближайших узлах (как «коннекторы» зоны в VISUM):
                # d_ij = min по узлам n (подход здания к n + путь по графу от n до центра) + подход центра.
                # С одним узлом все здания вокруг него получали одинаковые расстояния и уходили
                # к одному центру целиком — районы получались «пятнистыми».
                KC = int(request.get("connectors", 3))
                ds_pk, ipk = tree.query(pxy, k=KC)
                ds_pk = ds_pk.reshape(len(pxy), -1); ipk = ipk.reshape(len(pxy), -1)
                ds_a, ia = tree.query(axy)
                nodes_k = main[ipk]
                np_node = nodes_k[:, 0]
                ds_p = ds_pk[:, 0]
                na_node = main[ia]
                net = dijkstra(adj, directed=False, indices=na_node, limit=60000)   # K × узлы, м
                rel_on = use_relief and _graph_node_elev is not None and p_elev is not None
                D = None
                for kk in range(ds_pk.shape[1]):
                    acc = ds_pk[:, kk].copy()
                    if rel_on:   # подход от здания к узлу — тоже с перепадом высот
                        acc += RELIEF_K_H * np.nan_to_num(np.abs(p_elev - _graph_node_elev[nodes_k[:, kk]]))
                    Dk = acc[None, :] + net[:, nodes_k[:, kk]]
                    D = Dk if D is None else np.minimum(D, Dk)
                D = D + ds_a[:, None]                                               # K × точки
                if rel_on:
                    a_elev = p_elev[a_idx_near]
                    D = D + RELIEF_K_H * np.nan_to_num(np.abs(a_elev - _graph_node_elev[na_node]))[:, None]
                # точки далеко от графа (> 1 км) или недостижимые — по прямой с коэффициентом извилистости 1,3
                eu = np.hypot(pxy[None, :, 0] - axy[:, None, 0], pxy[None, :, 1] - axy[:, None, 1])
                bad = ~np.isfinite(D) | (ds_p[None, :] > 1000)
                D = np.where(bad, eu * 1.3, D)
                method = "network+relief" if (use_relief and _road_graph_relief is not None) else "network"
            except Exception as e:
                print(f"Граф УДС недоступен, расстояние по прямой: {e}")
                D = None
        if D is None:
            D = np.hypot(pxy[None, :, 0] - axy[:, None, 0], pxy[None, :, 1] - axy[:, None, 1])

        att = mass[:, None] / np.power(np.maximum(D, d0), beta)            # K × точки
        att = np.where(af[:, None] == pf[None, :], att, -1.0)               # только свои части области
        labels = att.argmax(axis=0)
        # если в части нет центра (не должно быть) — ближайший центр
        nofit = att.max(axis=0) < 0
        if nofit.any():
            labels[nofit] = D[:, nofit].argmin(axis=0)
        # здания комплекса (корпуса вуза, ТЦ) всегда относятся к своему центру
        for j, a in enumerate(anchors):
            for m in a.get("members") or []:
                if 0 <= m < len(labels):
                    labels[m] = j
        # здание-центр: ближайшая к центру точка
        from scipy.spatial import cKDTree
        _, anchor_idx = cKDTree(pxy).query(axy)
        # каждый район — сплошная территория
        moved, adjacency = 0, []
        if request.get("contiguous", True):
            labels, moved, adjacency = _make_contiguous(pxy, np.asarray(labels), pf, np.asarray(anchor_idx),
                                                        radius=float(request.get("contig_radius", 150)),
                                                        elev=p_elev)
        dist = D[labels, np.arange(len(pts))]
        relief_info = None
        if p_elev is not None:
            relief_info = {"elev_min": float(np.nanmin(p_elev)), "elev_max": float(np.nanmax(p_elev))}
        print(f"Хафф: {len(pts)} зданий, {len(anchors)} центров, расстояние: {method}, "
              f"медиана до центра {np.median(dist):.0f} м, оторванных зданий передано соседям: {moved}")
        return {"labels": labels.tolist(), "method": method, "moved": moved, "adjacency": adjacency,
                "relief": relief_info,
                "median_dist_m": float(np.median(dist)), "dist_m": np.round(dist).astype(int).tolist()}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


# ==================== ЗАПУСК СЕРВЕРА ====================
if __name__ == "__main__":
    import uvicorn
    print("=" * 50)
    print("🚀 ЗАПУСК СЕРВЕРА QGIS WEB TEST")
    print("=" * 50)
    print(f"📁 Данные: {DATA_DIR}")
    print(f"🌐 Сервер: http://127.0.0.1:8000")
    print("=" * 50)
    uvicorn.run(app, host="127.0.0.1", port=8000)