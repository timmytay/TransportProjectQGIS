// Показ статуса
function showStatus(msg, type) {
    const div = document.createElement('div');
    div.className = `status ${type}`;
    div.textContent = msg;
    div.style.cssText = 'position:fixed; bottom:20px; right:360px; z-index:2000; padding:10px 15px; border-radius:6px; max-width:350px; box-shadow:0 2px 8px rgba(0,0,0,0.2); background:white; font-weight:500; z-index:10000;';
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 4000);
}

// Переключение группы слоев
function toggleGroup(header) {
    const content = header.nextElementSibling;
    const icon = header.querySelector('.toggle-icon');
    if (content.classList.contains('collapsed')) {
        content.classList.remove('collapsed');
        icon.textContent = '▼';
    } else {
        content.classList.add('collapsed');
        icon.textContent = '▶';
    }
}

// Глобальные переменные
let drawControl = null;
let currentDrawType = 'rectangle';
let drawnItems = null;
let selectedArea = null;

// Инициализация слоя для рисования
function initDrawnItems() {
    if (drawnItems) map.removeLayer(drawnItems);
    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);
}

// Создание контрола для рисования
function createDrawControl() {
    if (drawControl) map.removeControl(drawControl);

    const opts = {
        position: 'topleft',
        draw: {
            rectangle: { shapeOptions: { color: '#ff0000', weight: 3, fillOpacity: 0.2 } },
            circle: { shapeOptions: { color: '#ff0000', weight: 3, fillOpacity: 0.2 } },
            polygon: false, polyline: false, marker: false, circlemarker: false
        },
        edit: { featureGroup: drawnItems, edit: true, remove: true }
    };

    if (currentDrawType === 'rectangle') opts.draw.circle = false;
    if (currentDrawType === 'circle') opts.draw.rectangle = false;

    drawControl = new L.Control.Draw(opts);
    map.addControl(drawControl);

    map.on(L.Draw.Event.CREATED, e => {
        drawnItems.clearLayers();
        const layer = e.layer;
        drawnItems.addLayer(layer);
        selectedArea = layer;
        const areaStatus = document.getElementById('areaStatus');
        if (areaStatus) {
            areaStatus.textContent = "Область выбрана! Нажмите «Выполнить районирование»";
            areaStatus.className = "status success";
        }
    });

    map.on(L.Draw.Event.DELETED, () => {
        selectedArea = null;
        const areaStatus = document.getElementById('areaStatus');
        if (areaStatus) {
            areaStatus.textContent = "Нажмите на иконку рисования на карте";
            areaStatus.className = "status info";
        }
    });
}

// Очистка выбранной области
function clearSelectedArea() {
    if (drawnItems) {
        drawnItems.clearLayers();
    }
    selectedArea = null;

    // ОБЯЗАТЕЛЬНО: очищаем результаты кластеризации при очистке области
    if (clusteringResultLayer) {
        map.removeLayer(clusteringResultLayer);
        clusteringResultLayer = null;
    }
    if (polygonLayer) {
        map.removeLayer(polygonLayer);
        polygonLayer = null;
    }
    currentPolygons = null;

    const areaStatus = document.getElementById('areaStatus');
    if (areaStatus) {
        areaStatus.textContent = "Нажмите на иконку рисования на карте";
        areaStatus.className = "status info";
    }
    showStatus("Область и результаты очищены", "info");
    console.log("Область и результаты очищены");
}

// Смена типа рисования и АКТИВАЦИЯ инструмента
function changeDrawType(type) {
    currentDrawType = type;
    clearSelectedArea();
    createDrawControl();


    setTimeout(() => {
        if (type === 'rectangle') {
            new L.Draw.Rectangle(map, {
                shapeOptions: { color: '#ff0000', weight: 3, fillOpacity: 0.2 }
            }).enable();
        } else if (type === 'circle') {
            new L.Draw.Circle(map, {
                shapeOptions: { color: '#ff0000', weight: 3, fillOpacity: 0.2 }
            }).enable();
        }
    }, 100);

    const selectRectangleBtn = document.getElementById('selectRectangleBtn');
    const selectCircleBtn = document.getElementById('selectCircleBtn');
    if (selectRectangleBtn) selectRectangleBtn.classList.toggle('active', type === 'rectangle');
    if (selectCircleBtn) selectCircleBtn.classList.toggle('active', type === 'circle');

    const areaStatus = document.getElementById('areaStatus');
    if (areaStatus) {
        areaStatus.textContent = `Нарисуйте ${type === 'rectangle' ? 'прямоугольник' : 'круг'} на карте`;
        areaStatus.className = "status info";
    }
}

