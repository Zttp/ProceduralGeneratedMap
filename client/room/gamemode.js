//Режим сделал "qupe"

import { DisplayValueHeader, Color, Vector3, Index } from 'pixel_combats/basic';
import { Game, Map, MapEditor, Players, Inventory, LeaderBoard, BuildBlocksSet, Teams, Damage, BreackGraph, Ui, Properties, GameMode, Spawns, Timers, TeamsBalancer, Build, AreaService, AreaPlayerTriggerService, AreaViewService, Chat } from 'pixel_combats/room';



// Создаем команды игроков
Teams.Add('PlayersTeam', 'ИГРОКИ', new Color(0.5, 0.5, 0.5, 1));
PlayersTeam.Spawns.SpawnPointsGroups.Add(1);
PlayersTeam.Build.BlocksSet.Value = BuildBlocksSet.Blue;

// СИСТЕМА ЧАНКОВ
const CHUNK_SIZE = 32;
const LOAD_RADIUS = 3;
const UNLOAD_DISTANCE = LOAD_RADIUS + 2;
const MAX_CHUNKS_PER_FRAME = 1;

let ChunkManager = {
    cache: {},
    loadQueue: [],
    unloadQueue: [],
    dirtyChunks: new Set(),
    playerChunks: {},
    
    getChunkKey(cx, cy, cz) {
        return `${cx},${cy},${cz}`;
    },
    
    worldToChunk(pos) {
        return {
            x: Math.floor(pos.x / CHUNK_SIZE),
            y: Math.floor(pos.y / CHUNK_SIZE),
            z: Math.floor(pos.z / CHUNK_SIZE)
        };
    },
    
    generateChunk(cx, cy, cz) {
        const data = new Uint16Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
        
        // Процедурная генерация ландшафта
        for (let x = 0; x < CHUNK_SIZE; x++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                const wx = cx * CHUNK_SIZE + x;
                const wz = cz * CHUNK_SIZE + z;
                
                // Генерация высоты (синусоида + шум)
                const height = Math.floor(10 + Math.sin(wx * 0.1) * 3 + Math.cos(wz * 0.1) * 3);
                
                for (let y = 0; y < CHUNK_SIZE; y++) {
                    const wy = cy * CHUNK_SIZE + y;
                    const index = y * CHUNK_SIZE * CHUNK_SIZE + z * CHUNK_SIZE + x;
                    
                    if (wy < height) {
                        data[index] = wy < height - 3 ? 1 : 2; // Камень / трава
                    } else if (wy === height) {
                        data[index] = 3; // Газон
                    } else {
                        data[index] = 0; // Воздух
                    }
                }
            }
        }
        return data;
    },
    
    saveChunk(cx, cy, cz) {
        const key = this.getChunkKey(cx, cy, cz);
        const chunk = this.cache[key];
        if (!chunk) return;
        
        // Конвертация в Base64
        const bytes = new Uint8Array(chunk.data.buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        Properties.Get(`chunk_${key}`).Value = btoa(binary);
    },
    
    loadChunk(cx, cy, cz) {
        const key = this.getChunkKey(cx, cy, cz);
        
        // Возвращаем если уже загружен
        if (this.cache[key]) return this.cache[key];
        
        let chunkData;
        const propName = `chunk_${key}`;
        
        // Пытаемся загрузить из сохранения
        if (Properties.Has(propName) {
            const base64 = Properties.Get(propName).Value;
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            
            chunkData = new Uint16Array(bytes.buffer);
        } else {
            // Генерация нового чанка
            chunkData = this.generateChunk(cx, cy, cz);
        }
        
        this.cache[key] = {
            data: chunkData,
            dirty: false
        };
        
        // Добавляем в очередь загрузки в мир
        this.loadQueue.push({ cx, cy, cz });
        return this.cache[key];
    },
    
    unloadChunk(cx, cy, cz) {
        const key = this.getChunkKey(cx, cy, cz);
        const chunk = this.cache[key];
        if (!chunk) return;
        
        // Сохраняем если изменен
        if (chunk.dirty) {
            this.saveChunk(cx, cy, cz);
            this.dirtyChunks.delete(key);
        }
        
        delete this.cache[key];
    },
    
    markDirty(cx, cy, cz) {
        const key = this.getChunkKey(cx, cy, cz);
        const chunk = this.cache[key];
        if (chunk) {
            chunk.dirty = true;
            this.dirtyChunks.add(key);
        }
    },
    
    processLoadQueue() {
        for (let i = 0; i < MAX_CHUNKS_PER_FRAME && this.loadQueue.length > 0; i++) {
            const { cx, cy, cz } = this.loadQueue.shift();
            const chunk = this.cache[this.getChunkKey(cx, cy, cz)];
            
            // Устанавливаем блоки в мире
            for (let x = 0; x < CHUNK_SIZE; x++) {
                for (let y = 0; y < CHUNK_SIZE; y++) {
                    for (let z = 0; z < CHUNK_SIZE; z++) {
                        const index = y * CHUNK_SIZE * CHUNK_SIZE + 
                                      z * CHUNK_SIZE + x;
                        
                        const blockId = chunk.data[index];
                        if (blockId === 0) continue; // Пропускаем воздух
                        
                        MapEditor.SetBlock(
                            cx * CHUNK_SIZE + x,
                            cy * CHUNK_SIZE + y,
                            cz * CHUNK_SIZE + z,
                            blockId
                        );
                    }
                }
            }
        }
    },
    
    processUnloadQueue() {
        while (this.unloadQueue.length > 0) {
            const { cx, cy, cz } = this.unloadQueue.shift();
            this.unloadChunk(cx, cy, cz);
        }
    },
    
    updatePlayerChunks() {
        Players.All.forEach(player => {
            const chunkPos = this.worldToChunk(player.Position);
            const chunkKey = this.getChunkKey(chunkPos.x, chunkPos.y, chunkPos.z);
            
            // Обновляем если игрок переместился в новый чанк
            if (this.playerChunks[player.id] !== chunkKey) {
                this.playerChunks[player.id] = chunkKey;
                
                // Загружаем чанки вокруг игрока
                for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
                            this.loadChunk(
                                chunkPos.x + dx,
                                chunkPos.y + dy,
                                chunkPos.z + dz
                            );
                        }
                    }
                }
            }
        });
    },
    
    checkUnload() {
        const activeChunks = new Set();
        
        // Собираем все активные чанки
        Object.values(this.playerChunks).forEach(key => {
            const [cx, cy, cz] = key.split(',').map(Number);
            
            for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
                        activeChunks.add(this.getChunkKey(
                            cx + dx,
                            cy + dy,
                            cz + dz
                        ));
                    }
                }
            }
        });
        
        // Помечаем на выгрузку неактивные чанки
        Object.keys(this.cache).forEach(key => {
            if (!activeChunks.has(key)) {
                const [cx, cy, cz] = key.split(',').map(Number);
                this.unloadQueue.push({ cx, cy, cz });
            }
        });
    }
};

