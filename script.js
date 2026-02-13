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
  auth: null,
  authUser: null,
  roomRef: null,
  heartbeatInterval: null,
  hostTimerInterval: null,
  workAccumInterval: null,
  pendingWorkSeconds: 0,
  currentSessionSeconds: 0,
  flushWorkPromise: Promise.resolve(),
};

window.addEventListener("DOMContentLoaded", () => {
  initApp();

  document.getElementById("settingsModal").addEventListener("click", (e) => {
    if (e.target.id === "settingsModal") toggleSettings();
  });
  document.getElementById("profileModal").addEventListener("click", (e) => {
    if (e.target.id === "profileModal") closeProfileModal();
  });
});

async function initApp() {
  updateConnectionStatus("connecting", "Firebase に接続中...");
  setJoinButtonsDisabled(true);
  updateAuthUi();

  const ready = await waitForFirebaseApp(8000);
  if (!ready) {
    updateConnectionStatus("error", "Firebase 初期化に失敗");
    showNotification("Firebase Hosting 上で公開してからアクセスしてください", true);
    return;
  }

  state.firebaseApp = firebase.app();
  state.database = firebase.database();
  state.auth = firebase.auth();
  bindAuthState();

  updateConnectionStatus("connected", "Firebase 接続済み");
  setJoinButtonsDisabled(false);

  const params = new URLSearchParams(window.location.search);
  const roomIdFromUrl = params.get("room");
  if (roomIdFromUrl) {
    document.getElementById("roomId").value = roomIdFromUrl.toUpperCase();
  }
}

function bindAuthState() {
  state.auth.onAuthStateChanged(async (user) => {
    const previousUid = state.authUser ? state.authUser.uid : null;
    state.authUser = user || null;
    updateAuthUi();

    if (previousUid && !user) {
      await flushWorkProgress({ finalizeSession: true, forcedUid: previousUid });
    }
    if (user) {
      await ensureUserProfile(user);
    }
  });
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

function updateAuthUi() {
  const isLoggedIn = !!state.authUser;
  const authStatusText = document.getElementById("authStatusText");
  const accountBannerText = document.getElementById("accountBannerText");
  const signInBtn = document.getElementById("googleSignInBtn");
  const signOutBtn = document.getElementById("googleSignOutBtn");

  if (authStatusText) {
    authStatusText.textContent = isLoggedIn
      ? `Googleログイン中: ${state.authUser.displayName || state.authUser.email || "アカウント"}`
      : "ゲスト";
  }

  if (accountBannerText) {
    accountBannerText.textContent = isLoggedIn
      ? "Googleアカウントで参加中 (作業履歴を保存)"
      : "ゲスト参加中 (履歴は保存されません)";
  }

  if (signInBtn) signInBtn.style.display = isLoggedIn ? "none" : "block";
  if (signOutBtn) signOutBtn.style.display = isLoggedIn ? "block" : "none";
}

async function signInWithGoogle() {
  if (!state.auth) return;
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await state.auth.signInWithPopup(provider);
    showNotification("Googleログインに成功しました");
  } catch (err) {
    console.error("Google sign-in error:", err);
    showNotification("Googleログインに失敗しました", true);
  }
}

async function signOutAccount() {
  if (!state.auth || !state.authUser) return;
  try {
    await flushWorkProgress({ finalizeSession: true });
    await state.auth.signOut();
    showNotification("ログアウトしました");
  } catch (err) {
    console.error("Sign-out error:", err);
    showNotification("ログアウトに失敗しました", true);
  }
}

