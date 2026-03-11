/* ===================================================================
   app.js — FileShare client (with Room Admin features)
   =================================================================== */

// ── Redirect if no username ──────────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const USERNAME = params.get('username') && params.get('username').trim();
if (!USERNAME) window.location.href = '/';

const socket = io();

// ── State ────────────────────────────────────────────────────────────────────
let mySocketId = null;
let currentMode = null;         // 'dm' | 'room'
let currentTarget = null;       // socketId (dm) | roomName (room)
let onlineUsers = [];
let onlineRooms = [];
let joinedRooms = new Set();
let adminRooms = new Set();     // rooms where I am admin
let myRoomPerms = {};           // roomName -> { canMessage, canSendFile }
let roomAutoDelete = {};        // roomName -> ms | null

// Join request queue (admin sees one at a time)
let pendingRequest = null;
let pendingRoomName = null;     // room I'm waiting approval for

const messageHistory = {};      // key -> [el, ...]

// ── Init ─────────────────────────────────────────────────────────────────────
socket.on('connect', () => socket.emit('register', USERNAME));

socket.on('registered', ({ username, socketId }) => {
  mySocketId = socketId;
  document.getElementById('myName').textContent = username;
  document.getElementById('myAvatar').textContent = avatarChar(username);
  showToast('👋 Welcome, ' + username + '!', 'join');
});

// ── User list ─────────────────────────────────────────────────────────────────
socket.on('user-list', (users) => {
  onlineUsers = users.filter(u => u.socketId !== mySocketId);
  renderUserList();
  document.getElementById('userCount').textContent = onlineUsers.length;
});

function renderUserList() {
  const list = document.getElementById('userList');
  if (onlineUsers.length === 0) { list.innerHTML = '<div class="empty-hint">No other users online</div>'; return; }
  list.innerHTML = '';
  onlineUsers.forEach(u => {
    const item = document.createElement('div');
    item.className = 'user-item' + (currentMode === 'dm' && currentTarget === u.socketId ? ' active' : '');
    item.dataset.sid = u.socketId;
    item.innerHTML = '<div class="user-avatar" style="' + avatarGrad(u.username) + '">' + avatarChar(u.username) + '</div>' +
      '<span class="user-name">' + esc(u.username) + '</span>' +
      '<div class="user-online-dot"></div>';
    item.addEventListener('click', () => openDM(u));
    list.appendChild(item);
  });
}

// ── Room list ─────────────────────────────────────────────────────────────────
socket.on('room-list', (rooms) => {
  onlineRooms = rooms;
  renderRoomList();
  // Update admin panel member list if open
  if (currentMode === 'room' && currentTarget && adminRooms.has(currentTarget)) {
    const room = onlineRooms.find(r => r.name === currentTarget);
    if (room) renderMemberList(room);
  }
  // Update room sub-title
  if (currentMode === 'room' && currentTarget) {
    const room = onlineRooms.find(r => r.name === currentTarget);
    if (room) document.getElementById('chatSub').textContent = room.memberCount + ' member' + (room.memberCount !== 1 ? 's' : '');
  }
});

function renderRoomList() {
  const list = document.getElementById('roomList');
  if (onlineRooms.length === 0) { list.innerHTML = '<div class="empty-hint">No rooms yet</div>'; return; }
  list.innerHTML = '';
  onlineRooms.forEach(r => {
    const joined = joinedRooms.has(r.name);
    const amAdmin = r.admin === mySocketId;
    const item = document.createElement('div');
    item.className = 'room-item' + (currentMode === 'room' && currentTarget === r.name ? ' active' : '');
    item.dataset.room = r.name;
    item.innerHTML =
      '<div class="room-icon">' + (joined ? '🔵' : '⚪') + '</div>' +
      '<div style="flex:1;overflow:hidden">' +
        '<div class="room-name-text">' + esc(r.name) + (amAdmin ? ' 👑' : '') + '</div>' +
        '<div class="room-meta">' + r.memberCount + ' member' + (r.memberCount !== 1 ? 's' : '') + '</div>' +
      '</div>' +
      (!joined && r.allowJoin ? '<button class="room-create-go" style="font-size:11px;padding:5px 9px" data-join="' + esc(r.name) + '">Request</button>' : '') +
      (!joined && !r.allowJoin ? '<span style="font-size:10px;color:var(--muted);padding:0 6px">Closed</span>' : '');

    if (joined) {
      item.addEventListener('click', () => openRoom(r.name));
    } else if (r.allowJoin) {
      const btn = item.querySelector('[data-join]');
      if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); socket.emit('join-room', r.name); });
    }
    list.appendChild(item);
  });
}

