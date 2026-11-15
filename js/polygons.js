async function generatePolygons() {
    console.log("=== ГЕНЕРАЦИЯ ПОЛИГОНОВ ===");
    
    // ИСПОЛЬЗУЕМ currentClusteredPoints (он у вас есть!)
    if (!currentClusteredPoints || currentClusteredPoints.length === 0) {
        console.error("Нет сохраненных точек кластеризации");
        console.log("currentClusteredPoints:", currentClusteredPoints);
        showStatus("Сначала выполните районирование!", "error");
        return;
    }
    
    console.log(`Использую ${currentClusteredPoints.length} сохраненных точек`);
    console.log("Пример точки:", currentClusteredPoints[0]);
    
    showStatus(`Создание полигонов из ${currentClusteredPoints.length} точек...`, "info");
    
    const method = document.getElementById('polygonMethod').value;
    const alpha = parseFloat(document.getElementById('alphaValue')?.value || 0.5);
    
    try {
        const response = await fetch('http://127.0.0.1:8000/generate-cluster-polygons', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clustered_features: currentClusteredPoints,  // ← используем переменную
                method: method,
                use_alpha_shape: method === 'alpha_shape',
                alpha: alpha,
                faces: window.currentFaces || null   // части области между барьерами — для обрезки полигонов
            })
        });
        
        const data = await response.json();
        console.log("Ответ сервера:", data);
        
        if (data.error) {
            showStatus(`Ошибка: ${data.error}`, "error");
            return;
        }
        
        if (!data.features || data.features.length === 0) {
            console.warn("Сервер вернул пустой результат");
            showStatus("Не удалось создать полигоны: сервер вернул пустой результат", "error");
            return;
        }
        
        currentPolygons = data;
        displayPolygons(data);
        showStatus(`Создано ${data.features.length} полигонов`, "success");
        
    } catch (error) {
        console.error('Ошибка:', error);
        showStatus(`Ошибка: ${error.message}`, "error");
    }
}

// Отображение полигонов на карте (с поддержкой переключения режимов)
function displayPolygons(polygons) {
    if (polygonLayer) {
        map.removeLayer(polygonLayer);
    }

    if (!polygons || !polygons.features || polygons.features.length === 0) {
        console.warn("Нет полигонов для отображения");
        return;
    }

    const displayModeSelect = document.getElementById('attractionDisplay');
    const displayMode = displayModeSelect ? displayModeSelect.value : 'score';

    const attractionColors = {
        5: '#e74c3c',  // Очень сильное
        4: '#e67e22',  // Сильное
        3: '#f39c12',  // Среднее
        2: '#3498db',  // Слабое
        1: '#95a5a6'   // Очень слабое
    };

    polygonLayer = L.geoJSON(polygons, {
        style: (feature) => {
            // Получаем уровень притяжения (1-5)
            let attractionLevel = feature.properties.attraction_level;

            // Если данных нет, вычисляем на основе площади и населения
            if (!attractionLevel || attractionLevel === 0) {
                const area = feature.properties.area_sqkm || 0.1;
                const population = feature.properties.total_population || 0;
                const density = population / area;

                if (density > 5000) attractionLevel = 5;
                else if (density > 3000) attractionLevel = 4;
                else if (density > 1500) attractionLevel = 3;
                else if (density > 500) attractionLevel = 2;
                else attractionLevel = 1;
            }

            const color = attractionColors[attractionLevel] || '#95a5a6';

            return {
                color: color,
                weight: 3,
                fillColor: color,
                fillOpacity: 0.3,
                opacity: 0.8
            };
        },
        onEachFeature: (feature, layer) => {
            const props = feature.properties;

            // Формируем текст притяжения в зависимости от выбранного режима
            let attractionText = '';
            let attractionValue = '';

            if (displayMode === 'score') {
                const score = props.attraction_score || Math.min(100, Math.floor((props.density_per_sqkm || 0) / 100));
                attractionValue = `${score}/100`;
                attractionText = `<b>Притяжение:</b> ${attractionValue}<br>`;
            } else if (displayMode === 'level') {
                const level = props.attraction_level || 1;
                const levelNames = { 1: 'Очень слабое', 2: 'Слабое', 3: 'Среднее', 4: 'Сильное', 5: 'Очень сильное' };
                attractionValue = `${level} (${levelNames[level]})`;
                attractionText = `<b>Уровень притяжения:</b> ${attractionValue}<br>`;
            } else if (displayMode === 'force') {
                const force = props.attraction_force || 'Среднее';
                attractionValue = force;
                attractionText = `<b>Притяжение:</b> ${attractionValue}<br>`;
            }

            // Формируем всплывающее окно
            let popupContent = `
                <b>Кластер ${props.cluster_id}</b><br>
                <b>Точек:</b> ${props.point_count || 0}<br>
                <b>Население:</b> ${props.total_population || 0} чел.<br>
                <b>Площадь:</b> ${(props.area_sqkm || 0).toFixed(2)} км²<br>
                <b>Плотность:</b> ${Math.round(props.density_per_sqkm || 0)} чел/км²<br>
                ${attractionText}
                <b>Центр:</b> ${(props.center_lat || 0).toFixed(4)}, ${(props.center_lon || 0).toFixed(4)}
            `;
            layer.bindPopup(popupContent);
        }
    });

    polygonLayer.addTo(map);
    console.log(`✅ Отображено ${polygons.features.length} полигонов, режим: ${displayMode}`);

    // Обновляем легенду
    updateAttractionLegend(displayMode);
}