async function continueAsGuest() {
  if (state.auth && state.authUser) {
    await signOutAccount();
    return;
  }
  showNotification("ゲストモードです");
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

function getDateKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = `${now.getMonth() + 1}`.padStart(2, "0");
  const d = `${now.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
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
    const profileBtn = data.authUid
      ? `<button class="profile-link" onclick="viewParticipantProfile('${data.authUid}')">プロフィール</button>`
      : "";

    div.innerHTML = `
      <span class="participant-dot ${isOnline ? "" : "offline"}"></span>
      <span>${data.nickname}${pId === state.odId ? " (あなた)" : ""}</span>
      ${profileBtn}
    `;
    list.appendChild(div);
  });

  document.getElementById("participantCount").textContent = String(state.participants.size);
}

function updateCallUI() {
  document.getElementById("callUI").classList.toggle("active", state.isBreak);
}

function showMainScreen() {
  document.getElementById("joinScreen").classList.remove("active");
  document.getElementById("mainScreen").classList.add("active");
  document.getElementById("roomCodeDisplay").textContent = state.roomId;
  updateHostControls();
  updateAuthUi();
}

function updateHostControls() {
  const hostControls = document.getElementById("hostControls");
  hostControls.classList.toggle("active", state.isHost);
  if (!state.isHost) return;

  document.getElementById("hostStartStopBtn").textContent = state.isPaused ? "開始" : "停止";
  const skipBtn = document.getElementById("hostSkipBtn");
  skipBtn.disabled = false;
  skipBtn.textContent = state.isBreak ? "作業へスキップ" : "休憩へスキップ";
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

function isWorkTimingActive() {
  return !!state.roomRef && !state.isBreak && !state.isPaused;
}

function startWorkAccumulator() {
  if (state.workAccumInterval) clearInterval(state.workAccumInterval);
  state.workAccumInterval = setInterval(() => {
    if (!state.authUser || !isWorkTimingActive()) return;
    state.pendingWorkSeconds += 1;
    state.currentSessionSeconds += 1;

    if (state.pendingWorkSeconds % 30 === 0) {
      flushWorkProgress({ finalizeSession: false });
    }
  }, 1000);
}

function stopWorkAccumulator() {
  if (!state.workAccumInterval) return;
  clearInterval(state.workAccumInterval);
  state.workAccumInterval = null;
}

async function flushWorkProgress(options = {}) {
  state.flushWorkPromise = state.flushWorkPromise
    .then(() => doFlushWorkProgress(options))
    .catch((err) => console.error("flushWorkProgress error:", err));
  return state.flushWorkPromise;
}

async function doFlushWorkProgress({ finalizeSession = false, forcedUid = null } = {}) {
  const uid = forcedUid || (state.authUser && state.authUser.uid);
  if (!uid || !state.database) {
    state.pendingWorkSeconds = 0;
    if (finalizeSession) state.currentSessionSeconds = 0;
    return;
  }

  const delta = state.pendingWorkSeconds;
  const sessionSeconds = state.currentSessionSeconds;
  if (delta <= 0 && (!finalizeSession || sessionSeconds <= 0)) return;

  state.pendingWorkSeconds = 0;
  if (finalizeSession) state.currentSessionSeconds = 0;

  if (delta > 0) {
    const dateKey = getDateKey();
    await incrementDailySeconds(uid, dateKey, delta);
    await incrementStats(uid, delta);
    await incrementPublicStats(uid, delta);
  }

  if (finalizeSession && sessionSeconds > 0) {
    const sessionRef = state.database.ref(`users/${uid}/sessions`).push();
    await sessionRef.set({
      date: getDateKey(),
      seconds: sessionSeconds,
      roomId: state.roomId || "",
      nickname: state.nickname || "",
      createdAt: firebase.database.ServerValue.TIMESTAMP,
    });
    await incrementSessionCount(uid);
  }
}

async function incrementDailySeconds(uid, dateKey, delta) {
  const ref = state.database.ref(`users/${uid}/daily/${dateKey}`);
  await ref.transaction((current) => {
    const data = current || { date: dateKey, seconds: 0 };
    data.date = dateKey;
    data.seconds = (data.seconds || 0) + delta;
    data.updatedAt = Date.now();
    return data;
  });
}

async function incrementStats(uid, delta) {
  const ref = state.database.ref(`users/${uid}/stats`);
  await ref.transaction((current) => {
    const data = current || { totalWorkSeconds: 0, totalSessions: 0 };
    data.totalWorkSeconds = (data.totalWorkSeconds || 0) + delta;
    data.lastWorkedAt = Date.now();
    return data;
  });
}

async function incrementSessionCount(uid) {
  const ref = state.database.ref(`users/${uid}/stats`);
  await ref.transaction((current) => {
    const data = current || { totalWorkSeconds: 0, totalSessions: 0 };
    data.totalSessions = (data.totalSessions || 0) + 1;
    data.lastWorkedAt = Date.now();
    return data;
  });
}

async function incrementPublicStats(uid, delta) {
  const displayName = getDisplayNameForProfile();
  const ref = state.database.ref(`publicUsers/${uid}`);
  await ref.transaction((current) => {
    const data = current || { displayName, totalWorkSeconds: 0 };
    data.displayName = displayName || data.displayName || "Unknown";
    data.totalWorkSeconds = (data.totalWorkSeconds || 0) + delta;
    data.lastWorkedAt = Date.now();
    data.updatedAt = Date.now();
    return data;
  });
}

function getDisplayNameForProfile() {
  if (state.authUser) {
    return state.authUser.displayName || state.authUser.email || state.nickname || "User";
  }
  return state.nickname || "Guest";
}

async function ensureUserProfile(user) {
  const profileData = {
    displayName: user.displayName || user.email || state.nickname || "User",
    photoURL: user.photoURL || "",
    email: user.email || "",
    updatedAt: Date.now(),
  };
  await state.database.ref(`users/${user.uid}/profile`).update(profileData);
  await state.database.ref(`publicUsers/${user.uid}`).update({
    displayName: profileData.displayName,
    photoURL: profileData.photoURL,
    updatedAt: Date.now(),
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
    authUid: state.authUser ? state.authUser.uid : "",
  });
  participantRef.onDisconnect().remove();

  if (state.heartbeatInterval) clearInterval(state.heartbeatInterval);
  state.heartbeatInterval = setInterval(() => {
    if (state.roomRef) participantRef.update({ lastSeen: firebase.database.ServerValue.TIMESTAMP });
  }, 5000);

  await initializePeer();
  setupFirebaseListeners();
  showMainScreen();
  startWorkAccumulator();

  if (state.isHost) startHostTimer();

  showNotification(state.isHost ? `ルーム ${state.roomId} を作成しました` : `ルーム ${state.roomId} に参加しました`);
  const newUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}?room=${state.roomId}`;
  window.history.pushState({ path: newUrl }, "", newUrl);
}

