let CONFIG = {
  WORK_MINUTES: 20,
  BREAK_MINUTES: 5,
};
const RECONNECT_SESSION_KEY = "studyTogether.reconnect.v1";

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
  participantRef: null,
  connectedRef: null,
  connectedRefHandler: null,
  heartbeatInterval: null,
  hostTimerInterval: null,
  displayTimerInterval: null,
  hostLastTickAt: 0,
  workAccumLastTickAt: 0,
  timerAnchorRemainingSeconds: CONFIG.WORK_MINUTES * 60,
  timerAnchorLastUpdateAt: 0,
  workAccumInterval: null,
  pendingWorkSeconds: 0,
  currentSessionSeconds: 0,
  flushWorkPromise: Promise.resolve(),
  currentTask: "",
  activeTaskStartedAt: null,
  viewingProfileUid: null,
  viewingProfileActivities: [],
  viewingProfileDates: [],
  viewingProfileDateIndex: 0,
  viewingProfileProfile: null,
  viewingProfileStats: null,
  viewingProfileActivityMap: new Map(),
  profileSubscriptions: [],
  roomSubscriptions: [],
  lastProcessedSkipToken: null,
  skipCompleteToken: 0,
  isPhaseSwitching: false,
  hasSeenTimerSnapshot: false,
  lastObservedTimerBreak: null,
  callInitInProgress: false,
  lastCallInitAttemptAt: 0,
};

window.addEventListener("DOMContentLoaded", () => {
  initApp();
  document.getElementById("settingsModal").addEventListener("click", (e) => {
    if (e.target.id === "settingsModal") toggleSettings();
  });
  document.getElementById("profileModal").addEventListener("click", (e) => {
    if (e.target.id === "profileModal") closeProfileModal();
  });
  document.getElementById("taskInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") setCurrentTask();
  });
});

function chooseTemplate(template) {
  const input = document.getElementById("taskInput");
  if (!input) return;

  const picked = (template || "").trim();
  if (!picked) return;

  const current = input.value.trim();
  if (!current) {
    input.value = picked;
    return;
  }
  if (current.includes(picked)) return;
  input.value = `${picked} / ${current}`;
}

async function initApp() {
  updateConnectionStatus("connecting", "Firebase に接続中...");
  setJoinButtonsDisabled(true);
  updateAuthUi();
  updateCycleIndicator();
  updateTimerDisplay();

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

  const params = new URLSearchParams(window.location.search);
  const roomId = (params.get("room") || "").toUpperCase();
  if (roomId) document.getElementById("roomId").value = roomId;

  if (roomId) {
    const rejoined = await tryAutoReconnect(roomId);
    if (rejoined) {
      updateConnectionStatus("connected", "Firebase 接続済み");
      return;
    }
  }

  updateConnectionStatus("connected", "Firebase 接続済み");
  setJoinButtonsDisabled(false);
}

async function tryAutoReconnect(roomId) {
  const saved = readReconnectSession();
  if (!saved) return false;
  if ((saved.roomId || "").toUpperCase() !== roomId) return false;
  const nickname = String(saved.nickname || "").trim().slice(0, 10);
  if (!nickname) return false;

  try {
    const roomSnap = await state.database.ref(`rooms/${roomId}`).once("value");
    if (!roomSnap.exists()) {
      clearReconnectSession();
      return false;
    }

    let shouldHost = !!saved.isHost;
    const room = roomSnap.val() || {};
    const currentHostId = room.hostId || "";
    if (shouldHost && saved.peerId && currentHostId && currentHostId !== saved.peerId) {
      shouldHost = false;
    }

    state.nickname = nickname;
    state.roomId = roomId;
    state.odId = generateId(10);
    state.isHost = shouldHost;
    state.currentTask = "";
    state.activeTaskStartedAt = null;

    document.getElementById("nickname").value = nickname;
    await initializeRoom({ rejoin: true });
    showNotification("ルームに再接続しました");
    return true;
  } catch (err) {
    console.error("auto reconnect failed:", err);
    return false;
  }
}

