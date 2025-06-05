// Режим сделал "qupe", доработано для полной работоспособности

import { DisplayValueHeader, Color, Vector3, Index } from 'pixel_combats/basic';
import { Game, Map, MapEditor, Players, Inventory, LeaderBoard, BuildBlocksSet, Teams, Damage, BreackGraph, Ui, Properties, GameMode, Spawns, Timers, TeamsBalancer, Build, AreaService, AreaPlayerTriggerService, AreaViewService, Chat } from 'pixel_combats/room';

// 1. Инициализация команды игроков
const PlayersTeam = Teams.Add('Players', 'ИГРОКИ', new Color(0.5, 0.5, 0.5, 1));
if (!PlayersTeam) {
    Chat.BroadcastMessage("Ошибка создания команды!");
    throw new Error("Не удалось создать команду игроков");
}

// Добавляем точку спавна
const spawnGroup = PlayersTeam.Spawns.SpawnPointsGroups.Add(1);
if (!spawnGroup) {
    Chat.BroadcastMessage("Ошибка создания точки спавна!");
    throw new Error("Не удалось создать точку спавна");
}

// Устанавливаем набор блоков для строительства
PlayersTeam.Build.BlocksSet.Value = BuildBlocksSet.Blue;

// 2. СИСТЕМА ЧАНКОВ (оптимизированная версия)
const CHUNK_SIZE = 32;
const LOAD_RADIUS = 2; // Уменьшено для производительности
const MAX_CHUNKS_PER_FRAME = 2;

class ChunkManager {
    constructor() {
        this.cache = {};
        this.loadQueue = [];
        this.unloadQueue = [];
        this.dirtyChunks = new Set();
        this.playerChunks = {};
    }

    getChunkKey(cx, cy, cz) {
        return `${cx},${cy},${cz}`;
    }

    worldToChunk(pos) {
        return {
            x: Math.floor(pos.x / CHUNK_SIZE),
            y: Math.floor(pos.y / CHUNK_SIZE),
            z: Math.floor(pos.z / CHUNK_SIZE)
        };
    }

    generateChunk(cx, cy, cz) {
        const data = new Uint16Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
        const seed = cx * 1000 + cz; // Простое seed значение
        
        for (let x = 0; x < CHUNK_SIZE; x++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                const wx = cx * CHUNK_SIZE + x;
                const wz = cz * CHUNK_SIZE + z;
                
                // Улучшенная генерация высоты с шумом
                const height = Math.floor(15 + 
                    Math.sin(wx * 0.1 + seed) * 5 + 
                    Math.cos(wz * 0.15 + seed) * 5);
                
                for (let y = 0; y < CHUNK_SIZE; y++) {
                    const wy = cy * CHUNK_SIZE + y;
                    const index = y * CHUNK_SIZE * CHUNK_SIZE + z * CHUNK_SIZE + x;
                    
                    if (wy < height - 5) {
                        data[index] = 1; // Камень
                    } else if (wy < height) {
                        data[index] = 2; // Земля
                    } else if (wy === height) {
                        data[index] = 3; // Трава
                    } else if (wy < height + 1) {
                        data[index] = 0; // Воздух (возможны деревья позже)
                    } else {
                        data[index] = 0; // Воздух
                    }
                }
            }
        }
        return data;
    }

    saveChunk(cx, cy, cz) {
        const key = this.getChunkKey(cx, cy, cz);
        const chunk = this.cache[key];
        if (!chunk) return;

        try {
            const bytes = new Uint8Array(chunk.data.buffer);
            Properties.Get(`chunk_${key}`).Value = btoa(String.fromCharCode(...bytes));
        } catch (e) {
            console.error("Ошибка сохранения чанка:", e);
        }
    }

    loadChunk(cx, cy, cz) {
        const key = this.getChunkKey(cx, cy, cz);
        
        if (this.cache[key]) return this.cache[key];
        
        const propName = `chunk_${key}`;
        
        if (Properties.Has(propName)) {
            try {
                const base64 = Properties.Get(propName).Value;
                const binary = atob(base64);
                const bytes = new Uint8Array(binary.length);
                
                for (let i = 0; i < binary.length; i++) {
                    bytes[i] = binary.charCodeAt(i);
                }
                
                this.cache[key] = {
                    data: new Uint16Array(bytes.buffer),
                    dirty: false
                };
            } catch (e) {
                console.error("Ошибка загрузки чанка, генерируем новый:", e);
                this.cache[key] = {
                    data: this.generateChunk(cx, cy, cz),
                    dirty: false
                };
            }
        } else {
            this.cache[key] = {
                data: this.generateChunk(cx, cy, cz),
                dirty: false
            };
        }
        
        this.loadQueue.push({ cx, cy, cz });
        return this.cache[key];
    }

    unloadChunk(cx, cy, cz) {
        const key = this.getChunkKey(cx, cy, cz);
        const chunk = this.cache[key];
        if (!chunk) return;

        if (chunk.dirty) {
            this.saveChunk(cx, cy, cz);
        }

        delete this.cache[key];
    }

    processLoadQueue() {
        let processed = 0;
        while (this.loadQueue.length > 0 && processed < MAX_CHUNKS_PER_FRAME) {
            const { cx, cy, cz } = this.loadQueue.shift();
            const key = this.getChunkKey(cx, cy, cz);
            const chunk = this.cache[key];
            if (!chunk) continue;

            for (let x = 0; x < CHUNK_SIZE; x++) {
                for (let y = 0; y < CHUNK_SIZE; y++) {
                    for (let z = 0; z < CHUNK_SIZE; z++) {
                        const index = y * CHUNK_SIZE * CHUNK_SIZE + z * CHUNK_SIZE + x;
                        const blockId = chunk.data[index];
                        if (blockId === 0) continue;

                        const wx = cx * CHUNK_SIZE + x;
                        const wy = cy * CHUNK_SIZE + y;
                        const wz = cz * CHUNK_SIZE + z;

                        MapEditor.SetBlock(wx, wy, wz, blockId);
                    }
                }
            }
            processed++;
        }
    }

    processUnloadQueue() {
        while (this.unloadQueue.length > 0) {
            const { cx, cy, cz } = this.unloadQueue.shift();
            this.unloadChunk(cx, cy, cz);
        }
    }

    updatePlayerChunks() {
        Players.All.forEach(player => {
            if (!player || !player.Position) return;

            const chunkPos = this.worldToChunk(player.Position);
            const chunkKey = this.getChunkKey(chunkPos.x, chunkPos.y, chunkPos.z);

            if (this.playerChunks[player.id] !== chunkKey) {
                this.playerChunks[player.id] = chunkKey;

                // Загружаем чанки вокруг игрока
                for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
                    for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
                        this.loadChunk(chunkPos.x + dx, 0, chunkPos.z + dz);
                    }
                }
            }
        });
    }

    checkUnload() {
        const activeChunks = new Set();

        Object.values(this.playerChunks).forEach(key => {
            if (!key) return;
            const [cx, , cz] = key.split(',').map(Number);

            for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
                for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
                    activeChunks.add(this.getChunkKey(cx + dx, 0, cz + dz));
                }
            }
        });

        Object.keys(this.cache).forEach(key => {
            if (!activeChunks.has(key)) {
                const [cx, cy, cz] = key.split(',').map(Number);
                this.unloadQueue.push({ cx, cy, cz });
            }
        });
    }
}