// Перехват установки блоков для отслеживания изменений
const originalSetBlock = MapEditor.SetBlock;
MapEditor.SetBlock = (x, y, z, blockId) => {
    originalSetBlock(x, y, z, blockId);
    
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    
    // Обновляем данные чанка
    const chunkKey = ChunkManager.getChunkKey(cx, cy, cz);
    const chunk = ChunkManager.cache[chunkKey];
    
    if (chunk) {
        const lx = x - cx * CHUNK_SIZE;
        const ly = y - cy * CHUNK_SIZE;
        const lz = z - cz * CHUNK_SIZE;
        
        const index = ly * CHUNK_SIZE * CHUNK_SIZE + 
                     lz * CHUNK_SIZE + lx;
        
        chunk.data[index] = blockId;
        chunk.dirty = true;
        ChunkManager.dirtyChunks.add(chunkKey);
    }
};

// Таймер для управления чанками
const ChunkTimer = Timers.GetContext().Get('ChunkManager');
ChunkTimer.OnTimer.Add(() => {
    ChunkManager.updatePlayerChunks();
    ChunkManager.checkUnload();
    ChunkManager.processLoadQueue();
    ChunkManager.processUnloadQueue();
});
ChunkTimer.RestartLoop(1);

// Автосохранение измененных чанков каждые 30 секунд
Timers.GetContext().Get('ChunkSaver').OnTimer.Add(() => {
    ChunkManager.dirtyChunks.forEach(key => {
        const [cx, cy, cz] = key.split(',').map(Number);
        ChunkManager.saveChunk(cx, cy, cz);
    });
    ChunkManager.dirtyChunks.clear();
});
Timers.GetContext().Get('ChunkSaver').RestartLoop(30);

// Инициализация игрока
Players.OnPlayerConnected.Add(function(p) {
    PlayersTeam.Add(player);
    player.Spawns.Spawn();
    p.Ui.Hint.Value = 'Загрузка чанков...';
    ChunkManager.updatePlayerChunks();
});

Players.OnPlayerDisconnected.Add(function(p) {
    ChunkManager.dirtyChunks.forEach(key => {
        const [cx, cy, cz] = key.split(',').map(Number);
        ChunkManager.saveChunk(cx, cy, cz);
    });
    ChunkManager.dirtyChunks.clear();
});
