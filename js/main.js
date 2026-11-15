// Точка входа приложения
document.addEventListener('DOMContentLoaded', async () => {
    console.log('🚀 Инициализация приложения...');

    // Инициализация компонентов карты
    if (typeof initDrawnItems === 'function') initDrawnItems();
    if (typeof createDrawControl === 'function') createDrawControl();
    if (typeof initUIEventListeners === 'function') initUIEventListeners();

    // ===== ЗАГРУЖАЕМ ТОЛЬКО БАРЬЕРЫ (ДАННЫЕ ДЛЯ КЛАСТЕРИЗАЦИИ) =====
    console.log('📥 Загрузка барьеров...');
    
    if (typeof loadCategories === 'function') loadCategories();

    if (typeof loadLayer === 'function') {
        // Загружаем ТОЛЬКО барьеры (они нужны для кластеризации)
        const barrierLayers = [
            'water', 'parks', 'graveyard', 'roads', 
            'landscape', 'agglom', 'graph', 'water_bodies', 'relief'
        ];
        
        for (const layerKey of barrierLayers) {
            await loadLayer(layerKey);
            console.log(`✅ ${layerKey} загружен (данные для барьеров)`);
        }
        
        // ЗДАНИЯ НЕ ЗАГРУЖАЕМ! Они загрузятся только по клику
        console.log('⏸️ Здания не загружены (будут загружены по требованию)');
    }

    // Добавляем слушатели на все чекбоксы слоев
    const allCheckboxes = document.querySelectorAll('.layer-checkbox');
    allCheckboxes.forEach(cb => {
        cb.addEventListener('change', (e) => {
            const layerKey = e.target.dataset.layer;
            const isChecked = e.target.checked;

            // Управляем видимостью на карте
            if (typeof toggleLayer === 'function') {
                toggleLayer(layerKey, isChecked);
            }

            // рельеф: вместе с полигонами склонов показываем отмывку (тени рельефа)
            if (layerKey === 'relief' && typeof toggleHillshade === 'function') toggleHillshade(isChecked);

            // Если включили здания — загружаем их
            if (layerKey === 'buildings' && isChecked) {
                if (typeof loadLayer === 'function') {
                    loadLayer('buildings');
                }
            }

            // Если выключили здания - очищаем результаты кластеризации
            if (layerKey === 'buildings' && !isChecked) {
                if (typeof clearClustering === 'function') {
                    clearClustering();
                }
            }

            // Обновляем ТОЛЬКО чипсы (список барьеров в UI)
            if (typeof updateActiveBarriersUI === 'function') {
                setTimeout(() => updateActiveBarriersUI(), 50);
            }
        });
    });

    // Один раз при старте обновляем барьеры
    setTimeout(() => {
        if (typeof updateActiveBarriersUI === 'function') {
            updateActiveBarriersUI();
        }
        if (typeof updateBarriers === 'function') {
            updateBarriers();
        }
    }, 2000);

    console.log('✅ Приложение инициализировано');
});