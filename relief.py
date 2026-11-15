"""
Рельеф для районирования (по цифровой модели рельефа SRTM 1″ ≈ 30 м).

Исходные данные: тайлы SRTM data/рельеф/srtm/N51E102.hgt … N52E105.hgt
(командная папка «проект/rar file/landscapes»). Каждый тайл — 3601×3601 высот
(int16, big-endian), шаг 1″, строка 0 — северный край тайла.

Что делает скрипт (один раз, результат лежит в data/рельеф и используется сервером):
  1) склеивает тайлы в одну модель рельефа (DEM) и обрезает по охвату зданий;
  2) считает уклон каждой ячейки:  α = arctg( √((∂h/∂x)² + (∂h/∂y)²) ), градусы;
  3) выделяет КРУТЫЕ СКЛОНЫ α ≥ 12° (≈ 21 %; по СП 42.13330 территории с уклоном > 20 %
     неблагоприятны для застройки и дорог) — это и есть барьер «Рельеф»:
     сглаживание шума, морфологическое «открытие/закрытие», отбрасывание пятен < 2 га,
     перевод в полигоны → data/рельеф/крутые_склоны.gpkg;
  4) сохраняет облегчённую модель высот (шаг 2″ ≈ 60×40 м) → data/рельеф/dem_2s.npz —
     по ней сервер берёт высоты узлов дорожного графа и зданий;
  5) рисует отмывку рельефа (hillshade) → data/рельеф/отмывка.png для подложки карты;
  6) добавляет высоту каждого здания (поле elev) в data/здания_центроиды.parquet.

Запуск:  python relief.py                       (тайлы лежат в data/рельеф/srtm)
         python relief.py "папка/с/тайлами"      (например «проект/rar file/landscapes»)
Результаты уже лежат в data/рельеф — перезапускать нужно только при смене порога или данных.
"""
import json
import os

import numpy as np

BASE = os.path.dirname(os.path.abspath(__file__))
RDIR = os.path.join(BASE, "data", "рельеф")
SRTM_DIR = os.path.join(RDIR, "srtm")
DEM_FILE = os.path.join(RDIR, "dem_2s.npz")
SLOPES_FILE = os.path.join(RDIR, "крутые_склоны.gpkg")
SHADE_FILE = os.path.join(RDIR, "отмывка.png")
SHADE_META = os.path.join(RDIR, "отмывка.json")
CENTROIDS = os.path.join(BASE, "data", "здания_центроиды.parquet")

EXTENT = (102.5, 51.7, 105.6, 53.0)   # lon_min, lat_min, lon_max, lat_max — охват зданий
SLOPE_DEG = 12.0                      # порог крутого склона, градусы
MIN_AREA_M2 = 20000                   # меньшие пятна склонов не считаем барьером (2 га)
ARC = 1 / 3600                        # 1 угловая секунда
M_PER_DEG = 111320.0


# ---------- 1. Мозаика тайлов ----------
def read_tile(path):
    a = np.fromfile(path, ">i2").reshape(3601, 3601).astype(np.float32)
    a[a < -1000] = np.nan                       # пустоты SRTM
    return a


def mosaic(extent=EXTENT):
    lon0, lat0, lon1, lat1 = extent
    lons = range(int(np.floor(lon0)), int(np.floor(lon1 - 1e-9)) + 1)
    lats = range(int(np.floor(lat0)), int(np.floor(lat1 - 1e-9)) + 1)
    W, H = len(lons) * 3600 + 1, len(lats) * 3600 + 1
    dem = np.full((H, W), np.nan, np.float32)
    top = max(lats) + 1                          # северный край мозаики
    for la in lats:
        for lo in lons:
            p = os.path.join(SRTM_DIR, f"N{la:02d}E{lo:03d}.hgt")
            if not os.path.exists(p):
                print("  нет тайла", os.path.basename(p))
                continue
            r = (top - (la + 1)) * 3600
            c = (lo - min(lons)) * 3600
            dem[r:r + 3601, c:c + 3601] = read_tile(p)
    west = min(lons)
    # обрезка по охвату
    r0 = int(round((top - lat1) / ARC)); r1 = int(round((top - lat0) / ARC)) + 1
    c0 = int(round((lon0 - west) / ARC)); c1 = int(round((lon1 - west) / ARC)) + 1
    dem = dem[r0:r1, c0:c1]
    if np.isnan(dem).any():                      # заполняем пустоты ближайшими высотами
        from scipy import ndimage
        idx = ndimage.distance_transform_edt(np.isnan(dem), return_distances=False, return_indices=True)
        dem = dem[tuple(idx)]
    return dem, (lon0, lat1)                     # (lon западного края, lat северного края)


