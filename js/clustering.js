// ===== ПРОФИЛЬ ЗОНЫ ПО КАТЕГОРИЯМ 2ГИС =====
const FUNCTION_ORDER = ['Жилая', 'Торговля и услуги', 'Деловая', 'Социальная', 'Отдых и спорт',
    'Производственная', 'Транспортная', 'Прочее'];
const FUNCTION_COLORS = {   // категориальная палитра (фиксированный порядок, проверена на цветовую слепоту)
    'Жилая': '#2a78d6', 'Торговля и услуги': '#eb6834', 'Деловая': '#1baf7a', 'Социальная': '#eda100',
    'Отдых и спорт': '#e87ba4', 'Производственная': '#008300', 'Транспортная': '#6250d6', 'Прочее': '#e34948'
};
const ZONE_TYPE_NAMES = {
    'Жилая': 'Жилая', 'Торговля и услуги': 'Торговая', 'Деловая': 'Деловая', 'Социальная': 'Социальная',
    'Отдых и спорт': 'Рекреационная', 'Производственная': 'Производственная', 'Транспортная': 'Транспортная',
    'Прочее': 'Прочая'
};
const ZONE_DOMINANT_SHARE = 0.6;   // функция занимает >= 60% площади -> зона названа по ней, иначе смешанная

function parsePairs(str) {
    const out = {};
    if (!str) return out;
    for (const kv of str.split(';')) {
        const i = kv.lastIndexOf(':');
        if (i > 0) out[kv.slice(0, i)] = parseFloat(kv.slice(i + 1)) || 0;
    }
    return out;
}

// Площадь этажей здания по категориям: из поля mix, иначе вся площадь — категории здания
function buildingMix(point) {
    if (point.mix) return parsePairs(point.mix);
    if (point.cat) return { [point.cat]: point.weight || 0 };
    return { NA: point.weight || 0 };
}

function computeZoneProfile(points) {
    const catArea = {}, orgCount = {}, funcArea = {};
    let leadCat = null, leadRank = Infinity, unknownArea = 0, knownArea = 0, nOrgs = 0;
    for (const pt of points) {
        for (const [code, area] of Object.entries(buildingMix(pt))) {
            if (code === 'NA') { unknownArea += area; continue; }
            catArea[code] = (catArea[code] || 0) + area;
            knownArea += area;
            const f = window.categoryInfo?.[code]?.function || 'Прочее';
            funcArea[f] = (funcArea[f] || 0) + area;
        }
        for (const [code, n] of Object.entries(parsePairs(pt.orgc))) {
            orgCount[code] = (orgCount[code] || 0) + n;
            nOrgs += n;
        }
        // ведущая категория — самая приоритетная среди зданий района
        const codes = pt.orgc ? Object.keys(parsePairs(pt.orgc)) : (pt.cat ? [pt.cat] : []);
        for (const code of codes) {
            const rank = window.categoryInfo?.[code]?.rank ?? 999;
            if (code !== 'NA' && rank < leadRank) { leadRank = rank; leadCat = code; }
        }
    }
    const funcShares = FUNCTION_ORDER
        .map(f => ({ f, area: funcArea[f] || 0, share: knownArea ? (funcArea[f] || 0) / knownArea : 0 }))
        .filter(x => x.area > 0)
        .sort((a, b) => b.share - a.share);
    let zoneType = 'Нет данных';
    if (funcShares.length) {
        const top = funcShares[0];
        zoneType = top.share >= ZONE_DOMINANT_SHARE
            ? ZONE_TYPE_NAMES[top.f]
            : `Смешанная (${ZONE_TYPE_NAMES[top.f].toLowerCase()} + ${(ZONE_TYPE_NAMES[funcShares[1]?.f] || '').toLowerCase()})`;
    }
    return {
        zoneType, funcShares, catArea, orgCount, nOrgs, leadCat,
        knownArea, unknownArea,
        unknownShare: (knownArea + unknownArea) ? unknownArea / (knownArea + unknownArea) : 0
    };
}

function zoneProfileHtml(prof) {
    if (!prof || !prof.funcShares.length) return '<b>Профиль:</b> нет данных<br>';
    const bars = prof.funcShares.map(x => `
        <div style="display:flex;align-items:center;gap:6px;font-size:11px;line-height:14px">
          <span style="width:112px">${x.f}</span>
          <span style="display:inline-block;height:8px;width:${Math.max(2, Math.round(x.share * 110))}px;background:${FUNCTION_COLORS[x.f]}"></span>
          <span>${(x.share * 100).toFixed(1)}%</span>
        </div>`).join('');
    const topOrgs = Object.entries(prof.orgCount).filter(([c]) => c !== 'NA')
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([c, n]) => `${window.categoryInfo?.[c]?.name || c} — ${n}`).join('; ');
    const lead = prof.leadCat ? (typeof categoryLabel === 'function' ? categoryLabel(prof.leadCat) : prof.leadCat) : '—';
    return `<b>Тип зоны:</b> ${prof.zoneType}<br>
        <b>Профиль по площади этажей:</b>${bars}
        ${prof.unknownShare > 0.005 ? `<span style="font-size:11px;color:#888">без данных о назначении: ${(prof.unknownShare * 100).toFixed(1)}% площади</span><br>` : ''}
        <b>Организаций 2ГИС:</b> ${prof.nOrgs}${topOrgs ? ` (${topOrgs})` : ''}<br>
        <b>Ведущая категория (приоритет):</b> ${lead}<br>`;
}

