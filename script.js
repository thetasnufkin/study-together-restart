// ============================================
// 設定
// ============================================
let CONFIG = {
  WORK_MINUTES: 20,
  BREAK_MINUTES: 5,
};

// ============================================
// 状態管理
// ============================================
let state = {
  odId: null, // 自分のPeerID (Firebaseのキーとしても使用)
  nickname: '',
  roomId: null, // 追加: ルームID
  isHost: false,
  participants: new Map(),
  isBreak: false,
  remainingSeconds: CONFIG.WORK_MINUTES * 60,
  isPaused: false,
  isMuted: false,
  currentCycle: 0,
  peer: null,
  connections: new Map(), // PeerJSのコネクション管理
  localStream: null,
  audioContext: null,
  analyser: null,
  firebaseApp: null,
  database: null,
  roomRef: null,
};

// ============================================
// 初期化チェック (ページロード時)
// ============================================
window.addEventListener('DOMContentLoaded', () => {
  if (loadFirebaseConfig()) {
    // URLからルームIDがある場合などはinitializeFirebase内で処理
  }
});

// ============================================
// ユーティリティ
// ============================================
function generateId(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function showNotification(message, isError = false) {
  const el = document.getElementById('notification');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}

// ============================================
// Firebase設定
// ============================================
function saveFirebaseConfig() {
  const input = document.getElementById('firebaseConfigInput').value.trim();
  
  try {
    // JSON形式をパース
    let config;
    if (input.startsWith('{')) {
      config = JSON.parse(input);
    } else {
      const jsonStr = input
        .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":')
        .replace(/'/g, '"');
      config = JSON.parse(jsonStr);
    }

    if (!config.apiKey || !config.databaseURL || !config.projectId) {
      throw new Error('必須フィールドが不足しています');
    }

    localStorage.setItem('firebaseConfig', JSON.stringify(config));
    initializeFirebase(config);
    showNotification('Firebase設定を保存しました');
    
  } catch (e) {
    console.error('Config parse error:', e);
    showNotification('設定の形式が正しくありません', true);
  }
}

function loadFirebaseConfig() {
  const saved = localStorage.getItem('firebaseConfig');
  if (saved) {
    try {
      const config = JSON.parse(saved);
      initializeFirebase(config);
      return true;
    } catch (e) {
      console.error('Failed to load config:', e);
    }
  }
  return false;
}

function resetConfig() {
  if (confirm('Firebase設定をリセットしますか？')) {
    localStorage.removeItem('firebaseConfig');
    location.reload();
  }
}

function initializeFirebase(config) {
  try {
    if (!firebase.apps.length) {
      state.firebaseApp = firebase.initializeApp(config);
    } else {
      state.firebaseApp = firebase.app();
    }
    state.database = firebase.database();
    
    document.getElementById('setupScreen').classList.add('hidden');
    document.getElementById('joinScreen').classList.add('active');
    
    updateConnectionStatus('connected', 'Firebase に接続済み');
    
    const params = new URLSearchParams(window.location.search);
    const roomIdFromUrl = params.get('room');
    if (roomIdFromUrl) {
      document.getElementById('roomId').value = roomIdFromUrl;
    }
    
  } catch (e) {
    console.error('Firebase init error:', e);
    updateConnectionStatus('error', '接続エラー');
    showNotification('Firebase接続に失敗しました', true);
  }
}

function updateConnectionStatus(status, text) {
  const dot = document.getElementById('connectionDot');
  const textEl = document.getElementById('connectionText');
  
  dot.className = 'connection-dot';
  if (status === 'connected') dot.classList.add('connected');
  if (status === 'error') dot.classList.add('error');
  
  textEl.textContent = text;
}

// ============================================
// UI更新
// ============================================
function updateTimerDisplay() {
  document.getElementById('timerDisplay').textContent = formatTime(state.remainingSeconds);
  
  const totalSeconds = state.isBreak ? CONFIG.BREAK_MINUTES * 60 : CONFIG.WORK_MINUTES * 60;
  // 0除算防止
  const progress = totalSeconds > 0 ? state.remainingSeconds / totalSeconds : 0;
  
  const circumference = 2 * Math.PI * 130;
  const offset = circumference * (1 - progress);
  
  const circle = document.getElementById('progressCircle');
  circle.style.strokeDashoffset = offset;
  circle.classList.toggle('work', !state.isBreak);
  
  const badge = document.getElementById('statusBadge');
  badge.textContent = state.isBreak ? '☕ 休憩中' : '🎯 作業中';
  badge.className = `status-badge ${state.isBreak ? 'status-break' : 'status-work'}`;
  
  document.getElementById('timerLabel').textContent = state.isBreak ? '休憩タイム' : '集中タイム';
}

function updateCycleIndicator() {
  const container = document.getElementById('cycleIndicator');
  container.innerHTML = '';
  
  for (let i = 0; i < 4; i++) {
    const dot = document.createElement('div');
    dot.className = 'cycle-dot';
    if (i < state.currentCycle) dot.classList.add('completed');
    if (i === state.currentCycle) dot.classList.add('current');
    container.appendChild(dot);
  }
}

function updateParticipantList() {
  const list = document.getElementById('participantList');
  list.innerHTML = '';
  
  state.participants.forEach((data, pId) => {
    const div = document.createElement('div');
    div.className = 'participant';
    div.id = `participant-${pId}`;
    
    // 最終更新から10秒以内ならオンラインとみなす
    const isOnline = data.lastSeen && (Date.now() - data.lastSeen < 15000);
    
    div.innerHTML = `
      <span class="participant-dot ${isOnline ? '' : 'offline'}"></span>
      <span>${data.nickname}${pId === state.odId ? '（自分）' : ''}</span>
    `;
    list.appendChild(div);
  });
  
  document.getElementById('participantCount').textContent = state.participants.size;
}

function updateCallUI() {
  const callUI = document.getElementById('callUI');
  callUI.classList.toggle('active', state.isBreak);
  
  // 休憩に入ったら通話開始、作業に戻ったら終了
  // (実際のストリーム制御は setupFirebaseListeners で呼ばれる startCall/endCall で行う)
}

function showMainScreen() {
  document.getElementById('joinScreen').classList.remove('active');
  document.getElementById('mainScreen').classList.add('active');
  document.getElementById('roomCodeDisplay').textContent = state.roomId;
}

// ============================================
// Firebase ルーム管理
// ============================================
async function createRoom() {
  const nickname = document.getElementById('nickname').value.trim();
  if (!nickname) {
    showNotification('ニックネームを入力してください', true);
    return;
  }

  state.nickname = nickname;
  state.roomId = generateId();
  state.odId = generateId(10); // PeerIDとしても使う
  state.isHost = true;

  await initializeRoom();
}

async function joinRoom() {
  const nickname = document.getElementById('nickname').value.trim();
  const roomId = document.getElementById('roomId').value.trim().toUpperCase();

  if (!nickname) {
    showNotification('ニックネームを入力してください', true);
    return;
  }
  if (!roomId) {
    showNotification('ルームIDを入力してください', true);
    return;
  }

  // ルームの存在確認
  const roomSnapshot = await state.database.ref(`rooms/${roomId}`).once('value');
  if (!roomSnapshot.exists()) {
    showNotification('ルームが見つかりません', true);
    return;
  }

  state.nickname = nickname;
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
        remainingSeconds: CONFIG.WORK_MINUTES * 60,
        isBreak: false,
        isPaused: false,
        lastUpdate: firebase.database.ServerValue.TIMESTAMP,
        currentCycle: 0,
      },
      settings: {
        workMinutes: CONFIG.WORK_MINUTES,
        breakMinutes: CONFIG.BREAK_MINUTES,
      }
    });
  } else {
    // 設定を取得
    const settingsSnapshot = await state.roomRef.child('settings').once('value');
    const settings = settingsSnapshot.val();
    if (settings) {
      CONFIG.WORK_MINUTES = settings.workMinutes;
      CONFIG.BREAK_MINUTES = settings.breakMinutes;
    }
  }

  // 自分を参加者として登録
  const participantRef = state.roomRef.child(`participants/${state.odId}`);
  await participantRef.set({
    nickname: state.nickname,
    joinedAt: firebase.database.ServerValue.TIMESTAMP,
    lastSeen: firebase.database.ServerValue.TIMESTAMP,
    peerId: state.odId // PeerIDを保存して他人が接続できるようにする
  });

  // 切断時に削除
  participantRef.onDisconnect().remove();

  // 定期的にlastSeenを更新
  setInterval(() => {
    if (state.roomRef) {
      participantRef.update({ lastSeen: firebase.database.ServerValue.TIMESTAMP });
    }
  }, 5000);

  // PeerJSを初期化 (Firebase初期化後に呼び出し)
  await initializePeer();

  // リスナーを設定
  setupFirebaseListeners();

  // UI更新
  showMainScreen();

  // ホストの場合、タイマーを開始
  if (state.isHost) {
    startHostTimer();
  }

  showNotification(state.isHost ? `ルーム ${state.roomId} を作成しました` : `ルーム ${state.roomId} に参加しました`);
  
  // URLパラメータ更新（リロードしても戻れるように）
  const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + '?room=' + state.roomId;
  window.history.pushState({path:newUrl},'',newUrl);
}

