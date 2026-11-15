"""
Центроиды зданий по площади.

Берёт полигоны зданий (data/здания_генерация.parquet) и для каждого здания
считает центроид — центр масс его площади (как «Центроиды» в QGIS).
Расчёт ведётся в метрической проекции UTM 48N (EPSG:32648), чтобы площадь
и центр масс не искажались проекцией Меркатора.

Результат:
  data/здания_центроиды.parquet  — для веб-приложения (быстро читается)
  exports/здания_центроиды.gpkg   — для открытия в QGIS (по флагу --gpkg)

Запуск:  python building_centroids.py            (только parquet)
         python building_centroids.py --gpkg     (+ gpkg для QGIS)
"""
import os
import sys

import geopandas as gpd
import numpy as np
from shapely.geometry import MultiPolygon, Polygon

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SRC_FILE = os.path.join(BASE_DIR, "data", "здания_генерация.parquet")
DST_FILE = os.path.join(BASE_DIR, "data", "здания_центроиды.parquet")
GPKG_FILE = os.path.join(BASE_DIR, "exports", "здания_центроиды.gpkg")

METRIC_CRS = "EPSG:32648"  # UTM зона 48N — Иркутская область

# Поля, которые переносим из полигонов в точки
KEEP_FIELDS = [
    "src", "mo_name", "village_name", "footprint_m2", "FLOORS",
    "total_area_m2", "inhab", "workers", "Z_daily_total",
]


def _only_polygons(geom):
    """Из GeometryCollection оставляем только полигональные части."""
    if geom is None or geom.is_empty:
        return None
    if isinstance(geom, (Polygon, MultiPolygon)):
        return geom
    if hasattr(geom, "geoms"):
        parts = []
        for g in geom.geoms:
            if isinstance(g, Polygon):
                parts.append(g)
            elif isinstance(g, MultiPolygon):
                parts.extend(g.geoms)
        if parts:
            return MultiPolygon(parts)
    return None


def build_centroids(src=SRC_FILE, dst=DST_FILE, gpkg=None):
    print(f"Чтение {src} ...")
    gdf = gpd.read_parquet(src)
    n_src = len(gdf)

    gdf["geometry"] = gdf.geometry.apply(_only_polygons)
    gdf = gdf[gdf.geometry.notna()].copy()
    # чиним самопересечения, иначе площадь/центроид могут быть неверными
    invalid = ~gdf.geometry.is_valid
    if invalid.any():
        gdf.loc[invalid, "geometry"] = gdf.loc[invalid, "geometry"].buffer(0)

    metric = gdf.to_crs(METRIC_CRS)
    poly_area = metric.geometry.area
    centroids = metric.geometry.centroid  # центр масс площади полигона

    keep = [c for c in KEEP_FIELDS if c in gdf.columns]
    out = gpd.GeoDataFrame(gdf[keep].copy(), geometry=centroids, crs=METRIC_CRS)
    out["area_m2"] = poly_area.round(2)
    # Вес для центров районов: площадь этажей = реальная площадь пятна × этажность.
    # Поле footprint_m2 в исходнике посчитано в Меркаторе (EPSG:3395) и на широте
    # Иркутска завышено ~в 2.7 раза, поэтому площадь берём свою (area_m2, UTM).
    floors = out["FLOORS"].fillna(1).clip(lower=1) if "FLOORS" in out.columns else 1
    out["weight_area"] = (out["area_m2"] * floors).round(2)
    # центроид L/П-образного здания может оказаться вне его контура — отмечаем
    out["inside"] = centroids.within(metric.geometry).values
    # точка гарантированно внутри контура — для звезды центра притяжения у Г-/П-образных зданий,
    # у которых центр масс лежит снаружи (во дворе)
    rep = gpd.GeoSeries(metric.geometry.representative_point().values, crs=METRIC_CRS).to_crs("EPSG:4326")
    out["in_lng"] = np.where(out["inside"], np.nan, rep.x.values)
    out["in_lat"] = np.where(out["inside"], np.nan, rep.y.values)

    # Категория здания по рубрикам 2ГИС с приоритетами (если есть файлы data/rubriki)
    try:
        from building_categories import assign_building_categories, files_available
        if files_available():
            print("Категории зданий по рубрикам 2ГИС ...")
            cats = assign_building_categories(
                metric, gdf["inhab"] if "inhab" in gdf.columns else None,
                foot=poly_area, floors=gdf["FLOORS"] if "FLOORS" in gdf.columns else None)
            for c in ["cat_code", "cat_name", "cat_priority", "cat_group", "n_orgs", "cat_source", "mix", "org_cats", "top_org"]:
                out[c] = cats[c].values
        else:
            print("  файлов data/rubriki нет — категории не назначены")
    except Exception as e:
        print(f"  категории не назначены: {e}")

    out = out.to_crs("EPSG:4326")
    out = out.reset_index(drop=True)
    # высота здания над уровнем моря по SRTM (если рельеф подготовлен скриптом relief.py)
    try:
        import relief
        if relief.load_dem() is not None:
            out["elev"] = np.round(relief.elevation(out.geometry.x.values, out.geometry.y.values), 1)
    except Exception as e:
        print(f"  высоты зданий не добавлены: {e}")
    out.insert(0, "bld_id", range(1, len(out) + 1))

    os.makedirs(os.path.dirname(dst), exist_ok=True)
    out.to_parquet(dst)
    print(f"Готово: {len(out)} центроидов из {n_src} зданий -> {dst}")
    print(f"  центроид вне контура здания: {(~out['inside']).sum()}")

    if gpkg:
        os.makedirs(os.path.dirname(gpkg), exist_ok=True)
        out.to_file(gpkg, layer="здания_центроиды", driver="GPKG")
        print(f"  GeoPackage для QGIS -> {gpkg}")
    return out


if __name__ == "__main__":
    build_centroids(gpkg=GPKG_FILE if "--gpkg" in sys.argv else None)
