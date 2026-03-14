// ── URL params ──
const params = new URLSearchParams(window.location.search);
let roomCode = params.get('code');
const myUsername = params.get('username') || 'Anon User';
const myUID = params.get('uid') || Math.random().toString(36).substr(2, 9);
const myColor = decodeURIComponent(params.get('color') || '#e74c3c');

console.log('Room loaded. Code:', roomCode, 'User:', myUsername);

const socket = io();

const remoteScreenStreams = {};
let currentlyViewing = null;

let amVIP = false;
let chatLocked = false;

const RTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// ── State ──
let users = [];
const peerConnections = {};
let localStream = null;
let isMuted = false;
let isDeafened = false;
let isSharing = false;
let screenStream = null;
let isSpeaking = false;
let speakingInterval = null;

// ═══════════════════════════════════════════
// MICROPHONE
// ═══════════════════════════════════════════

async function initMicrophone() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        console.log('Microphone ready');
        startSpeakingDetection(localStream);
    } catch (err) {
        console.warn('Microphone not available:', err.message);
    }
}

// ═══════════════════════════════════════════
// SPEAKING DETECTION
// ═══════════════════════════════════════════

function startSpeakingDetection(stream) {
    try {
        const audioCtx = new AudioContext();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.fftSize);
        const THRESHOLD = 0.02;

        speakingInterval = setInterval(() => {
            if (isMuted || isDeafened) {
                if (isSpeaking) {
                    isSpeaking = false;
                    setSpeakingIndicator(socket.id, false);
                    socket.emit('stopped-speaking', { roomCode });
                }
                return;
            }

            analyser.getByteTimeDomainData(dataArray);

            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                const val = (dataArray[i] - 128) / 128;
                sum += val * val;
            }
            const volume = Math.sqrt(sum / dataArray.length);

            if (volume > THRESHOLD && !isSpeaking) {
                isSpeaking = true;
                setSpeakingIndicator(socket.id, true);
                socket.emit('speaking', { roomCode });
            } else if (volume <= THRESHOLD && isSpeaking) {
                isSpeaking = false;
                setSpeakingIndicator(socket.id, false);
                socket.emit('stopped-speaking', { roomCode });
            }
        }, 100);

        console.log('Speaking detection started');
    } catch (err) {
        console.warn('Speaking detection failed:', err);
    }
}

// ═══════════════════════════════════════════
// SLOTS UI
// ═══════════════════════════════════════════

function buildSlots() {
    console.log('Building slots:', users);
    const grid = document.getElementById('slotsGrid');
    grid.innerHTML = '';

    for (let i = 0; i < 4; i++) {
        const slot = document.createElement('div');
        slot.classList.add('slot');
        slot.id = `slot-${i}`;

        const user = users[i];
        if (user) {
            slot.innerHTML = `
                <span class="crown-icon" style="opacity:${user.isVIP ? '1' : '0'}">
                    <svg viewBox="0 0 24 14" fill="currentColor"><polygon points="0,14 4,4 12,10 20,4 24,14"/></svg>
                </span>
                <div class="slot-avatar" style="background:${user.color || '#e74c3c'}">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="12" cy="8" r="4"/>
                        <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                    </svg>
                </div>
                <span class="slot-username">${user.username}</span>
            `;
            if (remoteScreenStreams[user.id]) {
                showPlayButton(user.id);
            }
        } else {
            const emptyBtn = document.createElement('button');
            emptyBtn.classList.add('slot-empty-btn');
            emptyBtn.textContent = '+';
            emptyBtn.addEventListener('click', showEmptyPopup);
            slot.appendChild(emptyBtn);
        }

        grid.appendChild(slot);
    }
}

function setSpeakingIndicator(userId, speaking) {
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex === -1) return;
    const slot = document.getElementById(`slot-${userIndex}`);
    if (!slot) return;
    const user = users[userIndex];
    const color = user.color || '#e74c3c';
    if (speaking) {
        slot.style.borderColor = color;
        slot.style.boxShadow = `0 0 0 3px ${color}55`;
    } else {
        slot.style.borderColor = '';
        slot.style.boxShadow = '';
    }
}

