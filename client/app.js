// ==================== Configs ====================

const PRODUCTION_SERVER_URL = "https://pigeon-chat.onrender.com";
const SERVER_URL = location.port === "3000" ? location.origin : PRODUCTION_SERVER_URL;
const socket = io(SERVER_URL);
const store = sessionStorage; // sessionStorage survives refresh and is separate per tab, localStorage survives closing the browser
const CLIENT_ID_KEY = "pigeon-client-id";
const SESSION_KEY = "pigeon-session";

// ==================== Helper functions ====================

function getClientid() {
    let id = store.getItem(CLIENT_ID_KEY);
    if(!id) {
        id = crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        store.setItem(CLIENT_ID_KEY, id);
    }
    return id;
}

function saveSession(session) {
    store.setItem(SESSION_KEY, JSON.stringify(session));
}

function loadSession() {
    try {
        return JSON.parse(store.getItem(SESSION_KEY));
    } catch {
        return null;
    }
}

function clearSession() {
    store.removeItem(SESSION_KEY);
}

const clientId = getClientid();

// ==================== Elements ====================

const lobbyEl = document.getElementById("lobby");
const roomEl = document.getElementById("room");
const usernameInput = document.getElementById("username");
const codeInput = document.getElementById("code-input");
const createBtn = document.getElementById("create-btn");
const joinBtn = document.getElementById("join-btn");
const errorEl = document.getElementById("error");
const roomCodeEl = document.getElementById("room-code");
const roomExpiryEl = document.getElementById("room-expiry");
const leaveBtn = document.getElementById("leave-btn");
const userListEl = document.getElementById("user-list");
const messagesEl = document.getElementById("messages");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");

// ==================== Rendering ====================

function showError(text) {
    errorEl.textContent = text;
}

function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isInRoom() {
    return !roomEl.classList.contains("hidden")
}

function renderUsers(users) {
    userListEl.innerHTML = "";
    for(const name of users) {
        const li = document.createElement("li");
        li.textContent = name;
        userListEl.appendChild(li);
    }
}

function renderMessage(msg) {
    const li = document.createElement("li");
    const time = formatTime(msg.time);

    if(msg.type === "system") {
        li.className = "system";
        li.textContent = `[${time}]  ${msg.text}`;
    }
    else {
        const name = document.createElement("b");
        name.textContent = `${msg.username} : `;
        li.append(`[${time}]  `, name, msg.text);
    }

    messagesEl.appendChild(li);
    messagesEl.scrollTop = messagesEl.scrollHeight;  // auto scroll to newest
}

function enterRoom({ code, username, expiresAt, users, messages }) {
    saveSession({ username, code });  // remember for refresh / reconnect
    
    lobbyEl.classList.add("hidden");
    roomEl.classList.remove("hidden");
    roomCodeEl.textContent = code;
    roomExpiryEl.textContent = `(closes at ${formatTime(expiresAt)})`;
    renderUsers(users);
    messagesEl.innerHTML = ""; // full history comes from server so missed messages appear after a reconnect
    messages.forEach(renderMessage);
    showError("");
    messageInput.focus();
}

function showLobby(error = "") {
    roomEl.classList.add("hidden");
    lobbyEl.classList.remove("hidden");
    messagesEl.innerHTML = "";
    userListEl.innerHTML = "";
    showError(error);
}

// shared handler for create/join acks
function handleRoomResponse(res) {
    if(!res.ok) return showError(res.error);
    enterRoom(res);
}

function getUsername() {
    const username = usernameInput.value.trim();
    if(!username) showError("Please enter a username");
    return username;
}

// ==================== Socket functions ====================

// rejoin the saved room if any
function rejoinSavedRoom() {
    const session = loadSession();
    if(!session) return;

    socket.emit("join-room", {...session, clientId }, (res) => {
        if(res.ok) return enterRoom(res);
        clearSession(); // room expired, server restarted or name taken while you were away
        showLobby(res.error);
    });
}

// ==================== Lobby actions ====================

createBtn.addEventListener("click", () => {
    const username = getUsername();
    if(!username) return;
    socket.emit("create-room", { username, clientId }, handleRoomResponse);
});

joinBtn.addEventListener("click", () => {
    const username = getUsername();
    if(!username) return;

    const code = codeInput.value.trim().toUpperCase();
    if(!/^[A-Z]{4}$/.test(code)) return showError("Room code must be 4 letters");
    socket.emit("join-room", { username, code, clientId }, handleRoomResponse);
});

// ==================== Room action ====================

leaveBtn.addEventListener("click", () => {
    socket.emit("leave-room");
    clearSession();
    showLobby();
});

messageForm.addEventListener("submit", (e) => {
    e.preventDefault(); // stop the page from reloading
    const text = messageInput.value.trim();
    if(!text) return;
    socket.emit("chat-message", text);
    messageInput.value = "";
});

// ==================== Connection lifecycle ====================

// connect fires on first connection AND after every automatic reconnect
socket.on("connect", () => {
    if(!loadSession()) showError("");
    rejoinSavedRoom();
});

socket.on("disconnect", () => {
    if(isInRoom()) {
        renderMessage({ type: "system", text: "Connection lost. Reconnecting...", time: Date.now() });
    }
});

socket.on("connect_error", () => {
    // also shown while a sleeping render instance wakes up
    if(!isInRoom()) showError("Can't reach the server. Retrying...");
});

// ==================== Server events ====================

socket.on("chat-message", renderMessage);
socket.on("users", renderUsers);

// room expired or this session was opened in other tab
socket.on("left-room", ({ reason }) => {
    clearSession();
    showLobby(reason);
});

// ==================== Startup ====================

const saved = loadSession();
if(saved) {
    usernameInput.value = saved.username;
    showError("Reconnecting to your room...");
}