// Инициализация менеджера чанков
const chunkManager = new ChunkManager();

// 3. Перехват установки блоков
const originalSetBlock = MapEditor.SetBlock;
MapEditor.SetBlock = (x, y, z, blockId) => {
    originalSetBlock(x, y, z, blockId);

    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const key = chunkManager.getChunkKey(cx, cy, cz);
    const chunk = chunkManager.cache[key];

    if (chunk) {
        const lx = x - cx * CHUNK_SIZE;
        const ly = y - cy * CHUNK_SIZE;
        const lz = z - cz * CHUNK_SIZE;
        const index = ly * CHUNK_SIZE * CHUNK_SIZE + lz * CHUNK_SIZE + lx;
        
        chunk.data[index] = blockId;
        chunk.dirty = true;
        chunkManager.dirtyChunks.add(key);
    }
};

// 4. Настройка таймеров
function setupTimers() {
    try {
        // Таймер для управления чанками
        const chunkTimer = Timers.CreateTimer('ChunkManager');
        chunkTimer.OnTimer.Add(() => {
            try {
                chunkManager.updatePlayerChunks();
                chunkManager.checkUnload();
                chunkManager.processLoadQueue();
                chunkManager.processUnloadQueue();
            } catch (e) {
                console.error("Ошибка в таймере чанков:", e);
            }
        });
        chunkTimer.RestartLoop(0.5); // Более частый вызов

        // Таймер для сохранения чанков
        const saveTimer = Timers.CreateTimer('ChunkSaver');
        saveTimer.OnTimer.Add(() => {
            chunkManager.dirtyChunks.forEach(key => {
                const [cx, cy, cz] = key.split(',').map(Number);
                chunkManager.saveChunk(cx, cy, cz);
            });
            chunkManager.dirtyChunks.clear();
        });
        saveTimer.RestartLoop(30);

        return true;
    } catch (e) {
        console.error("Ошибка настройки таймеров:", e);
        return false;
    }
}

// 5. Обработка игроков
Players.OnPlayerConnected.Add(player => {
    try {
        if (!player || !PlayersTeam) return;

        // Добавляем игрока в команду
        PlayersTeam.Add(player);

        // Устанавливаем начальные параметры
        player.Ui.Hint.Value = 'Добро пожаловать! Идет загрузка мира...';
        
        // Спавним игрока
        player.Spawns.Spawn();
        
        // Инициализируем чанки для игрока
        chunkManager.playerChunks[player.id] = null;
        chunkManager.updatePlayerChunks();


    } catch (e) {
        console.error("Ошибка при подключении игрока:", e);
    }
});

Players.OnPlayerDisconnected.Add(player => {
    delete chunkManager.playerChunks[player.id];
});

// 6. Инициализация режима
function initializeGameMode() {
    try {
        // Очищаем карту
        MapEditor.Clear();
        
        // Настраиваем таймеры
        if (!setupTimers()) {
            throw new Error("Не удалось настроить таймеры");
        }
        
        Chat.BroadcastMessage("Режим успешно загружен!");
        return true;
    } catch (e) {
        console.error("Ошибка инициализации режима:", e);
        Chat.BroadcastMessage("Ошибка загрузки режима!");
        return false;
    }
}

// Запускаем инициализацию
initializeGameMode();
