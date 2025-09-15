// script.js
const socket = io();

// UI elements
const findBtn = document.getElementById('findBtn');
const leaveBtn = document.getElementById('leaveBtn');
const newBtn = document.getElementById('newBtn');
const startVideoBtn = document.getElementById('startVideoBtn');
const toggleAudioBtn = document.getElementById('toggleAudioBtn');
const statusEl = document.getElementById('status');
const messagesEl = document.getElementById('messages');
const msgForm = document.getElementById('msgForm');
const msgInput = document.getElementById('msgInput');
const typingEl = document.getElementById('typing');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');

let partnerId = null;
let isBot = false;
let typingTimer = null;

// WebRTC variables
let pc = null;
let localStream = null;
let remoteStream = null;
let audioEnabled = true;

// STUN servers
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
    // Add TURN servers here for production / NAT traversal if needed
  ]
};

// ---------------- Helpers ----------------
function addMessage(text, cls='stranger') {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setStatus(text) {
  statusEl.textContent = text;
}

// Enable/disable UI controls based on connection
function updateUiForPaired() {
  startVideoBtn.disabled = false;
  newBtn.disabled = false;
  leaveBtn.disabled = false;
  findBtn.disabled = true;
  toggleAudioBtn.disabled = true; // enabled once we have local stream
}

// ---------------- Pairing & text ----------------
findBtn.addEventListener('click', async () => {
  // Request camera/mic permissions before proceeding
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    console.log('Media permissions granted.');

    // Proceed with the 'find' request only after permissions are granted
    socket.emit('find');
    setStatus('Searching for a stranger...');
    findBtn.disabled = true;

  } catch (err) {
    console.error('Permission denied or media not available:', err);
    setStatus('Please allow camera and microphone access to find a stranger.');
    // Re-enable the button if permission is denied
    findBtn.disabled = false;
  }
});

leaveBtn.addEventListener('click', () => {
  socket.emit('leave');
  resetChatUI();
  teardownCall();
});

newBtn.addEventListener('click', () => {
  socket.emit('leave');
  resetChatUI();
  teardownCall();
  socket.emit('find');
  setStatus('Searching for a stranger...');
});

msgForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text) return;
  socket.emit('message', { text });
  msgInput.value = '';
});

msgInput.addEventListener('input', () => {
  socket.emit('typing', true);
  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    socket.emit('typing', false);
  }, 600);
});

// ---------------- WebRTC logic ----------------
startVideoBtn.addEventListener('click', async () => {
  if (!partnerId || isBot) {
    alert('No human partner connected for video.');
    return;
  }
  startVideoBtn.disabled = true;
  try {
    await startLocalStream();
    createPeerConnection();
    // Add local tracks
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    // create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { sdp: offer });
    setStatus('Calling — waiting for answer...');
  } catch (err) {
    console.error('Failed to start call', err);
    setStatus('Could not access camera/mic or start call.');
    startVideoBtn.disabled = false;
  }
});

toggleAudioBtn.addEventListener('click', () => {
  if (!localStream) return;
  audioEnabled = !audioEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = audioEnabled);
  toggleAudioBtn.textContent = audioEnabled ? 'Mute' : 'Unmute';
});

// get user media
async function startLocalStream() {
  if (localStream) return;
  const constraints = { audio: true, video: true };
  localStream = await navigator.mediaDevices.getUserMedia(constraints);
  localVideo.srcObject = localStream;
  toggleAudioBtn.disabled = false;
}

// create RTCPeerConnection and handlers
function createPeerConnection() {
  if (pc) return;
  pc = new RTCPeerConnection(rtcConfig);

  // keep a stream to collect remote tracks
  remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;

  pc.ontrack = (event) => {
    event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', { candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('PC state:', pc.connectionState);
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      // remote disconnected
      teardownCall();
    }
  };
}

// handle incoming offer (answer automatically)
socket.on('webrtc-offer', async (data) => {
  // someone called us
  if (isBot) {
    console.log('Bot cannot accept video offer.');
    return;
  }
  partnerId = data.from; // update partner just in case
  try {
    await startLocalStream();
    createPeerConnection();
    // add local tracks
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    const desc = new RTCSessionDescription(data.sdp);
    await pc.setRemoteDescription(desc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc-answer', { to: data.from, sdp: answer });
    setStatus('In video call');
  } catch (err) {
    console.error('Error answering offer', err);
  }
});

socket.on('webrtc-answer', async (data) => {
  try {
    if (!pc) createPeerConnection();
    const desc = new RTCSessionDescription(data.sdp);
    await pc.setRemoteDescription(desc);
    setStatus('In video call');
  } catch (err) {
    console.error('Error handling answer', err);
  }
});

socket.on('webrtc-ice-candidate', async (data) => {
  try {
    if (!pc) return;
    await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
  } catch (err) {
    console.warn('Failed to add ICE candidate', err);
  }
});

// teardown peer connection and local stream
function teardownCall() {
  if (pc) {
    try { pc.close(); } catch (e) {}
    pc = null;
  }
  if (remoteStream) {
    remoteStream.getTracks().forEach(t => t.stop());
    remoteStream = null;
    remoteVideo.srcObject = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    localVideo.srcObject = null;
    toggleAudioBtn.disabled = true;
    toggleAudioBtn.textContent = 'Mute';
    audioEnabled = true;
  }
  startVideoBtn.disabled = false;
  setStatus(partnerId ? 'Connected (no active call)' : 'Not connected');
}

// ---------------- Socket handlers ----------------
socket.on('connect', () => {
  setStatus('Connected to server. Click "Find Stranger" to start.');
  findBtn.disabled = false;
});

socket.on('status', (data) => {
  setStatus(data.msg || '');
});

socket.on('paired', (data) => {
  partnerId = data.partnerId;
  isBot = !!data.bot;
  updateUiForPaired();
  setStatus(isBot ? 'Paired with a bot.' : 'Paired with a stranger.');
  messagesEl.innerHTML = '';
  addMessage(isBot ? 'You are chatting with a bot.' : 'You are now connected. Say hi!', isBot ? 'bot' : 'stranger');
});

socket.on('message', (data) => {
  if (data.from === 'you') {
    addMessage(data.text, 'you');
  } else if (data.from === 'bot') {
    addMessage(data.text, 'bot');
  } else {
    addMessage(data.text, 'stranger');
  }
});

socket.on('typing', (isTyping) => {
  typingEl.textContent = isTyping ? 'Stranger is typing...' : '';
});

socket.on('partner-left', () => {
  // partner closed or disconnected
  teardownCall();
  setStatus('Partner left the chat.');
  addMessage('Partner left the chat.', 'bot');
  partnerId = null;
  isBot = false;
  findBtn.disabled = false;
  leaveBtn.disabled = true;
  newBtn.disabled = true;
  startVideoBtn.disabled = true;
});

// server asks client to retry finding
socket.on('retry', () => {
  setTimeout(() => {
    socket.emit('find');
  }, 600);
});

// reset UI when leaving
function resetChatUI() {
  partnerId = null;
  isBot = false;
  messagesEl.innerHTML = '';
  typingEl.textContent = '';
  setStatus('Not connected');
  findBtn.disabled = false;
  leaveBtn.disabled = true;
  newBtn.disabled = true;
  startVideoBtn.disabled = true;
  teardownCall();
}

// handle unload
window.addEventListener('beforeunload', () => {
  socket.disconnect();
  teardownCall();
});