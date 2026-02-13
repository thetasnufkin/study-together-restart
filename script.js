let CONFIG = {
  WORK_MINUTES: 20,
  BREAK_MINUTES: 5,
};

let state = {
  odId: null,
  nickname: "",
  roomId: null,
  isHost: false,
  participants: new Map(),
  isBreak: false,
  remainingSeconds: CONFIG.WORK_MINUTES * 60,
  isPaused: true,
  isMuted: false,
  currentCycle: 0,
  peer: null,
  connections: new Map(),
  localStream: null,
  audioContext: null,
  analyser: null,
  firebaseApp: null,
  database: null,
  roomRef: null,
  heartbeatInterval: null,
  hostTimerInterval: null,
};

window.addEventListener("DOMContentLoaded", () => {
  initApp();
  document.getElementById("settingsModal").addEventListener("click", (e) => {
    if (e.target.id === "settingsModal") {
      toggleSettings();
    }
  });
});

async function initApp() {
  updateConnectionStatus("connecting", "Firebase に接続中...");
  setJoinButtonsDisabled(true);

  const ready = await waitForFirebaseApp(8000);
  if (!ready) {
    updateConnectionStatus("error", "Firebase 初期化に失敗");
    showNotification("Firebase Hosting 上で公開してからアクセスしてください", true);
    return;
  }

  state.firebaseApp = firebase.app();
  state.database = firebase.database();
  updateConnectionStatus("connected", "Firebase 接続済み");
  setJoinButtonsDisabled(false);

  const params = new URLSearchParams(window.location.search);
  const roomIdFromUrl = params.get("room");
  if (roomIdFromUrl) {
    document.getElementById("roomId").value = roomIdFromUrl.toUpperCase();
  }
}

function waitForFirebaseApp(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (window.firebase && firebase.apps && firebase.apps.length > 0) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
}

function setJoinButtonsDisabled(disabled) {
  document.getElementById("joinBtn").disabled = disabled;
  document.getElementById("createBtn").disabled = disabled;
}

function generateId(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function showNotification(message, isError = false) {
  const el = document.getElementById("notification");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 3000);
}

function updateConnectionStatus(status, text) {
  const dot = document.getElementById("connectionDot");
  const textEl = document.getElementById("connectionText");

  dot.className = "connection-dot";
  if (status === "connected") dot.classList.add("connected");
  if (status === "error") dot.classList.add("error");
  textEl.textContent = text;
}

function updateTimerDisplay() {
  document.getElementById("timerDisplay").textContent = formatTime(state.remainingSeconds);

  const totalSeconds = state.isBreak ? CONFIG.BREAK_MINUTES * 60 : CONFIG.WORK_MINUTES * 60;
  const progress = totalSeconds > 0 ? state.remainingSeconds / totalSeconds : 0;

  const circumference = 2 * Math.PI * 130;
  const offset = circumference * (1 - progress);

  const circle = document.getElementById("progressCircle");
  circle.style.strokeDashoffset = offset;
  circle.classList.toggle("work", !state.isBreak);

  const badge = document.getElementById("statusBadge");
  badge.textContent = state.isBreak ? "休憩中" : "作業中";
  badge.className = `status-badge ${state.isBreak ? "status-break" : "status-work"}`;

  document.getElementById("timerLabel").textContent = state.isBreak ? "休憩タイム" : "作業タイム";
}

function updateCycleIndicator() {
  const container = document.getElementById("cycleIndicator");
  container.innerHTML = "";

  for (let i = 0; i < 4; i += 1) {
    const dot = document.createElement("div");
    dot.className = "cycle-dot";
    if (i < state.currentCycle) dot.classList.add("completed");
    if (i === state.currentCycle) dot.classList.add("current");
    container.appendChild(dot);
  }
}

function updateParticipantList() {
  const list = document.getElementById("participantList");
  list.innerHTML = "";

  state.participants.forEach((data, pId) => {
    const div = document.createElement("div");
    div.className = "participant";
    div.id = `participant-${pId}`;

    const isOnline = data.lastSeen && Date.now() - data.lastSeen < 15000;
    div.innerHTML = `
      <span class="participant-dot ${isOnline ? "" : "offline"}"></span>
      <span>${data.nickname}${pId === state.odId ? " (あなた)" : ""}</span>
    `;
    list.appendChild(div);
  });

  document.getElementById("participantCount").textContent = String(state.participants.size);
}

