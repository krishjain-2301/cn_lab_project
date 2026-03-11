/* ===================================================================
   app.js — FileShare client-side logic
   =================================================================== */

// --- Redirect if no username ---
const params = new URLSearchParams(window.location.search);
const USERNAME = params.get('username')?.trim();
if (!USERNAME) window.location.href = '/';

// --- Socket ---
const socket = io();

// --- State ---
let mySocketId = null;
let currentMode = null;   // 'dm' | 'room'
let currentTarget = null; // socketId (dm) | roomName (room)
let onlineUsers = [];
let onlineRooms = [];
let joinedRooms = new Set();

/* ===================================================================
   Init
   =================================================================== */
socket.on('connect', () => {
  socket.emit('register', USERNAME);
});

socket.on('registered', ({ username, socketId }) => {
  mySocketId = socketId;
  document.getElementById('myName').textContent = username;
  document.getElementById('myAvatar').textContent = avatarChar(username);
  showToast(`👋 Welcome, ${username}!`, 'join');
});

/* ===================================================================
   User list
   =================================================================== */
socket.on('user-list', (users) => {
  onlineUsers = users.filter(u => u.socketId !== mySocketId);
  renderUserList();
  document.getElementById('userCount').textContent = onlineUsers.length;
});

function renderUserList() {
  const list = document.getElementById('userList');
  if (onlineUsers.length === 0) {
    list.innerHTML = '<div class="empty-hint">No other users online</div>';
    return;
  }
  list.innerHTML = '';
  onlineUsers.forEach(u => {
    const item = document.createElement('div');
    item.className = 'user-item' + (currentMode === 'dm' && currentTarget === u.socketId ? ' active' : '');
    item.dataset.sid = u.socketId;
    item.innerHTML = `
      <div class="user-avatar" style="${avatarGrad(u.username)}">${avatarChar(u.username)}</div>
      <span class="user-name">${esc(u.username)}</span>
      <div class="user-online-dot"></div>
    `;
    item.addEventListener('click', () => openDM(u));
    list.appendChild(item);
  });
}

/* ===================================================================
   Room list
   =================================================================== */
socket.on('room-list', (rooms) => {
  onlineRooms = rooms;
  renderRoomList();
});

function renderRoomList() {
  const list = document.getElementById('roomList');
  if (onlineRooms.length === 0) {
    list.innerHTML = '<div class="empty-hint">No rooms yet</div>';
    return;
  }
  list.innerHTML = '';
  onlineRooms.forEach(r => {
    const joined = joinedRooms.has(r.name);
    const item = document.createElement('div');
    item.className = 'room-item' + (currentMode === 'room' && currentTarget === r.name ? ' active' : '');
    item.dataset.room = r.name;
    item.innerHTML = `
      <div class="room-icon">${joined ? '🔵' : '⚪'}</div>
      <div style="flex:1;overflow:hidden">
        <div class="room-name-text">${esc(r.name)}</div>
        <div class="room-meta">${r.members.length} member${r.members.length !== 1 ? 's' : ''}</div>
      </div>
      ${!joined ? `<button class="room-create-go" style="font-size:11px;padding:5px 9px" data-join="${esc(r.name)}">Join</button>` : ''}
    `;
    if (joined) {
      item.addEventListener('click', () => openRoom(r.name));
    } else {
      item.querySelector('[data-join]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        socket.emit('join-room', r.name);
      });
    }
    list.appendChild(item);
  });
}

/* ===================================================================
   Create room UI
   =================================================================== */
document.getElementById('createRoomBtn').addEventListener('click', () => {
  const wrap = document.getElementById('createRoomWrap');
  wrap.style.display = 'flex';
  document.getElementById('newRoomInput').focus();
});
document.getElementById('roomCancel').addEventListener('click', () => {
  document.getElementById('createRoomWrap').style.display = 'none';
  document.getElementById('newRoomInput').value = '';
});
document.getElementById('roomCreateGo').addEventListener('click', doCreateRoom);
document.getElementById('newRoomInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') doCreateRoom();
  if (e.key === 'Escape') document.getElementById('roomCancel').click();
});
function doCreateRoom() {
  const name = document.getElementById('newRoomInput').value.trim();
  if (!name) return;
  socket.emit('create-room', name);
  document.getElementById('newRoomInput').value = '';
  document.getElementById('createRoomWrap').style.display = 'none';
}