// ═══════════════════════════════════════════
// EMPTY SLOT POPUP
// ═══════════════════════════════════════════

function showEmptyPopup() {
    document.getElementById('popupCode').textContent = roomCode;
    document.getElementById('emptySlotPopup').classList.add('visible');
    navigator.clipboard.writeText(roomCode).catch(() => {});
}

document.getElementById('closePopupBtn').addEventListener('click', () => {
    document.getElementById('emptySlotPopup').classList.remove('visible');
});

document.getElementById('emptySlotPopup').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('visible');
});

// ═══════════════════════════════════════════
// WEBRTC
// ═══════════════════════════════════════════

function createPeerConnection(targetId) {
    console.log('Creating peer connection to:', targetId);
    const pc = new RTCPeerConnection(RTC_CONFIG);
    peerConnections[targetId] = pc;

    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    } else {
        console.warn('No local stream for peer connection to:', targetId);
    }

    pc.ontrack = (event) => {
        console.log('Received track from:', targetId, 'kind:', event.track.kind);
        if (event.track.kind === 'audio') {
            let audioEl = document.getElementById(`audio-${targetId}`);
            if (!audioEl) {
                audioEl = document.createElement('audio');
                audioEl.id = `audio-${targetId}`;
                audioEl.autoplay = true;
                document.body.appendChild(audioEl);
            }
            audioEl.srcObject = event.streams[0];
            audioEl.muted = isDeafened;
        }
        if (event.track.kind === 'video') {
            console.log('Storing screen stream from:', targetId);
            remoteScreenStreams[targetId] = event.streams[0];
            showPlayButton(targetId);
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', { candidate: event.candidate, targetId });
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`Connection to ${targetId}:`, pc.connectionState);
    };

    return pc;
}

async function callUser(targetId) {
    const pc = createPeerConnection(targetId);
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc-offer', { offer, targetId });
        console.log('Offer sent to:', targetId);
    } catch (err) {
        console.error('Error creating offer:', err);
    }
}

function closePeerConnection(userId) {
    const pc = peerConnections[userId];
    if (pc) { pc.close(); delete peerConnections[userId]; }
    const audioEl = document.getElementById(`audio-${userId}`);
    if (audioEl) audioEl.remove();
}

socket.on('webrtc-offer', async ({ offer, fromId }) => {
    console.log('Received offer from:', fromId);
    const pc = createPeerConnection(fromId);
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc-answer', { answer, targetId: fromId });
    } catch (err) {
        console.error('Error handling offer:', err);
    }
});

socket.on('webrtc-answer', async ({ answer, fromId }) => {
    const pc = peerConnections[fromId];
    if (!pc) return;
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
        console.error('Error handling answer:', err);
    }
});

socket.on('ice-candidate', async ({ candidate, fromId }) => {
    const pc = peerConnections[fromId];
    if (!pc) return;
    try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.error('Error adding ICE candidate:', err);
    }
});

socket.on('webrtc-renegotiate', async ({ offer, fromId }) => {
    console.log('Renegotiating with:', fromId);
    const pc = peerConnections[fromId];
    if (!pc) return;
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc-renegotiate-answer', { answer, targetId: fromId });
    } catch (err) {
        console.error('Renegotiation answer error:', err);
    }
});

socket.on('webrtc-renegotiate-answer', async ({ answer, fromId }) => {
    const pc = peerConnections[fromId];
    if (!pc) return;
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log('Renegotiation complete with:', fromId);
    } catch (err) {
        console.error('Renegotiation complete error:', err);
    }
});

// ═══════════════════════════════════════════
// SCREEN SHARING
// ═══════════════════════════════════════════

async function startScreenShare() {
    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        isSharing = true;
        document.getElementById('shareScreenBtn').classList.add('active');

        const videoTrack = screenStream.getVideoTracks()[0];

        for (const [targetId, pc] of Object.entries(peerConnections)) {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) {
                await sender.replaceTrack(videoTrack);
            } else {
                pc.addTrack(videoTrack, screenStream);
            }
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                socket.emit('webrtc-renegotiate', { offer, targetId });
            } catch (err) {
                console.error('Renegotiation error:', err);
            }
        }

        socket.emit('screen-share-started', { roomCode, userId: socket.id });

        remoteScreenStreams[socket.id] = screenStream;
        viewScreen(socket.id);

        videoTrack.onended = () => stopScreenShare();
        console.log('Screen sharing started');
    } catch (err) {
        console.error('Screen share error:', err);
    }
}