function updateCallUI() {
  const callUI = document.getElementById("callUI");
  callUI.classList.toggle("active", state.isBreak);
}

function showMainScreen() {
  document.getElementById("joinScreen").classList.remove("active");
  document.getElementById("mainScreen").classList.add("active");
  document.getElementById("roomCodeDisplay").textContent = state.roomId;
  updateHostControls();
}

function updateHostControls() {
  const hostControls = document.getElementById("hostControls");
  if (!hostControls) return;

  hostControls.classList.toggle("active", state.isHost);
  if (!state.isHost) return;

  const startStopBtn = document.getElementById("hostStartStopBtn");
  const skipBtn = document.getElementById("hostSkipBtn");
  if (startStopBtn) {
    startStopBtn.textContent = state.isPaused ? "開始" : "停止";
  }
  if (skipBtn) {
    skipBtn.disabled = state.isBreak;
  }
}

function syncHostTimerToDb() {
  if (!state.isHost || !state.roomRef) return;
  state.roomRef.child("timer").update({
    remainingSeconds: state.remainingSeconds,
    isBreak: state.isBreak,
    isPaused: state.isPaused,
    currentCycle: state.currentCycle,
    lastUpdate: firebase.database.ServerValue.TIMESTAMP,
  });
}

async function createRoom() {
  if (!state.database) {
    showNotification("Firebase 接続が完了していません", true);
    return;
  }

  const nickname = document.getElementById("nickname").value.trim();
  if (!nickname) {
    showNotification("ニックネームを入力してください", true);
    return;
  }

  state.nickname = nickname.slice(0, 10);
  state.roomId = generateId();
  state.odId = generateId(10);
  state.isHost = true;
  state.isPaused = true;
  state.isBreak = false;
  state.currentCycle = 0;
  state.remainingSeconds = CONFIG.WORK_MINUTES * 60;

  await initializeRoom();
}

async function joinRoom() {
  if (!state.database) {
    showNotification("Firebase 接続が完了していません", true);
    return;
  }

  const nickname = document.getElementById("nickname").value.trim();
  const roomId = document.getElementById("roomId").value.trim().toUpperCase();

  if (!nickname) {
    showNotification("ニックネームを入力してください", true);
    return;
  }
  if (!roomId) {
    showNotification("ルームIDを入力してください", true);
    return;
  }

  const roomSnapshot = await state.database.ref(`rooms/${roomId}`).once("value");
  if (!roomSnapshot.exists()) {
    showNotification("ルームが見つかりません", true);
    return;
  }

  state.nickname = nickname.slice(0, 10);
  state.roomId = roomId;
  state.odId = generateId(10);
  state.isHost = false;

  await initializeRoom();
}