socket.on('room-joined', ({ roomName }) => {
  joinedRooms.add(roomName);
  renderRoomList();
  openRoom(roomName);
  showToast(`🏠 Joined room: ${roomName}`, 'join');
});
socket.on('room-left', ({ roomName }) => {
  joinedRooms.delete(roomName);
  renderRoomList();
  if (currentMode === 'room' && currentTarget === roomName) showWelcome();
});

/* ===================================================================
   Leave room
   =================================================================== */
document.getElementById('leaveRoomBtn').addEventListener('click', () => {
  if (currentMode === 'room' && currentTarget) {
    socket.emit('leave-room', currentTarget);
  }
});

/* ===================================================================
   Open DM / Room
   =================================================================== */
const messageHistory = {}; // key -> [{type,bubble}]

function openDM(user) {
  currentMode = 'dm';
  currentTarget = user.socketId;
  renderUserList(); renderRoomList();

  document.getElementById('welcomeScreen').style.display = 'none';
  document.getElementById('chatPanel').style.display = 'flex';
  document.getElementById('leaveRoomBtn').style.display = 'none';

  const avatar = document.getElementById('chatAvatar');
  avatar.textContent = avatarChar(user.username);
  avatar.className = 'chat-avatar';
  avatar.style.cssText = avatarGrad(user.username);
  document.getElementById('chatName').textContent = user.username;
  document.getElementById('chatSub').textContent = '● Online — private chat';

  restoreMessages('dm:' + user.socketId);
  document.getElementById('msgInput').focus();
}

function openRoom(roomName) {
  currentMode = 'room';
  currentTarget = roomName;
  renderUserList(); renderRoomList();

  document.getElementById('welcomeScreen').style.display = 'none';
  document.getElementById('chatPanel').style.display = 'flex';
  document.getElementById('leaveRoomBtn').style.display = '';

  const avatar = document.getElementById('chatAvatar');
  avatar.textContent = '🏠';
  avatar.className = 'chat-avatar room';
  avatar.style.cssText = '';
  document.getElementById('chatName').textContent = `# ${roomName}`;
  const room = onlineRooms.find(r => r.name === roomName);
  document.getElementById('chatSub').textContent = room ? `${room.members.length} members` : 'Room';

  restoreMessages('room:' + roomName);
  document.getElementById('msgInput').focus();
}

function showWelcome() {
  currentMode = null; currentTarget = null;
  document.getElementById('welcomeScreen').style.display = '';
  document.getElementById('chatPanel').style.display = 'none';
  renderUserList(); renderRoomList();
}

function restoreMessages(key) {
  const msgs = document.getElementById('messages');
  msgs.innerHTML = '<div class="day-divider"><span>Today</span></div>';
  (messageHistory[key] || []).forEach(({ el }) => msgs.appendChild(el));
  scrollBottom();
}

/* ===================================================================
   Send message
   =================================================================== */