function setupFirebaseListeners() {
  // 参加者の監視
  state.roomRef.child('participants').on('value', (snapshot) => {
    state.participants.clear();
    snapshot.forEach((child) => {
      state.participants.set(child.key, child.val());
    });
    updateParticipantList();
    
    // 休憩中なら、新しい参加者に接続を試みるなどの処理が可能
    if (state.isBreak && state.localStream) {
      connectToNewParticipants();
    }
  });

  // タイマーの監視
  state.roomRef.child('timer').on('value', (snapshot) => {
    const timer = snapshot.val();
    if (timer) {
      const previousIsBreak = state.isBreak;
      
      // ホスト以外はFirebaseの値で同期
      if (!state.isHost) {
        state.remainingSeconds = timer.remainingSeconds;
        state.isPaused = timer.isPaused;
        state.currentCycle = timer.currentCycle || 0;
      }
      
      // 休憩状態は全員同期
      state.isBreak = timer.isBreak;

      updateTimerDisplay();
      updateCycleIndicator();
      updateCallUI();

      // 休憩開始/終了を検出
      if (!previousIsBreak && state.isBreak) {
        showNotification('☕ 休憩タイム！通話が始まります');
        startCall();
      } else if (previousIsBreak && !state.isBreak) {
        showNotification('🎯 作業タイム！集中しましょう');
        endCall();
      }
    }
  });

  // ルーム削除の監視
  state.roomRef.on('value', (snapshot) => {
    if (!snapshot.exists() && state.roomId) {
      showNotification('ルームが閉じられました', true);
      setTimeout(leaveRoom, 2000);
    }
  });
}

