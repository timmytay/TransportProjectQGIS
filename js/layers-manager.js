// Конфигурация слоев
const layers = {
    buildings: { layer: null, data: null, visible: true, url: '/load-buildings-pop', isBarrier: false, name: "Здания", color: "#ff6b6b" },
    water: { layer: null, data: null, visible: false, url: '/load-gpx', isBarrier: true, color: "#4fc3f7", name: "Водные пути" },
    parks: { layer: null, data: null, visible: false, url: '/load-parks', isBarrier: true, color: "#81c784", name: "Парки" },
    graveyard: { layer: null, data: null, visible: false, url: '/load-graveyard', isBarrier: true, color: "#8d6e63", name: "Кладбища" },
    roads: { layer: null, data: null, visible: false, url: '/load-roads', isBarrier: true, color: "#ff9800", weight: 4, name: "Магистрали" },
    landscape: { layer: null, data: null, visible: false, url: '/load-landscape', isBarrier: true, color: "#488ac7", weight: 2, name: "Ландшафты" },
    agglom: { layer: null, data: null, visible: false, url: '/load-agglom', isBarrier: true, isBoundary: true, color: "#eee8aa", weight: 3, fillOpacity: 1, name: "Агломерации" },
    graph: { layer: null, data: null, visible: false, url: '/load-graph', isBarrier: true, color: "#9b59b6", weight: 2, name: "Граф (дороги)" },
    water_bodies: { layer: null, data: null, visible: false, url: '/load-water-bodies', isBarrier: true, color: "#2980b9", weight: 2, name: "Водные объекты" },
    relief: { layer: null, data: null, visible: false, url: '/load-relief', isBarrier: true, color: "#a0522d", weight: 1, fillOpacity: 0.45, name: "Рельеф (крутые склоны)" },
    settlements: { layer: null, data: null, visible: false, url: '/load-settlements', isBarrier: false, color: "#f1c40f", name: "Населенные пункты" },
    buildings_gen: { layer: null, data: null, visible: false, url: '/load-buildings-gen', isBarrier: false, name: "Здания (генерация)", color: "#e74c3c" },
    buildings_centroids: { layer: null, data: null, visible: false, url: '/load-buildings-centroids', isBarrier: false, name: "Центроиды зданий", color: "#c0392b" }
};

// ===== КАТЕГОРИИ 2ГИС И ПРИОРИТЕТЫ =====
// 1 — транспорт и спецобъекты, 2 — крупные центры притяжения, 3 — социальные,
// 4 — торговля и услуги, 5 — жильё и фон, 0 — категория не определена
const PRIORITY_COLORS = { 0: '#c8c8c8', 1: '#8e44ad', 2: '#c0392b', 3: '#2471a3', 4: '#e67e22', 5: '#7f8c8d' };
const PRIORITY_NAMES = {
    0: 'Нет данных', 1: 'Транспортные узлы и спецобъекты', 2: 'Крупные центры притяжения',
    3: 'Социальные и общественные объекты', 4: 'Торговля и услуги', 5: 'Жильё и фоновая застройка'
};
window.categoryInfo = {};   // код SQ -> {name, priority, group, rank}

async function loadCategories() {
    try {
        const resp = await fetch('http://127.0.0.1:8000/load-categories');
        const list = await resp.json();
        if (Array.isArray(list)) list.forEach(c => { window.categoryInfo[c.code] = c; });
        console.log(`✅ Категорий с приоритетами: ${Object.keys(window.categoryInfo).length}`);
    } catch (e) {
        console.warn('Справочник категорий не загружен', e);
    }
}

function categoryLabel(code) {
    if (!code) return 'не определена';
    const c = window.categoryInfo[code];
    return c ? `${c.name} (${code})` : code;
}

function centroidPopup(p) {
    const pr = p.prio || 0;
    return `<b>Центроид здания</b><br>
        <b>Категория:</b> ${categoryLabel(p.cat)}<br>
        <b>Приоритет:</b> <span style="color:${PRIORITY_COLORS[pr]}">●</span> ${pr || '—'} — ${PRIORITY_NAMES[pr]}<br>
        <b>Организаций 2ГИС:</b> ${p.n_orgs || 0}<br>
        ${p.mix ? '<b>Площадь по категориям:</b> ' + p.mix.split(';').map(kv => { const [c, v] = kv.split(':');
            return `${c === 'NA' ? 'нет данных' : (window.categoryInfo[c]?.name || c)} ${Math.round(+v)} м²`; }).join('; ') + '<br>' : ''}
        <b>Площадь пятна:</b> ${p.area_m2} м², этажей: ${p.FLOORS}<br>
        <b>Площадь этажей (вес):</b> ${p.weight_area} м²<br>
        <b>Жителей (оценка):</b> ${p.inhab}`;
}
window.loadCategories = loadCategories;
window.PRIORITY_COLORS = PRIORITY_COLORS;
window.PRIORITY_NAMES = PRIORITY_NAMES;

