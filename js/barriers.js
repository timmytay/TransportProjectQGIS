// ===== БАРЬЕРЫ: РАЗРЕЗАНИЕ ОБЛАСТИ НА ЧАСТИ =====
// Раньше линии барьеров обводились буфером ~1 м и полигонизовались: получались узкие
// «колбаски» вдоль рек и дорог, в которые не попадало почти ни одно здание, — все здания
// оказывались в одной группе, и k-means делил её, не видя барьеров.
// Теперь выделенная область разрезается ВСЕМИ включёнными барьерами на части (грани),
// и каждое здание относится к своей части. Районы строятся внутри частей и не пересекают барьеры.
const BARRIER_LAYERS = ['water', 'parks', 'graveyard', 'roads', 'landscape', 'agglom', 'graph', 'water_bodies', 'relief'];
const BARRIER_BUFFER_M = 5;   // полуширина разреза вдоль барьера, м

function activeBarrierKeys() {
    return BARRIER_LAYERS.filter(key => {
        const cb = document.querySelector(`.layer-checkbox[data-layer="${key}"]`);
        return cb && cb.checked && layers[key] && layers[key].data;
    });
}

function featureBBox(f) {
    if (!f._bb) { try { f._bb = turf.bbox(f); } catch (e) { f._bb = [0, 0, 0, 0]; } }
    return f._bb;
}
const bboxHit = (a, b) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);

// Геометрия выделенной области (прямоугольник, круг) или охват точек
function selectionGeometry(points) {
    // режим «масштабирование»: область = видимая часть карты (∩ выделенная область, если она есть)
    if (window.zoomRun) {
        let b = window.zoomRun.bounds;
        if (typeof selectedArea !== 'undefined' && selectedArea) {
            const s = selectedArea.getBounds();
            b = L.latLngBounds([Math.max(b.getSouth(), s.getSouth()), Math.max(b.getWest(), s.getWest())],
                               [Math.min(b.getNorth(), s.getNorth()), Math.min(b.getEast(), s.getEast())]);
        }
        return turf.bboxPolygon([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]).geometry;
    }
    if (typeof selectedArea !== 'undefined' && selectedArea) {
        if (selectedArea instanceof L.Circle) {
            const c = selectedArea.getLatLng();
            return turf.circle([c.lng, c.lat], selectedArea.getRadius() / 1000, { steps: 96, units: 'kilometers' }).geometry;
        }
        const b = selectedArea.getBounds();
        return turf.bboxPolygon([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]).geometry;
    }
    const xs = points.map(p => p.lng), ys = points.map(p => p.lat);
    const pad = 0.002;
    return turf.bboxPolygon([Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad]).geometry;
}

// areaGeometry — выделенная область; points — здания [{lng, lat}]
// Возвращает {keys, faces, assign, stats} или null, если барьеры не включены
async function updateBarriers(areaGeometry = null, points = []) {
    barrierGeometries = [];
    if (window.barrierVisualLayer) { map.removeLayer(window.barrierVisualLayer); window.barrierVisualLayer = null; }
    updateActiveBarriersUI();

    const keys = activeBarrierKeys();
    if (!areaGeometry || keys.length === 0) return null;

    const ab = turf.bbox(areaGeometry);
    const pad = 0.003;
    const clipBox = [ab[0] - pad, ab[1] - pad, ab[2] + pad, ab[3] + pad];
    const feats = [];
    for (const key of keys) {
        for (const f of layers[key].data.features) {
            if (!f.geometry || !bboxHit(featureBBox(f), clipBox)) continue;
            const t = f.geometry.type;
            if (!['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'].includes(t)) continue;
            try {
                const clipped = turf.bboxClip(f, clipBox);
                if (clipped && clipped.geometry && clipped.geometry.coordinates.length)
                    feats.push({ type: 'Feature', geometry: clipped.geometry, properties: { layer: key } });
            } catch (e) { console.warn(`Барьер ${key}:`, e); }
        }
    }
    console.log(`Барьеры: слоёв ${keys.length}, объектов в области ${feats.length}`);

    const resp = await fetch('http://127.0.0.1:8000/api/barrier-faces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            area: areaGeometry,
            barriers: { type: 'FeatureCollection', features: feats },
            points: points.map(p => [p.lng, p.lat]),
            buffer_m: BARRIER_BUFFER_M
        })
    });
    const res = await resp.json();
    if (res.error) throw new Error(res.error);

    // Линии раздела на карте: границы частей области
    window.barrierVisualLayer = L.geoJSON(res.faces, {
        style: { color: '#1f2d3d', weight: 1.5, dashArray: '5 4', fill: false, opacity: 0.8 },
        interactive: false
    }).addTo(map);
    window.currentFaces = res.faces;
    return { keys, faces: res.faces, assign: res.assign, stats: res.stats, nFeatures: feats.length };
}

// Обновление UI списка активных барьеров (чипсы)
function updateActiveBarriersUI() {
    const listContainer = document.getElementById('activeBarriersList');
    const countLabel = document.getElementById('barrierCount');
    if (!listContainer) return;

    const activeCheckboxes = document.querySelectorAll('.layer-checkbox:checked');
    const barrierCheckboxes = Array.from(activeCheckboxes).filter(cb => {
        const type = cb.getAttribute('data-layer');
        // в чипсах показываем только настоящие барьеры (здания, центроиды, нас. пункты — не барьеры)
        return layers[type] ? layers[type].isBarrier === true : (type !== 'buildings' && type !== 'attract');
    });

    if (countLabel) countLabel.textContent = barrierCheckboxes.length;

    if (barrierCheckboxes.length === 0) {
        listContainer.innerHTML = '<div class="empty-state">Нет выбранных барьеров</div>';
        return;
    }

    listContainer.innerHTML = barrierCheckboxes.map(cb => {
        const parentDiv = cb.closest('.layerItem');
        const labelText = parentDiv ? parentDiv.querySelector('label').textContent.trim() : cb.getAttribute('data-layer');
        const colorSpan = parentDiv ? parentDiv.querySelector('.layer-color') : null;
        const color = colorSpan ? colorSpan.style.backgroundColor : '#ccc';
        return `
            <div class="barrier-chip">
                <span class="barrier-chip-color" style="background-color: ${color}"></span>
                ${labelText}
            </div>
        `;
    }).join('');
}