// ============================================
// ホスト用タイマー
// ============================================
function startHostTimer() {
  setInterval(() => {
    if (state.isPaused || !state.isHost || !state.roomRef) return;

    state.remainingSeconds--;

    if (state.remainingSeconds <= 0) {
      switchPhase();
    }

    // Firebaseを更新 (1秒ごと)
    state.roomRef.child('timer').update({
      remainingSeconds: state.remainingSeconds,
      isBreak: state.isBreak,
      isPaused: state.isPaused,
      currentCycle: state.currentCycle,
      lastUpdate: firebase.database.ServerValue.TIMESTAMP,
    });

    updateTimerDisplay();
  }, 1000);
}

function switchPhase() {
  const previousIsBreak = state.isBreak;
  state.isBreak = !state.isBreak;
  state.remainingSeconds = state.isBreak ? CONFIG.BREAK_MINUTES * 60 : CONFIG.WORK_MINUTES * 60;

  if (!state.isBreak) {
    state.currentCycle = (state.currentCycle + 1) % 4;
  }

  updateTimerDisplay();
  updateCycleIndicator();
  updateCallUI();

  if (state.isBreak) {
    showNotification('☕ 休憩タイム！通話が始まります');
    startCall();
  } else {
    showNotification('🎯 作業タイム！集中しましょう');
    endCall();
  }
}

// ============================================
// PeerJS 通話機能 (補完部分)
// ============================================
async function initializePeer() {
  return new Promise((resolve) => {
    state.peer = new Peer(state.odId, {
      debug: 1, // エラーを見たい場合は2か3に
    });

    state.peer.on('open', (id) => {
      console.log('My peer ID is: ' + id);
      resolve();
    });

    state.peer.on('call', (call) => {
      // 着信時（休憩中なら応答）
      if (state.isBreak && state.localStream) {
        call.answer(state.localStream);
        handleStream(call);
      }
    });

    state.peer.on('error', (err) => {
      console.error('Peer error:', err);
    });
  });
}

async function startCall() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    state.localStream = stream;
    
    // ビジュアライザー起動
    setupAudioVisualizer(stream);

    // ミュート状態を反映
    setMute(state.isMuted);

    // 他の参加者に発信
    connectToNewParticipants();
    
    showNotification('マイクが有効になりました');
  } catch (err) {
    console.error('Mic access error:', err);
    showNotification('マイクへのアクセスが拒否されました', true);
  }
}