# ---------- 2. Уклон ----------
def slope_deg(dem, lat_c):
    dy = ARC * M_PER_DEG
    dx = ARC * M_PER_DEG * np.cos(np.radians(lat_c))
    gy, gx = np.gradient(dem, dy, dx)
    return np.degrees(np.arctan(np.hypot(gx, gy)))


# ---------- 3. Крутые склоны → полигоны ----------
def steep_polygons(dem, origin):
    from scipy import ndimage
    import contourpy
    import geopandas as gpd
    from shapely.geometry import Polygon

    lon0, latN = origin
    lat_c = latN - dem.shape[0] * ARC / 2
    sm = ndimage.gaussian_filter(dem, 1.0)       # SRTM шумит ±(3–5) м — сглаживаем
    s = slope_deg(sm, lat_c)
    mask = s >= SLOPE_DEG
    mask = ndimage.binary_opening(mask, iterations=1)   # убираем одиночные «шумовые» ячейки
    mask = ndimage.binary_closing(mask, iterations=2)   # склеиваем разорванный склон
    lab, n = ndimage.label(mask)
    cell = (ARC * M_PER_DEG) ** 2 * np.cos(np.radians(lat_c))
    sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(1, n + 1)) * cell
    keep = np.zeros(n + 1, bool); keep[1:] = sizes >= MIN_AREA_M2
    mask = keep[lab]
    print(f"  крутые склоны ≥{SLOPE_DEG}°: {int(keep.sum())} пятен, {mask.sum() * cell / 1e6:.1f} км²")

    # контур маски по уровню 0.5 → полигоны (с дырками)
    f = np.pad(mask.astype(np.float32), 1)
    gen = contourpy.contour_generator(z=f, fill_type=contourpy.FillType.OuterOffset)
    polys, offs = gen.filled(0.5, 1.5)
    out = []
    for pts, off in zip(polys, offs):
        rings = [pts[off[i]:off[i + 1]] for i in range(len(off) - 1)]
        conv = [np.c_[lon0 + (r[:, 0] - 1) * ARC, latN - (r[:, 1] - 1) * ARC] for r in rings]
        p = Polygon(conv[0], conv[1:])
        if p.is_valid or True:
            out.append(p.buffer(0))
    gdf = gpd.GeoDataFrame({"slope_min": [SLOPE_DEG] * len(out)}, geometry=out, crs=4326)
    m = gdf.to_crs(32648)
    m["geometry"] = m.simplify(15)               # упрощение до 15 м (размер ячейки 30 м)
    m = m[m.area >= MIN_AREA_M2]
    # средний уклон внутри пятна — для подписи
    gdf = m.to_crs(4326)
    gdf["area_ha"] = (m.area / 1e4).round(1).values
    gdf = gdf.explode(index_parts=False).reset_index(drop=True)
    gdf = gdf[gdf.to_crs(32648).area >= MIN_AREA_M2].reset_index(drop=True)
    gdf["id"] = np.arange(1, len(gdf) + 1)
    return gdf, s


# ---------- 4–5. Облегчённый DEM и отмывка ----------
def save_dem(dem, origin, step=2):
    lon0, latN = origin
    d = np.round(dem[::step, ::step]).astype(np.int16)
    np.savez_compressed(DEM_FILE, h=d, lon0=lon0, latN=latN, step=step * ARC)
    print(f"  DEM {d.shape} -> {DEM_FILE} ({os.path.getsize(DEM_FILE) / 1e6:.1f} МБ)")