document.getElementById('sendBtn').addEventListener('click', sendMsg);
document.getElementById('msgInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});

function sendMsg() {
  const input = document.getElementById('msgInput');
  const text = input.value.trim();
  if (!text || !currentTarget) return;
  input.value = '';

  if (currentMode === 'dm') {
    socket.emit('private-message', { toSocketId: currentTarget, message: text });
  } else {
    socket.emit('room-message', { roomName: currentTarget, message: text });
  }
}

/* ===================================================================
   Receive messages
   =================================================================== */
socket.on('private-message', (data) => {
  const key = 'dm:' + data.fromSocketId;
  const isCurrent = currentMode === 'dm' && currentTarget === data.fromSocketId;
  const el = makeBubble({ ...data, sent: false });
  storeMessage(key, el);
  if (isCurrent) appendMsg(el);
  else showToast(`💬 ${data.fromUsername}: ${data.message.substring(0, 60)}`, 'info');
  if (!isCurrent) {
    const user = onlineUsers.find(u => u.socketId === data.fromSocketId);
    if (user) pulseUserItem(data.fromSocketId);
  }
});

socket.on('private-message-echo', (data) => {
  const key = 'dm:' + data.fromSocketId;
  const isCurrent = currentMode === 'dm' && currentTarget === data.fromSocketId;
  const el = makeBubble({ ...data, sent: true });
  storeMessage(key, el);
  if (isCurrent) appendMsg(el);
});

socket.on('private-file', (data) => {
  const key = 'dm:' + data.fromSocketId;
  const isCurrent = currentMode === 'dm' && currentTarget === data.fromSocketId;
  const el = makeFileCard({ ...data, sent: false });
  storeMessage(key, el);
  if (isCurrent) appendMsg(el);
  else showToast(`📎 ${data.fromUsername} sent a file: ${data.fileName}`, 'file');
});

socket.on('private-file-echo', (data) => {
  const key = 'dm:' + data.fromSocketId;
  const isCurrent = currentMode === 'dm' && currentTarget === data.fromSocketId;
  const el = makeFileCard({ ...data, sent: true });
  storeMessage(key, el);
  if (isCurrent) appendMsg(el);
});

socket.on('room-message', (data) => {
  const key = 'room:' + data.roomName;
  const isCurrent = currentMode === 'room' && currentTarget === data.roomName;
  const sent = data.fromSocketId === mySocketId;
  const el = makeBubble({ ...data, sent });
  storeMessage(key, el);
  if (isCurrent) appendMsg(el);
  else showToast(`💬 [${data.roomName}] ${data.fromUsername}: ${data.message.substring(0, 50)}`, 'info');
});

socket.on('room-file', (data) => {
  const key = 'room:' + data.roomName;
  const isCurrent = currentMode === 'room' && currentTarget === data.roomName;
  const sent = data.fromSocketId === mySocketId;
  const el = makeFileCard({ ...data, sent });
  storeMessage(key, el);
  if (isCurrent) appendMsg(el);
  else showToast(`📎 [${data.roomName}] ${data.fromUsername} shared: ${data.fileName}`, 'file');
});

socket.on('room-system', (data) => {
  const key = 'room:' + data.roomName;
  const isCurrent = currentMode === 'room' && currentTarget === data.roomName;
  const el = document.createElement('div');
  el.className = 'sys-msg';
  el.textContent = data.message;
  storeMessage(key, el);
  if (isCurrent) appendMsg(el);
});

socket.on('error-msg', (msg) => showToast(`⚠️ ${msg}`, 'info'));

/* ===================================================================
   File upload — drag & drop + file input
   =================================================================== */
const mainEl = document.querySelector('.main');
const dropOverlay = document.getElementById('dropOverlay');

mainEl.addEventListener('dragover', (e) => {
  if (!currentTarget) return;
  e.preventDefault();
  dropOverlay.classList.add('active');
});
mainEl.addEventListener('dragleave', (e) => {
  if (!dropOverlay.contains(e.relatedTarget)) dropOverlay.classList.remove('active');
});
mainEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dropOverlay.classList.remove('active');
  if (!currentTarget) return;
  const file = e.dataTransfer.files[0];
  if (file) uploadAndSend(file);
});

document.getElementById('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file && currentTarget) uploadAndSend(file);
  e.target.value = '';
});

function uploadAndSend(file) {
  const bar = document.getElementById('uploadProgress');
  const fill = document.getElementById('progressFill');
  const pct = document.getElementById('progressPct');
  const pname = document.getElementById('progressName');

  bar.style.display = '';
  fill.style.width = '0%';
  pct.textContent = '0%';
  pname.textContent = file.name.length > 40 ? file.name.substring(0, 38) + '…' : file.name;

  const form = new FormData();
  form.append('file', file);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/upload');

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      const p = Math.round((e.loaded / e.total) * 100);
      fill.style.width = p + '%';
      pct.textContent = p + '%';
    }
  });

  xhr.addEventListener('load', () => {
    bar.style.display = 'none';
    if (xhr.status === 200) {
      const { fileId } = JSON.parse(xhr.responseText);
      if (currentMode === 'dm') {
        socket.emit('private-file', {
          toSocketId: currentTarget,
          fileId, fileName: file.name, fileSize: file.size
        });
      } else {
        socket.emit('room-file', {
          roomName: currentTarget,
          fileId, fileName: file.name, fileSize: file.size
        });
      }
    } else {
      showToast('❌ Upload failed', 'info');
    }
  });

  xhr.addEventListener('error', () => {
    bar.style.display = 'none';
    showToast('❌ Network error during upload', 'info');
  });

  xhr.send(form);
}

