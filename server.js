const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e8 // 100MB for socket transfers
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- File storage ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const fileMetaStore = {}; // id -> { originalName, path, size, uploader }

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname);
    cb(null, `${id}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// --- REST: Upload ---
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const id = path.parse(req.file.filename).name;
  fileMetaStore[id] = {
    originalName: req.file.originalname,
    storedName: req.file.filename,
    filePath: req.file.path,
    size: req.file.size,
    mimetype: req.file.mimetype
  };
  res.json({ fileId: id, downloadUrl: `/file/${id}` });
});

// --- REST: Download ---
app.get('/file/:id', (req, res) => {
  const meta = fileMetaStore[req.params.id];
  if (!meta) return res.status(404).send('File not found');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(meta.originalName)}"`);
  res.setHeader('Content-Type', meta.mimetype || 'application/octet-stream');
  res.setHeader('Content-Length', meta.size);
  fs.createReadStream(meta.filePath).pipe(res);
});

// --- In-memory state ---
const users = {};   // socketId -> { username, socketId }
const rooms = {};   // roomName -> Set<socketId>

function broadcastUserList() {
  const userList = Object.values(users).map(u => ({ username: u.username, socketId: u.socketId }));
  io.emit('user-list', userList);
}

function broadcastRoomList() {
  const roomList = Object.keys(rooms).map(name => ({
    name,
    members: [...rooms[name]].map(sid => users[sid] && users[sid].username).filter(Boolean)
  }));
  io.emit('room-list', roomList);
}

// --- Socket.io ---
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // Register user with a username
  socket.on('register', (username) => {
    const cleanName = String(username).trim().substring(0, 32) || `User_${socket.id.substring(0, 4)}`;
    users[socket.id] = { username: cleanName, socketId: socket.id };
    socket.emit('registered', { username: cleanName, socketId: socket.id });
    broadcastUserList();
    broadcastRoomList();
    console.log(`[register] ${cleanName} (${socket.id})`);
  });

  // ---- 1-to-1 ----
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
      fileId, fileName, fileSize,
      downloadUrl: `/file/${fileId}`,
      type: 'file', ts: Date.now()
    };
    io.to(toSocketId).emit('private-file', payload);
    socket.emit('private-file-echo', payload);
  });

  // ---- Rooms (1-to-many) ----
  socket.on('create-room', (roomName) => {
    const name = String(roomName).trim().substring(0, 40);
    if (!name) return;
    if (!rooms[name]) rooms[name] = new Set();
    rooms[name].add(socket.id);
    socket.join(name);
    socket.emit('room-joined', { roomName: name });
    broadcastRoomList();
    console.log('[create-room] ' + name + ' by ' + (users[socket.id] && users[socket.id].username));
  });

  socket.on('join-room', (roomName) => {
    if (!rooms[roomName]) return socket.emit('error-msg', 'Room does not exist');
    rooms[roomName].add(socket.id);
    socket.join(roomName);
    const from = users[socket.id];
    socket.emit('room-joined', { roomName });
    io.to(roomName).emit('room-system', { roomName, message: (from && from.username) + ' joined the room', ts: Date.now() });
    broadcastRoomList();
  });

  socket.on('leave-room', (roomName) => {
    if (!rooms[roomName]) return;
    rooms[roomName].delete(socket.id);
    socket.leave(roomName);
    if (rooms[roomName] && rooms[roomName].size === 0) delete rooms[roomName];
    const from = users[socket.id];
    if (rooms[roomName]) {
      io.to(roomName).emit('room-system', { roomName, message: (from && from.username) + ' left the room', ts: Date.now() });
    }
    socket.emit('room-left', { roomName });
    broadcastRoomList();
  });

  socket.on('room-message', ({ roomName, message }) => {
    const from = users[socket.id];
    if (!from || !rooms[roomName] || !rooms[roomName].has(socket.id)) return;
    const payload = { fromSocketId: socket.id, fromUsername: from.username, message, type: 'text', roomName, ts: Date.now() };
    io.to(roomName).emit('room-message', payload);
  });

  socket.on('room-file', ({ roomName, fileId, fileName, fileSize }) => {
    const from = users[socket.id];
    if (!from || !rooms[roomName] || !rooms[roomName].has(socket.id)) return;
    const payload = {
      fromSocketId: socket.id, fromUsername: from.username,
      fileId, fileName, fileSize,
      downloadUrl: `/file/${fileId}`,
      type: 'file', roomName, ts: Date.now()
    };
    io.to(roomName).emit('room-file', payload);
  });

  // ---- Disconnect ----
  socket.on('disconnect', () => {
    const user = users[socket.id];
    console.log('[disconnect] ' + (user ? user.username : socket.id));
    // Remove from all rooms
    for (const [name, members] of Object.entries(rooms)) {
      if (members.has(socket.id)) {
        members.delete(socket.id);
        if (rooms[name] && members.size === 0) delete rooms[name];
      }
    }
    delete users[socket.id];
    broadcastUserList();
    broadcastRoomList();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✅  FileShare running at http://localhost:${PORT}\n`);
});