def hillshade_png(dem, origin, step=3):
    """Отмывка: освещение с северо-запада (азимут 315°, высота 45°), строки
    пересчитаны в проекцию Меркатора, чтобы картинка ровно легла на веб-карту."""
    from PIL import Image
    lon0, latN = origin
    d = dem[::step, ::step].astype(np.float64)
    st = ARC * step
    lat_c = latN - d.shape[0] * st / 2
    gy, gx = np.gradient(d, st * M_PER_DEG, st * M_PER_DEG * np.cos(np.radians(lat_c)))
    slope = np.arctan(np.hypot(gx, gy) * 2.0)     # ×2 — усиление рельефа для наглядности
    aspect = np.arctan2(-gx, gy)
    az, alt = np.radians(315), np.radians(45)
    hs = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    hs = np.clip(hs, 0, 1)
    # строки равномерно по Меркатору
    lats = latN - np.arange(d.shape[0]) * st
    latS = lats[-1]
    merc = lambda la: np.log(np.tan(np.pi / 4 + np.radians(la) / 2))
    ys = np.linspace(merc(latN), merc(latS), d.shape[0])
    lat_rows = np.degrees(2 * np.arctan(np.exp(ys)) - np.pi / 2)
    ri = np.clip(np.round((latN - lat_rows) / st).astype(int), 0, d.shape[0] - 1)
    hs = hs[ri]
    # тёмные (теневые) склоны — непрозрачнее, освещённые — прозрачные
    shade = (1 - hs)
    alpha = np.clip((shade - 0.25) * 1.6, 0, 1) * 200
    img = np.zeros(hs.shape + (4,), np.uint8)
    img[..., 0] = 60; img[..., 1] = 45; img[..., 2] = 30
    img[..., 3] = alpha.astype(np.uint8)
    Image.fromarray(img, "RGBA").save(SHADE_FILE, optimize=True)
    bounds = [[latS, lon0], [latN, lon0 + (d.shape[1] - 1) * st]]
    json.dump({"bounds": bounds}, open(SHADE_META, "w"))
    print(f"  отмывка {img.shape[1]}×{img.shape[0]} -> {SHADE_FILE} ({os.path.getsize(SHADE_FILE) / 1e6:.1f} МБ)")


# ---------- Высоты точек по DEM (используется и сервером) ----------
_dem_cache = None


def load_dem():
    global _dem_cache
    if _dem_cache is None and os.path.exists(DEM_FILE):
        z = np.load(DEM_FILE)
        _dem_cache = (z["h"].astype(np.float32), float(z["lon0"]), float(z["latN"]), float(z["step"]))
    return _dem_cache


def elevation(lon, lat):
    """Высота (м) в точках по билинейной интерполяции DEM; вне охвата — NaN."""
    D = load_dem()
    lon = np.asarray(lon, float); lat = np.asarray(lat, float)
    if D is None:
        return np.full(lon.shape, np.nan)
    h, lon0, latN, st = D
    c = (lon - lon0) / st; r = (latN - lat) / st
    ok = (c >= 0) & (r >= 0) & (c < h.shape[1] - 1) & (r < h.shape[0] - 1)
    out = np.full(lon.shape, np.nan)
    c0 = np.floor(c[ok]).astype(int); r0 = np.floor(r[ok]).astype(int)
    fc = c[ok] - c0; fr = r[ok] - r0
    out[ok] = (h[r0, c0] * (1 - fc) * (1 - fr) + h[r0, c0 + 1] * fc * (1 - fr)
               + h[r0 + 1, c0] * (1 - fc) * fr + h[r0 + 1, c0 + 1] * fc * fr)
    return out


def add_building_elevation(path=CENTROIDS):
    import geopandas as gpd
    if not os.path.exists(path):
        return
    g = gpd.read_parquet(path)
    g["elev"] = np.round(elevation(g.geometry.x.values, g.geometry.y.values), 1)
    g.to_parquet(path)
    print(f"  высоты зданий: {np.isfinite(g['elev']).sum()} из {len(g)}, "
          f"от {np.nanmin(g['elev']):.0f} до {np.nanmax(g['elev']):.0f} м")


def main():
    import sys
    global SRTM_DIR
    if len(sys.argv) > 1:
        SRTM_DIR = sys.argv[1]
    os.makedirs(RDIR, exist_ok=True)
    print("Склейка тайлов SRTM ...")
    dem, origin = mosaic()
    print(f"  DEM {dem.shape}, высоты {np.nanmin(dem):.0f}…{np.nanmax(dem):.0f} м")
    print("Крутые склоны ...")
    gdf, _ = steep_polygons(dem, origin)
    if os.path.exists(SLOPES_FILE):
        os.remove(SLOPES_FILE)
    gdf.to_file(SLOPES_FILE, layer="крутые_склоны", driver="GPKG")
    print(f"  {len(gdf)} полигонов -> {SLOPES_FILE} ({os.path.getsize(SLOPES_FILE) / 1e6:.1f} МБ)")
    save_dem(dem, origin)
    hillshade_png(dem, origin)
    global _dem_cache
    _dem_cache = None
    add_building_elevation()
    print("Готово.")


if __name__ == "__main__":
    main()
