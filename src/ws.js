                                                     
import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP = { TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 };
const MAX_FRAME_BYTES = 128 * 1024;
const MAX_BUFFER_BYTES = MAX_FRAME_BYTES + 14;

export function selectProtocol(req) {
  const offered = (req.headers["sec-websocket-protocol"] || "").split(",");
  return offered.map((s) => s.trim()).includes("gh-pvp-v1") ? "gh-pvp-v1" : "";
}

export function acceptUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) throw new Error("缺少 Sec-WebSocket-Key");
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  const protocol = selectProtocol(req);
  const headers = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
  ];
  if (protocol) headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
  socket.write(headers.join("\r\n") + "\r\n\r\n");
  return protocol;
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

                                  
function parseFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) === 0x80;
    let len = b1 & 0x7f;
    let head = 2;
    if (len === 126) {
      if (offset + 4 > buffer.length) break;
      len = buffer.readUInt16BE(offset + 2);
      head = 4;
    } else if (len === 127) {
      if (offset + 10 > buffer.length) break;
      const hi = buffer.readBigUInt64BE(offset + 2);
      if (hi > BigInt(Number.MAX_SAFE_INTEGER)) break;
      len = Number(hi);
      head = 10;
    }
    let maskKey = null;
    if (masked) {
      if (offset + head + 4 > buffer.length) break;
      maskKey = buffer.slice(offset + head, offset + head + 4);
      head += 4;
    }
    if (offset + head + len > buffer.length) break;
    const payload = Buffer.from(buffer.slice(offset + head, offset + head + len));
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    frames.push({ opcode, payload });
    offset += head + len;
  }
  return { frames, rest: buffer.slice(offset) };
}

export class WsConnection {
  constructor(socket, { onText, onBinary, onClose } = {}) {
    this.socket = socket;
    this.onText = onText;
    this.onBinary = onBinary;
    this.onClose = onClose;
    this.buffer = Buffer.alloc(0);
    this.closed = false;

    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > MAX_BUFFER_BYTES) {
        this.destroy();
        return;
      }
      const { frames, rest } = parseFrames(this.buffer);
      this.buffer = rest;
      for (const frame of frames) this.dispatch(frame);
    });
    socket.on("close", () => this.destroy());
    socket.on("error", () => this.destroy());
  }

  dispatch({ opcode, payload }) {
    if (payload.length > MAX_FRAME_BYTES) {
      this.destroy();
      return;
    }
    if (opcode === OP.PING) {
      this.sendFrame(OP.PONG, payload);
      return;
    }
    if (opcode === OP.PONG) return;
    if (opcode === OP.CLOSE) return this.destroy();
    if (opcode === OP.TEXT) this.onText?.(payload.toString("utf-8"), this);
    else if (opcode === OP.BINARY) this.onBinary?.(new Uint8Array(payload), this);
  }

  sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(encodeFrame(opcode, payload));
  }

  sendJSON(message) {
    this.sendFrame(OP.TEXT, Buffer.from(JSON.stringify(message) + "\n", "utf-8"));
  }

  sendSnapshot(buffer) {
    this.sendFrame(OP.BINARY, buffer);
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.end(); } catch {}
    this.onClose?.(this);
  }
}