/* ===================================================================
   DOM helpers
   =================================================================== */
function makeBubble({ fromUsername, message, sent, ts }) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-bubble ' + (sent ? 'sent' : 'recv');
  const time = formatTime(ts || Date.now());
  if (!sent) wrap.innerHTML += `<div class="bubble-sender">${esc(fromUsername)}</div>`;
  wrap.innerHTML += `<div class="bubble-body">${esc(message)}</div><div class="bubble-time">${time}</div>`;
  return wrap;
}

function makeFileCard({ fromUsername, fileName, fileSize, downloadUrl, sent, ts }) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-bubble ' + (sent ? 'sent' : 'recv');
  const time = formatTime(ts || Date.now());
  const sizeStr = formatSize(fileSize);
  const icon = fileIcon(fileName);
  if (!sent) wrap.innerHTML += `<div class="bubble-sender">${esc(fromUsername)}</div>`;
  const card = document.createElement('div');
  card.className = 'bubble-body' + (sent ? '' : '');
  card.style.padding = '0'; card.style.background = 'none'; card.style.border = 'none';
  card.innerHTML = `
    <div class="file-card">
      <div class="file-icon">${icon}</div>
      <div class="file-info">
        <div class="file-name" title="${esc(fileName)}">${esc(fileName)}</div>
        <div class="file-size-text">${sizeStr}</div>
      </div>
      <a class="file-dl-btn" href="${downloadUrl}" download="${esc(fileName)}" target="_blank">↓ Save</a>
    </div>
  `;
  wrap.appendChild(card);
  wrap.innerHTML += `<div class="bubble-time">${time}</div>`;
  return wrap;
}

function storeMessage(key, el) {
  if (!messageHistory[key]) messageHistory[key] = [];
  messageHistory[key].push({ el });
}

function appendMsg(el) {
  const msgs = document.getElementById('messages');
  msgs.appendChild(el);
  scrollBottom();
}

function scrollBottom() {
  const msgs = document.getElementById('messages');
  msgs.scrollTop = msgs.scrollHeight;
}

/* ===================================================================
   Toasts
   =================================================================== */
function showToast(text, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = text;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'opacity 0.3s, transform 0.3s';
    setTimeout(() => toast.remove(), 350);
  }, 3500);
}

/* ===================================================================
   Utilities
   =================================================================== */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function avatarChar(name) {
  return name ? name.charAt(0).toUpperCase() : '?';
}

const GRAD_COLORS = [
  ['#6c63ff','#8b5cf6'], ['#06d6a0','#00b4d8'],
  ['#f72585','#b5179e'], ['#ffd166','#ef8c00'],
  ['#2ec4b6','#3d405b'], ['#e76f51','#f4a261'],
];
function avatarGrad(name) {
  let hash = 0;
  for (let i=0; i<name.length; i++) hash = name.charCodeAt(i) + ((hash<<5)-hash);
  const [c1,c2] = GRAD_COLORS[Math.abs(hash) % GRAD_COLORS.length];
  return `background: linear-gradient(135deg, ${c1}, ${c2}); color: white;`;
}

function pulseUserItem(socketId) {
  const el = document.querySelector(`.user-item[data-sid="${socketId}"]`);
  if (!el) return;
  el.style.background = 'rgba(108,99,255,0.25)';
  setTimeout(() => { el.style.background = ''; }, 1200);
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  if (bytes < 1024*1024*1024) return (bytes/1024/1024).toFixed(1) + ' MB';
  return (bytes/1024/1024/1024).toFixed(2) + ' GB';
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    pdf:'📄', doc:'📝', docx:'📝', xls:'📊', xlsx:'📊', ppt:'📋', pptx:'📋',
    jpg:'🖼️', jpeg:'🖼️', png:'🖼️', gif:'🖼️', svg:'🖼️', webp:'🖼️',
    mp4:'🎬', mov:'🎬', avi:'🎬', mkv:'🎬', webm:'🎬',
    mp3:'🎵', wav:'🎵', flac:'🎵', ogg:'🎵',
    zip:'📦', rar:'📦', '7z':'📦', tar:'📦', gz:'📦',
    js:'💻', ts:'💻', py:'🐍', html:'🌐', css:'🎨', json:'🗂️',
    txt:'📃', md:'📃', csv:'📊',
  };
  return map[ext] || '📁';
}