function bindAuthState() {
  state.auth.onAuthStateChanged(async (user) => {
    const previousUid = state.authUser ? state.authUser.uid : null;
    state.authUser = user || null;
    updateAuthUi();
    if (state.participantRef) {
      try {
        await upsertParticipantPresence();
      } catch (err) {
        console.error("presence sync on auth failed:", err);
      }
    }

    if (previousUid && !user) {
      await closeActiveTaskSegment(Date.now(), previousUid);
      await flushWorkProgress({ finalizeSession: true, forcedUid: previousUid });
    }
    if (user) await ensureUserProfile(user);
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
  document.getElementById("authStatusText").textContent = isLoggedIn
    ? `Googleログイン中: ${state.authUser.displayName || state.authUser.email || "アカウント"}`
    : "ゲスト";
  document.getElementById("accountBannerText").textContent = isLoggedIn
    ? "Googleアカウントで参加中 (作業履歴を保存)"
    : "ゲスト参加中 (履歴は保存されません)";
  document.getElementById("googleSignInBtn").style.display = isLoggedIn ? "none" : "block";
  document.getElementById("googleSignOutBtn").style.display = isLoggedIn ? "block" : "none";
}

async function signInWithGoogle() {
  if (!state.auth) return;
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await state.auth.signInWithPopup(provider);
    showNotification("Googleログインに成功しました");
  } catch (err) {
    console.error(err);
    showNotification("Googleログインに失敗しました", true);
  }
}

async function signOutAccount() {
  if (!state.auth || !state.authUser) return;
  try {
    await closeActiveTaskSegment(Date.now());
    await flushWorkProgress({ finalizeSession: true });
    await state.auth.signOut();
    showNotification("ログアウトしました");
  } catch (err) {
    console.error(err);
    showNotification("ログアウトに失敗しました", true);
  }
}

async function continueAsGuest() {
  if (state.auth && state.authUser) await signOutAccount();
  else showNotification("ゲストモードです");
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

function formatClock(ts) {
  const d = new Date(ts);
  const hh = `${d.getHours()}`.padStart(2, "0");
  const mm = `${d.getMinutes()}`.padStart(2, "0");
  return `${hh}:${mm}`;
}

function getDateKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function readReconnectSession() {
  try {
    const raw = sessionStorage.getItem(RECONNECT_SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    return data;
  } catch (_err) {
    return null;
  }
}

function writeReconnectSession() {
  if (!state.roomId || !state.nickname) return;
  const payload = {
    roomId: state.roomId,
    nickname: state.nickname,
    isHost: !!state.isHost,
    peerId: state.odId || "",
    updatedAt: Date.now(),
  };
  sessionStorage.setItem(RECONNECT_SESSION_KEY, JSON.stringify(payload));
}

function clearReconnectSession() {
  sessionStorage.removeItem(RECONNECT_SESSION_KEY);
}

function setTimerAnchorFromSnapshot(timer, baseNowTs = Date.now()) {
  state.timerAnchorRemainingSeconds = Math.max(0, toFiniteNumber(timer && timer.remainingSeconds, state.remainingSeconds));
  state.timerAnchorLastUpdateAt = baseNowTs;
}

function getAnchoredRemainingSeconds(nowTs = Date.now()) {
  if (state.isPaused) return Math.max(0, Math.floor(state.timerAnchorRemainingSeconds));
  const elapsedSec = Math.max(0, Math.floor((nowTs - state.timerAnchorLastUpdateAt) / 1000));
  return Math.max(0, Math.floor(state.timerAnchorRemainingSeconds) - elapsedSec);
}

function refreshTimerFromAnchor() {
  state.remainingSeconds = getAnchoredRemainingSeconds(Date.now());
  updateTimerDisplay();
}

function startDisplayTimerLoop() {
  if (state.isHost) {
    stopDisplayTimerLoop();
    return;
  }
  if (state.displayTimerInterval) clearInterval(state.displayTimerInterval);
  state.displayTimerInterval = setInterval(() => {
    if (!state.roomRef) return;
    refreshTimerFromAnchor();
  }, 1000);
}

function stopDisplayTimerLoop() {
  if (!state.displayTimerInterval) return;
  clearInterval(state.displayTimerInterval);
  state.displayTimerInterval = null;
}

function detachPresenceListener() {
  if (state.connectedRef && state.connectedRefHandler) {
    state.connectedRef.off("value", state.connectedRefHandler);
  }
  state.connectedRef = null;
  state.connectedRefHandler = null;
}

function clearRoomSubscriptions() {
  if (!state.roomSubscriptions || !state.roomSubscriptions.length) return;
  state.roomSubscriptions.forEach((off) => {
    try {
      off();
    } catch (_err) {
      // noop
    }
  });
  state.roomSubscriptions = [];
}

function ensureBreakCallActive() {
  if (!state.isBreak) return;
  if (state.localStream) {
    connectToNewParticipants();
    return;
  }

  const now = Date.now();
  if (state.callInitInProgress) return;
  if (now - state.lastCallInitAttemptAt < 10000) return;
  state.callInitInProgress = true;
  state.lastCallInitAttemptAt = now;
  startCall()
    .catch((err) => console.error("ensureBreakCallActive failed:", err))
    .finally(() => {
      state.callInitInProgress = false;
    });
}

async function upsertParticipantPresence() {
  if (!state.participantRef) return;
  await state.participantRef.set({
    nickname: state.nickname,
    joinedAt: firebase.database.ServerValue.TIMESTAMP,
    lastSeen: firebase.database.ServerValue.TIMESTAMP,
    peerId: state.odId,
    authUid: state.authUser ? state.authUser.uid : "",
    currentTask: state.currentTask || "",
  });
}

function attachPresenceListener() {
  if (!state.database || !state.participantRef) return;
  detachPresenceListener();
  state.connectedRef = state.database.ref(".info/connected");
  state.connectedRefHandler = (snap) => {
    if (!snap.val() || !state.participantRef) return;
    state.participantRef.onDisconnect().remove();
    upsertParticipantPresence().catch((err) => console.error("presence set failed:", err));
  };
  state.connectedRef.on("value", state.connectedRefHandler);
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getActivityDateKey(activity) {
  const startedAt = toFiniteNumber(activity && activity.startedAt, 0);
  if (startedAt > 0) return getDateKey(startedAt);

  const rawDate = typeof (activity && activity.date) === "string" ? activity.date.trim() : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return rawDate;

  const endedAt = toFiniteNumber(activity && activity.endedAt, 0);
  if (endedAt > 0) return getDateKey(endedAt);

  return getDateKey();
}

function showNotification(message, isError = false) {
  const el = document.getElementById("notification");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

function playPhaseSwitchTone(isBreak) {
  if (!window.AudioContext && !window.webkitAudioContext) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioContextClass();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sine";
  osc.frequency.value = isBreak ? 880 : 660;
  gain.gain.value = 0.0001;

  osc.connect(gain);
  gain.connect(ctx.destination);

  const now = ctx.currentTime;
  gain.gain.exponentialRampToValueAtTime(0.07, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
  osc.start(now);
  osc.stop(now + 0.23);
  osc.onended = () => ctx.close().catch(() => {});
}

function notifyPhaseSwitch(isBreak) {
  const message = isBreak ? "作業終了。休憩に入りました" : "休憩終了。作業を再開します";
  showNotification(message);

  try {
    playPhaseSwitchTone(isBreak);
  } catch (_err) {
    // noop
  }

  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted" &&
    document.visibilityState === "hidden"
  ) {
    try {
      new Notification("Study Together", {
        body: message,
        tag: "phase-switch",
      });
    } catch (_err) {
      // noop
    }
  }
}

function maybeEnableBrowserNotifications() {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "default") return;
  Notification.requestPermission().catch(() => {});
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
  const total = state.isBreak ? CONFIG.BREAK_MINUTES * 60 : CONFIG.WORK_MINUTES * 60;
  const progress = total > 0 ? state.remainingSeconds / total : 0;
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

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function updateParticipantList() {
  const list = document.getElementById("participantList");
  list.innerHTML = "";

  state.participants.forEach((data, pId) => {
    const div = document.createElement("div");
    div.className = "participant";
    const online = data.lastSeen && Date.now() - data.lastSeen < 15000;
    const taskPill = data.currentTask ? `<span class="participant-task">${escapeHtml(data.currentTask)}</span>` : "";
    const profileBtn = data.authUid ? `<button class="profile-link" onclick="viewParticipantProfile('${data.authUid}')">プロフィール</button>` : "";
    div.innerHTML = `
      <span class="participant-dot ${online ? "" : "offline"}"></span>
      <span>${escapeHtml(data.nickname || "NoName")}${pId === state.odId ? " (あなた)" : ""}</span>
      ${taskPill}
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
    skipCompleteToken: state.skipCompleteToken || 0,
    lastUpdate: firebase.database.ServerValue.TIMESTAMP,
  });
}

function isWorkTimingActive() {
  return !!state.roomRef && !state.isBreak && !state.isPaused;
}

function applySkipCompletionCredit(timer) {
  const token = toFiniteNumber(timer && timer.skipCompleteToken, 0);
  if (!token || token === state.lastProcessedSkipToken) return;

  const fullSeconds = Math.max(0, CONFIG.WORK_MINUTES * 60);
  const bonus = Math.max(0, fullSeconds - state.currentSessionSeconds);
  if (bonus > 0) {
    state.pendingWorkSeconds += bonus;
    state.currentSessionSeconds += bonus;
    if (state.activeTaskStartedAt) state.activeTaskStartedAt -= bonus * 1000;
  }
  state.lastProcessedSkipToken = token;
}

function startWorkAccumulator() {
  if (state.workAccumInterval) clearInterval(state.workAccumInterval);
  state.workAccumLastTickAt = Date.now();
  state.workAccumInterval = setInterval(() => {
    const now = Date.now();
    const elapsedSec = Math.max(0, Math.floor((now - state.workAccumLastTickAt) / 1000));
    if (elapsedSec <= 0) return;
    state.workAccumLastTickAt += elapsedSec * 1000;

    if (!state.authUser || !isWorkTimingActive()) return;

    const before = state.pendingWorkSeconds;
    state.pendingWorkSeconds += elapsedSec;
    state.currentSessionSeconds += elapsedSec;
    if (Math.floor(before / 30) !== Math.floor(state.pendingWorkSeconds / 30)) {
      flushWorkProgress({ finalizeSession: false });
    }
  }, 1000);
}

function stopWorkAccumulator() {
  if (!state.workAccumInterval) return;
  clearInterval(state.workAccumInterval);
  state.workAccumInterval = null;
  state.workAccumLastTickAt = 0;
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
      task: state.currentTask || "",
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
  if (state.authUser) return state.authUser.displayName || state.authUser.email || state.nickname || "User";
  return state.nickname || "Guest";
}

async function ensureUserProfile(user) {
  const profile = {
    displayName: user.displayName || user.email || state.nickname || "User",
    photoURL: user.photoURL || "",
    email: user.email || "",
    updatedAt: Date.now(),
  };
  await state.database.ref(`users/${user.uid}/profile`).update(profile);
  await state.database.ref(`publicUsers/${user.uid}`).update({
    displayName: profile.displayName,
    photoURL: profile.photoURL,
    updatedAt: Date.now(),
  });
}

async function createRoom() {
  if (!state.database) return showNotification("Firebase 接続が完了していません", true);
  const nickname = document.getElementById("nickname").value.trim();
  if (!nickname) return showNotification("ニックネームを入力してください", true);

  maybeEnableBrowserNotifications();
  state.nickname = nickname.slice(0, 10);
  state.roomId = generateId();
  state.odId = generateId(10);
  state.isHost = true;
  state.isPaused = true;
  state.isBreak = false;
  state.currentCycle = 0;
  state.remainingSeconds = CONFIG.WORK_MINUTES * 60;
  state.timerAnchorRemainingSeconds = state.remainingSeconds;
  state.timerAnchorLastUpdateAt = Date.now();
  state.currentTask = "";
  state.activeTaskStartedAt = null;
  try {
    await initializeRoom({ rejoin: false });
  } catch (err) {
    console.error(err);
    showNotification("ルーム作成に失敗しました", true);
  }
}

async function joinRoom() {
  if (!state.database) return showNotification("Firebase 接続が完了していません", true);
  const nickname = document.getElementById("nickname").value.trim();
  const roomId = document.getElementById("roomId").value.trim().toUpperCase();
  if (!nickname) return showNotification("ニックネームを入力してください", true);
  if (!roomId) return showNotification("ルームIDを入力してください", true);

  maybeEnableBrowserNotifications();
  const roomSnap = await state.database.ref(`rooms/${roomId}`).once("value");
  if (!roomSnap.exists()) return showNotification("ルームが見つかりません", true);

  state.nickname = nickname.slice(0, 10);
  state.roomId = roomId;
  state.odId = generateId(10);
  state.isHost = false;
  state.currentTask = "";
  state.activeTaskStartedAt = null;
  try {
    await initializeRoom({ rejoin: false });
  } catch (err) {
    console.error(err);
    showNotification("ルーム参加に失敗しました", true);
  }
}

async function initializeRoom({ rejoin = false } = {}) {
  state.roomRef = state.database.ref(`rooms/${state.roomId}`);
  const existingRoomSnap = await state.roomRef.once("value");
  const existingRoom = existingRoomSnap.val() || {};
  const existingSettings = existingRoom.settings || {};
  const existingTimer = existingRoom.timer || {};

  if (existingSettings.workMinutes && existingSettings.breakMinutes) {
    CONFIG.WORK_MINUTES = existingSettings.workMinutes;
    CONFIG.BREAK_MINUTES = existingSettings.breakMinutes;
  }

  if (state.isHost && !rejoin) {
    await state.roomRef.set({
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      hostId: state.odId,
      timer: {
        remainingSeconds: state.remainingSeconds,
        isBreak: false,
        isPaused: true,
        lastUpdate: firebase.database.ServerValue.TIMESTAMP,
        currentCycle: 0,
        skipCompleteToken: 0,
      },
      settings: { workMinutes: CONFIG.WORK_MINUTES, breakMinutes: CONFIG.BREAK_MINUTES },
    });
  } else if (state.isHost && rejoin) {
    if (!existingRoomSnap.exists()) throw new Error("Room no longer exists");
    await state.roomRef.update({ hostId: state.odId });
  } else if (!existingRoomSnap.exists()) {
    throw new Error("Room no longer exists");
  }

  if (existingRoomSnap.exists()) {
    state.remainingSeconds = Math.max(0, toFiniteNumber(existingTimer.remainingSeconds, state.remainingSeconds));
    state.isBreak = !!existingTimer.isBreak;
    state.isPaused = !!existingTimer.isPaused;
    state.currentCycle = Math.max(0, toFiniteNumber(existingTimer.currentCycle, state.currentCycle || 0));
    state.skipCompleteToken = toFiniteNumber(existingTimer.skipCompleteToken, 0);
    setTimerAnchorFromSnapshot(existingTimer);
  } else {
    setTimerAnchorFromSnapshot({
      remainingSeconds: state.remainingSeconds,
      lastUpdate: Date.now(),
    });
  }

  state.participantRef = state.roomRef.child(`participants/${state.odId}`);
  await state.participantRef.set({
    nickname: state.nickname,
    joinedAt: firebase.database.ServerValue.TIMESTAMP,
    lastSeen: firebase.database.ServerValue.TIMESTAMP,
    peerId: state.odId,
    authUid: state.authUser ? state.authUser.uid : "",
    currentTask: "",
  });
  state.participantRef.onDisconnect().remove();
  attachPresenceListener();

  if (state.heartbeatInterval) clearInterval(state.heartbeatInterval);
  state.heartbeatInterval = setInterval(() => {
    if (!state.roomRef || !state.participantRef) return;
    state.participantRef
      .update({ lastSeen: firebase.database.ServerValue.TIMESTAMP })
      .catch(() => upsertParticipantPresence().catch((err) => console.error("presence heartbeat recover failed:", err)));
  }, 5000);

  await initializePeer();
  setupFirebaseListeners();
  showMainScreen();
  startWorkAccumulator();
  if (state.isBreak) ensureBreakCallActive();
  if (state.isHost) {
    stopDisplayTimerLoop();
    startHostTimer();
  } else {
    startDisplayTimerLoop();
  }
  writeReconnectSession();

  const newUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}?room=${state.roomId}`;
  window.history.pushState({ path: newUrl }, "", newUrl);
  showNotification(state.isHost ? `ルーム ${state.roomId} を作成しました` : `ルーム ${state.roomId} に参加しました`);
}

function setupFirebaseListeners() {
  clearRoomSubscriptions();
  state.participants.clear();
  state.hasSeenTimerSnapshot = false;
  state.lastObservedTimerBreak = null;
  updateParticipantList();

  const participantsRef = state.roomRef.child("participants");
  const upsertParticipant = (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    state.participants.set(snapshot.key, data);
    updateParticipantList();
    if (state.isBreak) ensureBreakCallActive();
  };
  const removeParticipant = (snapshot) => {
    const peerId = snapshot.key;
    state.participants.delete(peerId);
    cleanupConnection(peerId);
    updateParticipantList();
  };
  participantsRef.on("child_added", upsertParticipant);
  participantsRef.on("child_changed", upsertParticipant);
  participantsRef.on("child_removed", removeParticipant);
  state.roomSubscriptions.push(() => participantsRef.off("child_added", upsertParticipant));
  state.roomSubscriptions.push(() => participantsRef.off("child_changed", upsertParticipant));
  state.roomSubscriptions.push(() => participantsRef.off("child_removed", removeParticipant));

  const timerRef = state.roomRef.child("timer");
  const onTimer = async (snapshot) => {
    const timer = snapshot.val();
    if (!timer) return;
    const isFirstTimerSnapshot = !state.hasSeenTimerSnapshot;
    state.hasSeenTimerSnapshot = true;

    const nextIsBreak = !!timer.isBreak;
    const prevObservedBreak = state.lastObservedTimerBreak;
    const hasObservedBreak = typeof prevObservedBreak === "boolean";
    const breakChanged = hasObservedBreak && prevObservedBreak !== nextIsBreak;
    state.lastObservedTimerBreak = nextIsBreak;

    const wasActive = isWorkTimingActive();
    const prevBreak = hasObservedBreak ? prevObservedBreak : state.isBreak;
    const transitionToBreak = breakChanged && nextIsBreak;
    state.isPaused = !!timer.isPaused;
    state.currentCycle = Math.max(0, toFiniteNumber(timer.currentCycle, 0));
    state.isBreak = nextIsBreak;
    const timerRemaining = Math.max(0, toFiniteNumber(timer.remainingSeconds, state.remainingSeconds));
    state.skipCompleteToken = toFiniteNumber(timer.skipCompleteToken, 0);
    setTimerAnchorFromSnapshot({ remainingSeconds: timerRemaining }, Date.now());
    if (state.isHost) {
      state.remainingSeconds = timerRemaining;
      updateTimerDisplay();
    } else {
      refreshTimerFromAnchor();
    }

    const nowActive = isWorkTimingActive();
    if (!wasActive && nowActive) startOrResumeTaskSegment(Date.now());
    if (wasActive && !nowActive) {
      if (transitionToBreak) applySkipCompletionCredit(timer);
      await closeActiveTaskSegment(Date.now());
    }

    updateCycleIndicator();
    updateCallUI();
    updateHostControls();
    if (state.isBreak) ensureBreakCallActive();

    if (transitionToBreak) {
      await flushWorkProgress({ finalizeSession: true });
      ensureBreakCallActive();
    } else if (breakChanged && !state.isBreak) {
      endCall();
    }

    if (!isFirstTimerSnapshot && breakChanged) {
      notifyPhaseSwitch(state.isBreak);
    }
  };
  timerRef.on("value", onTimer);
  state.roomSubscriptions.push(() => timerRef.off("value", onTimer));

  const onRoom = (snapshot) => {
    if (!snapshot.exists() && state.roomId) {
      showNotification("ルームが終了しました", true);
      setTimeout(() => leaveRoom(), 1800);
    }
  };
  state.roomRef.on("value", onRoom);
  state.roomSubscriptions.push(() => state.roomRef.off("value", onRoom));
}

function startHostTimer() {
  if (state.hostTimerInterval) clearInterval(state.hostTimerInterval);
  state.hostLastTickAt = Date.now();
  state.hostTimerInterval = setInterval(() => {
    if (!state.isHost || !state.roomRef) return;
    const now = Date.now();
    if (state.isPaused) {
      state.hostLastTickAt = now;
      return;
    }

    const elapsedSec = Math.max(0, Math.floor((now - state.hostLastTickAt) / 1000));
    if (elapsedSec <= 0) return;
    state.hostLastTickAt += elapsedSec * 1000;

    state.remainingSeconds = Math.max(0, state.remainingSeconds - elapsedSec);
    setTimerAnchorFromSnapshot({
      remainingSeconds: state.remainingSeconds,
      lastUpdate: now,
    });
    refreshTimerFromAnchor();
    if (state.remainingSeconds <= 0) {
      syncHostTimerToDb();
      switchPhase({ completeAsFullPomodoro: false }).catch((err) => console.error(err));
      return;
    }
    syncHostTimerToDb();
  }, 500);
}

async function switchPhase({ completeAsFullPomodoro = false } = {}) {
  if (state.isPhaseSwitching) return;
  state.isPhaseSwitching = true;

  try {
    const goingToBreak = !state.isBreak;
    if (goingToBreak) {
      if (completeAsFullPomodoro) {
        const fullSeconds = Math.max(0, CONFIG.WORK_MINUTES * 60);
        const bonus = Math.max(0, fullSeconds - state.currentSessionSeconds);
        if (bonus > 0) {
          state.pendingWorkSeconds += bonus;
          state.currentSessionSeconds += bonus;
          if (state.activeTaskStartedAt) state.activeTaskStartedAt -= bonus * 1000;
        }
        state.skipCompleteToken = Date.now();
      } else {
        state.skipCompleteToken = 0;
      }
      await closeActiveTaskSegment(Date.now());
      await flushWorkProgress({ finalizeSession: true });
    }

    state.isBreak = !state.isBreak;
    state.remainingSeconds = state.isBreak ? CONFIG.BREAK_MINUTES * 60 : CONFIG.WORK_MINUTES * 60;
    state.hostLastTickAt = Date.now();
    if (!state.isBreak) {
      state.currentCycle = (state.currentCycle + 1) % 4;
      state.skipCompleteToken = 0;
    }
    setTimerAnchorFromSnapshot({
      remainingSeconds: state.remainingSeconds,
      lastUpdate: Date.now(),
    });
    refreshTimerFromAnchor();
    updateCycleIndicator();
    updateCallUI();
    if (state.isBreak) startCall();
    else endCall();
    syncHostTimerToDb();
    updateHostControls();
  } finally {
    state.isPhaseSwitching = false;
  }
}

async function toggleHostTimer() {
  if (!state.isHost || !state.roomRef) return;
  state.isPaused = !state.isPaused;
  if (state.isPaused) {
    await closeActiveTaskSegment(Date.now());
    await flushWorkProgress({ finalizeSession: true });
  } else {
    state.hostLastTickAt = Date.now();
    startOrResumeTaskSegment(Date.now());
  }
  setTimerAnchorFromSnapshot({
    remainingSeconds: state.remainingSeconds,
    lastUpdate: Date.now(),
  });
  refreshTimerFromAnchor();
  syncHostTimerToDb();
  updateHostControls();
  showNotification(state.isPaused ? "タイマーを停止しました" : "タイマーを開始しました");
}

async function skipToBreak() {
  if (!state.isHost || !state.roomRef) return;
  await switchPhase({ completeAsFullPomodoro: !state.isBreak });
  showNotification(state.isBreak ? "休憩へスキップしました" : "作業へスキップしました");
}

async function initializePeer() {
  return new Promise((resolve) => {
    state.peer = new Peer(state.odId, { debug: 1 });
    state.peer.on("open", () => resolve());
    state.peer.on("call", async (call) => {
      if (!state.isBreak) return;
      try {
        if (!state.localStream) await startCall();
        if (!state.localStream) return;
        call.answer(state.localStream);
        handleStream(call);
      } catch (err) {
        console.error("Failed to answer call:", err);
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
  } catch (err) {
    console.error(err);
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
  state.callInitInProgress = false;
  state.lastCallInitAttemptAt = 0;
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
    bars.forEach((bar, idx) => {
      const v = dataArray[idx + 2] || 0;
      bar.style.height = `${Math.max(4, v / 4)}px`;
    });
  }
  renderFrame();
}

function copyRoomCode() {
  if (!state.roomId) return;
  navigator.clipboard.writeText(state.roomId).then(() => showNotification("ルームIDをコピーしました"));
}

async function leaveRoom() {
  clearReconnectSession();
  await closeActiveTaskSegment(Date.now());
  await flushWorkProgress({ finalizeSession: true });
  stopWorkAccumulator();
  stopDisplayTimerLoop();
  closeProfileModal();
  endCall();
  if (state.hostTimerInterval) clearInterval(state.hostTimerInterval);
  if (state.heartbeatInterval) clearInterval(state.heartbeatInterval);
  detachPresenceListener();
  clearRoomSubscriptions();
  try {
    if (state.roomRef && state.odId) await state.roomRef.child(`participants/${state.odId}`).remove();
    if (state.roomRef && state.isHost) await state.roomRef.remove();
  } catch (err) {
    console.error(err);
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
  if (!(work > 0 && brk > 0)) return showNotification("時間設定が不正です", true);
  CONFIG.WORK_MINUTES = work;
  CONFIG.BREAK_MINUTES = brk;
  if (state.isHost && state.roomRef) {
    state.roomRef.child("settings").update({ workMinutes: work, breakMinutes: brk });
    state.remainingSeconds = state.isBreak ? brk * 60 : work * 60;
    setTimerAnchorFromSnapshot({
      remainingSeconds: state.remainingSeconds,
      lastUpdate: Date.now(),
    });
    syncHostTimerToDb();
    updateHostControls();
  }
  refreshTimerFromAnchor();
  toggleSettings();
}

function openProfileModal(title = "マイページ") {
  document.getElementById("profileModalTitle").textContent = title;
  document.getElementById("profileModal").classList.add("active");
}

function closeProfileModal() {
  clearProfileSubscriptions();
  document.getElementById("profileModal").classList.remove("active");
}

function clearProfileSubscriptions() {
  if (!state.profileSubscriptions || !state.profileSubscriptions.length) {
    state.viewingProfileActivityMap = new Map();
    return;
  }
  state.profileSubscriptions.forEach((off) => {
    try {
      off();
    } catch (_err) {
      // noop
    }
  });
  state.profileSubscriptions = [];
  state.viewingProfileActivityMap = new Map();
}

async function loadMyProfile() {
  if (!state.authUser) return showNotification("Googleログインすると履歴を表示できます", true);
  openProfileModal("マイページ");
  await loadProfile(state.authUser.uid);
}

async function viewParticipantProfile(uid) {
  openProfileModal("プロフィール");
  await loadProfile(uid);
}

async function loadProfile(uid) {
  try {
    clearProfileSubscriptions();
    state.viewingProfileUid = uid;
    state.viewingProfileActivities = [];
    state.viewingProfileDates = [];
    state.viewingProfileDateIndex = 0;
    state.viewingProfileProfile = {};
    state.viewingProfileStats = { totalWorkSeconds: 0, totalSessions: 0 };
    state.viewingProfileActivityMap = new Map();

    const rerenderProfile = () => {
      const activities = state.viewingProfileActivities || [];
      const selectedDate = state.viewingProfileDates[state.viewingProfileDateIndex] || null;
      const nextDates = Array.from(
        new Set(activities.map((a) => getActivityDateKey(a)))
      ).sort().reverse();
      let nextIndex = 0;
      if (selectedDate) {
        const found = nextDates.indexOf(selectedDate);
        if (found >= 0) nextIndex = found;
      }
      state.viewingProfileDates = nextDates;
      state.viewingProfileDateIndex = nextIndex;
      renderProfileSummary(state.viewingProfileProfile, state.viewingProfileStats);
      renderProfileDateHeader();
      renderProfileActivitiesByDate();
    };

    const profileRef = state.database.ref(`users/${uid}/profile`);
    const statsRef = state.database.ref(`users/${uid}/stats`);
    const activitiesRef = state.database.ref(`users/${uid}/activities`);

    const onProfile = (snapshot) => {
      if (state.viewingProfileUid !== uid) return;
      state.viewingProfileProfile = snapshot.val() || {};
      rerenderProfile();
    };
    const onStats = (snapshot) => {
      if (state.viewingProfileUid !== uid) return;
      state.viewingProfileStats = snapshot.val() || { totalWorkSeconds: 0, totalSessions: 0 };
      rerenderProfile();
    };
    const updateActivitiesFromMap = () => {
      const activities = Array.from(state.viewingProfileActivityMap.values());
      activities.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      state.viewingProfileActivities = activities.slice(0, 1000);
      rerenderProfile();
    };
    const upsertActivity = (snapshot) => {
      if (state.viewingProfileUid !== uid) return;
      const raw = snapshot.val() || {};
      state.viewingProfileActivityMap.set(snapshot.key, {
        ...raw,
        startedAt: toFiniteNumber(raw.startedAt, 0),
        endedAt: toFiniteNumber(raw.endedAt, 0),
        seconds: toFiniteNumber(raw.seconds, 0),
        _id: snapshot.key,
      });
      updateActivitiesFromMap();
    };
    const removeActivity = (snapshot) => {
      if (state.viewingProfileUid !== uid) return;
      state.viewingProfileActivityMap.delete(snapshot.key);
      updateActivitiesFromMap();
    };

    profileRef.on("value", onProfile);
    statsRef.on("value", onStats);
    activitiesRef.on("child_added", upsertActivity);
    activitiesRef.on("child_changed", upsertActivity);
    activitiesRef.on("child_removed", removeActivity);

    state.profileSubscriptions.push(() => profileRef.off("value", onProfile));
    state.profileSubscriptions.push(() => statsRef.off("value", onStats));
    state.profileSubscriptions.push(() => activitiesRef.off("child_added", upsertActivity));
    state.profileSubscriptions.push(() => activitiesRef.off("child_changed", upsertActivity));
    state.profileSubscriptions.push(() => activitiesRef.off("child_removed", removeActivity));

    renderProfileSummary(state.viewingProfileProfile, state.viewingProfileStats);
    renderProfileDateHeader();
    renderProfileActivitiesByDate();
  } catch (err) {
    console.error(err);
    showNotification("プロフィール取得に失敗しました", true);
  }
}

function renderProfileSummary(profile, stats, visibleCount = null) {
  const displayName = profile && profile.displayName ? profile.displayName : "(未設定)";
  const totalHours = ((stats.totalWorkSeconds || 0) / 3600).toFixed(1);
  const totalSessions = stats.totalSessions || 0;
  const visibleLine = visibleCount === null ? "" : `<br>表示日の履歴件数: ${visibleCount} 件`;
  const totalLoaded = state.viewingProfileActivities ? state.viewingProfileActivities.length : 0;
  document.getElementById("profileSummary").innerHTML = `
    <strong>${escapeHtml(displayName)}</strong><br>
    合計作業時間: ${totalHours} 時間<br>
    セッション回数: ${totalSessions} 回
    ${visibleLine}<br>読み込み履歴総数: ${totalLoaded} 件
  `;
}

function renderProfileDateHeader() {
  const hasDates = state.viewingProfileDates.length > 0;
  const label = document.getElementById("profileDateLabel");
  const prevBtn = document.getElementById("profilePrevDateBtn");
  const nextBtn = document.getElementById("profileNextDateBtn");

  if (!hasDates) {
    label.textContent = "履歴なし";
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  label.textContent = state.viewingProfileDates[state.viewingProfileDateIndex];
  prevBtn.disabled = state.viewingProfileDateIndex >= state.viewingProfileDates.length - 1;
  nextBtn.disabled = state.viewingProfileDateIndex <= 0;
}

function moveProfileDate(direction) {
  if (!state.viewingProfileDates.length) return;
  const next = state.viewingProfileDateIndex - direction;
  if (next < 0 || next >= state.viewingProfileDates.length) return;
  state.viewingProfileDateIndex = next;
  renderProfileDateHeader();
  renderProfileActivitiesByDate();
}

function renderProfileActivitiesByDate() {
  const historyEl = document.getElementById("profileHistory");
  if (!state.viewingProfileDates.length) {
    renderProfileSummary(
      state.viewingProfileProfile || {},
      state.viewingProfileStats || { totalWorkSeconds: 0, totalSessions: 0 },
      0
    );
    historyEl.innerHTML = "<div class=\"history-item\">活動履歴はまだありません</div>";
    return;
  }

  const date = state.viewingProfileDates[state.viewingProfileDateIndex];
  const items = state.viewingProfileActivities
    .filter((a) => getActivityDateKey(a) === date)
    .sort((a, b) => {
      const t = (a.startedAt || 0) - (b.startedAt || 0);
      if (t !== 0) return t;
      const e = (a.endedAt || 0) - (b.endedAt || 0);
      if (e !== 0) return e;
      return String(a._id || "").localeCompare(String(b._id || ""));
    });

  renderProfileSummary(
    state.viewingProfileProfile || {},
    state.viewingProfileStats || { totalWorkSeconds: 0, totalSessions: 0 },
    items.length
  );

  if (!items.length) {
    historyEl.innerHTML = "<div class=\"history-item\">この日の活動はありません</div>";
    return;
  }

  historyEl.innerHTML = items
    .map((act) => {
      const startedAt = act.startedAt || 0;
      const endedAt = act.endedAt || 0;
      const mins = Math.max(1, Math.round((act.seconds || 0) / 60));
      const task = escapeHtml(act.task || "タスク未設定");
      return `
        <div class="history-item timeline-item">
          <div class="timeline-time">${formatClock(startedAt)} - ${formatClock(endedAt)}</div>
          <div class="timeline-task">${task}</div>
          <div class="timeline-duration">${mins}分</div>
        </div>
      `;
    })
    .join("");
}

async function setCurrentTask() {
  const input = document.getElementById("taskInput");
  const nextTask = input.value.trim().slice(0, 60);
  const prevTask = state.currentTask;
  state.currentTask = nextTask;

  if (state.participantRef) {
    await state.participantRef
      .update({ currentTask: nextTask })
      .catch(() => upsertParticipantPresence().catch((err) => console.error("presence task sync failed:", err)));
  }

  const now = Date.now();
  if (prevTask !== nextTask && isWorkTimingActive()) {
    await closeActiveTaskSegment(now);
    startOrResumeTaskSegment(now);
  }
  showNotification(nextTask ? "現在タスクを更新しました" : "現在タスクをクリアしました");
}

function startOrResumeTaskSegment(nowTs) {
  if (!state.authUser || !isWorkTimingActive()) return;
  if (!state.activeTaskStartedAt) state.activeTaskStartedAt = nowTs;
}

async function closeActiveTaskSegment(nowTs, forcedUid = null) {
  const uid = forcedUid || (state.authUser && state.authUser.uid);
  if (!uid || !state.database) {
    state.activeTaskStartedAt = null;
    return;
  }
  if (!state.activeTaskStartedAt) {
    state.activeTaskStartedAt = null;
    return;
  }

  const start = state.activeTaskStartedAt;
  const end = Math.max(nowTs, start + 1000);
  const seconds = Math.max(1, Math.floor((end - start) / 1000));
  state.activeTaskStartedAt = null;
  const task = (state.currentTask || "").trim() || "タスク未設定";

  const activityRef = state.database.ref(`users/${uid}/activities`).push();
  await activityRef.set({
    task,
    date: getDateKey(start),
    startedAt: start,
    endedAt: end,
    seconds,
    roomId: state.roomId || "",
    createdAt: firebase.database.ServerValue.TIMESTAMP,
  });
}