// ===== СТИЛИ =====
function getLayerStyle(layerKey) {
    const styles = {
        buildings: { color: "#ff6b6b" },
        water: { color: "#4fc3f7", weight: 2 },
        parks: { color: "#81c784", weight: 2 },
        graveyard: { color: "#8d6e63", weight: 2 },
        roads: { color: "#ff9800", weight: 4 },
        landscape: { color: "#488AC7", weight: 2 },
        agglom: { color: "#eee8aa", weight: 3 },
        graph: { color: "#9b59b6", weight: 2 },
        water_bodies: { color: "#2980b9", weight: 2 },
        relief: { color: "#a0522d", weight: 1, fillOpacity: 0.45 },
        settlements: { color: "#f1c40f", weight: 2 },
        buildings_gen: { color: "#e74c3c", weight: 1 },
        buildings_centroids: { color: "#c0392b" }
    };
    return styles[layerKey] || { color: "#ccc", weight: 2 };
}

// ===== ЗАГРУЗКА СЛОЯ =====
async function loadLayer(layerKey) {
    const layerConfig = layers[layerKey];
    if (!layerConfig) {
        console.error(`Слой ${layerKey} не найден`);
        return;
    }

    if (layerConfig.data) {
        displayLayer(layerKey);
        return;
    }

    try {
        console.log(`📥 Загрузка ${layerKey}...`);
        const response = await fetch(`http://127.0.0.1:8000${layerConfig.url}`);
        const data = await response.json();

        if (data.error || !data.features || data.features.length === 0) {
            console.error(`❌ ${layerKey}:`, data.error || "Нет данных");
            return;
        }

        console.log(`✅ ${layerKey}: ${data.features.length} объектов`);
        layerConfig.data = data;
        displayLayer(layerKey);
    } catch (error) {
        console.error(`❌ Ошибка загрузки ${layerKey}:`, error);
    }
}

// ===== ОТОБРАЖЕНИЕ СЛОЯ =====
function displayLayer(layerKey) {
    console.log(`🔄 Отображение ${layerKey}`);
    const layerConfig = layers[layerKey];
    if (!layerConfig || !layerConfig.data) {
        console.error(`❌ Нет данных для ${layerKey}`);
        return;
    }

    if (layerConfig.layer) {
        map.removeLayer(layerConfig.layer);
        layerConfig.layer = null;
    }

    const style = getLayerStyle(layerKey);

    let geomType = null;
    for (const feature of layerConfig.data.features) {
        if (feature.geometry) {
            geomType = feature.geometry.type;
            break;
        }
    }
    console.log(`📐 Тип геометрии ${layerKey}: ${geomType}`);

    let layerOptions = {
        onEachFeature: (f, l) => {
            if (layerKey === 'buildings_centroids') {
                l.bindPopup(() => centroidPopup(f.properties || {}));
                return;
            }
            if (layerKey === 'relief') {
                l.bindPopup(`<b>Крутой склон</b><br>уклон ≥ 12° (≈ 21 %)<br>площадь: ${f.properties?.area_ha ?? '—'} га<br>
                    <i>Барьер: районы не переходят через склон</i>`);
                return;
            }
            let txt = `<b>${layerConfig.name || layerKey}</b><br>`;
            for (const [k, v] of Object.entries(f.properties || {})) {
                if (typeof v === 'string' || typeof v === 'number') {
                    txt += `${k}: ${v}<br>`;
                }
            }
            l.bindPopup(txt);
        }
    };

    // ===== ТОЧКИ =====
    if (geomType === 'Point' || geomType === 'MultiPoint') {
        console.log(`📌 Отображение ${layerConfig.data.features.length} точек ${layerKey}`);

        const fillColor = style.color || '#ff6b6b';

        layerOptions.pointToLayer = (f, latlng) => {
            let radius = 3;
            if (layerKey === 'buildings' || layerKey === 'buildings_gen') {
                const pop = f.properties?.['Насел'] || 0;
                if (pop > 0) radius = Math.min(6, Math.max(2, Math.sqrt(pop) / 4));
            }
            let color = fillColor;
            if (layerKey === 'buildings_centroids') {
                // размер точки зависит от площади этажей здания, цвет — от приоритета категории
                const w = f.properties?.weight_area || 0;
                radius = Math.min(6, Math.max(1.5, Math.sqrt(w) / 10));
                color = PRIORITY_COLORS[f.properties?.prio || 0];
                if ((f.properties?.prio || 0) > 0 && f.properties.prio < 5) radius = Math.max(radius, 3.5);
            }
            return L.circleMarker(latlng, {
                radius: radius,
                fillColor: color,
                color: '#fff',
                weight: 0.5,
                fillOpacity: 0.7,
                opacity: 0.7
            });
        };
        
        layerConfig.layer = L.geoJSON(layerConfig.data, layerOptions);
    }
    // ===== ЛИНИИ =====
    else if (geomType === 'LineString' || geomType === 'MultiLineString') {
        layerOptions.style = {
            color: style.color || '#ff9800',
            weight: style.weight || 3,
            opacity: 0.8
        };
        layerConfig.layer = L.geoJSON(layerConfig.data, layerOptions);
    }
    // ===== ПОЛИГОНЫ =====
    else if (geomType === 'Polygon' || geomType === 'MultiPolygon') {
        layerOptions.style = {
            color: style.color || '#488AC7',
            weight: style.weight || 2,
            fillColor: style.color || '#488AC7',
            fillOpacity: style.fillOpacity || 0.3,
            opacity: 0.8
        };
        layerConfig.layer = L.geoJSON(layerConfig.data, layerOptions);
    }

    if (layerConfig.layer && layerConfig.visible) {
        layerConfig.layer.addTo(map);
        console.log(`✅ Слой ${layerKey} добавлен на карту`);
    }
}

