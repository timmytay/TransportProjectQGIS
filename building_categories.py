"""
Категории зданий по рубрикам 2ГИС с приоритетами.

Цепочка:  рубрика 2ГИС -> категория SQ -> приоритет категории -> категория здания.

1. Организация.  У организации может быть несколько рубрик (через «;»). Каждая рубрика
   по справочнику rubriki_2gis_v_kategorii.csv даёт код категории SQ. Из всех кодов
   организации выбирается самый приоритетный (меньший «Ранг» в prioritety_kategorij.csv).
2. Здание.  Организации привязываются к ближайшему полигону здания (не дальше 30 м,
   расчёт в метрах, UTM 48N). Категория здания — самая приоритетная из категорий
   организаций в нём.
3. Здание без организаций, но с жителями (inhab > 0) — «Жильё» (SQ1).
   Без организаций и без жителей — категория не определена.
4. Профиль здания по площади (поле mix, «SQ1:2400.0;SQ2:300.0»):
   площадь этажей здания F = площадь пятна × этажность делится между функциями:
   - есть жители и организации: организациям — первый этаж (площадь пятна; у одноэтажного
     дома — половина), остальное — жильё SQ1;
   - жителей нет, организации есть: вся площадь — организациям;
   - только жители: вся площадь — SQ1;  ни того ни другого — профиль пустой (нет данных).
   Доля организаций делится между ними поровну; у организации без категории — код NA (нет данных).
   Поле org_cats — число организаций по категориям («SQ2:3;SQ10:1»).
5. top_org — подпись здания: организация, рубрика которой описывает всё здание (ТЦ, рынок,
   бизнес-центр, вуз, больница…), иначе самое частое название, иначе самая приоритетная.
   Из профилей зданий складывается профиль района (доли площади по категориям и функциям).

Таблица приоритетов (data/rubriki/prioritety_kategorij.csv) редактируется вручную:
  Приоритет — группа 1..5 (1 — самая важная), Ранг — порядок внутри всего списка (1..47),
  Якорные рубрики — (через « | ») только эти рубрики дают категории её приоритет;
  Иначе — код, в который переходят остальные рубрики этой категории.
  Пример: «Авиабилеты» размечены как SQ34 Аэропорт, но якорная рубрика у SQ34 только
  «Аэропорты», поэтому турагентство получает SQ21 (офис), а не делает дом аэропортом.
Исходный справочник рубрик и коды категорий не меняются.

Запуск отдельно:  python building_categories.py   (пишет exports/организации_с_приоритетом.csv)
"""
import os

import geopandas as gpd
import pandas as pd
import shapely

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RUB_DIR = os.path.join(BASE_DIR, "data", "rubriki")
CATEGORIES_FILE = os.path.join(RUB_DIR, "kategorii_47.csv")
RUBRICS_FILE = os.path.join(RUB_DIR, "rubriki_2gis_v_kategorii.csv")
ORGS_FILE = os.path.join(RUB_DIR, "organizacii_irkutsk_2gis.csv")
PRIORITY_FILE = os.path.join(RUB_DIR, "prioritety_kategorij.csv")
ORGS_EXPORT = os.path.join(BASE_DIR, "exports", "организации_с_приоритетом.csv")

METRIC_CRS = "EPSG:32648"
MAX_DIST_M = 30          # организация дальше 30 м от любого здания не привязывается
HOUSING = "SQ1"


def files_available():
    return all(os.path.exists(f) for f in (RUBRICS_FILE, ORGS_FILE, PRIORITY_FILE))


def load_priorities():
    pr = pd.read_csv(PRIORITY_FILE, encoding="utf-8-sig", dtype=str).fillna("")
    pr["Ключ"] = pr["Ключ"].str.strip()
    pr["Приоритет"] = pr["Приоритет"].astype(int)
    pr["Ранг"] = pr["Ранг"].astype(int)
    if "Якорные рубрики" not in pr:
        pr["Якорные рубрики"] = ""
    if "Иначе" not in pr:
        pr["Иначе"] = ""
    return pr.set_index("Ключ")


FUNCTIONS_FILE = os.path.join(RUB_DIR, "ukrupnenie_kategorij.csv")


