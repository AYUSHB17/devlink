'use strict';
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
  else if (d.candidate) await pc.addIceCandidate(d.candidate);
});

api.hello().then(start).catch((e) => {
  console.error('screen capture failed', e);
  api.stop();
});