function setupFirebaseListeners() {
  state.roomRef.child("participants").on("value", (snapshot) => {
    state.participants.clear();
    snapshot.forEach((child) => state.participants.set(child.key, child.val()));
    updateParticipantList();
    if (state.isBreak && state.localStream) connectToNewParticipants();
  });

  state.roomRef.child("timer").on("value", async (snapshot) => {
    const timer = snapshot.val();
    if (!timer) return;

    const previousIsBreak = state.isBreak;
    const previousPaused = state.isPaused;

    state.remainingSeconds = timer.remainingSeconds;
    state.isPaused = !!timer.isPaused;
    state.currentCycle = timer.currentCycle || 0;
    state.isBreak = !!timer.isBreak;

    updateTimerDisplay();
    updateCycleIndicator();
    updateCallUI();
    updateHostControls();

    if (!previousIsBreak && state.isBreak) {
      await flushWorkProgress({ finalizeSession: true });
      showNotification("休憩タイムです。通話を開始します");
      startCall();
    } else if (previousIsBreak && !state.isBreak) {
      showNotification("作業タイムです。通話を終了します");
      endCall();
    } else if (!previousPaused && state.isPaused) {
      await flushWorkProgress({ finalizeSession: true });
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

async function toggleHostTimer() {
  if (!state.isHost || !state.roomRef) return;
  state.isPaused = !state.isPaused;
  syncHostTimerToDb();
  updateHostControls();
  if (state.isPaused) {
    await flushWorkProgress({ finalizeSession: true });
  }
  showNotification(state.isPaused ? "タイマーを停止しました" : "タイマーを開始しました");
}

async function skipToBreak() {
  if (!state.isHost || !state.roomRef) return;

  if (!state.isBreak) {
    await flushWorkProgress({ finalizeSession: true });
  }
  switchPhase();
  showNotification(state.isBreak ? "休憩へスキップしました" : "作業へスキップしました");
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
    state.peer.on("error", (err) => console.error("Peer error:", err));
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
  if (!state.localStream) return;
  state.localStream.getAudioTracks().forEach((track) => {
    track.enabled = !muted;
  });
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
      bar.style.height = `${Math.max(4, value / 4)}px`;
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
  await flushWorkProgress({ finalizeSession: true });
  stopWorkAccumulator();
  closeProfileModal();
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
  document.getElementById("settingsModal").classList.toggle("active");
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
    state.roomRef.child("settings").update({ workMinutes: work, breakMinutes: brk });
    state.remainingSeconds = state.isBreak ? brk * 60 : work * 60;
    syncHostTimerToDb();
    updateHostControls();
  }

  updateTimerDisplay();
  toggleSettings();
}

function openProfileModal(title = "マイページ") {
  document.getElementById("profileModalTitle").textContent = title;
  document.getElementById("profileModal").classList.add("active");
}

function closeProfileModal() {
  document.getElementById("profileModal").classList.remove("active");
}

async function loadMyProfile() {
  if (!state.authUser) {
    showNotification("Googleログインすると履歴を保存・表示できます", true);
    return;
  }
  openProfileModal("マイページ");
  await loadProfile(state.authUser.uid);
}

async function viewParticipantProfile(uid) {
  openProfileModal("プロフィール");
  await loadProfile(uid);
}

async function loadProfile(uid) {
  try {
    const profileSnap = await state.database.ref(`users/${uid}/profile`).once("value");
    const statsSnap = await state.database.ref(`users/${uid}/stats`).once("value");
    const sessionsSnap = await state.database.ref(`users/${uid}/sessions`).limitToLast(20).once("value");

    const profile = profileSnap.val();
    const stats = statsSnap.val() || { totalWorkSeconds: 0, totalSessions: 0 };
    const sessions = [];
    sessionsSnap.forEach((child) => sessions.push(child.val()));
    sessions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    renderProfile(profile, stats, sessions);
  } catch (err) {
    console.error("loadProfile error:", err);
    showNotification("プロフィール取得に失敗しました", true);
  }
}

function renderProfile(profile, stats, sessions) {
  const displayName = profile && profile.displayName ? profile.displayName : "(未設定)";
  const totalHours = ((stats.totalWorkSeconds || 0) / 3600).toFixed(1);
  const totalSessions = stats.totalSessions || 0;

  document.getElementById("profileSummary").innerHTML = `
    <strong>${displayName}</strong><br>
    合計作業時間: ${totalHours} 時間<br>
    セッション回数: ${totalSessions} 回
  `;

  const historyEl = document.getElementById("profileHistory");
  if (!sessions.length) {
    historyEl.innerHTML = "<div class=\"history-item\">履歴はまだありません</div>";
    return;
  }

  historyEl.innerHTML = sessions
    .slice(0, 20)
    .map((session) => {
      const date = session.date || "-";
      const mins = Math.round((session.seconds || 0) / 60);
      const room = session.roomId || "-";
      return `<div class="history-item">${date} / ${mins}分 / Room: ${room}</div>`;
    })
    .join("");
}
