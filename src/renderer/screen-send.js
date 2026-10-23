'use strict';
// Only accept ICE candidates on the local network or a private overlay such as Tailscale (private, CGNAT 100.64.0.0/10,
// link-local, loopback or mDNS .local names).
function lanCandidate(c) {
  const parts = String((c && c.candidate) || '').split(' ');
  const addr = (parts[4] || '').toLowerCase();
  if (/^[0-9a-f-]+\.local$/.test(addr)) return true; // Chromium mDNS host name
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) {
    const [a, b] = addr.split('.').map(Number);
    return a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31);
  }
  // IPv6 literal only (hex groups and colons)
  if (!/^[0-9a-f:]+$/.test(addr) || !addr.includes(':')) return false;
  return addr === '::1' || /^fe[89ab][0-9a-f]:/.test(addr) || /^f[cd][0-9a-f]{2}:/.test(addr);
}
// Hidden capture window on the machine being viewed: captures the primary display and offers it over WebRTC.
const api = window.screenApi;
let pc = null;

async function capture() {
  const src = await api.source();
  if (src.fake) {
    // test mode (DEVLINK_FAKE_SCREEN=1): an animated canvas instead of the real screen
    const c = document.getElementById('fake');
    const g = c.getContext('2d');
    let t = 0;
    setInterval(() => {
      t++;
      g.fillStyle = `hsl(${t % 360} 60% 30%)`;
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#fff';
      g.font = '64px sans-serif';
      g.fillText(`DevLink test screen ${t}`, 80, 360);
    }, 33);
    return c.captureStream(30);
  }
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id, maxWidth: 2560, maxHeight: 1600, maxFrameRate: 30 } },
  });
}

async function start() {
  const stream = await capture();
  pc = new RTCPeerConnection({ iceServers: [] }); // LAN only
  for (const track of stream.getVideoTracks()) {
    track.contentHint = 'detail'; // keep text sharp rather than motion smooth
    pc.addTrack(track, stream);
  }
  pc.onicecandidate = (e) => e.candidate && api.signal({ candidate: e.candidate.toJSON() });
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') api.live();
    if (pc.connectionState === 'failed') api.stop();
  };
  const sender = pc.getSenders()[0];
  const p = sender.getParameters();
  p.encodings = [{ ...(p.encodings && p.encodings[0]), maxBitrate: 8_000_000, maxFramerate: 30 }];
  p.degradationPreference = 'maintain-resolution';
  await sender.setParameters(p).catch(() => undefined);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  api.signal({ type: 'offer', sdp: offer.sdp });
}

api.onSignal(async (d) => {
  if (!pc || !d) return;
  if (d.type === 'answer') await pc.setRemoteDescription({ type: 'answer', sdp: String(d.sdp) });
  else if (d.candidate && lanCandidate(d.candidate)) await pc.addIceCandidate(d.candidate);
});

api.hello().then(start).catch((e) => {
  console.error('screen capture failed', e);
  api.stop();
});
