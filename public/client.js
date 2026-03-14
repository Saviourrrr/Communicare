const socket = io();

const createRoomBtn  = document.getElementById('createRoomBtn');
const joinRoomBtn    = document.getElementById('joinRoomBtn');
const joinPanel      = document.getElementById('joinPanel');
const cancelJoinBtn  = document.getElementById('cancelJoinBtn');
const confirmJoinBtn = document.getElementById('confirmJoinBtn');
const usernameInput  = document.getElementById('usernameInput');
const roomCodeInput  = document.getElementById('roomCodeInput');

// ── Color picker ──
const COLORS = [
    '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
    '#1abc9c', '#3498db', '#9b59b6', '#e91e63'
];

let selectedColor = COLORS[Math.floor(Math.random() * COLORS.length)];

const colorOptions = document.getElementById('colorOptions');
const profilePreview = document.getElementById('profilePreview');
const colorPickerPanel = document.getElementById('colorPickerPanel');
const profileAvatarPreview = document.getElementById('profileAvatarPreview');

// Build color swatches
COLORS.forEach(color => {
    const swatch = document.createElement('button');
    swatch.classList.add('color-swatch');
    swatch.style.background = color;
    if (color === selectedColor) swatch.classList.add('selected');
    swatch.addEventListener('click', () => {
        selectedColor = color;
        profileAvatarPreview.style.background = color;
        document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
        swatch.classList.add('selected');
    });
    colorOptions.appendChild(swatch);
});

// Set initial avatar color
profileAvatarPreview.style.background = selectedColor;

// Toggle color picker panel
profilePreview.addEventListener('click', () => {
    colorPickerPanel.classList.toggle('open');
});

// Close picker when clicking outside
document.addEventListener('click', (e) => {
    if (!profilePreview.contains(e.target) && !colorPickerPanel.contains(e.target)) {
        colorPickerPanel.classList.remove('open');
    }
});

function getUsername() {
    return usernameInput.value.trim() || 'Anon User';
}

function generateUID() {
    return Math.random().toString(36).substr(2, 9);
}

joinRoomBtn.addEventListener('click', () => {
    joinPanel.classList.add('visible');
});

cancelJoinBtn.addEventListener('click', () => {
    joinPanel.classList.remove('visible');
    roomCodeInput.value = '';
});

createRoomBtn.addEventListener('click', () => {
    const uid = generateUID();
    socket.emit('create-room', { username: getUsername(), uid, color: selectedColor });
});

socket.on('room-created', ({ code, uid }) => {
    window.location.href = `/room.html?code=${code}&username=${encodeURIComponent(getUsername())}&uid=${uid}&color=${encodeURIComponent(selectedColor)}`;
});

confirmJoinBtn.addEventListener('click', () => {
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!code) return;
    const uid = generateUID();
    socket.emit('join-room', { code, username: getUsername(), uid, color: selectedColor });
});

socket.on('join-success', ({ code, uid }) => {
    window.location.href = `/room.html?code=${code}&username=${encodeURIComponent(getUsername())}&uid=${uid}&color=${encodeURIComponent(selectedColor)}`;
});

socket.on('join-error', (message) => {
    alert(message);
});