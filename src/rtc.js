import { RTCPeerConnection } from "werift";

const MAX_RELIABLE_BYTES = 64 * 1024;
const MAX_STATE_BYTES = 1200;

export class RtcConnection {
  constructor(pc) {
    this.pc = pc;
    this.reliable = null;
    this.state = null;
    this.closed = false;
    this.onText = null;
    this.onBinary = null;
    this.onClose = null;

    pc.connectionStateChange.subscribe((state) => {
      if (state === "failed" || state === "closed") this.destroy();
    });
  }

  bind(channel) {
    if (this.closed) return;

    if (channel.label === "reliable") {
      this.reliable = channel;
      channel.onMessage.subscribe((data) => {
        if (this.closed) return;
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        if (Buffer.byteLength(text, "utf8") > MAX_RELIABLE_BYTES) {
          this.destroy();
          return;
        }
        this.onText?.(text);
      });
    } else if (channel.label === "state") {
      this.state = channel;
      channel.onMessage.subscribe((data) => {
        if (this.closed) return;
        const bytes = data instanceof Uint8Array
          ? data
          : Buffer.isBuffer(data) ? new Uint8Array(data) : null;
        if (!bytes || bytes.byteLength > MAX_STATE_BYTES) {
          this.destroy();
          return;
        }
        this.onBinary?.(bytes);
      });
    } else {
      channel.close();
      return;
    }

    channel.onclose = () => this.destroy();
    channel.onerror = () => this.destroy();
  }

  sendJSON(message) {
    if (this.closed || this.reliable?.readyState !== "open") return false;
    try {
      this.reliable.send(JSON.stringify(message) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  sendSnapshot(buffer) {
    if (this.closed || this.state?.readyState !== "open") return false;
    try {
      this.state.send(Buffer.from(buffer));
      return true;
    } catch {
      return false;
    }
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    try { this.reliable?.close(); } catch {}
    try { this.state?.close(); } catch {}
    try { this.pc.close(); } catch {}
    this.onClose?.(this);
  }
}

export async function createRtcRelay(offer, iceServers = []) {
  const pc = new RTCPeerConnection({
    iceServers,
    iceUseDefaultStunServer: false,
    compatibility: "standard",
  });
  const connection = new RtcConnection(pc);
  pc.onDataChannel.subscribe((channel) => connection.bind(channel));

  await pc.setRemoteDescription(offer);
  await pc.setLocalDescription(await pc.createAnswer());

  if (pc.iceGatheringState !== "complete") {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2500);
      pc.iceGatheringStateChange.subscribe(() => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }

  const answer = pc.localDescription;
  if (!answer?.sdp) {
    connection.destroy();
    throw new Error("WebRTC answer generation failed");
  }

  return {
    connection,
    answer: { type: "answer", sdp: answer.sdp },
    close: () => connection.destroy(),
  };
}
