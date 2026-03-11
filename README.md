# ⚡ FileShare — Real-time File Sharing App

A real-time web application for sharing files and messages — supports **1-to-1** (private direct messages) and **1-to-many** (room broadcast) transfers.

## 🛠️ Tech Stack

### Backend
| | Library |
|---|---|
| Runtime | Node.js |
| HTTP Server | Express.js |
| Real-time | Socket.io |
| File Upload | Multer |
| File IDs | uuid |

### Frontend
| | Technology |
|---|---|
| Structure | Vanilla HTML5 |
| Styling | Vanilla CSS3 (glassmorphism dark theme) |
| Logic | Vanilla JavaScript (ES6) |
| Real-time | Socket.io client |
| Fonts | Google Fonts — Inter |

---

## 🚀 Getting Started

### Prerequisites
- Node.js (v12 or higher)
- npm

### Installation

```bash
# Clone the repository
git clone https://github.com/krishjain-2301/cn_lab_project.git
cd cn_lab_project

# Install dependencies
npm install

# Start the server
node server.js
```

Then open **http://localhost:3000** in your browser.

---

## 📂 Project Structure

```
file-share-app/
├── server.js           # Express + Socket.io server
├── package.json
├── uploads/            # Temporary uploaded files (auto-created)
└── public/
    ├── index.html      # Landing / login page
    ├── landing.css     # Landing page styles
    ├── app.html        # Main dashboard
    ├── app.css         # Dashboard styles
    └── app.js          # Client-side Socket.io logic
```

---

## ✨ Features

- **1-to-1 Private Chat** — Send messages and files directly to any online user
- **Room Broadcast (1-to-many)** — Create or join rooms; everything you send goes to all members
- **File Sharing** — Upload files up to **500 MB** with a real-time progress bar
- **Drag & Drop** — Drop a file onto the chat window to send instantly
- **Live User List** — See who's online in real time
- **Toast Notifications** — Get alerted when you receive a message or file while in another chat
- **No account required** — Just enter a display name and go

---

## 📡 Socket.io Events

| Event | Direction | Description |
|---|---|---|
| `register` | Client → Server | Set display name |
| `user-list` | Server → Client | Updated list of online users |
| `room-list` | Server → Client | Updated list of rooms |
| `private-message` | Client ↔ Server | 1-to-1 text message |
| `private-file` | Client ↔ Server | 1-to-1 file notification |
| `create-room` | Client → Server | Create a new room |
| `join-room` | Client → Server | Join an existing room |
| `leave-room` | Client → Server | Leave a room |
| `room-message` | Client ↔ Server | Broadcast text to room |
| `room-file` | Client ↔ Server | Broadcast file to room |

---

## 📸 Screenshots

### Landing Page
> Premium dark-mode entry screen with username input

### Dashboard
> Sidebar with live users & rooms, chat pane with file cards and progress bar

---

*Built as a CN Lab Project — demonstrating real-time WebSocket communication and file transfer over HTTP.*
