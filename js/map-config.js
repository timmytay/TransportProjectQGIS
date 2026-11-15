// Инициализация карты
var map = L.map('map', { preferCanvas: true }).setView([52.286, 104.305], 13);

// Базовый слой карты
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

// Легенда
const legend = L.control({ position: 'bottomleft' });
legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'info legend');
    div.style.cssText = 'background:white; padding:8px 12px; border-radius:6px; border:1px solid #ccc; font-size:12px; box-shadow:0 1px 3px rgba(0,0,0,0.1); max-width:200px;';
    div.innerHTML = `
        <b>Легенда</b><br>
        <span style="background:#ff6b6b; display:inline-block; width:12px; height:12px; border-radius:50%;"></span> Здания<br>
        <b style="font-size:11px">Центроиды зданий — приоритет категории:</b><br>
        <span style="background:#8e44ad; display:inline-block; width:10px; height:10px; border-radius:50%;"></span> 1 Транспорт, спецобъекты<br>
        <span style="background:#c0392b; display:inline-block; width:10px; height:10px; border-radius:50%;"></span> 2 Крупные центры притяжения<br>
        <span style="background:#2471a3; display:inline-block; width:10px; height:10px; border-radius:50%;"></span> 3 Социальные объекты<br>
        <span style="background:#e67e22; display:inline-block; width:10px; height:10px; border-radius:50%;"></span> 4 Торговля и услуги<br>
        <span style="background:#7f8c8d; display:inline-block; width:10px; height:10px; border-radius:50%;"></span> 5 Жильё, фон<br>
        <span style="background:#c8c8c8; display:inline-block; width:10px; height:10px; border-radius:50%;"></span> нет данных<br>
        <span style="background:#4fc3f7; display:inline-block; width:12px; height:12px; border-radius:50%;"></span> Водные пути (барьер)<br>
        <span style="background:#81c784; display:inline-block; width:12px; height:12px; border-radius:50%;"></span> Парки (барьер)<br>
        <span style="background:#8d6e63; display:inline-block; width:12px; height:12px; border-radius:50%;"></span> Кладбища (барьер)<br>
        <span style="background:#488AC7; display:inline-block; width:12px; height:12px; border-radius:50%;"></span> Ландшафты (барьер)<br>
        <span style="background:#ff9800; display:inline-block; width:15px; height:4px; margin-bottom:3px;"></span> Магистрали<br>
        <span style="background:#eee8aa; display:inline-block; width:12px; height:12px; border-radius:50%;"></span> Агломерации (барьер)<br>
        <span style="background:#9b59b6; display:inline-block; width:15px; height:4px; margin-bottom:3px;"></span> Граф<br>
        <span style="background:#2980b9; display:inline-block; width:12px; height:12px; border-radius:50%;"></span> Водные объекты<br>
        <span style="background:#f1c40f; display:inline-block; width:12px; height:12px; border-radius:50%;"></span> Нас. пункты<br>
        <span style="background:#ff0000; display:inline-block; width:12px; height:12px;"></span> Выделенная область<br>
        <hr style="margin:5px 0">
        <span style="background:#e74c3c; display:inline-block; width:12px; height:12px; border-radius:50%;"></span> Кластеры → разные цвета<br>
        <span style="color:#222; font-size:14px;">★</span> Центр района (по площади зданий)
    `;
    return div;
};
legend.addTo(map);

// Глобальные переменные
let clusteringResultLayer = null;
let currentPolygons = null;
let currentClusteredPoints = null;
let polygonLayer = null;
let barrierGeometries = [];

// Функция для генерации случайного цвета
function getRandomColor() {
    const hue = Math.random() * 360;
    return `hsl(${hue}, 70%, 55%)`;
}

// Функция для генерации набора цветов
function generateClusterColors(count) {
    const colors = [];
    for (let i = 0; i < count; i++) {
        const hue = (i * 137.5) % 360;
        colors.push(`hsl(${hue}, 70%, 55%)`);
    }
    return colors;
}

// Функция для обновления цветов кластеров
function updateClusterColors(colorCount) {
    clusterColors = generateClusterColors(colorCount);
}