// Обновление легенды притяжения
function updateAttractionLegend(mode) {
    const legend = document.getElementById('attractionLegend');
    if (!legend) return;

    if (mode === 'none') {
        legend.style.display = 'none';
        return;
    }

    legend.style.display = 'block';

    // Обновляем содержимое легенды в зависимости от режима
    if (mode === 'score') {
        legend.innerHTML = `
            <b>Шкала притяжения:</b><br>
            <span style="color:#e74c3c;">●</span> Очень сильное (80-100)<br>
            <span style="color:#e67e22;">●</span> Сильное (60-79)<br>
            <span style="color:#f39c12;">●</span> Среднее (40-59)<br>
            <span style="color:#3498db;">●</span> Слабое (20-39)<br>
            <span style="color:#95a5a6;">●</span> Очень слабое (0-19)
        `;
    } else if (mode === 'level') {
        legend.innerHTML = `
            <b>Уровни притяжения:</b><br>
            <span style="color:#e74c3c;">●</span> Уровень 5 - Очень сильное<br>
            <span style="color:#e67e22;">●</span> Уровень 4 - Сильное<br>
            <span style="color:#f39c12;">●</span> Уровень 3 - Среднее<br>
            <span style="color:#3498db;">●</span> Уровень 2 - Слабое<br>
            <span style="color:#95a5a6;">●</span> Уровень 1 - Очень слабое
        `;
    } else if (mode === 'force') {
        legend.innerHTML = `
            <b>Сила притяжения:</b><br>
            <span style="color:#e74c3c;">●</span> Очень сильное<br>
            <span style="color:#e67e22;">●</span> Сильное<br>
            <span style="color:#f39c12;">●</span> Среднее<br>
            <span style="color:#3498db;">●</span> Слабое<br>
            <span style="color:#95a5a6;">●</span> Очень слабое
        `;
    }
}

// Экспорт полигонов
async function exportPolygons() {
    if (!currentPolygons || currentPolygons.features.length === 0) {
        showStatus("Нет полигонов для экспорта", "error");
        return;
    }

    const format = document.getElementById('exportFormat').value;
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const filename = `clusters_${timestamp}.${format === 'shapefile' ? 'shp' : format}`;

    showStatus(`Экспорт в ${format}...`, "info");

    try {
        const response = await fetch('http://127.0.0.1:8000/export-polygons', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                polygons: currentPolygons,
                format: format,
                filename: filename
            })
        });

        const data = await response.json();

        if (data.error) {
            showStatus(`Ошибка экспорта: ${data.error}`, "error");
        } else {
            showStatus(`Экспорт завершен! Файл сохранен в папке exports`, "success");
        }

    } catch (error) {
        console.error(error);
        showStatus("Ошибка при экспорте", "error");
    }
}