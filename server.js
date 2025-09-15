// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// pairing structures
let waitingQueue = [];
const partners = new Map(); // socketId -> partnerSocketId or 'bot'

// bot fallback toggle
const ENABLE_BOT_FALLBACK = true;

function pairSockets(s1, s2) {
  partners.set(s1.id, s2.id);
  partners.set(s2.id, s1.id);

  const room = `room_${s1.id}_${s2.id}`;
  s1.join(room);
  s2.join(room);

  s1.emit('paired', { partnerId: s2.id });
  s2.emit('paired', { partnerId: s1.id });
  console.log(`Paired ${s1.id} <-> ${s2.id}`);
}

io.on('connection', (socket) => {
  console.log('New connection', socket.id);

  socket.on('find', () => {
    if (partners.has(socket.id)) {
      socket.emit('status', { msg: 'Already connected' });
      return;
    }

    if (waitingQueue.length > 0) {
      const otherId = waitingQueue.shift();
      const otherSocket = io.sockets.sockets.get(otherId);
      if (otherSocket && otherSocket.connected) {
        pairSockets(socket, otherSocket);
      } else {
        // candidate disconnected, let client retry
        socket.emit('status', { msg: 'Candidate disconnected; retrying...' });
        socket.emit('retry');
      }
    } else {
      waitingQueue.push(socket.id);
      socket.emit('status', { msg: 'Waiting for a partner...' });

      if (ENABLE_BOT_FALLBACK) {
        socket.botTimeout = setTimeout(() => {
          if (waitingQueue.includes(socket.id) && !partners.has(socket.id)) {
            waitingQueue = waitingQueue.filter(id => id !== socket.id);
            partners.set(socket.id, 'bot');
            socket.emit('paired', { partnerId: 'bot', bot: true });
            socket.emit('message', { from: 'bot', text: "Hi — I'm a bot while you wait. Try 'New' to find a human." });
          }
        }, 15000);
      }
    }
  });

  // SIGNALING: forward offer/answer/ice to partner
  socket.on('webrtc-offer', (payload) => {
    const partnerId = partners.get(socket.id);
    if (!partnerId || partnerId === 'bot') return;
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket && partnerSocket.connected) {
      partnerSocket.emit('webrtc-offer', { from: socket.id, sdp: payload.sdp });
    } else {
      socket.emit('status', { msg: 'Partner disconnected (during offer).' });
    }
  });

  socket.on('webrtc-answer', (payload) => {
    const partnerSocket = io.sockets.sockets.get(payload.to);
    if (partnerSocket && partnerSocket.connected) {
      partnerSocket.emit('webrtc-answer', { from: socket.id, sdp: payload.sdp });
    }
  });

  socket.on('webrtc-ice-candidate', (payload) => {
    const partnerId = partners.get(socket.id);
    if (!partnerId || partnerId === 'bot') return;
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket && partnerSocket.connected) {
      partnerSocket.emit('webrtc-ice-candidate', { from: socket.id, candidate: payload.candidate });
    }
  });

  // text messages (same as before)
  socket.on('message', (data) => {
    const partnerId = partners.get(socket.id);
    if (!partnerId) {
      socket.emit('status', { msg: 'No partner to send to.' });
      return;
    }
    if (partnerId === 'bot') {
      setTimeout(() => {
        socket.emit('message', { from: 'bot', text: `Bot: I heard "${data.text}".` });
      }, 700);
      return;
    }
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket && partnerSocket.connected) {
      partnerSocket.emit('message', { from: 'stranger', text: data.text });
      socket.emit('message', { from: 'you', text: data.text });
    } else {
      socket.emit('status', { msg: 'Partner disconnected.' });
      cleanupPartner(socket.id);
    }
  });

  socket.on('typing', (isTyping) => {
    const partnerId = partners.get(socket.id);
    if (!partnerId || partnerId === 'bot') return;
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket && partnerSocket.connected) {
      partnerSocket.emit('typing', isTyping);
    }
  });

  socket.on('leave', () => {
    const partnerId = partners.get(socket.id);
    if (partnerId === 'bot') {
      partners.delete(socket.id);
      socket.emit('status', { msg: 'Left bot conversation.' });
      return;
    }
    if (!partnerId) {
      waitingQueue = waitingQueue.filter(id => id !== socket.id);
      socket.emit('status', { msg: 'Stopped waiting.' });
      return;
    }
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket && partnerSocket.connected) {
      partnerSocket.emit('status', { msg: 'Partner left the chat.' });
      // also inform partner to teardown any WebRTC stuff
      partnerSocket.emit('partner-left');
      partners.delete(partnerId);
    }
    partners.delete(socket.id);
    socket.emit('status', { msg: 'You left the chat.' });
  });

  socket.on('disconnect', () => {
    console.log('Disconnect', socket.id);
    if (socket.botTimeout) clearTimeout(socket.botTimeout);
    waitingQueue = waitingQueue.filter(id => id !== socket.id);
    const partnerId = partners.get(socket.id);
    if (!partnerId) return;
    if (partnerId === 'bot') {
      partners.delete(socket.id);
      return;
    }
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket && partnerSocket.connected) {
      partnerSocket.emit('status', { msg: 'Partner disconnected.' });
      partnerSocket.emit('partner-left');
      partners.delete(partnerId);
    }
    partners.delete(socket.id);
  });
});

function cleanupPartner(socketId) {
  const partnerId = partners.get(socketId);
  if (!partnerId) return;
  if (partnerId !== 'bot') partners.delete(partnerId);
  partners.delete(socketId);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
