const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const cors = require('cors');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e8,
  transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── File storage ──────────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const fileMetaStore = {};

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname);
    cb(null, id + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const id = path.parse(req.file.filename).name;
  fileMetaStore[id] = {
    originalName: req.file.originalname,
    filePath: req.file.path,
    size: req.file.size,
    mimetype: req.file.mimetype
  };
  res.json({ fileId: id, downloadUrl: '/file/' + id });
});

app.get('/file/:id', (req, res) => {
  const meta = fileMetaStore[req.params.id];
  if (!meta) return res.status(404).send('File not found');
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(meta.originalName) + '"');
  res.setHeader('Content-Type', meta.mimetype || 'application/octet-stream');
  res.setHeader('Content-Length', meta.size);
  fs.createReadStream(meta.filePath).pipe(res);
});

// ── In-memory state ───────────────────────────────────────────────────────────
const users = {};   // socketId -> { username, socketId }

/*
  rooms[name] = {
    admin: socketId,
    members: Set<socketId>,
    pending: Set<socketId>,           // awaiting admin approval
    permissions: {                    // per-member permissions
      [socketId]: { canMessage: bool, canSendFile: bool }
    },
    autoDeleteMs: null | number,      // null = permanent
    settings: { allowJoin: bool }     // admin toggle: open/closed
  }
*/
const rooms = {};

// ── Helpers ───────────────────────────────────────────────────────────────────
function broadcastUserList() {
  const list = Object.values(users).map(u => ({ username: u.username, socketId: u.socketId }));
  io.emit('user-list', list);
}

function broadcastRoomList() {
  const list = Object.keys(rooms).map(name => {
    const r = rooms[name];
    return {
      name,
      admin: r.admin,
      adminName: (users[r.admin] && users[r.admin].username) || '?',
      memberCount: r.members.size,
      members: [...r.members].map(sid => ({
        socketId: sid,
        username: (users[sid] && users[sid].username) || '?',
        permissions: r.permissions[sid] || { canMessage: true, canSendFile: true }
      })),
      autoDeleteMs: r.autoDeleteMs,
      allowJoin: r.settings.allowJoin
    };
  });
  io.emit('room-list', list);
}

function defaultPerms() {
  return { canMessage: true, canSendFile: true };
}