function stopScreenShare() {
    if (!isSharing) return;
    isSharing = false;
    document.getElementById('shareScreenBtn').classList.remove('active');

    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }

    socket.emit('screen-share-stopped', { roomCode, userId: socket.id });
    delete remoteScreenStreams[socket.id];
    if (currentlyViewing === socket.id) currentlyViewing = null;
    buildSlots();
}

function showPlayButton(userId) {
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex === -1) return;
    const slot = document.getElementById(`slot-${userIndex}`);
    if (!slot) return;
    const existing = slot.querySelector('.play-indicator');
    if (existing) existing.remove();
    const playBtn = document.createElement('button');
    playBtn.classList.add('play-indicator');
    playBtn.innerHTML = '▶';
    playBtn.title = 'Click to view screen share';
    playBtn.addEventListener('click', () => viewScreen(userId));
    slot.appendChild(playBtn);
}

function viewScreen(userId) {
    const stream = remoteScreenStreams[userId];
    if (!stream) return;
    if (currentlyViewing && currentlyViewing !== userId) {
        restoreSlot(currentlyViewing);
    }
    currentlyViewing = userId;
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex === -1) return;
    const slot = document.getElementById(`slot-${userIndex}`);
    if (!slot) return;
    slot.innerHTML = `
        <video autoplay playsinline></video>
        <button class="slot-fullscreen-btn">⛶ Fullscreen</button>
        <button class="stop-viewing-btn">✕ Stop viewing</button>
    `;
    const video = slot.querySelector('video');
    video.srcObject = stream;
    slot.querySelector('.slot-fullscreen-btn').addEventListener('click', () => {
        if (video.requestFullscreen) video.requestFullscreen();
    });
    slot.querySelector('.stop-viewing-btn').addEventListener('click', () => {
        currentlyViewing = null;
        restoreSlot(userId);
        showPlayButton(userId);
    });
}

function restoreSlot(userId) {
    function restoreSlot(userId) {
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex === -1) return;
    const slot = document.getElementById(`slot-${userIndex}`);
    if (!slot) return;
    const user = users[userIndex];
    slot.innerHTML = `
        <span class="crown-icon" style="opacity:${user.isVIP ? '1' : '0'}">
            <svg viewBox="0 0 24 14" fill="currentColor"><polygon points="0,14 4,4 12,10 20,4 24,14"/></svg>
        </span>
        <div class="slot-avatar" style="background:${user.color || '#e74c3c'}">
            <svg viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="8" r="4"/>
                <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
            </svg>
        </div>
        <span class="slot-username">${user.username}</span>
    `;
}
}

socket.on('screen-share-started', ({ userId }) => {
    console.log('User started sharing:', userId);
});

socket.on('screen-share-stopped', ({ userId }) => {
    console.log('User stopped sharing:', userId);
    delete remoteScreenStreams[userId];
    if (currentlyViewing === userId) currentlyViewing = null;
    restoreSlot(userId);
});

// ═══════════════════════════════════════════
// CONTROL BAR
// ═══════════════════════════════════════════

document.getElementById('shareScreenBtn').addEventListener('click', () => {
    if (isSharing) stopScreenShare(); else startScreenShare();
});

const chatPanel    = document.getElementById('chatPanel');
const optionsPanel = document.getElementById('optionsPanel');
const chatBtn      = document.getElementById('chatBtn');
const optionsBtn   = document.getElementById('optionsBtn');

chatBtn.addEventListener('click', () => {
    const isOpen = chatPanel.classList.toggle('open');
    chatBtn.classList.toggle('active', isOpen);
    optionsPanel.classList.remove('open');
    optionsBtn.classList.remove('active');
});

document.getElementById('closeChatBtn').addEventListener('click', () => {
    chatPanel.classList.remove('open');
    chatBtn.classList.remove('active');
});

