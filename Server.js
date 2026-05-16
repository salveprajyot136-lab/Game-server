const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
    console.log('📱 Player connected:', socket.id);

    socket.on('createRoom', ({ playerName }) => {
        const roomCode = generateRoomCode();
        rooms.set(roomCode, {
            players: new Map(),
            gameState: {
                worldSize: 4000,
                players: {},
                bullets: [],
                cars: [
                    { id: 'car1', x: 1800, y: 1800, type: '🏎️ Sports', available: true },
                    { id: 'car2', x: 2200, y: 2000, type: '🚙 SUV', available: true },
                    { id: 'car3', x: 2000, y: 2200, type: '🚚 Truck', available: true },
                    { id: 'car4', x: 2500, y: 2500, type: '🏁 Race', available: true }
                ]
            },
            currentSong: null
        });
        
        const playerId = socket.id;
        const room = rooms.get(roomCode);
        room.players.set(playerId, {
            id: playerId,
            name: playerName || 'Player 1',
            number: 1,
            x: 1800,
            y: 1800,
            health: 100,
            kills: 0,
            deaths: 0,
            weapon: 'pistol',
            ammo: 30,
            isInCar: false,
            currentCarId: null,
            angle: 0,
            carAngle: 0,
            carSpeed: 0
        });
        
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode, playerNumber: 1 });
    });

    socket.on('joinRoom', ({ roomCode, playerName }) => {
        const room = rooms.get(roomCode.toUpperCase());
        if (!room) {
            socket.emit('joinError', 'Room not found!');
            return;
        }
        if (room.players.size >= 2) {
            socket.emit('joinError', 'Room is full!');
            return;
        }

        const playerId = socket.id;
        const playerNum = room.players.size + 1;
        
        room.players.set(playerId, {
            id: playerId,
            name: playerName || 'Player 2',
            number: playerNum,
            x: 2200,
            y: 2100,
            health: 100,
            kills: 0,
            deaths: 0,
            weapon: 'pistol',
            ammo: 30,
            isInCar: false,
            currentCarId: null,
            angle: 0,
            carAngle: 0,
            carSpeed: 0
        });
        
        socket.join(roomCode);
        socket.emit('joined', { playerNumber: playerNum });
        
        // Send existing state to new player
        const state = {
            players: Object.fromEntries(room.players),
            cars: room.gameState.cars,
            bullets: room.gameState.bullets
        };
        socket.emit('gameState', state);
        
        // Broadcast to all in room
        io.to(roomCode).emit('playerJoined', {
            id: playerId,
            name: playerName || `Player ${playerNum}`,
            number: playerNum,
            x: playerNum === 1 ? 1800 : 2200,
            y: playerNum === 1 ? 1800 : 2100
        });
    });

    // Player movement
    socket.on('playerMove', ({ roomCode, x, y, angle, isInCar, carAngle, carSpeed }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        
        const player = room.players.get(socket.id);
        if (player) {
            player.x = x;
            player.y = y;
            player.angle = angle;
            player.isInCar = isInCar;
            player.carAngle = carAngle;
            player.carSpeed = carSpeed;
            
            io.to(roomCode).emit('playerUpdate', {
                id: socket.id,
                x, y, angle, isInCar, carAngle, carSpeed
            });
        }
    });

    // Enter car
    socket.on('enterCar', ({ roomCode, carId }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        
        const car = room.gameState.cars.find(c => c.id === carId);
        if (car && car.available) {
            car.available = false;
            const player = room.players.get(socket.id);
            if (player) {
                player.isInCar = true;
                player.currentCarId = carId;
                player.carSpeed = 0;
                player.carAngle = 0;
                io.to(roomCode).emit('carEntered', { playerId: socket.id, carId });
            }
        }
    });

    // Exit car
    socket.on('exitCar', ({ roomCode, carId }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        
        const car = room.gameState.cars.find(c => c.id === carId);
        if (car) car.available = true;
        
        const player = room.players.get(socket.id);
        if (player) {
            player.isInCar = false;
            player.currentCarId = null;
            player.carSpeed = 0;
            io.to(roomCode).emit('carExited', { playerId: socket.id, carId });
        }
    });

    // Shoot
    socket.on('shoot', ({ roomCode, fromX, fromY, targetX, targetY, weapon }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        
        const bullet = {
            id: Date.now() + Math.random(),
            fromId: socket.id,
            fromX, fromY,
            targetX, targetY,
            x: fromX, y: fromY,
            weapon: weapon,
            timestamp: Date.now()
        };
        
        room.gameState.bullets.push(bullet);
        
        // Check hit
        for (let [id, player] of room.players) {
            if (id !== socket.id) {
                const dx = player.x - targetX;
                const dy = player.y - targetY;
                const dist = Math.sqrt(dx*dx + dy*dy);
                if (dist < 40) {
                    const damage = weapon === 'rifle' ? 25 : (weapon === 'shotgun' ? 35 : 15);
                    player.health -= damage;
                    
                    if (player.health <= 0) {
                        player.health = 100;
                        player.x = 1800 + Math.random() * 400;
                        player.y = 1800 + Math.random() * 400;
                        const shooter = room.players.get(socket.id);
                        if (shooter) shooter.kills++;
                        player.deaths++;
                        io.to(roomCode).emit('playerDied', { id, kills: shooter?.kills, deaths: player.deaths });
                    }
                    
                    io.to(roomCode).emit('playerHit', { id, health: player.health, damage });
                }
            }
        }
        
        io.to(roomCode).emit('bulletFired', bullet);
        
        // Remove bullet after 500ms
        setTimeout(() => {
            if (room) {
                room.gameState.bullets = room.gameState.bullets.filter(b => b.id !== bullet.id);
                io.to(roomCode).emit('bulletRemoved', bullet.id);
            }
        }, 500);
    });

    // Chat
    socket.on('chatMessage', ({ roomCode, message, playerName }) => {
        io.to(roomCode).emit('chatMessage', {
            playerName,
            message,
            timestamp: Date.now()
        });
    });

    // Song sync
    socket.on('syncSong', ({ roomCode, songUrl }) => {
        const room = rooms.get(roomCode);
        if (room) {
            room.currentSong = songUrl;
            io.to(roomCode).emit('songSync', { songUrl, timestamp: Date.now() });
        }
    });

    // Disconnect
    socket.on('disconnect', () => {
        for (let [code, room] of rooms) {
            if (room.players.has(socket.id)) {
                room.players.delete(socket.id);
                io.to(code).emit('playerLeft', socket.id);
                if (room.players.size === 0) {
                    rooms.delete(code);
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 Server running on port ${PORT}`);
});