def load_functions():
    """Код SQ -> укрупнённая функция (Жилая, Торговля и услуги, ...)."""
    if not os.path.exists(FUNCTIONS_FILE):
        return {}
    f = pd.read_csv(FUNCTIONS_FILE, encoding="utf-8-sig", dtype=str)
    return dict(zip(f["Ключ"].str.strip(), f["Функция"].str.strip()))


def resolve_code(rubric, code, pr):
    """Код категории для рубрики с учётом якорных рубрик и правила «Иначе»."""
    for _ in range(5):  # защита от зацикливания
        if code not in pr.index:
            return None
        anchors = pr.at[code, "Якорные рубрики"]
        fallback = pr.at[code, "Иначе"].strip()
        if not anchors or not fallback:
            return code
        if rubric in {a.strip() for a in anchors.split("|")}:
            return code
        code = fallback
    return code


def load_rubric_map():
    rub = pd.read_csv(RUBRICS_FILE, encoding="utf-8-sig")
    rub = rub.dropna(subset=["Код категории"])
    return dict(zip(rub["Название рубрики"].str.strip(), rub["Код категории"].str.strip()))


def categorize_organizations(pr=None, rubric_map=None):
    """Организации с категорией по приоритету среди ВСЕХ их рубрик."""
    pr = load_priorities() if pr is None else pr
    rubric_map = load_rubric_map() if rubric_map is None else rubric_map
    rank = pr["Ранг"].to_dict()

    orgs = pd.read_csv(ORGS_FILE, encoding="utf-8-sig")
    orgs = orgs.dropna(subset=["latitude", "longitude"]).copy()

    def best_code(rubrics):
        rubs = [r.strip() for r in str(rubrics).split(";") if r.strip() in rubric_map]
        codes = {resolve_code(r, rubric_map[r], pr) for r in rubs}
        codes = [c for c in codes if c in rank]
        return min(codes, key=rank.get) if codes else None

    orgs["cat_code"] = orgs["rubrics"].apply(best_code)
    orgs["cat_name"] = orgs["cat_code"].map(pr["Название"])
    orgs["cat_priority"] = orgs["cat_code"].map(pr["Приоритет"])
    orgs["cat_rank"] = orgs["cat_code"].map(pr["Ранг"])
    return orgs


def building_mix(F, foot, floors, inhab, codes):
    """Распределение площади этажей здания F по кодам категорий."""
    if F <= 0:
        return {}
    if not codes:
        return {HOUSING: F} if inhab > 0 else {}
    if inhab > 0:
        nonres = min(F, foot if floors > 1 else foot * 0.5)
    else:
        nonres = F
    mix = {}
    share = nonres / len(codes)
    for c in codes:
        mix[c] = mix.get(c, 0.0) + share
    if F - nonres > 0:
        mix[HOUSING] = mix.get(HOUSING, 0.0) + (F - nonres)
    return mix