optionsBtn.addEventListener('click', () => {
    const isOpen = optionsPanel.classList.toggle('open');
    optionsBtn.classList.toggle('active', isOpen);
    chatPanel.classList.remove('open');
    chatBtn.classList.remove('active');
});

document.getElementById('closeOptionsBtn').addEventListener('click', () => {
    optionsPanel.classList.remove('open');
    optionsBtn.classList.remove('active');
});

document.getElementById('leaveBtn').addEventListener('click', () => {
    stopScreenShare();
    Object.keys(peerConnections).forEach(closePeerConnection);
    socket.disconnect();
    window.location.href = '/';
});

// ═══════════════════════════════════════════
// OPTIONS — MUTE / DEAFEN
// ═══════════════════════════════════════════

document.getElementById('muteBtn').addEventListener('click', () => {
    isMuted = !isMuted;
    const btn = document.getElementById('muteBtn');
    btn.dataset.active = String(isMuted);
    btn.textContent = isMuted ? 'On' : 'Off';
    if (localStream) {
        localStream.getAudioTracks().forEach(track => { track.enabled = !isMuted; });
    }
    if (isMuted) setSpeakingIndicator(socket.id, false);
    console.log('Muted:', isMuted);
});

document.getElementById('deafenBtn').addEventListener('click', () => {
    isDeafened = !isDeafened;
    const btn = document.getElementById('deafenBtn');
    btn.dataset.active = String(isDeafened);
    btn.textContent = isDeafened ? 'On' : 'Off';
    isMuted = isDeafened;
    const muteBtn = document.getElementById('muteBtn');
    muteBtn.dataset.active = String(isMuted);
    muteBtn.textContent = isMuted ? 'On' : 'Off';
    if (localStream) {
        localStream.getAudioTracks().forEach(track => { track.enabled = !isDeafened; });
    }
    document.querySelectorAll('audio[id^="audio-"]').forEach(el => { el.muted = isDeafened; });
    if (isDeafened) setSpeakingIndicator(socket.id, false);
    console.log('Deafened:', isDeafened);
});

// ═══════════════════════════════════════════
// DEVICES
// ═══════════════════════════════════════════

async function populateDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const micSelect = document.getElementById('micSelect');
        const outputSelect = document.getElementById('outputSelect');
        micSelect.innerHTML = '';
        outputSelect.innerHTML = '';
        devices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || `Device ${device.deviceId.slice(0, 6)}`;
            if (device.kind === 'audioinput') micSelect.appendChild(option);
            if (device.kind === 'audiooutput') outputSelect.appendChild(option);
        });
    } catch (err) {
        console.warn('Could not enumerate devices:', err);
    }
}

// ═══════════════════════════════════════════
// CHAT
// ═══════════════════════════════════════════

const chatMessages = document.getElementById('chatMessages');
const chatInput    = document.getElementById('chatInput');

function appendMessage(username, text, isSelf = false) {
    const msg = document.createElement('div');
    msg.classList.add('chat-message');
    if (isSelf) msg.style.opacity = '0.6';
    msg.innerHTML = `
        <span class="msg-author">${username}</span>
        <span class="msg-text">${text}</span>
    `;
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Client side rate limit tracking
let clientChatLog = [];

function sendMessage() {
    const text = chatInput.value.trim();
    if (!text) return;
    if (text.length > 200) return;

    // Client side rate limit — mirrors server: 3 messages per 2 seconds
    const now = Date.now();
    clientChatLog = clientChatLog.filter(t => now - t < 2000);

    if (clientChatLog.length >= 3) {
        // Flash warning without sending
        chatInput.style.borderColor = '#e74c3c';
        chatInput.placeholder = 'Slow down...';
        setTimeout(() => {
            chatInput.style.borderColor = '';
            chatInput.placeholder = 'Send a message...';
        }, 1500);
        return;
    }

    clientChatLog.push(now);
    appendMessage(myUsername, text, true);
    socket.emit('chat-message', { roomCode, username: myUsername, text });
    chatInput.value = '';
}

document.getElementById('sendChatBtn').addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });

socket.on('chat-message', ({ username, text }) => {
    appendMessage(username, text);
});

// ═══════════════════════════════════════════
// SOCKET ROOM EVENTS
// ═══════════════════════════════════════════

