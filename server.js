const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function generateRoomCode() {
    const numbers = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const letters = String.fromCharCode(
        65 + Math.floor(Math.random() * 26),
        65 + Math.floor(Math.random() * 26),
        65 + Math.floor(Math.random() * 26)
    );
    return `${numbers}-${letters}`;
}

function createUniqueCode() {
    let code;
    do { code = generateRoomCode(); } while (rooms[code]);
    return code;
}

function ensureVIP(room, code) {
    const hasVIP = room.users.some(u => u.isVIP);
    if (!hasVIP && room.users.length > 0) {
        room.users[0].isVIP = true;
        io.to(code).emit('vip-assigned', { userId: room.users[0].id });
        console.log(`VIP auto-assigned to ${room.users[0].username} in room ${code}`);
    }
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // uid is now passed with create-room
    socket.on('create-room', ({ username, uid, color }) => {
        const code = createUniqueCode();
        const user = {
            id: socket.id,
            uid,
            username: username || 'Anon User',
            color: color || '#e74c3c',
            isVIP: true  // Creator is always VIP
        };
        rooms[code] = { users: [user], locked: false, chatLocked: false };
        socket.join(code);
        socket.currentRoom = code;
        socket.username = user.username;
        socket.uid = uid;
        console.log(`Room created: ${code} by ${socket.username} (VIP)`);
        // Return uid so client can put it in URL
        socket.emit('room-created', { code, uid });
    });

    socket.on('join-room', ({ code, username, uid, color }) => {
        const room = rooms[code];
        if (!room) { socket.emit('join-error', 'Room not found. Check your code!'); return; }
        if (room.locked) { socket.emit('join-error', 'This room is locked.'); return; }
        if (room.users.length >= 4) { socket.emit('join-error', 'Room is full!'); return; }
        const user = {
            id: socket.id,
            uid,
            username: username || 'Anon User',
            color: color || '#e74c3c',
            isVIP: false
        };
        room.users.push(user);
        socket.join(code);
        socket.currentRoom = code;
        socket.username = user.username;
        socket.uid = uid;
        console.log(`${socket.username} joined room: ${code}`);
        socket.emit('join-success', { code, uid });
        socket.to(code).emit('user-joined', user);
    });

    // rejoin-room now uses uid for reliable identification
    socket.on('rejoin-room', ({ code, username, uid, color }) => {
        console.log(`Rejoin: code=${code} user=${username} uid=${uid}`);
        if (!rooms[code]) {
            socket.emit('room-not-found');
            return;
        }
        const room = rooms[code];

        // Find existing entry by uid
        const existing = room.users.find(u => u.uid === uid);
        const wasVIP = existing ? existing.isVIP : false;

        // Remove old entry for this uid
        room.users = room.users.filter(u => u.uid !== uid);

        // If nobody has VIP, this user gets it
        const hasVIP = room.users.some(u => u.isVIP);

        const user = {
            id: socket.id,
            uid,
            username: username || 'Anon User',
             color: existing ? existing.color : (color || '#e74c3c'),
            isVIP: wasVIP || !hasVIP
        };

        room.users.push(user);
        socket.join(code);
        socket.currentRoom = code;
        socket.username = user.username;
        socket.uid = uid;

        console.log(`Room ${code} users:`, room.users.map(u => `${u.username}(VIP:${u.isVIP})`));

        socket.emit('room-state', {
            users: room.users,
            locked: room.locked,
            chatLocked: room.chatLocked
        });
        socket.to(code).emit('user-joined', user);
    });

    socket.on('chat-message', ({ roomCode, username, text }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.chatLocked) return;

    // ── Character limit ──
    if (!text || typeof text !== 'string') return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed.length > 200) return;

    // ── Rate limiting — max 3 messages per 2 seconds ──
    const now = Date.now();
    if (!socket.chatLog) socket.chatLog = [];

    // Clear messages older than 2 seconds
    socket.chatLog = socket.chatLog.filter(t => now - t < 2000);

    if (socket.chatLog.length >= 3) {
        socket.emit('chat-rate-limited');
        return;
    }

    socket.chatLog.push(now);
    socket.to(roomCode).emit('chat-message', { username, text: trimmed });});

    socket.on('chat-rate-limited', () => {
    const input = document.getElementById('chatInput');
    input.placeholder = 'Slow down...';
    input.style.borderColor = '#e74c3c';
    setTimeout(() => {
        input.placeholder = 'Send a message...';
        input.style.borderColor = '';
    }, 1500);});

    socket.on('webrtc-offer', ({ offer, targetId }) => {
        io.to(targetId).emit('webrtc-offer', { offer, fromId: socket.id });
    });

    socket.on('webrtc-answer', ({ answer, targetId }) => {
        io.to(targetId).emit('webrtc-answer', { answer, fromId: socket.id });
    });

    socket.on('ice-candidate', ({ candidate, targetId }) => {
        io.to(targetId).emit('ice-candidate', { candidate, fromId: socket.id });
    });

    socket.on('webrtc-renegotiate', ({ offer, targetId }) => {
        io.to(targetId).emit('webrtc-renegotiate', { offer, fromId: socket.id });
    });

    socket.on('webrtc-renegotiate-answer', ({ answer, targetId }) => {
        io.to(targetId).emit('webrtc-renegotiate-answer', { answer, fromId: socket.id });
    });

    socket.on('speaking', ({ roomCode }) => {
        socket.to(roomCode).emit('user-speaking', { userId: socket.id });
    });

    socket.on('stopped-speaking', ({ roomCode }) => {
        socket.to(roomCode).emit('user-stopped-speaking', { userId: socket.id });
    });

    socket.on('screen-share-started', ({ roomCode, userId }) => {
        socket.to(roomCode).emit('screen-share-started', { userId });
    });

    socket.on('screen-share-stopped', ({ roomCode, userId }) => {
        socket.to(roomCode).emit('screen-share-stopped', { userId });
    });

    socket.on('vip-lock-room', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const user = room.users.find(u => u.id === socket.id);
        if (!user || !user.isVIP) return;
        room.locked = !room.locked;
        io.to(roomCode).emit('room-locked', { locked: room.locked });
    });

    socket.on('vip-lock-chat', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const user = room.users.find(u => u.id === socket.id);
        if (!user || !user.isVIP) return;
        room.chatLocked = !room.chatLocked;
        io.to(roomCode).emit('chat-locked', { locked: room.chatLocked });
    });

    socket.on('vip-kick', ({ roomCode, targetId }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const user = room.users.find(u => u.id === socket.id);
        if (!user || !user.isVIP) return;
        io.to(targetId).emit('kicked');
    });

    socket.on('vip-force-mute', ({ roomCode, targetId }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const user = room.users.find(u => u.id === socket.id);
        if (!user || !user.isVIP) return;
        io.to(targetId).emit('force-muted');
    });

    socket.on('vip-force-deafen', ({ roomCode, targetId }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const user = room.users.find(u => u.id === socket.id);
        if (!user || !user.isVIP) return;
        io.to(targetId).emit('force-deafened');
    });

    socket.on('vip-give', ({ roomCode, targetId }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const user = room.users.find(u => u.id === socket.id);
        if (!user || !user.isVIP) return;
        const target = room.users.find(u => u.id === targetId);
        if (!target) return;
        target.isVIP = true;
        io.to(roomCode).emit('vip-assigned', { userId: targetId });
    });

    socket.on('vip-reroll-code', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const user = room.users.find(u => u.id === socket.id);
        if (!user || !user.isVIP) return;
        const newCode = createUniqueCode();
        rooms[newCode] = room;
        delete rooms[roomCode];
        room.users.forEach(u => {
            const s = io.sockets.sockets.get(u.id);
            if (s) s.currentRoom = newCode;
        });
        io.to(roomCode).emit('code-rerolled', { newCode });
        io.in(roomCode).socketsJoin(newCode);
        io.in(roomCode).socketsLeave(roomCode);
        console.log(`Room rerolled: ${roomCode} → ${newCode}`);
    });

    socket.on('mute-state', ({ roomCode, isMuted }) => {
        socket.to(roomCode).emit('user-mute-state', { userId: socket.id, isMuted });
    });

    socket.on('deafen-state', ({ roomCode, isDeafened }) => {
        socket.to(roomCode).emit('user-deafen-state', { userId: socket.id, isDeafened });
    });

    socket.on('disconnect', () => {
        const code = socket.currentRoom;
        if (!code) return;
        console.log(`Disconnect: ${socket.username} from room ${code}`);

        setTimeout(() => {
            if (!rooms[code]) return;
            const room = rooms[code];
            // Remove by socket.id — uid-based rejoin will re-add them if they return
            room.users = room.users.filter(u => u.id !== socket.id);
            socket.to(code).emit('user-left', socket.id);
            ensureVIP(room, code);

            if (room.users.length === 0) {
                setTimeout(() => {
                    if (rooms[code] && rooms[code].users.length === 0) {
                        delete rooms[code];
                        console.log(`Room ${code} deleted`);
                    }
                }, 15000);
            }
        }, 500);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Communicare running at http://localhost:${PORT}`);
});