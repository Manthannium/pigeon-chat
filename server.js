import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";

// ==================== Config ====================

const PORT = process.env.PORT || 3000;
const MAX_NAME_LENGTH = 20;
const MAX_MESSAGE_LENGTH = 500;
const MAX_MESSAGE_HISTORY = 100;
const ROOM_TTL_MS = 60 * 60 * 1000; // 1 hour
const LEAVE_GRACE_MS = 5000;
const CLIENT_DIR = fileURLToPath(new URL("client", import.meta.url));
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

// ==================== HTTP + Socket.IO setup ====================

const app = express();
app.use(express.static(CLIENT_DIR));

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: CLIENT_ORIGINS },
    maxHttpBufferSize: 10_000,
});

// ==================== In-memory store ====================

// roomCode -> {
//      createdAt, expiresAt,
//      users: Map<clientId, {username, sockerId}>,
//      messages: Array<{type, username?, text, time}>
// }

const rooms = new Map();
let totalRoomsCreated = 0;

// ==================== HTTP endpoints ====================

app.get("/ping", (_, res) => {
    res.type("text/plain").send("pong");
});

app.get("/status", (_, res) => {
    let userInRooms = 0;
    for(const room of rooms.values()) userInRooms += room.users.size;

    res.json({
        activeRooms: rooms.size,
        totalRoomsCreated,
        connectedSockets: io.of("/").sockets.size,
        userInRooms,
        uptimeSeconds: Math.round(process.uptime()),
    });
});

// ==================== Helper functions ====================

function generateRoomCode() {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let code;
    do {
        code = "";
        for(let i=0; i<4; i++) {
            code += letters[Math.floor(Math.random() * letters.length)];
        }
    } while(rooms.has(code));  // retry till you get unique code
    return code;
}

function clearText(value, maxLength) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function userList(room) {
    return [...room.users.values()].map((user) => user.username);
}

function saveMessage(room, message) {
    const msg = {...message, time: Date.now()};
    room.messages.push(msg);
    if(room.messages.length > MAX_MESSAGE_HISTORY) room.messages.shift();   // drop older messages
    return msg;
}

// same client can come back
function isNameTaken(room, username, clientId) {
    const wanted = username.toLowerCase();
    for(const [id, user] of room.users) {
        if(id !== clientId && user.username.toLowerCase() === wanted) return true;
    }
    return false;
}

// room of current socket. returns null for stale sockets
function activeRoom(socket) {
    const room = rooms.get(socket.data.room);
    const user = room?.users.get(socket.data.clientId);
    return user?.socketId === socket.id ? room : null;
}

function createRoom() {
    const code = generateRoomCode();
    const createdAt = Date.now();
    rooms.set(code, {
        createdAt,
        expiresAt: createdAt + ROOM_TTL_MS,
        users: new Map(),
        messages: [],
    });
    totalRoomsCreated++;

    setTimeout(() => closeRoom(code), ROOM_TTL_MS); 
    console.log(`room created: ${code}`);
    return code;
}

function closeRoom(code) {
    if(!rooms.has(code)) return;
    io.to(code).emit("left-room", { reason: `Room ${code} expired (rooms last 1 hr)`});
    io.in(code).socketsLeave(code);
    rooms.delete(code);
    console.log(`room ${code} expired`);
}

function joinRoom(socket, code, username, clientId) {
    // leave other room first (one socket, one room)
    if(socket.data.room && socket.data.room !== code) leaveRoom(socket);

    const room = rooms.get(code);
    const previous = room.users.get(clientId);

    room.users.set(clientId, {username, socketId: socket.id});
    socket.data.username = username;
    socket.data.room = code;
    socket.data.clientId = clientId;
    socket.join(code);

    if(previous) {
        // same person join back the chat (refresh / reconnect / duplicate tab) -> swap sockets quitely
        if(previous.socketId !== socket.id) {
            const oldSocket = io.of("/").sockets.get(previous.socketId);
            if(oldSocket) {
                oldSocket.leave(code);
                oldSocket.emit("left-room", { reason: "This chat was opened in other tab" });
            }
        }
        console.log(`${username} rejoined ${code}`);
    }
    else {
        const msg = saveMessage(room, { type: "system", text: `${username} joined`});
        socket.to(code).emit("chat-message", msg);
        console.log(`${username} joined ${code}`);
    }
    socket.to(code).emit("users", userList(room));

    return {
        ok: true,
        code,
        username,
        expiresAt: room.expiresAt,
        users: userList(room),
        messages: room.messages,
    };
}

// removes a user only if socketId is still their current socket
function removeUser(code, clientId, socketId) {
    const room = rooms.get(code);
    const user = room?.users.get(clientId);
    if(!user || user.socketId !== socketId) return; // already gone or came back on new socket

    room.users.delete(clientId);

    const msg = saveMessage(room, { type: "system", text: `${user.username} left` });
    io.to(code).emit("chat-message", msg);
    io.to(code).emit("users", userList(room));
    console.log(`${user.username} left ${code}`);
}  

// explicitely leave (leave button or switching rooms) -> immediate, no grace period
function leaveRoom(socket) {
    const { room: code, clientId } = socket.data;
    if(!code) return;

    socket.leave(code);
    socket.data.room = null;
    removeUser(code, clientId, socket.id);
}

// ==================== Socket Handlers ====================

io.on("connection", (socket) => {
    console.log(`connected: ${socket.id}`);

    socket.on("create-room", (payload, ack) => {
        if(typeof ack !== "function") return;

        const username = clearText(payload?.username, MAX_NAME_LENGTH);
        const clientId = clearText(payload?.clientId, 64);
        if(!username) return ack({ ok: false, error: "username required"});
        if(!clientId) return ack({ ok: false, error: "missing client ID, please refresh"});

        const code = createRoom();
        ack(joinRoom(socket, code, username, clientId));
    });

    socket.on("join-room", (payload, ack) => {
        if(typeof ack !== "function") return;

        const username = clearText(payload?.username, MAX_NAME_LENGTH);
        const clientId = clearText(payload?.clientId, 64);
        const code = clearText(payload?.code, 4).toUpperCase();
        const room = rooms.get(code);

        if(!username) return ack({ ok: false, error: "username required"});
        if(!clientId) return ack({ ok: false, error: "missing client ID, please refresh"});
        if(!room) return ack({ ok: false, error: `Room ${code} not found or expired`});
        if(isNameTaken(room, username, clientId)) {
            return ack({ ok: false, error: `username ${username} is already taken in this room`});
        }
        ack(joinRoom(socket, code, username, clientId));
    });

    socket.on("leave-room", () => leaveRoom(socket));

    socket.on("chat-message", (text) => {
        const room = activeRoom(socket);
        const clean = clearText(text, MAX_MESSAGE_LENGTH);
        if(!room || !clean) return;

        const msg = saveMessage(room, {
            type: "chat",
            username: socket.data.username,
            text: clean,
        });
        io.to(socket.data.room).emit("chat-message", msg); // everyone including sender
    });

    socket.on("disconnect", (reason) => {
        console.log(`disconnected ${socket.id} (${reason})`);

        // give user few seconds to comeback (refresh / network blip)
        const { room: code, clientId } = socket.data;
        if(code) {
            setTimeout(() => removeUser(code, clienId, socket.id), LEAVE_GRACE_MS);
        } 
    });
});

// ==================== Spin-up the server ====================

httpServer.listen(PORT, () => {
    console.log(`pigeon chat server running at http://localhost:${PORT}`);
    console.log(`Allowed client origins: ${CLIENT_ORIGINS.join(", ")}`);
});