socket.on('connect', async () => {
    console.log('Socket connected');
    await initMicrophone();
    await populateDevices();
    socket.emit('rejoin-room', { code: roomCode, username: myUsername, uid: myUID, color: myColor });
});

socket.on('room-state', async (data) => {
    // Handle both old format (array) and new format (object)
    const roomUsers = Array.isArray(data) ? data : data.users;
    const isLocked = data.locked || false;
    const isChatLocked = data.chatLocked || false;

    console.log('Room state received:', roomUsers);
    users = roomUsers;
    buildSlots();

    // Check if we are VIP
    const me = users.find(u => u.id === socket.id);
if (me && me.isVIP) {
    amVIP = true;
    showVIPControls();
} else {
    amVIP = false;
    hideVIPControls();
}

    // Apply chat lock state
    if (isChatLocked) {
        chatLocked = true;
        document.getElementById('chatInput').disabled = true;
        document.getElementById('sendChatBtn').disabled = true;
        document.getElementById('chatInput').placeholder = 'Chat is locked';
    }

    if (!localStream) await initMicrophone();

    for (const user of roomUsers) {
        if (user.id !== socket.id) {
            await callUser(user.id);
        }
    }
});

socket.on('user-joined', (user) => {
    console.log('User joined:', user);
    if (!users.find(u => u.id === user.id)) {
        users.push(user);
        buildSlots();
    }
});

socket.on('user-left', (userId) => {
    closePeerConnection(userId);
    users = users.filter(u => u.id !== userId);
    buildSlots();
});

socket.on('user-speaking', ({ userId }) => {
    setSpeakingIndicator(userId, true);
});

socket.on('user-stopped-speaking', ({ userId }) => {
    setSpeakingIndicator(userId, false);
});

socket.on('room-not-found', () => {
    alert('Room no longer exists.');
    window.location.href = '/';
});

// ═══════════════════════════════════════════
// VIP
// ═══════════════════════════════════════════

function showVIPControls() {
    document.getElementById('vipControls').style.display = 'flex';
    document.getElementById('vipControls').style.flexDirection = 'column';
    document.getElementById('vipControls').style.gap = '8px';
    document.getElementById('vipDivider').style.display = 'block';
}

function hideVIPControls() {
    document.getElementById('vipControls').style.display = 'none';
    document.getElementById('vipDivider').style.display = 'none';
}

function updateCrowns() {
    users.forEach((user, i) => {
        const slot = document.getElementById(`slot-${i}`);
        if (!slot) return;
        let crown = slot.querySelector('.crown-icon');
        if (!crown) {
            crown = document.createElement('span');
            crown.classList.add('crown-icon');
            crown.innerHTML = `<svg viewBox="0 0 24 14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><polygon points="0,14 4,4 12,10 20,4 24,14"/></svg>`;
            slot.appendChild(crown);
        }
        crown.style.opacity = user.isVIP ? '1' : '0';
    });
}

// Open user picker for a VIP action
function openUserPicker(title, excludeSelf, callback) {
    const overlay = document.getElementById('userPickerOverlay');
    const list = document.getElementById('userPickerList');
    document.getElementById('userPickerTitle').textContent = title;
    list.innerHTML = '';

    const targets = users.filter(u => excludeSelf ? u.id !== socket.id : true);

    if (targets.length === 0) {
        list.innerHTML = '<p style="color:#666;font-size:0.85rem;text-align:center;">No other users in room</p>';
    }

    targets.forEach((user, i) => {
        const btn = document.createElement('button');
        btn.classList.add('user-pick-btn');
        btn.innerHTML = `
    <div class="user-pick-avatar" style="background:${user.color || '#e74c3c'}">
        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
            <circle cx="12" cy="8" r="4"/>
            <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
        </svg>
    </div>
    <span>${user.username}</span>
    ${user.isVIP ? '<span style="margin-left:auto;font-size:0.8rem;opacity:0.8;">VIP</span>' : ''}
`;
        btn.addEventListener('click', () => {
            overlay.classList.remove('visible');
            callback(user.id);
        });
        list.appendChild(btn);
    });

    overlay.classList.add('visible');
}

