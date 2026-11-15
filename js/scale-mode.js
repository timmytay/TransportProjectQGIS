// ===== РАЙОНИРОВАНИЕ ПО МАСШТАБУ (иерархия районов) =====
// Галочка «Масштабирование»: районы строятся для видимой части карты и пересчитываются после
// каждого приближения/отдаления/сдвига. Чем крупнее масштаб, тем мельче районы — как уровни
// планировочной структуры города: планировочные районы → жилые районы → микрорайоны → кварталы.
// Без галочки работает прежний режим: выделенная область и своё число районов K (или свой порог).
//
// Уровень масштаба задаёт:
//   area   — целевая площадь застроенной части одного района, км² (для k-means: K = S_застр / area);
//   minMass — порог «крупного объекта» для центров притяжения;
//   merge  — радиус комплекса (крупные здания ближе merge, м — один центр);
//   minCatch — минимум зданий в зоне тяготения центра;
//   eps    — радиус соседства DBSCAN, м.
const SCALE_LEVELS = [
    { minZoom: 0,  name: 'планировочные районы', area: 6.0,  minMass: 80000, merge: 1200, minCatch: 150, eps: 400 },
    { minZoom: 13, name: 'жилые районы',         area: 2.5,  minMass: 40000, merge: 800,  minCatch: 80,  eps: 250 },
    { minZoom: 14, name: 'микрорайоны',          area: 1.0,  minMass: 20000, merge: 500,  minCatch: 50,  eps: 150 },
    { minZoom: 15, name: 'группы кварталов',     area: 0.35, minMass: 8000,  merge: 300,  minCatch: 25,  eps: 90 },
    { minZoom: 16, name: 'кварталы',             area: 0.15, minMass: 3000,  merge: 150,  minCatch: 12,  eps: 60 },
];
const SCALE_MIN_ZOOM = 12;        // мельче — в кадре сотни тысяч зданий, расчёт слишком долгий
const SCALE_DEBOUNCE_MS = 700;    // пауза после движения карты перед пересчётом
const SCALE_CELL_M = 100;         // застроенная площадь — по клеткам 100×100 м, где есть здания

function scaleLevel(zoom) {
    let lv = SCALE_LEVELS[0];
    for (const l of SCALE_LEVELS) if (zoom >= l.minZoom) lv = l;
    return { ...lv, zoom };
}

// Число районов для k-means на уровне масштаба: застроенная площадь в кадре / целевая площадь района
function scaleK(points, level) {
    if (!points.length) return 1;
    const lat0 = points[0].lat;
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    const cells = new Set(points.map(p => Math.floor(p.lng * kx / SCALE_CELL_M) + ':' + Math.floor(p.lat * ky / SCALE_CELL_M)));
    const built = cells.size * (SCALE_CELL_M * SCALE_CELL_M) / 1e6;   // км²
    const k = Math.round(built / level.area);
    window.lastScaleInfo = { built: +built.toFixed(2), k: Math.max(2, Math.min(60, k)) };
    return window.lastScaleInfo.k;
}

function districtsWord(n) {
    const a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return 'район';
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return 'района';
    return 'районов';
}

function scaleModeOn() {
    return !!document.getElementById('scaleMode')?.checked;
}

function updateScaleInfo(text) {
    const el = document.getElementById('scaleInfo');
    if (el) el.innerHTML = text;
}

let scaleTimer = null;
let scaleBusy = false, scalePending = false;

async function runScaleClustering() {
    if (!scaleModeOn()) return;
    if (scaleBusy) { scalePending = true; return; }   // идёт расчёт — пересчитаем после него
    const z = map.getZoom();
    if (z < SCALE_MIN_ZOOM) {
        updateScaleInfo(`Масштаб ${z}: приблизьте карту (уровень ≥ ${SCALE_MIN_ZOOM}), чтобы построить районы`);
        return;
    }
    const level = scaleLevel(z);
    // небольшой отступ от краёв экрана, чтобы точки не прятались под панелями
    window.zoomRun = { bounds: map.getBounds().pad(-0.03), level };
    updateScaleInfo(`Масштаб ${z} → <b>${level.name}</b>: считаю районы для видимой части карты…`);
    scaleBusy = true;
    try {
        await performClustering();
        const n = (window.currentCentroids || []).length;
        const extra = document.getElementById('clusteringMethod')?.value === 'kmeans' && window.lastScaleInfo
            ? `, застроено ${window.lastScaleInfo.built} км² → K = ${window.lastScaleInfo.k}`
            : document.getElementById('clusteringMethod')?.value === 'attract'
                ? `, порог крупного объекта ${level.minMass.toLocaleString('ru-RU')}` : '';
        updateScaleInfo(`Масштаб ${z} → <b>${level.name}</b>: ${n} ${districtsWord(n)}${extra}. Приблизьте или отдалите карту — районы пересчитаются`);
    } catch (e) {
        console.error(e);
        updateScaleInfo('Ошибка пересчёта: ' + e.message);
    } finally {
        scaleBusy = false;
        if (scalePending) { scalePending = false; runScaleClustering(); }
    }
}

function onMapMoved() {
    if (!scaleModeOn()) return;
    clearTimeout(scaleTimer);
    scaleTimer = setTimeout(runScaleClustering, SCALE_DEBOUNCE_MS);
}

function initScaleMode() {
    const cb = document.getElementById('scaleMode');
    if (!cb) return;
    map.on('moveend', onMapMoved);          // moveend срабатывает и после изменения масштаба
    cb.addEventListener('change', () => {
        if (cb.checked) {
            runScaleClustering();
        } else {
            window.zoomRun = null;
            updateScaleInfo('Обычный режим: районы строятся в выделенной области, число районов задаёте вы');
        }
    });
}

window.scaleLevel = scaleLevel;
window.scaleK = scaleK;
window.runScaleClustering = runScaleClustering;
document.addEventListener('DOMContentLoaded', initScaleMode);
