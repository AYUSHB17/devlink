'use strict';
// Viewer: receives the other machine's screen over WebRTC. Signalling arrives via DevLink's encrypted session.
const api = window.screenApi;
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const msg = document.getElementById('msg');
const stats = document.getElementById('stats');
let pc = null;
let mini = false;
let ended = false;
const show = (text) => { msg.textContent = text; overlay.classList.remove('hidden'); };

(async () => {
  const info = await api.hello();
  document.getElementById('who').textContent = info.name;
  document.title = `${info.name} – screen`;
  show(`Waiting for ${info.name} to allow screen viewing…`);
})();

api.onSignal(async (d) => {
  try {
    if (d && d.type === 'offer') {
      if (pc) pc.close();
      pc = new RTCPeerConnection({ iceServers: [] }); // LAN only
      pc.ontrack = (e) => {
        video.srcObject = e.streams[0];
        overlay.classList.add('hidden');
        api.live();
      };
      pc.onicecandidate = (e) => e.candidate && api.signal({ candidate: e.candidate.toJSON() });
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') show('Connection failed. Both machines must be on the same network.');
      };
      await pc.setRemoteDescription({ type: 'offer', sdp: String(d.sdp) });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      api.signal({ type: 'answer', sdp: answer.sdp });
    } else if (d && d.candidate && pc) {
      await pc.addIceCandidate(d.candidate);
    }
  } catch (e) {
    show('Could not start the video: ' + e.message);
  }
});

api.onEnded((reason) => {
  ended = true;
  document.getElementById('stop').textContent = 'Close';
  if (pc) pc.close();
  pc = null;
  video.srcObject = null;
  show(reason);
});

document.getElementById('stop').onclick = () => (ended ? window.close() : api.stop());
document.getElementById('mini').onclick = () => {
  mini = !mini;
  document.body.classList.toggle('mini', mini);
  document.getElementById('mini').textContent = mini ? 'Full window' : 'Mini player';
  api.mini(mini);
};
video.ondblclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());

// small resolution / fps readout
setInterval(async () => {
  if (!pc) return (stats.textContent = '');
  const r = await pc.getStats();
  r.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') stats.textContent = `${s.frameWidth || '?'}×${s.frameHeight || '?'} · ${Math.round(s.framesPerSecond || 0)} fps`;
  });
}, 1000);