function connectToNewParticipants() {
  state.participants.forEach((data, pId) => {
    // 自分以外、かつまだ接続していない相手に発信
    if (pId !== state.odId && !state.connections.has(pId)) {
      if (state.localStream) {
        const call = state.peer.call(pId, state.localStream);
        if (call) {
          handleStream(call);
        }
      }
    }
  });
}

function handleStream(call) {
  const peerId = call.peer;
  state.connections.set(peerId, call);

  call.on('stream', (remoteStream) => {
    // 音声を再生するためのAudio要素作成（画面には表示しない）
    let audio = document.getElementById(`audio-${peerId}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `audio-${peerId}`;
      audio.autoplay = true;
      document.body.appendChild(audio);
    }
    audio.srcObject = remoteStream;
    
    // UI反映（話している人を光らせるなど）
    // ※今回は簡易実装のため省略。本格的にはAudioContextで音量検知が必要
  });

  call.on('close', () => {
    cleanupConnection(peerId);
  });
  
  call.on('error', () => {
    cleanupConnection(peerId);
  });
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
    state.localStream.getTracks().forEach(track => track.stop());
    state.localStream = null;
  }
  
  // 全通話を切断
  state.connections.forEach(call => call.close());
  state.connections.clear();
  
  // Audio要素の掃除
  document.querySelectorAll('audio').forEach(el => el.remove());
  
  // ビジュアライザー停止
  if (state.audioContext) {
    state.audioContext.close();
    state.audioContext = null;
  }
}

function toggleMute() {
  state.isMuted = !state.isMuted;
  setMute(state.isMuted);
  
  const btn = document.getElementById('muteBtn');
  if (state.isMuted) {
    btn.innerHTML = '🔇 ミュート中';
    btn.classList.add('active');
  } else {
    btn.innerHTML = '🎤 ミュート';
    btn.classList.remove('active');
  }
}

function setMute(muted) {
  if (state.localStream) {
    state.localStream.getAudioTracks().forEach(track => {
      track.enabled = !muted;
    });
  }
}

// ============================================
// オーディオビジュアライザー (簡易版)
// ============================================
function setupAudioVisualizer(stream) {
  if (!window.AudioContext && !window.webkitAudioContext) return;
  
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  state.audioContext = new AudioContext();
  const src = state.audioContext.createMediaStreamSource(stream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 64; // バーの本数に合わせて調整
  src.connect(state.analyser);
  
  const bufferLength = state.analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  const bars = document.querySelectorAll('.audio-bar');
  
  function renderFrame() {
    if (!state.localStream || !state.audioContext) return;
    
    requestAnimationFrame(renderFrame);
    state.analyser.getByteFrequencyData(dataArray);
    
    // バーの高さに反映 (簡易的)
    bars.forEach((bar, index) => {
      // 低音域から適当にピックアップ
      const value = dataArray[index + 2] || 0;
      const height = Math.max(4, value / 4); // 最大高さを調整
      bar.style.height = `${height}px`;
    });
  }
  
  renderFrame();
}

// ============================================
// その他の操作
// ============================================
function copyRoomCode() {
  if (state.roomId) {
    navigator.clipboard.writeText(state.roomId).then(() => {
      showNotification('ルームIDをコピーしました');
    });
  }
}

function leaveRoom() {
  // 接続解除
  endCall();
  if (state.peer) state.peer.destroy();
  if (state.roomRef) state.roomRef.off(); // リスナー解除
  
  // ページリロードでリセット
  window.location.href = window.location.pathname;
}

// ============================================
// 設定モーダル
// ============================================
function toggleSettings() {
  const modal = document.getElementById('settingsModal');
  modal.classList.toggle('active');
}

function saveSettings() {
  const work = parseInt(document.getElementById('workMinutes').value);
  const brk = parseInt(document.getElementById('breakMinutes').value);
  
  if (work > 0 && brk > 0) {
    CONFIG.WORK_MINUTES = work;
    CONFIG.BREAK_MINUTES = brk;
    
    // ホストならDBにも反映
    if (state.isHost && state.roomRef) {
      state.roomRef.child('settings').update({
        workMinutes: work,
        breakMinutes: brk
      });
      // タイマーリセット
      state.remainingSeconds = state.isBreak ? brk * 60 : work * 60;
      state.roomRef.child('timer').update({
        remainingSeconds: state.remainingSeconds
      });
    }
    
    updateTimerDisplay();
    toggleSettings();
  }
}

// モーダル外クリックで閉じる
document.getElementById('settingsModal').addEventListener('click', (e) => {
  if (e.target.id === 'settingsModal') {
    toggleSettings();
  }
});