// Выгрузка профилей районов в CSV (для отчёта и для кластеризации зон по профилю)
function exportZoneProfiles() {
    const cs = window.currentCentroids || [];
    if (!cs.length) { showStatus('Сначала выполните районирование', 'error'); return; }
    const codes = Object.keys(window.categoryInfo || {});
    const head = ['район', 'центр_притяжения', 'тип_зоны', 'широта', 'долгота', 'зданий', 'площадь_этажей_м2', 'население', 'организаций',
        'ведущая_категория', ...FUNCTION_ORDER.map(f => 'доля_' + f), 'доля_нет_данных',
        ...codes.map(c => 'S_' + c), ...codes.map(c => 'N_' + c)];
    const rows = cs.map(c => {
        const p = c.profile;
        const share = f => (p.funcShares.find(x => x.f === f)?.share || 0).toFixed(4);
        return [c.clusterId, c.anchor ? anchorLabel(c.anchor) : '', p.zoneType, c.lat.toFixed(6), c.lng.toFixed(6), c.pointCount, Math.round(c.totalArea),
            Math.round(c.totalPopulation), p.nOrgs, p.leadCat || '', ...FUNCTION_ORDER.map(share), p.unknownShare.toFixed(4),
            ...codes.map(k => Math.round(p.catArea[k] || 0)), ...codes.map(k => p.orgCount[k] || 0)];
    });
    const esc = v => /[";,\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
    const csv = '﻿' + [head, ...rows].map(r => r.map(esc).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `профили_районов_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
window.exportZoneProfiles = exportZoneProfiles;

// ===== ИСТОЧНИК ЗДАНИЙ ДЛЯ РАЙОНИРОВАНИЯ =====
function getClusteringSourceKey() {
    const sel = document.getElementById('clusteringSource');
    return sel ? sel.value : 'buildings';
}

// Точка здания: для полигона — центроид по площади, для точки — сама точка.
// weight — площадь здания (площадь × этажи), по ней взвешиваются центры районов.
function featureToBuildingPoint(feature, idx) {
    const g = feature.geometry;
    if (!g || !g.coordinates) return null;
    let lng, lat;
    if (g.type === 'Point') {
        [lng, lat] = g.coordinates;
    } else if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
        try {
            [lng, lat] = turf.centroid(feature).geometry.coordinates;
        } catch (e) { return null; }
    } else {
        return null;
    }
    if (lng === undefined || lat === undefined) return null;

    const p = feature.properties || {};
    let weight = p.weight_area;
    if (weight === undefined && (g.type === 'Polygon' || g.type === 'MultiPolygon')) {
        try { weight = turf.area(feature) * Math.max(1, p.FLOORS || 1); } catch (e) { }
    }
    return {
        idx: idx,
        lng: lng,
        lat: lat,
        population: p["Насел"] ?? p.population ?? (p.inhab !== undefined ? Math.round(p.inhab) : 100),
        weight: weight > 0 ? weight : 1,
        hasArea: weight > 0,
        cat: p.cat || null,
        prio: p.prio || 0,
        mix: p.mix || null,
        orgc: p.orgc || null,
        name: p.name || null,
        inpt: p.inpt || null,
        elev: (p.elev ?? null),          // высота над уровнем моря (SRTM), м
        feature: feature
    };
}

function getPointsInArea(sourceLayer) {
    const view = window.zoomRun ? window.zoomRun.bounds : null;   // режим «масштабирование»: видимая часть карты
    if (!sourceLayer || !sourceLayer.data || (!selectedArea && !view)) return [];

    const points = [];
    const bounds = selectedArea ? selectedArea.getBounds() : view;

    sourceLayer.data.features.forEach(feature => {
        const g = feature.geometry;
        // быстрый отсев по охвату (точечные слои), чтобы не считать 360 тыс. точек при каждом сдвиге карты
        if (view && g && g.type === 'Point') {
            const [x, y] = g.coordinates;
            if (y < view.getSouth() || y > view.getNorth() || x < view.getWest() || x > view.getEast()) return;
        }
        const bp = featureToBuildingPoint(feature, 0);
        if (!bp) return;

        const point = L.latLng(bp.lat, bp.lng);
        if (view && !view.contains(point)) return;

        let isInside = false;
        if (!selectedArea) {
            isInside = true;
        } else if (selectedArea instanceof L.Rectangle) {
            isInside = bounds.contains(point);
        } else if (selectedArea instanceof L.Circle) {
            const center = selectedArea.getLatLng();
            const distance = map.distance(point, center);
            isInside = distance <= selectedArea.getRadius();
        }

        if (isInside) {
            bp.idx = points.length;
            points.push(bp);
        }
    });

    console.log(`Найдено точек в области: ${points.length}`);
    return points;
}
// Выполнение кластеризации
async function performClustering() {
    const runId = window.clusterRunId = (window.clusterRunId || 0) + 1;   // старые незавершённые расчёты не рисуем
    const Z = window.zoomRun ? window.zoomRun.level : null;               // параметры уровня масштаба
    // Центрам притяжения нужны площади, этажность и категории зданий — они есть только
    // в слое «Центроиды зданий 2.0». В точках «Жилые здания» площадей нет: все здания
    // получили бы одинаковую массу, и центр ставился бы на случайный дом.
    const methodSel = document.getElementById('clusteringMethod');
    const srcSel = document.getElementById('clusteringSource');
    if (methodSel && methodSel.value === 'attract' && srcSel && srcSel.value !== 'buildings_centroids') {
        srcSel.value = 'buildings_centroids';
        showStatus('Для центров притяжения нужны площади зданий — использую слой «Центроиды зданий 2.0»', 'info');
    }
    const sourceKey = getClusteringSourceKey();
    const sourceLayer = layers[sourceKey];

    // Если выбранный слой зданий ещё не загружен — загружаем
    if (sourceLayer && !sourceLayer.data) {
        showStatus("Загрузка зданий...", "info");
        await loadLayer(sourceKey);
    }

    if (!sourceLayer || !sourceLayer.data || sourceLayer.data.features.length === 0) {
        showStatus("Нет данных о зданиях", "error");
        return;
    }

    let targetPoints;

    if (selectedArea || window.zoomRun) {
        targetPoints = getPointsInArea(sourceLayer);
        if (targetPoints.length === 0) {
            showStatus("В выбранной области нет зданий", "error");
            return;
        }
    } else {
        if (sourceKey === 'buildings_centroids') {
            showStatus("Выделите область на карте: центроидов слишком много для всей территории", "error");
            return;
        }
        targetPoints = [];
        sourceLayer.data.features.forEach(f => {
            const bp = featureToBuildingPoint(f, targetPoints.length);
            if (bp) targetPoints.push(bp);
        });
    }

    // Барьеры: выделенная область разрезается всеми включёнными барьерами на части,
    // каждое здание относится к своей части (раздел «Барьеры» в отчёте)
    let barrier = null;
    try {
        if (activeBarrierKeys().length) showStatus('Разрезаю область барьерами...', 'info');
        barrier = await updateBarriers(selectionGeometry(targetPoints), targetPoints);
    } catch (e) {
        console.error('Барьеры:', e);
        showStatus('Ошибка обработки барьеров: ' + e.message, 'error');
        return;
    }
    const groups = groupPointsByFaces(targetPoints, barrier);
    const nonEmpty = [...groups.values()].filter(g => g.length).length;

    let labels = [];
    const method = document.getElementById('clusteringMethod').value;

    window.clusterAnchors = null;
    if (method === 'attract') {
        // в режиме масштабирования порог крупного объекта и число районов задаёт уровень масштаба
        const k = Z ? scaleK(targetPoints, Z) : parseInt(document.getElementById('kmeansClusters').value);
        const auto = Z ? true : (document.getElementById('autoCenters')?.checked ?? true);
        const minMass = Z ? Z.minMass : parseFloat(document.getElementById('attractMinMass')?.value || 20000);
        showStatus('Ищу центры притяжения и считаю расстояния по дорогам...', 'info');
        try {
            labels = await attractionClustering(targetPoints, k, groups, auto, minMass);
        } catch (e) {
            console.error(e); showStatus('Ошибка модели притяжения: ' + e.message, 'error'); return;
        }
    } else if (method === 'kmeans') {
        const k = Z ? scaleK(targetPoints, Z) : parseInt(document.getElementById('kmeansClusters').value);
        labels = await kMeansWithBarriers(targetPoints, k, groups);
        if (barrier && nonEmpty > k)
            setTimeout(() => showStatus(`Барьеры делят область на ${nonEmpty} частей с зданиями — районов больше, чем K = ${k}: район не может пересекать барьер`, 'info'), 1200);
    } else if (method === 'dbscan') {
        const epsilon = Z ? Z.eps : parseFloat(document.getElementById('dbscanEpsilon')?.value ?? 300);
        const minSamples = parseInt(document.getElementById('dbscanMinSamples')?.value ?? 5);
        labels = await dbscanWithBarriers(targetPoints, epsilon, minSamples, groups);
    }
    window.lastBarrierInfo = barrier ? { layers: barrier.keys, faces: barrier.stats.faces, nonEmpty } : null;

    if (runId !== window.clusterRunId) return false;   // пока считали, карту сдвинули — рисует новый расчёт
    if (Z && typeof polygonLayer !== 'undefined' && polygonLayer) {   // полигоны прошлого масштаба устарели
        map.removeLayer(polygonLayer); polygonLayer = null; currentPolygons = null;
    }
    displayClusteringResults(targetPoints, labels, method);
    return true;
}
// Группировка зданий по частям области между барьерами.
// barrier.assign[i] — номер части для i-го здания; без барьеров — одна общая группа.
function groupPointsByFaces(points, barrier) {
    const groups = new Map();
    points.forEach((p, i) => {
        const face = barrier && barrier.assign ? barrier.assign[i] : 0;
        p.face = face;
        if (!groups.has(face)) groups.set(face, []);
        groups.get(face).push(p);
    });
    console.log(`Частей области с зданиями: ${groups.size}`);
    return groups;
}

// Распределение K районов между частями области.
// Каждая непустая часть получает минимум 1 район (район не может пересекать барьер),
// остальные K − m распределяются пропорционально площади этажей частей (метод Д'Ондта):
// очередной район получает часть с наибольшим W_f / (a_f + 1).
function allocateClusters(groups, K) {
    const entries = [...groups.entries()].filter(([, pts]) => pts.length > 0);
    const alloc = new Map(entries.map(([id]) => [id, 1]));
    let rest = K - entries.length;
    const W = new Map(entries.map(([id, pts]) => [id, pts.reduce((s, p) => s + (p.weight || 1), 0)]));
    while (rest > 0) {
        let best = null, bestQ = -1;
        for (const [id, pts] of entries) {
            const a = alloc.get(id);
            if (a >= pts.length) continue;               // районов не больше, чем зданий
            const q = W.get(id) / (a + 1);
            if (q > bestQ) { bestQ = q; best = id; }
        }
        if (best === null) break;
        alloc.set(best, alloc.get(best) + 1);
        rest--;
    }
    return alloc;
}

// Короткая подпись организации: «Иркутский национальный исследовательский технический университет» → «ИРНИТУ»
const ORG_ABBR = { 'Иркутский национальный исследовательский технический университет': 'ИРНИТУ',
    'Иркутский государственный университет': 'ИГУ', 'Иркутский государственный медицинский университет': 'ИГМУ',
    'Байкальский государственный университет': 'БГУ', 'Иркутский государственный аграрный университет им. А.А. Ежевского': 'ИрГАУ' };
function shortOrgName(n) {
    if (ORG_ABBR[n]) return ORG_ABBR[n];
    return n.length > 30 ? n.slice(0, 28) + '…' : n;
}

// Подпись центра притяжения: аббревиатура вуза, «Торговый центр (N орг.)», «Бизнес-центр (N орг.)»
// или название главной организации
function anchorLabel(a) {
    if (!a.name) return 'здание без данных 2ГИС';
    if (ORG_ABBR[a.name]) return ORG_ABBR[a.name];
    if (a.nOrgs >= 20) {
        let trade = 0, total = 0;
        for (const [code, area] of Object.entries(parsePairs(a.mix))) {
            if (code === 'SQ1' || code === 'NA') continue;
            total += area;
            if (window.categoryInfo?.[code]?.function === 'Торговля и услуги') trade += area;
        }
        return (total && trade / total >= 0.5 ? 'Торговый центр' : 'Бизнес-центр') + ` (${a.nOrgs} орг.)`;
    }
    const nm = shortOrgName(a.name);
    return a.nOrgs >= 10 ? `${nm} и ещё ${a.nOrgs - 1} орг.` : nm;
}

// ===== ЦЕНТРЫ ПРИТЯЖЕНИЯ: МОДЕЛЬ ХАФФА ПО УЛИЧНО-ДОРОЖНОЙ СЕТИ =====
// Центр района — реальный крупный объект (вуз, ТЦ, больница, завод, вокзал), к которому
// «тянутся» окружающие здания. Так строят зоны тяготения в транспортном моделировании:
//  1) масса (привлекательность) здания  M = нежилая площадь этажей × коэффициент группы приоритета;
//  2) центры притяжения программа находит сама: здания с M ≥ порога; крупные здания ближе R_MERGE
//     друг к другу (корпуса одного вуза, корпуса ТЦ) объединяются в один центр, массы складываются;
//  3) каждое здание относится к центру с наибольшим притяжением (модель Хаффа)
//        A_ij = M_j / max(d_ij, d0)^β,
//     где d_ij — расстояние по улично-дорожной сети (граф.gpkg), а не по прямой;
//  4) районы не пересекают барьеры: здание может тянуться только к центру своей части области;
//  5) слабые центры (зона тяготения < MIN_CATCHMENT зданий) отсеиваются, распределение пересчитывается;
//  6) каждый район делается сплошным: оторванные куски передаются соседнему району (сервер);
//  7) соседние районы раскрашиваются разными цветами (как раскраска политической карты).
const ATTRACT_GROUP_FACTOR = { 1: 3, 2: 2.5, 3: 2, 4: 1.5, 5: 0, 0: 1 };  // 0 — категория неизвестна
const GRAVITY_BETA = 2;        // показатель затухания с расстоянием (типично 1,5–2)
const GRAVITY_D0_M = 100;      // минимальное расстояние, м
const CENTER_MERGE_M = 500;    // крупные здания ближе 500 м (5–7 мин пешком) — один центр (кампус, комплекс ТЦ)
const MIN_CATCHMENT = 50;      // центр, к которому тянется меньше 50 зданий, отсеивается (слабый центр)
// в режиме масштабирования радиус комплекса и минимальная зона тяготения зависят от уровня масштаба
const mergeRadius = () => window.zoomRun ? window.zoomRun.level.merge : CENTER_MERGE_M;
const minCatchment = () => window.zoomRun ? window.zoomRun.level.minCatch : MIN_CATCHMENT;
const CONTIG_RADIUS_M = 150;   // район — сплошная территория: соседние здания района не дальше 150 м

// Нежилая площадь этажей здания (по профилю mix: всё, кроме SQ1 «Жильё»)
function nonResidentialArea(p) {
    if (p.mix) {
        let s = 0;
        for (const [c, a] of Object.entries(parsePairs(p.mix))) if (c !== 'SQ1') s += a;
        return s;
    }
    if (p.cat === 'SQ1') return 0;          // жилой дом без организаций
    return p.weight || 0;                    // нежилое здание без данных (склад, производство…)
}
function attractionMass(p) {
    return nonResidentialArea(p) * (ATTRACT_GROUP_FACTOR[p.prio || 0] ?? 1);
}

// Локальные метры: долгота × 111 320·cos φ, широта × 110 540
function setLocalXY(points) {
    if (!points.length) return;
    const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    for (const p of points) { p._x = p.lng * kx; p._y = p.lat * ky; }
}
function distM(a, b) { return Math.hypot(a._x - b._x, a._y - b._y); }

// Автоматический поиск центров притяжения в части области
function detectCenters(gp, minMass) {
    const cands = gp.filter(p => p.mass >= minMass).sort((a, b) => b.mass - a.mass);
    const centers = [];
    for (const c of cands) {
        const near = centers.find(z => distM(z.point, c) <= mergeRadius());
        if (near) { near.mass += c.mass; near.members.push(c); }     // часть того же комплекса
        else centers.push({ point: c, mass: c.mass, members: [c] });
    }
    return centers;
}

// Ручной режим: ровно n центров — самые «тяжёлые» здания, не ближе D_min = ½·√(S/n)
function pickAnchors(groupPoints, n, areaM2) {
    let dmin = 0.5 * Math.sqrt(areaM2 / n);
    const byMass = groupPoints.filter(p => p.mass > 0).sort((a, b) => b.mass - a.mass);
    const byArea = [...groupPoints].sort((a, b) => (b.weight || 0) - (a.weight || 0));
    const chosen = [];
    for (let pass = 0; pass < 4 && chosen.length < n; pass++) {
        for (const list of [byMass, byArea]) {
            for (const c of list) {
                if (chosen.length >= n) break;
                if (chosen.includes(c)) continue;
                if (chosen.every(a => distM(a, c) >= dmin)) chosen.push(c);
            }
        }
        dmin /= 2;
    }
    return chosen;
}

async function attractionClustering(points, k, groups, auto, minMass) {
    setLocalXY(points);
    for (const p of points) p.mass = attractionMass(p);
    const alloc = auto ? null : allocateClusters(groups, k);
    const faceArea = new Map();
    (window.currentFaces?.features || []).forEach(f => faceArea.set(f.properties.face_id, f.properties.area_km2 * 1e6));

    const anchors = [];
    for (const [face, gp] of groups.entries()) {
        if (!gp.length) continue;
        let C;
        if (auto) {
            C = detectCenters(gp, minMass);
        } else {
            let area = faceArea.get(face);
            if (!area) {
                const xs = gp.map(p => p._x), ys = gp.map(p => p._y);
                area = Math.max(1, (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)));
            }
            C = pickAnchors(gp, alloc.get(face) || 1, area).map(p => ({ point: p, mass: p.mass, members: [p] }));
        }
        if (!C.length) {   // в части нет крупных объектов — центром становится самое большое здание
            const big = gp.reduce((m, p) => (p.mass > m.mass || (p.mass === m.mass && (p.weight || 0) > (m.weight || 0))) ? p : m, gp[0]);
            C = [{ point: big, mass: big.mass, members: [big], minor: true }];
        }
        C.forEach(c => { c.face = face; if (!(c.mass > 0)) c.mass = c.point.weight || 1; anchors.push(c); });
    }

    // final = false — промежуточный расчёт при отсеве слабых центров: без «склейки» районов (быстрее)
    const huff = async (anc, final = true) => {
        const resp = await fetch('http://127.0.0.1:8000/api/huff-assign', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                points: points.map(p => [p.lng, p.lat]),
                faces: points.map(p => p.face ?? 0),
                anchors: anc.map(a => ({ lng: a.point.lng, lat: a.point.lat, mass: a.mass, face: a.face,
                                         members: a.members.map(m => m.idx) })),
                beta: GRAVITY_BETA, d0: GRAVITY_D0_M, network: true,
                contiguous: final, contig_radius: CONTIG_RADIUS_M,
                relief: reliefOn()
            })
        });
        const r = await resp.json();
        if (r.error) throw new Error(r.error);
        return r;
    };
    let res = await huff(anchors, !auto);
    // отсев слабых центров (только в автоматическом режиме): пока есть центр с маленькой зоной
    // тяготения, убираем самый слабый (в части области должен остаться хотя бы один центр)
    for (let it = 0; auto && it < 30; it++) {
        const cnt = new Array(anchors.length).fill(0);
        res.labels.forEach(l => cnt[l]++);
        const perFace = {};
        anchors.forEach(a => perFace[a.face] = (perFace[a.face] || 0) + 1);
        let worst = -1;
        anchors.forEach((a, j) => {
            if (cnt[j] < minCatchment() && perFace[a.face] > 1 && (worst < 0 || cnt[j] < cnt[worst] || (cnt[j] === cnt[worst] && a.mass < anchors[worst].mass))) worst = j;
        });
        if (worst < 0) break;
        anchors.splice(worst, 1);
        res = await huff(anchors, false);
    }
    if (auto) res = await huff(anchors, true);   // окончательное распределение — со «склейкой» районов
    // после «склейки» районов здание-центр могло уйти в соседний район (если оно стояло отдельно от
    // основной массы своего района) — тогда звезда переносится на самое крупное здание своего района
    anchors.forEach((a, j) => {
        if (res.labels[a.point.idx] === j) return;
        let best = null;
        points.forEach((p, i) => { if (res.labels[i] === j && (!best || p.mass > best.mass ||
            (p.mass === best.mass && (p.weight || 0) > (best.weight || 0)))) best = p; });
        if (best) { a.point = best; a.moved = true; }
    });
    window.districtAdjacency = res.adjacency || [];
    window.clusterAnchors = anchors;
    window.lastHuffInfo = { method: res.method, centers: anchors.length, medianDist: res.median_dist_m, moved: res.moved, relief: res.relief };
    return res.labels;
}

// ===== РЕЛЬЕФ В РАЙОНИРОВАНИИ =====
// Включён слой «Рельеф (крутые склоны)» →
//   1) склоны вырезаются из области как барьер (сервер, /api/barrier-faces);
//   2) модель притяжения считает «приведённое» расстояние по дорогам L' = L + K_H·|Δh| (правило Нейсмита);
//   3) k-means и DBSCAN работают в 3D: координата z = K_H · высота здания, т.е. перепад 10 м
//      «отдаляет» здания так же, как 80 м по горизонтали — районы не перескакивают с террасы на террасу.
const RELIEF_K_H = 8;
function reliefOn() {
    return typeof activeBarrierKeys === 'function' && activeBarrierKeys().includes('relief');
}
// координаты для k-means / DBSCAN: с рельефом — метры и высота, без рельефа — как раньше (градусы)
function clusterCoords(gp, relief) {
    if (!relief) return gp.map(p => [p.lng, p.lat]);
    const lat0 = gp.reduce((s, p) => s + p.lat, 0) / gp.length;
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    const zs = gp.map(p => p.elev).filter(z => z !== null && z !== undefined);
    const zMed = zs.length ? zs.sort((a, b) => a - b)[zs.length >> 1] : 0;
    return gp.map(p => [p.lng * kx, p.lat * ky, RELIEF_K_H * ((p.elev ?? zMed) - zMed)]);
}

// K-means с учётом барьеров: кластеризация отдельно внутри каждой части области
async function kMeansWithBarriers(points, k, groups) {
    const allLabels = new Array(points.length).fill(-1);
    const alloc = allocateClusters(groups, k);
    let offset = 0;
    for (const [face, groupPoints] of groups.entries()) {
        if (!groupPoints.length) continue;
        const nClusters = alloc.get(face) || 1;
        if (nClusters <= 1) {
            for (const p of groupPoints) allLabels[p.idx] = offset;
            offset += 1;
            continue;
        }
        const coords = clusterCoords(groupPoints, reliefOn());
        const weights = groupPoints.map(p => p.weight || 1);
        const labels = kMeansClustering(coords, nClusters, weights);
        for (let i = 0; i < groupPoints.length; i++) allLabels[groupPoints[i].idx] = offset + labels[i];
        offset += nClusters;
    }
    return renumberClusters(allLabels);
}

// Базовый K-means алгоритм
function kMeansClustering(coords, k, weights = null) {
    if (coords.length < k) k = coords.length;
    if (k === 0) return new Array(coords.length).fill(0);

    let centroids = [];
    for (let i = 0; i < k; i++) {
        const s = Math.floor(i * coords.length / k);
        centroids.push(coords[s].slice());
    }

    let labels = new Array(coords.length).fill(0);
    let changed = true;
    let iter = 0;

    while (changed && iter < 100) {
        changed = false;

        // Присваивание точек к ближайшим центроидам
        for (let i = 0; i < coords.length; i++) {
            let best = 0;
            let bestDist = Infinity;
            for (let j = 0; j < centroids.length; j++) {
                let d = 0;
                for (let q = 0; q < coords[i].length; q++) { const t = coords[i][q] - centroids[j][q]; d += t * t; }
                if (d < bestDist) {
                    bestDist = d;
                    best = j;
                }
            }
            if (labels[i] !== best) {
                labels[i] = best;
                changed = true;
            }
        }

        // Пересчет центроидов
        const dim = coords[0].length;
        const newCent = Array(k).fill().map(() => new Array(dim).fill(0));
        const cnt = Array(k).fill(0);
        // центр кластера = центр масс зданий, масса = площадь здания
        for (let i = 0; i < coords.length; i++) {
            const w = weights ? weights[i] : 1;
            for (let q = 0; q < dim; q++) newCent[labels[i]][q] += coords[i][q] * w;
            cnt[labels[i]] += w;
        }
        for (let j = 0; j < k; j++) {
            if (cnt[j] > 0) { for (let q = 0; q < dim; q++) newCent[j][q] /= cnt[j]; }
            else newCent[j] = centroids[j];   // пустой кластер — центр на месте
        }
        centroids = newCent;
        iter++;
    }

    return labels;
}

// DBSCAN кластеризация (как в QGIS)
function dbscanClustering(coords, epsilon, minSamples, scale = 111000) {
    const n = coords.length;
    const labels = new Array(n).fill(-1);
    let clusterId = 0;

    for (let i = 0; i < n; i++) {
        if (labels[i] !== -1) continue;

        // Находим соседей
        const neighbors = [];
        for (let j = 0; j < n; j++) {
            let d2 = 0;
            for (let q = 0; q < coords[i].length; q++) { const t = coords[i][q] - coords[j][q]; d2 += t * t; }
            const distMeters = Math.sqrt(d2) * scale;   // scale = 1, если координаты уже в метрах (рельеф)
            if (distMeters <= epsilon) {
                neighbors.push(j);
            }
        }

        if (neighbors.length < minSamples) {
            labels[i] = -1;
            continue;
        }

        // Начинаем новый кластер
        labels[i] = clusterId;
        const queue = [...neighbors];

        while (queue.length > 0) {
            const current = queue.shift();

            if (labels[current] === -1) {
                labels[current] = clusterId;
            }

            if (labels[current] !== undefined && labels[current] !== clusterId) {
                continue;
            }

            labels[current] = clusterId;

            // Находим соседей текущей точки
            const currentNeighbors = [];
            for (let j = 0; j < n; j++) {
                const dist = Math.hypot(coords[current][0] - coords[j][0], coords[current][1] - coords[j][1]);
                const distMeters = dist * 111000;
                if (distMeters <= epsilon) {
                    currentNeighbors.push(j);
                }
            }

            if (currentNeighbors.length >= minSamples) {
                for (const nb of currentNeighbors) {
                    if (labels[nb] !== clusterId && labels[nb] !== -2) {
                        if (!queue.includes(nb)) {
                            queue.push(nb);
                        }
                    }
                }
            }
        }

        clusterId++;
    }

    return labels;
}

// DBSCAN с учётом барьеров: отдельно внутри каждой части области
async function dbscanWithBarriers(points, epsilon, minSamples, groups) {
    const allLabels = new Array(points.length).fill(-1);
    let offset = 0;
    for (const [, groupPoints] of groups.entries()) {
        if (groupPoints.length < minSamples) continue;     // слишком мало точек — шум
        const rel = reliefOn();
        const labels = dbscanClustering(clusterCoords(groupPoints, rel), epsilon, minSamples, rel ? 1 : 111000);
        let maxL = -1;
        for (let i = 0; i < groupPoints.length; i++) {
            if (labels[i] >= 0) { allLabels[groupPoints[i].idx] = offset + labels[i]; if (labels[i] > maxL) maxL = labels[i]; }
        }
        offset += maxL + 1;
    }
    return renumberClusters(allLabels, true);
}

// Перенумерация кластеров
function renumberClusters(labels, keepNoise = false) {
    const uniqueClusters = [...new Set(labels)];

    if (!keepNoise) {
        const noiseIndex = uniqueClusters.indexOf(-1);
        if (noiseIndex !== -1) uniqueClusters.splice(noiseIndex, 1);
    }

    const mapping = new Map();
    for (let i = 0; i < uniqueClusters.length; i++) {
        mapping.set(uniqueClusters[i], i);
    }

    if (keepNoise) mapping.set(-1, -1);

    return labels.map(label => mapping.get(label) ?? -1);
}


// Выполнение кластеризации
// Отображение результатов
function displayClusteringResults(points, labels, method) {
    if (window.clusteringResultLayer) {
        map.removeLayer(window.clusteringResultLayer);
    }
    
    const uniqueClusters = [...new Set(labels.filter(l => l !== -1))];
    const colorMap = new Map();
    // Раскраска как у политической карты: соседние районы — всегда разными цветами.
    // Палитра из 8 хорошо различимых цветов (проверена на цветовую слепоту); цвет может повториться
    // только у районов, которые не соприкасаются. Соседство — по зданиям ближе 150 м (сервер)
    // или, если его нет, по расстоянию между центрами.
    const DISTRICT_PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#8c564b'];
    const neigh = new Map(uniqueClusters.map(c => [c, new Set()]));
    if (method === 'attract' && window.districtAdjacency) {
        for (const [a, b] of window.districtAdjacency) { neigh.get(a)?.add(b); neigh.get(b)?.add(a); }
    }
    {
        // для k-means / DBSCAN: соседи — районы с близкими точками (по сетке ~150 м)
        const cell = new Map();
        points.forEach((p, i) => { if (labels[i] < 0) return;
            const k = Math.round(p.lat / 0.0014) + ':' + Math.round(p.lng / 0.0022);
            if (!cell.has(k)) cell.set(k, new Set()); cell.get(k).add(labels[i]); });
        for (const [k, set] of cell) {
            const [y, x] = k.split(':').map(Number);
            for (const [dy, dx] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
                const other = cell.get((y + dy) + ':' + (x + dx)); if (!other) continue;
                for (const a of [...set, ...other]) for (const b of [...set, ...other]) if (a !== b) neigh.get(a)?.add(b);
            }
            for (const a of set) for (const b of set) if (a !== b) neigh.get(a)?.add(b);
        }
    }
    // жадная раскраска: сначала районы с наибольшим числом соседей; цвет — не занятый соседями,
    // из свободных — самый редко использованный
    const order = [...uniqueClusters].sort((a, b) => neigh.get(b).size - neigh.get(a).size);
    const used = new Array(DISTRICT_PALETTE.length).fill(0);
    // центр каждого района (среднее точек) — чтобы одинаковые цвета доставались районам подальше друг от друга
    const ctr = new Map();
    points.forEach((p, i) => { const l = labels[i]; if (l < 0) return;
        const c = ctr.get(l) || [0, 0, 0]; c[0] += p.lng; c[1] += p.lat; c[2]++; ctr.set(l, c); });
    const kx = Math.cos((points[0]?.lat || 52) * Math.PI / 180);
    const cdist = (a, b) => { const A = ctr.get(a), B = ctr.get(b);
        return Math.hypot((A[0] / A[2] - B[0] / B[2]) * kx, A[1] / A[2] - B[1] / B[2]); };
    const byColor = DISTRICT_PALETTE.map(() => []);
    for (const c of order) {
        const busy = new Set([...neigh.get(c)].map(n => colorMap.get(n)).filter(Boolean));
        // из свободных цветов — тот, у которого ближайший район того же цвета дальше всего
        let best = -1, bestD = -1;
        DISTRICT_PALETTE.forEach((col, i) => {
            if (busy.has(col)) return;
            const d = byColor[i].length ? Math.min(...byColor[i].map(o => cdist(c, o))) : Infinity;
            if (d > bestD || (d === bestD && used[i] < used[best])) { best = i; bestD = d; }
        });
        if (best >= 0) byColor[best].push(c);
        if (best >= 0) { colorMap.set(c, DISTRICT_PALETTE[best]); used[best]++; }
        else colorMap.set(c, `hsl(${(colorMap.size * 137.5) % 360}, 70%, 45%)`);   // запасной вариант
    }

    currentClusteredPoints = [];
    for (let i = 0; i < points.length; i++) {
        const clusterId = labels[i];
        if (clusterId !== -1) {
            currentClusteredPoints.push({
                type: "Feature",
                geometry: {
                    type: "Point",
                    coordinates: [points[i].lng, points[i].lat]
                },
                properties: {
                    cluster_id: clusterId,
                    face_id: points[i].face ?? null,
                    population: points[i].population || 100,
                    Насел: points[i].population || 100  // Для совместимости
                }
            });
        }
    }
    console.log(`Сохранено ${currentClusteredPoints.length} точек для генерации полигонов`);
    
    // ВЫЧИСЛЕНИЕ ЦЕНТРОВ КЛАСТЕРОВ
    const centroids = [];
    const clusterPoints = new Map();
    
    // Группируем точки по кластерам
    for (let i = 0; i < points.length; i++) {
        const clusterId = labels[i];
        if (clusterId === -1) continue;
        
        if (!clusterPoints.has(clusterId)) {
            clusterPoints.set(clusterId, []);
        }
        clusterPoints.get(clusterId).push(points[i]);
    }
    
    // Центр каждого района — центроид по площади зданий:
    //   X = Σ(x_i · S_i) / Σ S_i,  Y = Σ(y_i · S_i) / Σ S_i,  S_i — площадь здания
    for (const [clusterId, clusterPointList] of clusterPoints.entries()) {
        let sumLng = 0, sumLat = 0, sumW = 0;
        for (const point of clusterPointList) {
            const w = point.weight || 1;
            sumLng += point.lng * w;
            sumLat += point.lat * w;
            sumW += w;
        }
        // Профиль района (как в README руководителя): площадь этажей по категориям 2ГИС,
        // укрупнённая до функций, и число организаций по категориям
        const prof = computeZoneProfile(clusterPointList);

        const anc = window.clusterAnchors ? window.clusterAnchors[clusterId] : null;
        centroids.push({
            clusterId: clusterId,
            leadCat: prof.leadCat,
            profile: prof,
            anchor: anc ? { name: anc.point.name || null, cat: anc.point.cat || null, mass: anc.mass,
                            weight: anc.point.weight, lat: anc.point.lat, lng: anc.point.lng,
                            nOrgs: anc.point.feature?.properties?.n_orgs || 0, mix: anc.point.mix || null,
                            members: anc.members ? anc.members.length : 1, minor: !!anc.minor } : null,
            massLng: sumLng / sumW,   // центр тяжести застройки (для сравнения)
            massLat: sumLat / sumW,
            // звезда — на главном здании центра; если его центр масс снаружи контура — на точке внутри здания
            lng: anc ? (anc.point.inpt ? anc.point.inpt[0] : anc.point.lng) : sumLng / sumW,
            lat: anc ? (anc.point.inpt ? anc.point.inpt[1] : anc.point.lat) : sumLat / sumW,
            pointCount: clusterPointList.length,
            totalArea: clusterPointList.reduce((sum, p) => sum + (p.hasArea ? p.weight : 0), 0),
            totalPopulation: clusterPointList.reduce((sum, p) => sum + (p.population || 0), 0),
            color: colorMap.get(clusterId)
        });
    }
    window.currentCentroids = centroids;
    const expBtn = document.getElementById('exportProfilesBtn');
    if (expBtn) expBtn.disabled = centroids.length === 0;

    // Точки кластеров
    const features = points.map((point, i) => ({
        type: "Feature",
        geometry: {
            type: "Point",
            coordinates: [point.lng, point.lat]
        },
        properties: {
            cluster_id: labels[i] === -1 ? 'Шум' : labels[i],
            population: point.population,
            method: method
        }
    }));
    
    window.clusteringResultLayer = L.geoJSON({
        type: "FeatureCollection",
        features: features
    }, {
        pointToLayer: (f, latlng) => {
            const cid = f.properties.cluster_id;
            let color;
            if (cid === 'Шум') {
                color = '#95a5a6';
            } else {
                color = colorMap.get(parseInt(cid));
            }
            const pop = f.properties.population || 100;
            return L.circleMarker(latlng, {
                radius: Math.min(8, Math.max(4, Math.sqrt(pop) / 5)),
                fillColor: color,
                color: '#fff',
                weight: 1,
                fillOpacity: 0.7,
                opacity: 0.8
            });
        },
        onEachFeature: (f, layer) => {
            layer.feature = f;
            layer.bindPopup(`
                <b>Население:</b> ${f.properties.population}<br>
                <b>Кластер:</b> ${f.properties.cluster_id}<br>
                <b>Метод:</b> ${f.properties.method}
            `);
        }
    }).addTo(map);
    
    // ОТОБРАЖЕНИЕ ЦЕНТРОВ КЛАСТЕРОВ (центроиды по площади зданий)
    if (window.centroidsLayer) {
        map.removeLayer(window.centroidsLayer);
        window.centroidsLayer = null;
    }
    if (centroids.length > 0) {
        const markers = centroids.map(c => {
            const icon = L.divIcon({
                className: 'cluster-centroid-icon',
                html: `<div style="color:${c.color}; font-size:26px; line-height:26px; text-shadow:0 0 3px #000, 0 0 2px #000;">★</div>`,
                iconSize: [26, 26],
                iconAnchor: [13, 13]
            });
            const areaTxt = c.totalArea > 0
                ? `<b>Площадь зданий:</b> ${Math.round(c.totalArea).toLocaleString('ru-RU')} м²<br>`
                : '';
            const catTxt = zoneProfileHtml(c.profile);
            return L.marker([c.lat, c.lng], { icon: icon, zIndexOffset: 1000 })
                .bindPopup(`
                    <b>Центр района ${c.clusterId}</b><br>
                    ${c.anchor
                        ? `<i>центр притяжения — крупное здание</i><br><b>Объект:</b> ${anchorLabel(c.anchor)}<br>
                           ${c.anchor.name && c.anchor.nOrgs >= 10 ? `<b>Например:</b> ${c.anchor.name}<br>` : ''}
                           <b>Категория:</b> ${typeof categoryLabel === 'function' ? categoryLabel(c.anchor.cat) : (c.anchor.cat || '—')}<br>
                           ${c.anchor.members > 1 ? `<b>Комплекс:</b> ${c.anchor.members} крупных зданий в радиусе ${mergeRadius()} м<br>` : ''}
                           ${c.anchor.minor ? '<i>крупных объектов в этой части нет — центр по самому большому зданию</i><br>' : ''}
                           <b>Организаций в главном здании:</b> ${c.anchor.nOrgs}<br>
                           <b>Масса притяжения:</b> ${Math.round(c.anchor.mass).toLocaleString('ru-RU')}<br>`
                        : '<i>центроид по площади зданий</i><br>'}
                    <b>Зданий:</b> ${c.pointCount}<br>
                    ${areaTxt}
                    ${catTxt}
                    <b>Население:</b> ${Math.round(c.totalPopulation)}<br>
                    <b>Координаты:</b> ${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}
                `);
        });
        window.centroidsLayer = L.layerGroup(markers).addTo(map);
    }

    const bi = window.lastBarrierInfo;
    const hi = method === 'attract' ? window.lastHuffInfo : null;
    showStatus(`Районирование выполнено: ${uniqueClusters.length} районов` +
        (hi ? `; центров притяжения ${hi.centers}, расстояние ${hi.method === 'network+relief' ? 'по дорогам с учётом рельефа' : hi.method === 'network' ? 'по дорогам' : 'по прямой'}` : '') +
        (window.zoomRun ? `; масштаб: ${window.zoomRun.level.name}` : '') +
        (bi ? `; барьеры разделили область на ${bi.nonEmpty} частей с зданиями` : ''), "success");
}

function clearClustering() {
    if (window.clusteringResultLayer) {
        map.removeLayer(window.clusteringResultLayer);
        window.clusteringResultLayer = null;
    }
    if (window.centroidsLayer) {
        map.removeLayer(window.centroidsLayer);
        window.centroidsLayer = null;
    }
    window.currentCentroids = null;
    if (window.barrierVisualLayer) { map.removeLayer(window.barrierVisualLayer); window.barrierVisualLayer = null; }
    window.currentFaces = null;
    currentClusteredPoints = null;  // ← ДОБАВЬТЕ
    currentPolygons = null;          // ← ДОБАВЬТЕ
    if (polygonLayer) {
        map.removeLayer(polygonLayer);
        polygonLayer = null;
    }
    showStatus("Результаты районирования очищены", "info");
}

// Вспомогательная функция показа статуса
function showStatus(msg, type) {
    const div = document.createElement('div');
    div.className = `status ${type}`;
    div.textContent = msg;
    div.style.cssText = 'position:fixed; bottom:20px; right:360px; z-index:10000; padding:10px 15px; border-radius:6px; max-width:350px; box-shadow:0 2px 8px rgba(0,0,0,0.2); background:white; font-weight:500;';
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 4000);
}