// ── Create room ───────────────────────────────────────────────────────────────
document.getElementById('createRoomBtn').addEventListener('click', () => {
  document.getElementById('createRoomWrap').style.display = 'flex';
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

// ── Room joined / left / dissolved ────────────────────────────────────────────
socket.on('room-joined', ({ roomName, isAdmin, permissions }) => {
  joinedRooms.add(roomName);
  myRoomPerms[roomName] = permissions || { canMessage: true, canSendFile: true };
  if (isAdmin) adminRooms.add(roomName);
  renderRoomList();
  openRoom(roomName);
  showToast((isAdmin ? '👑 Created' : '🏠 Joined') + ' room: ' + roomName, 'join');
});

socket.on('room-left', ({ roomName, reason }) => {
  joinedRooms.delete(roomName);
  adminRooms.delete(roomName);
  delete myRoomPerms[roomName];
  delete roomAutoDelete[roomName];
  renderRoomList();
  if (currentMode === 'room' && currentTarget === roomName) showWelcome();
  if (reason === 'kicked') showToast('🚫 You were removed from room: ' + roomName, 'warn');
});

socket.on('room-dissolved', ({ roomName, message }) => {
  joinedRooms.delete(roomName);
  adminRooms.delete(roomName);
  delete myRoomPerms[roomName];
  delete roomAutoDelete[roomName];
  renderRoomList();
  if (currentMode === 'room' && currentTarget === roomName) showWelcome();
  showToast('💥 ' + message, 'warn');
});

socket.on('join-pending', ({ roomName }) => {
  pendingRoomName = roomName;
  document.getElementById('pendingBody').textContent = 'Waiting for the admin to approve your request to join "' + roomName + '"…';
  document.getElementById('pendingOverlay').style.display = 'flex';
});

socket.on('join-rejected', ({ roomName }) => {
  document.getElementById('pendingOverlay').style.display = 'none';
  pendingRoomName = null;
  showToast('❌ Your request to join "' + roomName + '" was rejected', 'warn');
});

function cancelPending() {
  document.getElementById('pendingOverlay').style.display = 'none';
  pendingRoomName = null;
}

// ── Permissions updated ───────────────────────────────────────────────────────
socket.on('permissions-updated', ({ roomName, canMessage, canSendFile }) => {
  myRoomPerms[roomName] = { canMessage, canSendFile };
  if (currentMode === 'room' && currentTarget === roomName) updateInputPermissions(roomName);
  showToast('🔑 Your permissions in "' + roomName + '" were updated', 'info');
});

// ── Room settings updated ─────────────────────────────────────────────────────
socket.on('room-settings-updated', ({ roomName, autoDeleteMs, allowJoin }) => {
  roomAutoDelete[roomName] = autoDeleteMs || null;
  // Sync admin panel UI if open
  if (adminRooms.has(roomName) && document.getElementById('adminPanel').style.display !== 'none') {
    document.getElementById('autoDeleteSelect').value = String(autoDeleteMs || 0);
    document.getElementById('allowJoinToggle').checked = allowJoin;
  }
});

// ── Join request (received by admin) ──────────────────────────────────────────
socket.on('join-request', ({ roomName, socketId, username }) => {
  pendingRequest = { roomName, socketId, username };
  document.getElementById('joinRequestBody').textContent =
    '"' + username + '" wants to join room "' + roomName + '"';
  document.getElementById('joinRequestOverlay').style.display = 'flex';
  showToast('🔔 Join request from ' + username, 'info');
});

document.getElementById('approveBtn').addEventListener('click', () => {
  if (!pendingRequest) return;
  socket.emit('approve-join', { roomName: pendingRequest.roomName, socketId: pendingRequest.socketId });
  document.getElementById('joinRequestOverlay').style.display = 'none';
  pendingRequest = null;
});

document.getElementById('rejectBtn').addEventListener('click', () => {
  if (!pendingRequest) return;
  socket.emit('reject-join', { roomName: pendingRequest.roomName, socketId: pendingRequest.socketId });
  document.getElementById('joinRequestOverlay').style.display = 'none';
  pendingRequest = null;
});

// ── Admin panel ───────────────────────────────────────────────────────────────
document.getElementById('adminSettingsBtn').addEventListener('click', () => {
  const panel = document.getElementById('adminPanel');
  panel.style.display = panel.style.display === 'none' ? '' : 'none';
  if (panel.style.display !== 'none' && currentTarget) {
    const room = onlineRooms.find(r => r.name === currentTarget);
    if (room) {
      document.getElementById('autoDeleteSelect').value = String(room.autoDeleteMs || 0);
      document.getElementById('allowJoinToggle').checked = room.allowJoin;
      renderMemberList(room);
    }
  }
});

document.getElementById('closeAdminBtn').addEventListener('click', () => {
  document.getElementById('adminPanel').style.display = 'none';
});

document.getElementById('applySettingsBtn').addEventListener('click', () => {
  if (!currentTarget || !adminRooms.has(currentTarget)) return;
  const ms = parseInt(document.getElementById('autoDeleteSelect').value, 10);
  const allowJoin = document.getElementById('allowJoinToggle').checked;
  socket.emit('update-room-settings', {
    roomName: currentTarget,
    autoDeleteMs: ms || null,
    allowJoin
  });
  showToast('✅ Settings applied', 'join');
});

function renderMemberList(room) {
  const list = document.getElementById('membersList');
  list.innerHTML = '';
  room.members.forEach(m => {
    const isMe = m.socketId === mySocketId;
    const isRoomAdmin = m.socketId === room.admin;
    const perms = m.permissions || { canMessage: true, canSendFile: true };

    const row = document.createElement('div');
    row.className = 'member-row';
    row.innerHTML =
      '<div class="member-row-top">' +
        '<div class="member-av" style="' + avatarGrad(m.username) + '">' + avatarChar(m.username) + '</div>' +
        '<div class="member-name">' + esc(m.username) + (isMe ? ' (you)' : '') + '</div>' +
        (isRoomAdmin ? '<span class="member-admin-tag">👑 Admin</span>' : '') +
        (!isRoomAdmin && !isMe ?
          '<button class="member-kick-btn" data-kick="' + m.socketId + '">Kick</button>' : '') +
      '</div>' +
      (!isRoomAdmin ?
        '<div class="perm-toggles">' +
          '<div class="perm-toggle ' + (perms.canMessage ? 'active' : 'inactive') + '" data-sid="' + m.socketId + '" data-perm="msg">' +
            (perms.canMessage ? '💬 Msg ✓' : '💬 Msg ✗') +
          '</div>' +
          '<div class="perm-toggle ' + (perms.canSendFile ? 'active' : 'inactive') + '" data-sid="' + m.socketId + '" data-perm="file">' +
            (perms.canSendFile ? '📎 File ✓' : '📎 File ✗') +
          '</div>' +
        '</div>' : '');

    // Kick
    const kickBtn = row.querySelector('[data-kick]');
    if (kickBtn) kickBtn.addEventListener('click', () => {
      socket.emit('kick-member', { roomName: currentTarget, targetSocketId: m.socketId });
    });

    // Toggle permissions
    row.querySelectorAll('.perm-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const sid = btn.dataset.sid;
        const perm = btn.dataset.perm;
        const currentPerms = (room.members.find(x => x.socketId === sid) || {}).permissions || { canMessage: true, canSendFile: true };
        const newPerms = Object.assign({}, currentPerms);
        if (perm === 'msg') newPerms.canMessage = !newPerms.canMessage;
        if (perm === 'file') newPerms.canSendFile = !newPerms.canSendFile;
        socket.emit('set-permissions', { roomName: currentTarget, targetSocketId: sid, canMessage: newPerms.canMessage, canSendFile: newPerms.canSendFile });
      });
    });

    list.appendChild(row);
  });
}