async function initializeRoom() {
  state.roomRef = state.database.ref(`rooms/${state.roomId}`);

  if (state.isHost) {
    await state.roomRef.set({
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      hostId: state.odId,
      timer: {
        remainingSeconds: state.remainingSeconds,
        isBreak: false,
        isPaused: true,
        lastUpdate: firebase.database.ServerValue.TIMESTAMP,
        currentCycle: 0,
      },
      settings: {
        workMinutes: CONFIG.WORK_MINUTES,
        breakMinutes: CONFIG.BREAK_MINUTES,
      },
    });
  } else {
    const settingsSnapshot = await state.roomRef.child("settings").once("value");
    const settings = settingsSnapshot.val();
    if (settings) {
      CONFIG.WORK_MINUTES = settings.workMinutes;
      CONFIG.BREAK_MINUTES = settings.breakMinutes;
    }
  }

  const participantRef = state.roomRef.child(`participants/${state.odId}`);
  await participantRef.set({
    nickname: state.nickname,
    joinedAt: firebase.database.ServerValue.TIMESTAMP,
    lastSeen: firebase.database.ServerValue.TIMESTAMP,
    peerId: state.odId,
  });
  participantRef.onDisconnect().remove();

  if (state.heartbeatInterval) clearInterval(state.heartbeatInterval);
  state.heartbeatInterval = setInterval(() => {
    if (state.roomRef) {
      participantRef.update({ lastSeen: firebase.database.ServerValue.TIMESTAMP });
    }
  }, 5000);

  await initializePeer();
  setupFirebaseListeners();
  showMainScreen();

  if (state.isHost) {
    startHostTimer();
  }

  showNotification(state.isHost ? `ルーム ${state.roomId} を作成しました` : `ルーム ${state.roomId} に参加しました`);

  const newUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}?room=${state.roomId}`;
  window.history.pushState({ path: newUrl }, "", newUrl);
}

function setupFirebaseListeners() {
  state.roomRef.child("participants").on("value", (snapshot) => {
    state.participants.clear();
    snapshot.forEach((child) => {
      state.participants.set(child.key, child.val());
    });
    updateParticipantList();

    if (state.isBreak && state.localStream) {
      connectToNewParticipants();
    }
  });

  state.roomRef.child("timer").on("value", (snapshot) => {
    const timer = snapshot.val();
    if (!timer) return;

    const previousIsBreak = state.isBreak;
    state.remainingSeconds = timer.remainingSeconds;
    state.isPaused = !!timer.isPaused;
    state.currentCycle = timer.currentCycle || 0;
    state.isBreak = !!timer.isBreak;

    updateTimerDisplay();
    updateCycleIndicator();
    updateCallUI();
    updateHostControls();

    if (!previousIsBreak && state.isBreak) {
      showNotification("休憩タイムです。通話を開始します");
      startCall();
    } else if (previousIsBreak && !state.isBreak) {
      showNotification("作業タイムです。通話を終了します");
      endCall();
    }
  });

  state.roomRef.on("value", (snapshot) => {
    if (!snapshot.exists() && state.roomId) {
      showNotification("ルームが終了しました", true);
      setTimeout(() => leaveRoom(), 2000);
    }
  });
}

function startHostTimer() {
  if (state.hostTimerInterval) clearInterval(state.hostTimerInterval);
  state.hostTimerInterval = setInterval(() => {
    if (state.isPaused || !state.isHost || !state.roomRef) return;

    state.remainingSeconds -= 1;
    if (state.remainingSeconds <= 0) {
      switchPhase();
      return;
    }

    syncHostTimerToDb();
  }, 1000);
}

function switchPhase() {
  state.isBreak = !state.isBreak;
  state.remainingSeconds = state.isBreak ? CONFIG.BREAK_MINUTES * 60 : CONFIG.WORK_MINUTES * 60;

  if (!state.isBreak) {
    state.currentCycle = (state.currentCycle + 1) % 4;
  }

  updateTimerDisplay();
  updateCycleIndicator();
  updateCallUI();

  if (state.isBreak) {
    showNotification("休憩タイムです。通話を開始します");
    startCall();
  } else {
    showNotification("作業タイムです。通話を終了します");
    endCall();
  }

  syncHostTimerToDb();
  updateHostControls();
}

function toggleHostTimer() {
  if (!state.isHost || !state.roomRef) return;
  state.isPaused = !state.isPaused;
  syncHostTimerToDb();
  updateHostControls();
  showNotification(state.isPaused ? "タイマーを停止しました" : "タイマーを開始しました");
}

function skipToBreak() {
  if (!state.isHost || !state.roomRef) return;
  if (state.isBreak) {
    showNotification("すでに休憩中です");
    return;
  }

  state.isBreak = true;
  state.remainingSeconds = CONFIG.BREAK_MINUTES * 60;
  state.isPaused = false;

  updateTimerDisplay();
  updateCycleIndicator();
  updateCallUI();
  startCall();

  syncHostTimerToDb();
  updateHostControls();
  showNotification("休憩へスキップしました");
}

async function initializePeer() {
  return new Promise((resolve) => {
    state.peer = new Peer(state.odId, { debug: 1 });

    state.peer.on("open", () => resolve());

    state.peer.on("call", (call) => {
      if (state.isBreak && state.localStream) {
        call.answer(state.localStream);
        handleStream(call);
      }
    });

    state.peer.on("error", (err) => {
      console.error("Peer error:", err);
    });
  });
}

async function startCall() {
  if (state.localStream) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    state.localStream = stream;
    setupAudioVisualizer(stream);
    setMute(state.isMuted);
    connectToNewParticipants();
    showNotification("マイクが有効になりました");
  } catch (err) {
    console.error("Mic access error:", err);
    showNotification("マイクへのアクセスに失敗しました", true);
  }
}

function connectToNewParticipants() {
  state.participants.forEach((_data, pId) => {
    if (pId !== state.odId && !state.connections.has(pId) && state.localStream) {
      const call = state.peer.call(pId, state.localStream);
      if (call) handleStream(call);
    }
  });
}

function handleStream(call) {
  const peerId = call.peer;
  state.connections.set(peerId, call);

  call.on("stream", (remoteStream) => {
    let audio = document.getElementById(`audio-${peerId}`);
    if (!audio) {
      audio = document.createElement("audio");
      audio.id = `audio-${peerId}`;
      audio.autoplay = true;
      document.body.appendChild(audio);
    }
    audio.srcObject = remoteStream;
  });

  call.on("close", () => cleanupConnection(peerId));
  call.on("error", () => cleanupConnection(peerId));
}

function cleanupConnection(peerId) {
  if (state.connections.has(peerId)) {
    state.connections.get(peerId).close();
    state.connections.delete(peerId);
  }
  const audio = document.getElementById(`audio-${peerId}`);
  if (audio) audio.remove();
}

function endCall() {
  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
    state.localStream = null;
  }

  state.connections.forEach((call) => call.close());
  state.connections.clear();
  document.querySelectorAll("audio").forEach((el) => el.remove());

  if (state.audioContext) {
    state.audioContext.close();
    state.audioContext = null;
  }
}

function toggleMute() {
  state.isMuted = !state.isMuted;
  setMute(state.isMuted);

  const btn = document.getElementById("muteBtn");
  if (state.isMuted) {
    btn.textContent = "ミュート中";
    btn.classList.add("active");
  } else {
    btn.textContent = "ミュート";
    btn.classList.remove("active");
  }
}

function setMute(muted) {
  if (state.localStream) {
    state.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }
}

function setupAudioVisualizer(stream) {
  if (!window.AudioContext && !window.webkitAudioContext) return;

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  state.audioContext = new AudioContextClass();
  const src = state.audioContext.createMediaStreamSource(stream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 64;
  src.connect(state.analyser);

  const bufferLength = state.analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  const bars = document.querySelectorAll(".audio-bar");

  function renderFrame() {
    if (!state.localStream || !state.audioContext) return;

    requestAnimationFrame(renderFrame);
    state.analyser.getByteFrequencyData(dataArray);
    bars.forEach((bar, index) => {
      const value = dataArray[index + 2] || 0;
      const height = Math.max(4, value / 4);
      bar.style.height = `${height}px`;
    });
  }

  renderFrame();
}

function copyRoomCode() {
  if (!state.roomId) return;
  navigator.clipboard.writeText(state.roomId).then(() => {
    showNotification("ルームIDをコピーしました");
  });
}

async function leaveRoom() {
  endCall();
  if (state.hostTimerInterval) clearInterval(state.hostTimerInterval);
  if (state.heartbeatInterval) clearInterval(state.heartbeatInterval);

  try {
    if (state.roomRef && state.odId) {
      await state.roomRef.child(`participants/${state.odId}`).remove();
    }
    if (state.roomRef && state.isHost) {
      await state.roomRef.remove();
    }
  } catch (err) {
    console.error("Leave room cleanup error:", err);
  }

  if (state.peer) state.peer.destroy();
  if (state.roomRef) state.roomRef.off();
  window.location.href = window.location.pathname;
}

function toggleSettings() {
  const modal = document.getElementById("settingsModal");
  modal.classList.toggle("active");
}

function saveSettings() {
  const work = parseInt(document.getElementById("workMinutes").value, 10);
  const brk = parseInt(document.getElementById("breakMinutes").value, 10);

  if (!(work > 0 && brk > 0)) {
    showNotification("時間設定が不正です", true);
    return;
  }

  CONFIG.WORK_MINUTES = work;
  CONFIG.BREAK_MINUTES = brk;

  if (state.isHost && state.roomRef) {
    state.roomRef.child("settings").update({
      workMinutes: work,
      breakMinutes: brk,
    });
    state.remainingSeconds = state.isBreak ? brk * 60 : work * 60;
    syncHostTimerToDb();
    updateHostControls();
  }

  updateTimerDisplay();
  toggleSettings();
}