// ===== ОТМЫВКА РЕЛЬЕФА (подложка) =====
// Тени склонов из SRTM (relief.py) — показываются вместе со слоем «Рельеф»
async function toggleHillshade(visible) {
    if (visible) {
        if (!window.hillshadeLayer) {
            try {
                const meta = await (await fetch('http://127.0.0.1:8000/relief/hillshade.json')).json();
                if (meta.bounds) window.hillshadeLayer = L.imageOverlay('http://127.0.0.1:8000/relief/hillshade.png',
                    meta.bounds, { opacity: 0.75, interactive: false, zIndex: 250 });
            } catch (e) { console.warn('Отмывка рельефа недоступна', e); }
        }
        if (window.hillshadeLayer && !map.hasLayer(window.hillshadeLayer)) window.hillshadeLayer.addTo(map);
    } else if (window.hillshadeLayer && map.hasLayer(window.hillshadeLayer)) {
        map.removeLayer(window.hillshadeLayer);
    }
}
window.toggleHillshade = toggleHillshade;

// ===== ПЕРЕКЛЮЧЕНИЕ ВИДИМОСТИ =====
function toggleLayer(layerKey, visible) {
    console.log(`🔄 toggleLayer: ${layerKey} -> ${visible}`);
    const cfg = layers[layerKey];
    if (!cfg) return;

    // ===== НЕ ВЫЗЫВАЕМ ПОВТОРНО, ЕСЛИ УЖЕ ЗАГРУЖЕН =====
    if (cfg.data && visible) {
        console.log(`⏭️ ${layerKey} уже загружен, просто показываем/скрываем`);
        cfg.visible = visible;
        if (cfg.layer) {
            if (visible && !map.hasLayer(cfg.layer)) {
                cfg.layer.addTo(map);
            } else if (!visible && map.hasLayer(cfg.layer)) {
                map.removeLayer(cfg.layer);
            }
        }
        return;
    }

    cfg.visible = visible;

    if (cfg.layer) {
        if (visible) {
            if (!map.hasLayer(cfg.layer)) {
                cfg.layer.addTo(map);
            }
        } else {
            if (map.hasLayer(cfg.layer)) {
                map.removeLayer(cfg.layer);
            }
        }
    } else if (visible) {
        loadLayer(layerKey);
    }
}

// ===== ВЫГРУЗКА СЛОЯ =====
function unloadLayer(layerKey) {
    const cfg = layers[layerKey];
    if (!cfg) return;
    
    if (cfg.layer) {
        map.removeLayer(cfg.layer);
        cfg.layer = null;
    }
    cfg.data = null;
    console.log(`🧹 Слой ${layerKey} выгружен`);
}

// ===== ЭКСПОРТ =====
window.loadLayer = loadLayer;
window.displayLayer = displayLayer;
window.toggleLayer = toggleLayer;
window.unloadLayer = unloadLayer;
window.layers = layers;

console.log('✅ layers-manager.js загружен (БЕЗ кэша)');