// ── Open DM / Room ────────────────────────────────────────────────────────────
function openDM(user) {
  currentMode = 'dm'; currentTarget = user.socketId;
  renderUserList(); renderRoomList();
  document.getElementById('welcomeScreen').style.display = 'none';
  document.getElementById('chatPanel').style.display = 'flex';
  document.getElementById('adminCrown').style.display = 'none';
  document.getElementById('adminSettingsBtn').style.display = 'none';
  document.getElementById('leaveRoomBtn').style.display = 'none';
  document.getElementById('adminPanel').style.display = 'none';
  document.getElementById('noPermBanner').style.display = 'none';

  const avatar = document.getElementById('chatAvatar');
  avatar.textContent = avatarChar(user.username);
  avatar.className = 'chat-avatar';
  avatar.setAttribute('style', avatarGrad(user.username));
  document.getElementById('chatName').textContent = user.username;
  document.getElementById('chatSub').textContent = '● Online — private chat';
  setInputEnabled(true, true);
  restoreMessages('dm:' + user.socketId);
  document.getElementById('msgInput').focus();
}

function openRoom(roomName) {
  currentMode = 'room'; currentTarget = roomName;
  renderUserList(); renderRoomList();
  document.getElementById('welcomeScreen').style.display = 'none';
  document.getElementById('chatPanel').style.display = 'flex';
  document.getElementById('adminPanel').style.display = 'none';

  const amAdmin = adminRooms.has(roomName);
  document.getElementById('adminCrown').style.display = amAdmin ? '' : 'none';
  document.getElementById('adminSettingsBtn').style.display = amAdmin ? '' : 'none';
  document.getElementById('leaveRoomBtn').style.display = '';

  const avatar = document.getElementById('chatAvatar');
  avatar.textContent = '🏠'; avatar.className = 'chat-avatar room'; avatar.setAttribute('style', '');
  document.getElementById('chatName').textContent = '# ' + roomName;
  const room = onlineRooms.find(r => r.name === roomName);
  document.getElementById('chatSub').textContent = room ? room.memberCount + ' members' : 'Room';

  updateInputPermissions(roomName);
  restoreMessages('room:' + roomName);
  document.getElementById('msgInput').focus();
}