def assign_building_categories(buildings_metric, inhab=None, foot=None, floors=None):
    """
    buildings_metric — GeoDataFrame полигонов зданий в метрической СК (METRIC_CRS).
    inhab — Series жителей по тем же индексам (для правила «Жильё»).
    Возвращает DataFrame с тем же индексом: cat_code, cat_name, cat_priority, cat_group,
    n_orgs, cat_source.
    """
    pr = load_priorities()
    orgs = categorize_organizations(pr)
    pts = gpd.GeoDataFrame(orgs, geometry=gpd.points_from_xy(orgs.longitude, orgs.latitude),
                           crs="EPSG:4326").to_crs(METRIC_CRS)

    polys = buildings_metric[["geometry"]].copy()
    polys["geometry"] = shapely.make_valid(polys.geometry.values)
    polys = polys[~polys.geometry.is_empty]
    polys["bidx"] = polys.index

    joined = gpd.sjoin_nearest(pts, polys, how="left", max_distance=MAX_DIST_M, distance_col="dist_m")
    joined = joined[~joined.index.duplicated()]          # равноудалённые здания — берём одно
    orgs["bidx"] = joined["bidx"]
    orgs["dist_m"] = joined["dist_m"].round(1)

    linked = orgs.dropna(subset=["bidx"])
    n_orgs = linked.groupby("bidx").size()
    best = (linked.dropna(subset=["cat_rank"])
                  .sort_values("cat_rank")
                  .groupby("bidx")["cat_code"].first())

    res = pd.DataFrame(index=buildings_metric.index)
    res["n_orgs"] = n_orgs.reindex(res.index).fillna(0).astype(int)
    res["cat_code"] = best.reindex(res.index)
    # название главной (самой приоритетной) организации здания — подпись центра притяжения
    # сначала самое частое название в здании (у кампуса ИРНИТУ — «ИРНИТУ»), при равенстве —
    # организация с самой приоритетной категорией
    # приоритет у организаций, рубрика которых описывает всё здание (ТЦ, рынок, бизнес-центр, вуз, больница)
    bld_kw = ("Торговые центры|Торгово-развлекательные|Рынки|Бизнес-центр|Университеты|Институты|Академии|"
              "Больницы|Колледжи|Гостиницы|вокзал|Аэропорты|Стадионы|Театры|Дома / дворцы культуры")
    nm = linked.assign(r=linked["cat_rank"].fillna(999),
                       bk=linked["rubrics"].fillna("").str.contains(bld_kw, case=False).astype(int),
                       cnt=linked.groupby(["bidx", "name"])["name"].transform("size"))
    top_name = (nm.sort_values(["bk", "cnt", "r"], ascending=[False, False, True])
                  .groupby("bidx")["name"].first())
    res["top_org"] = top_name.reindex(res.index)
    res["cat_source"] = res["cat_code"].notna().map({True: "организации", False: None})

    if inhab is not None:
        housing = res["cat_code"].isna() & (inhab.reindex(res.index).fillna(0) > 0)
        res.loc[housing, "cat_code"] = HOUSING
        res.loc[housing, "cat_source"] = "жители"

    # профиль здания по площади этажей
    if foot is not None and floors is not None:
        org_codes = linked.assign(c=linked["cat_code"].fillna("NA")).groupby("bidx")["c"].apply(list)
        foot_s = foot.reindex(res.index).fillna(0).values
        fl_s = floors.reindex(res.index).fillna(1).clip(lower=1).values
        inh_s = (inhab.reindex(res.index).fillna(0).values if inhab is not None else [0] * len(res))
        codes_s = org_codes.reindex(res.index).values
        mixes = []
        for fa, fl, ih, cl in zip(foot_s, fl_s, inh_s, codes_s):
            m = building_mix(fa * fl, fa, fl, ih, cl if isinstance(cl, list) else [])
            mixes.append(";".join(f"{k}:{v:.1f}" for k, v in m.items()))
        res["mix"] = mixes
        res["org_cats"] = [";".join(f"{k}:{v}" for k, v in pd.Series(cl).value_counts().items())
                           if isinstance(cl, list) else "" for cl in codes_s]

    res["cat_name"] = res["cat_code"].map(pr["Название"])
    res["cat_priority"] = res["cat_code"].map(pr["Приоритет"])
    res["cat_group"] = res["cat_code"].map(pr["Группа"])

    # выгрузка организаций с итоговой категорией — для проверки и отчёта
    try:
        os.makedirs(os.path.dirname(ORGS_EXPORT), exist_ok=True)
        orgs.drop(columns=["bidx"]).to_csv(ORGS_EXPORT, index=False, encoding="utf-8-sig")
    except Exception as e:
        print(f"  не удалось сохранить {ORGS_EXPORT}: {e}")

    print(f"  организаций: {len(orgs)}, с категорией: {orgs.cat_code.notna().sum()}, "
          f"привязано к зданиям: {linked.shape[0]}")
    print(f"  зданий с организациями: {(res.n_orgs > 0).sum()}, "
          f"жильё по жителям: {(res.cat_source == 'жители').sum()}, "
          f"без категории: {res.cat_code.isna().sum()}")
    return res


if __name__ == "__main__":
    o = categorize_organizations()
    os.makedirs(os.path.dirname(ORGS_EXPORT), exist_ok=True)
    o.to_csv(ORGS_EXPORT, index=False, encoding="utf-8-sig")
    print(o.groupby(["cat_priority", "cat_code", "cat_name"]).size().to_string())
    print(f"-> {ORGS_EXPORT}")