function isAdmin(roomName, socketId) {
  return rooms[roomName] && rooms[roomName].admin === socketId;
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[connect] ' + socket.id);

  // Register
  socket.on('register', (username) => {
    const name = String(username).trim().substring(0, 32) || ('User_' + socket.id.substring(0, 4));
    users[socket.id] = { username: name, socketId: socket.id };
    socket.emit('registered', { username: name, socketId: socket.id });
    broadcastUserList();
    broadcastRoomList();
    console.log('[register] ' + name);
  });

  // ── 1-to-1 ──────────────────────────────────────────────────────────────────
  socket.on('private-message', ({ toSocketId, message }) => {
    const from = users[socket.id];
    if (!from || !users[toSocketId]) return;
    const payload = { fromSocketId: socket.id, fromUsername: from.username, message, type: 'text', ts: Date.now() };
    io.to(toSocketId).emit('private-message', payload);
    socket.emit('private-message-echo', payload);
  });

  socket.on('private-file', ({ toSocketId, fileId, fileName, fileSize }) => {
    const from = users[socket.id];
    if (!from || !users[toSocketId]) return;
    const payload = {
      fromSocketId: socket.id, fromUsername: from.username,
      fileId, fileName, fileSize, downloadUrl: '/file/' + fileId,
      type: 'file', ts: Date.now()
    };
    io.to(toSocketId).emit('private-file', payload);
    socket.emit('private-file-echo', payload);
  });

  // ── Room creation ────────────────────────────────────────────────────────────
  socket.on('create-room', (roomName) => {
    const name = String(roomName).trim().substring(0, 40);
    if (!name) return;
    if (rooms[name]) return socket.emit('error-msg', 'Room already exists');
    rooms[name] = {
      admin: socket.id,
      members: new Set([socket.id]),
      pending: new Set(),
      permissions: { [socket.id]: { canMessage: true, canSendFile: true } },
      autoDeleteMs: null,
      settings: { allowJoin: true }
    };
    socket.join(name);
    socket.emit('room-joined', { roomName: name, isAdmin: true, permissions: defaultPerms() });
    broadcastRoomList();
    console.log('[create-room] ' + name + ' by ' + (users[socket.id] && users[socket.id].username));
  });

  // ── Join request (goes to admin first) ──────────────────────────────────────
  socket.on('join-room', (roomName) => {
    const room = rooms[roomName];
    if (!room) return socket.emit('error-msg', 'Room does not exist');
    if (room.members.has(socket.id)) return; // already in
    if (!room.settings.allowJoin) return socket.emit('error-msg', 'This room is not accepting new members');

    const from = users[socket.id];
    const fromName = from ? from.username : socket.id;

    // Admin is the creator — notify them with a join request
    room.pending.add(socket.id);
    io.to(room.admin).emit('join-request', {
      roomName,
      socketId: socket.id,
      username: fromName
    });
    // Tell requester they are pending
    socket.emit('join-pending', { roomName });
    console.log('[join-request] ' + fromName + ' -> ' + roomName);
  });

  // ── Admin: approve join ──────────────────────────────────────────────────────
  socket.on('approve-join', ({ roomName, socketId }) => {
    const room = rooms[roomName];
    if (!room || !isAdmin(roomName, socket.id)) return;
    if (!room.pending.has(socketId)) return;

    room.pending.delete(socketId);
    room.members.add(socketId);
    room.permissions[socketId] = defaultPerms();

    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
      targetSocket.join(roomName);
      targetSocket.emit('room-joined', {
        roomName,
        isAdmin: false,
        permissions: room.permissions[socketId]
      });
    }

    const name = users[socketId] && users[socketId].username;
    io.to(roomName).emit('room-system', { roomName, message: (name || socketId) + ' joined the room', ts: Date.now() });
    broadcastRoomList();
  });

  // ── Admin: reject join ───────────────────────────────────────────────────────
  socket.on('reject-join', ({ roomName, socketId }) => {
    const room = rooms[roomName];
    if (!room || !isAdmin(roomName, socket.id)) return;
    room.pending.delete(socketId);
    const target = io.sockets.sockets.get(socketId);
    if (target) target.emit('join-rejected', { roomName });
  });

  // ── Admin: set per-user permissions ─────────────────────────────────────────
  socket.on('set-permissions', ({ roomName, targetSocketId, canMessage, canSendFile }) => {
    const room = rooms[roomName];
    if (!room || !isAdmin(roomName, socket.id)) return;
    if (!room.members.has(targetSocketId)) return;
    room.permissions[targetSocketId] = { canMessage, canSendFile };
    // Notify the affected member of their new permissions
    const target = io.sockets.sockets.get(targetSocketId);
    if (target) target.emit('permissions-updated', { roomName, canMessage, canSendFile });
    // Notify all members so admin panel updates
    broadcastRoomList();
    const tName = users[targetSocketId] && users[targetSocketId].username;
    const perms = (canMessage ? 'msg ✓' : 'msg ✗') + ' ' + (canSendFile ? 'file ✓' : 'file ✗');
    io.to(roomName).emit('room-system', {
      roomName,
      message: 'Admin updated permissions for ' + (tName || targetSocketId) + ': ' + perms,
      ts: Date.now()
    });
  });

  // ── Admin: update room settings ──────────────────────────────────────────────
  socket.on('update-room-settings', ({ roomName, autoDeleteMs, allowJoin }) => {
    const room = rooms[roomName];
    if (!room || !isAdmin(roomName, socket.id)) return;
    if (autoDeleteMs !== undefined) room.autoDeleteMs = autoDeleteMs;
    if (allowJoin !== undefined) room.settings.allowJoin = allowJoin;
    // Broadcast new settings to all room members
    io.to(roomName).emit('room-settings-updated', {
      roomName,
      autoDeleteMs: room.autoDeleteMs,
      allowJoin: room.settings.allowJoin
    });
    broadcastRoomList();
    const delLabel = room.autoDeleteMs ? (room.autoDeleteMs / 1000) + 's auto-delete' : 'permanent messages';
    const joinLabel = room.settings.allowJoin ? 'open to new members' : 'closed to new members';
    io.to(roomName).emit('room-system', {
      roomName,
      message: 'Room settings updated: ' + delLabel + ', ' + joinLabel,
      ts: Date.now()
    });
  });

  // ── Admin: kick member ───────────────────────────────────────────────────────
  socket.on('kick-member', ({ roomName, targetSocketId }) => {
    const room = rooms[roomName];
    if (!room || !isAdmin(roomName, socket.id)) return;
    if (targetSocketId === socket.id) return; // can't kick self
    if (!room.members.has(targetSocketId)) return;

    room.members.delete(targetSocketId);
    delete room.permissions[targetSocketId];

    const target = io.sockets.sockets.get(targetSocketId);
    if (target) {
      target.leave(roomName);
      target.emit('room-left', { roomName, reason: 'kicked' });
    }
    const tName = users[targetSocketId] && users[targetSocketId].username;
    io.to(roomName).emit('room-system', { roomName, message: (tName || targetSocketId) + ' was removed from the room', ts: Date.now() });
    broadcastRoomList();
  });

  // ── Room messaging ───────────────────────────────────────────────────────────
  socket.on('room-message', ({ roomName, message }) => {
    const from = users[socket.id];
    const room = rooms[roomName];
    if (!from || !room || !room.members.has(socket.id)) return;

    // Check permission (admin always can)
    const perms = room.permissions[socket.id] || defaultPerms();
    if (!isAdmin(roomName, socket.id) && !perms.canMessage) {
      return socket.emit('error-msg', 'You do not have permission to send messages in this room');
    }

    const payload = {
      fromSocketId: socket.id, fromUsername: from.username,
      message, type: 'text', roomName,
      autoDeleteMs: room.autoDeleteMs,
      ts: Date.now(),
      msgId: uuidv4()
    };
    io.to(roomName).emit('room-message', payload);
  });

  socket.on('room-file', ({ roomName, fileId, fileName, fileSize }) => {
    const from = users[socket.id];
    const room = rooms[roomName];
    if (!from || !room || !room.members.has(socket.id)) return;

    const perms = room.permissions[socket.id] || defaultPerms();
    if (!isAdmin(roomName, socket.id) && !perms.canSendFile) {
      return socket.emit('error-msg', 'You do not have permission to send files in this room');
    }

    const payload = {
      fromSocketId: socket.id, fromUsername: from.username,
      fileId, fileName, fileSize, downloadUrl: '/file/' + fileId,
      type: 'file', roomName,
      autoDeleteMs: room.autoDeleteMs,
      ts: Date.now(),
      msgId: uuidv4()
    };
    io.to(roomName).emit('room-file', payload);
  });

  // ── Leave room ───────────────────────────────────────────────────────────────
  socket.on('leave-room', (roomName) => {
    const room = rooms[roomName];
    if (!room) return;
    const from = users[socket.id];

    if (isAdmin(roomName, socket.id)) {
      // Admin leaves → dissolve room
      io.to(roomName).emit('room-dissolved', { roomName, message: 'The room was closed by the admin.' });
      [...room.members].forEach(sid => {
        const s = io.sockets.sockets.get(sid);
        if (s) s.leave(roomName);
      });
      delete rooms[roomName];
    } else {
      room.members.delete(socket.id);
      delete room.permissions[socket.id];
      socket.leave(roomName);
      if (room.members.size === 0) delete rooms[roomName];
      else {
        io.to(roomName).emit('room-system', {
          roomName,
          message: (from && from.username) + ' left the room',
          ts: Date.now()
        });
      }
      socket.emit('room-left', { roomName });
    }
    broadcastRoomList();
  });

  // ── Disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const user = users[socket.id];
    console.log('[disconnect] ' + (user ? user.username : socket.id));

    for (const name of Object.keys(rooms)) {
      const room = rooms[name];
      if (!room) continue;
      room.pending.delete(socket.id);

      if (room.members.has(socket.id)) {
        if (room.admin === socket.id) {
          // Admin disconnected — dissolve room
          io.to(name).emit('room-dissolved', { roomName: name, message: 'The admin disconnected. Room closed.' });
          [...room.members].forEach(sid => {
            const s = io.sockets.sockets.get(sid);
            if (s) s.leave(name);
          });
          delete rooms[name];
        } else {
          room.members.delete(socket.id);
          delete room.permissions[socket.id];
          if (room.members.size === 0) delete rooms[name];
          else {
            io.to(name).emit('room-system', {
              roomName: name,
              message: (user ? user.username : socket.id) + ' disconnected',
              ts: Date.now()
            });
          }
        }
      }
    }

    delete users[socket.id];
    broadcastUserList();
    broadcastRoomList();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n✅  FileShare running at http://localhost:' + PORT + '\n');
});