function updateInputPermissions(roomName) {
  const amAdmin = adminRooms.has(roomName);
  const perms = myRoomPerms[roomName] || { canMessage: true, canSendFile: true };
  const canMsg = amAdmin || perms.canMessage;
  const canFile = amAdmin || perms.canSendFile;
  setInputEnabled(canMsg, canFile);
  document.getElementById('noPermBanner').style.display = (!canMsg && !canFile) ? '' : 'none';
}

function setInputEnabled(canMsg, canFile) {
  document.getElementById('msgInput').disabled = !canMsg;
  document.getElementById('sendBtn').disabled = !canMsg;
  const attach = document.getElementById('attachLabel');
  if (canFile) attach.classList.remove('disabled'); else attach.classList.add('disabled');
  document.getElementById('fileInput').disabled = !canFile;
}

function showWelcome() {
  currentMode = null; currentTarget = null;
  document.getElementById('adminPanel').style.display = 'none';
  document.getElementById('welcomeScreen').style.display = '';
  document.getElementById('chatPanel').style.display = 'none';
  renderUserList(); renderRoomList();
}

function restoreMessages(key) {
  const msgs = document.getElementById('messages');
  msgs.innerHTML = '<div class="day-divider"><span>Today</span></div>';
  (messageHistory[key] || []).forEach(el => msgs.appendChild(el));
  scrollBottom();
}

// ── Leave room ────────────────────────────────────────────────────────────────
document.getElementById('leaveRoomBtn').addEventListener('click', () => {
  if (currentMode === 'room' && currentTarget) socket.emit('leave-room', currentTarget);
});