// Инициализация всех UI обработчиков
function initUIEventListeners() {
    console.log("Инициализация UI обработчиков...");

    // Чекбоксы слоев
    document.querySelectorAll('.layer-checkbox').forEach(cb => {
        cb.addEventListener('change', e => {
            const layerKey = e.target.dataset.layer;
            if (typeof toggleLayer === 'function') {
                toggleLayer(layerKey, e.target.checked);
            }
        });
    });

    // Кнопки рисования
    const selectRectangleBtn = document.getElementById('selectRectangleBtn');
    const selectCircleBtn = document.getElementById('selectCircleBtn');
    const clearAreaBtn = document.getElementById('clearAreaBtn');
    const performBtn = document.getElementById('performClusteringBtn');
    const clearClusteringBtn = document.getElementById('clearClusteringBtn');

    if (selectRectangleBtn) {
        selectRectangleBtn.addEventListener('click', () => changeDrawType('rectangle'));
        console.log("Кнопка прямоугольника привязана");
    }

    if (selectCircleBtn) {
        selectCircleBtn.addEventListener('click', () => changeDrawType('circle'));
        console.log("Кнопка круга привязана");
    }

    if (clearAreaBtn) {
        clearAreaBtn.addEventListener('click', clearSelectedArea);
        console.log("Кнопка очистки области привязана");
    }

    // ГЛАВНАЯ КНОПКА - ВЫПОЛНИТЬ РАЙОНИРОВАНИЕ
    if (performBtn) {
        // Удаляем старые слушатели
        const newPerformBtn = performBtn.cloneNode(true);
        performBtn.parentNode.replaceChild(newPerformBtn, performBtn);

        newPerformBtn.addEventListener('click', function () {
            console.log("Кнопка районирования НАЖАТА!");
            if (typeof performClustering === 'function') {
                performClustering();
            } else {
                console.error("Функция performClustering не найдена!");
                showStatus("Ошибка: функция районирования не загружена", "error");
            }
        });
        console.log("Кнопка районирования привязана");
    } else {
        console.error("Кнопка performClusteringBtn не найдена в DOM");
    }

    if (clearClusteringBtn) {
        clearClusteringBtn.addEventListener('click', function () {
            console.log("Кнопка очистки результатов нажата");
            if (typeof clearClustering === 'function') {
                clearClustering();
            }
        });
    }

    // Методы кластеризации
    const methodSelect = document.getElementById('clusteringMethod');
    if (methodSelect) {
        methodSelect.addEventListener('change', () => {
            const m = methodSelect.value;
            const kmeansParams = document.getElementById('kmeansParams');
            const dbscanParams = document.getElementById('dbscanParams');
            const srcSel = document.getElementById('clusteringSource');
            if (m === 'attract' && srcSel) srcSel.value = 'buildings_centroids';   // центрам нужны площади зданий
            const attractParams = document.getElementById('attractParams');
            const auto = document.getElementById('autoCenters')?.checked;
            if (attractParams) attractParams.style.display = m === 'attract' ? 'block' : 'none';
            if (kmeansParams) kmeansParams.style.display = (m === 'kmeans' || (m === 'attract' && !auto)) ? 'block' : 'none';
            if (dbscanParams) dbscanParams.style.display = m === 'dbscan' ? 'block' : 'none';
        });
    }

    const autoCb = document.getElementById('autoCenters');
    if (autoCb) autoCb.addEventListener('change', () => methodSelect && methodSelect.dispatchEvent(new Event('change')));

    // Полигоны
    const polygonMethodSelect = document.getElementById('polygonMethod');
    if (polygonMethodSelect) {
        polygonMethodSelect.addEventListener('change', () => {
            const alphaParams = document.getElementById('alphaParams');
            if (alphaParams) alphaParams.style.display = polygonMethodSelect.value === 'alpha_shape' ? 'block' : 'none';
        });
    }

    const alphaValue = document.getElementById('alphaValue');
    if (alphaValue) {
        alphaValue.addEventListener('input', () => {
            const display = document.getElementById('alphaValueDisplay');
            if (display) display.textContent = alphaValue.value;
        });
    }

    const generatePolygonsBtn = document.getElementById('generatePolygonsBtn');
    if (generatePolygonsBtn) {
        generatePolygonsBtn.addEventListener('click', () => {
            if (typeof generatePolygons === 'function') generatePolygons();
        });
    }

    const exportPolygonsBtn = document.getElementById('exportPolygonsBtn');
    if (exportPolygonsBtn) {
        exportPolygonsBtn.addEventListener('click', () => {
            if (typeof exportPolygons === 'function') exportPolygons();
        });
    }

    const attractionDisplay = document.getElementById('attractionDisplay');
    if (attractionDisplay) {
        attractionDisplay.addEventListener('change', () => {
            if (typeof displayPolygons === 'function' && currentPolygons) {
                displayPolygons(currentPolygons);
            }
        });
    }
    console.log("Инициализация UI обработчиков завершена");
}