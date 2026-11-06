// Diagnoses the machine rather than the game: what ICE candidates does Chrome gather here,
// and can two RTCPeerConnections in this browser reach each other with no broker at all?
import { chromium } from 'playwright-core';

const flagSets = { default: [], 'no-mdns': ['--disable-features=WebRtcHideLocalIpsWithMdns'] };

const pageCode = async (iceServers) => {
  const gather = async (servers) => {
    const pc = new RTCPeerConnection({ iceServers: servers });
    const seen = [];
    const errors = [];
    pc.onicecandidate = (e) => { if (e.candidate?.candidate) seen.push(e.candidate.candidate); };
    pc.onicecandidateerror = (e) => errors.push(`${e.url} ${e.errorCode} ${e.errorText}`);
    pc.createDataChannel('x');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((done) => {
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') done(); };
      setTimeout(done, 8000);
    });
    pc.close();
    return { candidates: seen.map((c) => c.split(' ').filter((_, i) => [2, 4, 5, 7].includes(i)).join(' ')), errors: errors.slice(0, 3) };
  };
  const direct = async () => {
    const a = new RTCPeerConnection({ iceServers: [] });
    const b = new RTCPeerConnection({ iceServers: [] });
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
    const dc = a.createDataChannel('x');
    const opened = new Promise((done) => { dc.onopen = () => done('open'); setTimeout(() => done(`no: ${a.connectionState}/${a.iceConnectionState}`), 9000); });
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    const result = await opened;
    a.close();
    b.close();
    return result;
  };
  return { gathered: await gather(iceServers), sameBrowserLoopback: await direct() };
};

for (const [name, args] of Object.entries(flagSets)) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args });
  const page = await (await browser.newContext()).newPage();
  await page.goto('about:blank');
  const out = await page.evaluate(pageCode, [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }]);
  console.log(`--- ${name}`);
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
}