// ── Send message ──────────────────────────────────────────────────────────────
document.getElementById('sendBtn').addEventListener('click', sendMsg);
document.getElementById('msgInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});

function sendMsg() {
  const input = document.getElementById('msgInput');
  const text = input.value.trim();
  if (!text || !currentTarget) return;
  input.value = '';
  if (currentMode === 'dm') socket.emit('private-message', { toSocketId: currentTarget, message: text });
  else socket.emit('room-message', { roomName: currentTarget, message: text });
}

// ── Receive messages ──────────────────────────────────────────────────────────
socket.on('private-message', (data) => {
  const key = 'dm:' + data.fromSocketId;
  const isCurrent = currentMode === 'dm' && currentTarget === data.fromSocketId;
  const el = makeBubble(Object.assign({}, data, { sent: false }));
  storeMsg(key, el); if (isCurrent) appendMsg(el);
  else { showToast('💬 ' + data.fromUsername + ': ' + data.message.substring(0, 60), 'info'); pulseUser(data.fromSocketId); }
});

socket.on('private-message-echo', (data) => {
  const key = 'dm:' + data.fromSocketId;
  const isCurrent = currentMode === 'dm' && currentTarget === data.fromSocketId;
  const el = makeBubble(Object.assign({}, data, { sent: true }));
  storeMsg(key, el); if (isCurrent) appendMsg(el);
});

socket.on('private-file', (data) => {
  const key = 'dm:' + data.fromSocketId;
  const isCurrent = currentMode === 'dm' && currentTarget === data.fromSocketId;
  const el = makeFileCard(Object.assign({}, data, { sent: false }));
  storeMsg(key, el); if (isCurrent) appendMsg(el);
  else showToast('📎 ' + data.fromUsername + ' sent: ' + data.fileName, 'file');
});

socket.on('private-file-echo', (data) => {
  const key = 'dm:' + data.fromSocketId;
  const isCurrent = currentMode === 'dm' && currentTarget === data.fromSocketId;
  const el = makeFileCard(Object.assign({}, data, { sent: true }));
  storeMsg(key, el); if (isCurrent) appendMsg(el);
});

socket.on('room-message', (data) => {
  const key = 'room:' + data.roomName;
  const isCurrent = currentMode === 'room' && currentTarget === data.roomName;
  const sent = data.fromSocketId === mySocketId;
  const el = makeBubble(Object.assign({}, data, { sent }));
  scheduleAutoDelete(el, data.autoDeleteMs);
  storeMsg(key, el); if (isCurrent) appendMsg(el);
  else if (!sent) showToast('💬 [' + data.roomName + '] ' + data.fromUsername + ': ' + data.message.substring(0, 50), 'info');
});

socket.on('room-file', (data) => {
  const key = 'room:' + data.roomName;
  const isCurrent = currentMode === 'room' && currentTarget === data.roomName;
  const sent = data.fromSocketId === mySocketId;
  const el = makeFileCard(Object.assign({}, data, { sent }));
  scheduleAutoDelete(el, data.autoDeleteMs);
  storeMsg(key, el); if (isCurrent) appendMsg(el);
  else if (!sent) showToast('📎 [' + data.roomName + '] ' + data.fromUsername + ': ' + data.fileName, 'file');
});

socket.on('room-system', (data) => {
  const key = 'room:' + data.roomName;
  const isCurrent = currentMode === 'room' && currentTarget === data.roomName;
  const el = document.createElement('div');
  el.className = 'sys-msg'; el.textContent = data.message;
  storeMsg(key, el); if (isCurrent) appendMsg(el);
});

socket.on('error-msg', (msg) => showToast('⚠️ ' + msg, 'warn'));

// ── Auto-delete ───────────────────────────────────────────────────────────────
function scheduleAutoDelete(el, ms) {
  if (!ms) return;
  // Show badge
  const footer = el.querySelector('.bubble-footer');
  if (footer) {
    const badge = document.createElement('span');
    badge.className = 'auto-delete-badge';
    badge.textContent = '⏱ ' + formatDuration(ms);
    footer.appendChild(badge);
  }
  setTimeout(() => {
    el.classList.add('fading');
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 500);
  }, ms);
}

// ── File upload ───────────────────────────────────────────────────────────────
const mainEl = document.querySelector('.main');
const dropOverlay = document.getElementById('dropOverlay');