document.getElementById('closeUserPickerBtn').addEventListener('click', () => {
    document.getElementById('userPickerOverlay').classList.remove('visible');
});

document.getElementById('userPickerOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('visible');
});

// VIP button listeners
document.getElementById('lockRoomBtn').addEventListener('click', () => {
    console.log('Lock room clicked, emitting to server. roomCode:', roomCode);
    console.log('Socket connected:', socket.connected);
    socket.emit('vip-lock-room', { roomCode });
});

document.getElementById('lockChatBtn').addEventListener('click', () => {
    socket.emit('vip-lock-chat', { roomCode });
});

document.getElementById('kickBtn').addEventListener('click', () => {
    openUserPicker('Kick who?', true, (targetId) => {
        socket.emit('vip-kick', { roomCode, targetId });
    });
});

document.getElementById('forceMuteBtn').addEventListener('click', () => {
    openUserPicker('Force mute who?', true, (targetId) => {
        socket.emit('vip-force-mute', { roomCode, targetId });
    });
});

document.getElementById('forceDeafenBtn').addEventListener('click', () => {
    openUserPicker('Force deafen who?', true, (targetId) => {
        socket.emit('vip-force-deafen', { roomCode, targetId });
    });
});

document.getElementById('giveVipBtn').addEventListener('click', () => {
    openUserPicker('Give VIP to who?', true, (targetId) => {
        socket.emit('vip-give', { roomCode, targetId });
    });
});

document.getElementById('rerollBtn').addEventListener('click', () => {
    if (confirm('Reroll the room code? Everyone will get the new code.')) {
        socket.emit('vip-reroll-code', { roomCode });
    }
});

// ── VIP socket events ──

socket.on('vip-assigned', ({ userId }) => {
    // Only the new person gets VIP — don't preserve old VIP
    users = users.map(u => ({
        ...u,
        isVIP: u.id === userId
    }));
    amVIP = userId === socket.id;
    if (amVIP) showVIPControls(); else hideVIPControls();
    updateCrowns();
    console.log('VIP assigned to:', userId, '| I am VIP:', amVIP);
});

socket.on('room-locked', ({ locked }) => {
    const btn = document.getElementById('lockRoomBtn');
    btn.dataset.active = String(locked);
    btn.textContent = locked ? 'On' : 'Off';
});

socket.on('chat-locked', ({ locked }) => {
    chatLocked = locked;
    const btn = document.getElementById('lockChatBtn');
    btn.dataset.active = String(locked);
    btn.textContent = locked ? 'On' : 'Off';
    document.getElementById('chatInput').disabled = locked;
    document.getElementById('sendChatBtn').disabled = locked;
    document.getElementById('chatInput').placeholder = locked ? 'Chat is locked' : 'Send a message...';
});

socket.on('kicked', () => {
    alert('You were kicked from the room.');
    socket.disconnect();
    window.location.href = '/';
});

socket.on('force-muted', () => {
    isMuted = true;
    const btn = document.getElementById('muteBtn');
    btn.dataset.active = 'true';
    btn.textContent = 'On';
    if (localStream) {
        localStream.getAudioTracks().forEach(track => { track.enabled = false; });
    }
    setSpeakingIndicator(socket.id, false);
});

socket.on('force-deafened', () => {
    isDeafened = true;
    isMuted = true;
    const deafBtn = document.getElementById('deafenBtn');
    const muteBtn = document.getElementById('muteBtn');
    deafBtn.dataset.active = 'true';
    deafBtn.textContent = 'On';
    muteBtn.dataset.active = 'true';
    muteBtn.textContent = 'On';
    if (localStream) {
        localStream.getAudioTracks().forEach(track => { track.enabled = false; });
    }
    document.querySelectorAll('audio[id^="audio-"]').forEach(el => { el.muted = true; });
    setSpeakingIndicator(socket.id, false);
});

socket.on('code-rerolled', ({ newCode }) => {
    roomCode = newCode;
    const newUrl = `/room.html?code=${newCode}&username=${encodeURIComponent(myUsername)}&uid=${myUID}`;
    window.history.replaceState({}, '', newUrl);
    alert(`Room code changed to: ${newCode}`);
});

buildSlots();