mainEl.addEventListener('dragover', (e) => {
  if (!currentTarget) return;
  if (currentMode === 'room' && !(adminRooms.has(currentTarget) || (myRoomPerms[currentTarget] && myRoomPerms[currentTarget].canSendFile))) return;
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
  fill.style.width = '0%'; pct.textContent = '0%';
  pname.textContent = file.name.length > 40 ? file.name.substring(0, 38) + '…' : file.name;

  const form = new FormData();
  form.append('file', file);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/upload');

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      const p = Math.round((e.loaded / e.total) * 100);
      fill.style.width = p + '%'; pct.textContent = p + '%';
    }
  });

  xhr.addEventListener('load', () => {
    bar.style.display = 'none';
    if (xhr.status === 200) {
      const data = JSON.parse(xhr.responseText);
      if (currentMode === 'dm') {
        socket.emit('private-file', { toSocketId: currentTarget, fileId: data.fileId, fileName: file.name, fileSize: file.size });
      } else {
        socket.emit('room-file', { roomName: currentTarget, fileId: data.fileId, fileName: file.name, fileSize: file.size });
      }
    } else showToast('❌ Upload failed', 'warn');
  });
  xhr.addEventListener('error', () => { bar.style.display = 'none'; showToast('❌ Network error', 'warn'); });
  xhr.send(form);
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
function makeBubble({ fromUsername, message, sent, ts, autoDeleteMs }) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-bubble ' + (sent ? 'sent' : 'recv');
  const time = formatTime(ts || Date.now());
  if (!sent) wrap.innerHTML += '<div class="bubble-sender">' + esc(fromUsername) + '</div>';
  wrap.innerHTML += '<div class="bubble-body">' + esc(message) + '</div>';
  wrap.innerHTML += '<div class="bubble-footer"><span class="bubble-time">' + time + '</span></div>';
  return wrap;
}

function makeFileCard({ fromUsername, fileName, fileSize, downloadUrl, sent, ts }) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-bubble ' + (sent ? 'sent' : 'recv');
  const time = formatTime(ts || Date.now());
  if (!sent) wrap.innerHTML += '<div class="bubble-sender">' + esc(fromUsername) + '</div>';
  const card = document.createElement('div');
  card.className = 'bubble-body';
  card.style.cssText = 'padding:0;background:none;border:none;';
  card.innerHTML =
    '<div class="file-card">' +
      '<div class="file-icon">' + fileIcon(fileName) + '</div>' +
      '<div class="file-info">' +
        '<div class="file-name" title="' + esc(fileName) + '">' + esc(fileName) + '</div>' +
        '<div class="file-size-text">' + formatSize(fileSize) + '</div>' +
      '</div>' +
      '<a class="file-dl-btn" href="' + downloadUrl + '" download="' + esc(fileName) + '" target="_blank">↓ Save</a>' +
    '</div>';
  wrap.appendChild(card);
  wrap.innerHTML += '<div class="bubble-footer"><span class="bubble-time">' + time + '</span></div>';
  return wrap;
}

function storeMsg(key, el) {
  if (!messageHistory[key]) messageHistory[key] = [];
  messageHistory[key].push(el);
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

// ── Toasts ────────────────────────────────────────────────────────────────────
function showToast(text, type) {
  type = type || 'info';
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = text;
  c.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0'; t.style.transform = 'translateX(20px)';
    t.style.transition = 'opacity 0.3s, transform 0.3s';
    setTimeout(() => t.remove(), 350);
  }, 3500);
}

function pulseUser(sid) {
  const el = document.querySelector('.user-item[data-sid="' + sid + '"]');
  if (!el) return;
  el.style.background = 'rgba(108,99,255,0.25)';
  setTimeout(() => { el.style.background = ''; }, 1200);
}

// ── Utility ───────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function avatarChar(name) { return name ? name.charAt(0).toUpperCase() : '?'; }

const GRADS = [['#6c63ff','#8b5cf6'],['#06d6a0','#00b4d8'],['#f72585','#b5179e'],['#ffd166','#ef8c00'],['#2ec4b6','#3d405b'],['#e76f51','#f4a261']];
function avatarGrad(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  const [c1,c2] = GRADS[Math.abs(h) % GRADS.length];
  return 'background: linear-gradient(135deg, ' + c1 + ', ' + c2 + '); color: white;';
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatSize(b) {
  if (!b) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}

function formatDuration(ms) {
  const s = ms / 1000;
  if (s < 60) return s + 's';
  return (s / 60) + 'm';
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = { pdf:'📄', doc:'📝', docx:'📝', xls:'📊', xlsx:'📊', ppt:'📋', pptx:'📋', jpg:'🖼️', jpeg:'🖼️', png:'🖼️', gif:'🖼️', svg:'🖼️', webp:'🖼️', mp4:'🎬', mov:'🎬', avi:'🎬', mkv:'🎬', webm:'🎬', mp3:'🎵', wav:'🎵', flac:'🎵', zip:'📦', rar:'📦', '7z':'📦', tar:'📦', gz:'📦', js:'💻', ts:'💻', py:'🐍', html:'🌐', css:'🎨', json:'🗂️', txt:'📃', md:'📃', csv:'📊' };
  return map[ext] || '📁';
}
