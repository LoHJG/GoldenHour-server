import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { ASSETS_DIR, RTC_ICE_SERVERS, WEAPON_SPECS, MODES } from "./config.js";
import { RoomManager, Player, normalizeM200Build } from "./room.js";
import { WsConnection, acceptUpgrade } from "./ws.js";
import { decodeInput } from "./snapshot.js";
import { createRtcRelay } from "./rtc.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".glb": "model/gltf-binary",
  ".bin": "application/octet-stream",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".manifest": "application/manifest+json",
  ".ico": "image/x-icon",
};

function sendJSON(res, status, body, extra = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buf.length,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(buf);
}

function safeJoin(root, urlPath) {
  let clean;
  try {
    clean = decodeURIComponent(urlPath.split("?")[0]).replace(/^[/\\]+/, "");
  } catch {
    return null;
  }
  const joined = path.resolve(root, clean);
  const relative = path.relative(root, joined);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return joined;
}

function readBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function createSession(manager, conn) {
  let player = null;
  let room = null;

  function onHello(msg) {
    const name = String(msg.name || "玩家").slice(0, 16);
    const mapId = msg.mapId || libraryDefaultMap(manager);
    const modeId = msg.modeId || "tdm";
    const uid = typeof msg.uid === "string" && msg.uid ? msg.uid.slice(0, 256) : null;
    const resumeToken = typeof msg.resumeToken === "string" && msg.resumeToken ? msg.resumeToken.slice(0, 128) : null;
    const m200Build = normalizeM200Build(msg.m200Build);

    if (msg.resume && msg.room && resumeToken) {
      const existing = manager.get(msg.room)?.findByResume(resumeToken);
      if (existing) {
        player = existing;
        room = manager.get(msg.room);
        player.conn = conn;
        player.connected = true;
        if (m200Build) player.m200Build = m200Build;
        const previousClose = conn.onClose;
        conn.onClose = () => {
          if (previousClose) previousClose();
          if (room && player && player.conn === conn) room.dropPlayer(player.id);
        };
        conn.sendJSON({
          type: "welcome", id: player.id, room: room.code, resume: true,
          resumeToken: player.resumeToken, inputSeq: 0, weapons: WEAPON_SPECS,
          m200Build: player.m200Build,
        });
        conn.sendJSON(room.rosterPayload());
        return;
      }
    }

    if (msg.create) {
      room = manager.create({ mapId, modeId, difficulty: msg.difficulty, quick: false, hostPlayer: null });
    } else if (msg.quick) {
      room = manager.findJoinable({ mapId, modeId }) ||
        manager.create({ mapId, modeId, difficulty: msg.difficulty, quick: true, hostPlayer: null });
    } else if (msg.room) {
      room = manager.get(String(msg.room).toUpperCase());
      if (!room || !room.canJoin()) {
        conn.sendJSON({ type: "error", message: "room is unavailable or full" });
        conn.destroy();
        return;
      }
    } else {
      conn.sendJSON({ type: "error", message: "missing room parameter" });
      conn.destroy();
      return;
    }

    player = new Player(room, { uid: uid || undefined, name, team: 0, bot: false, conn });
    player.m200Build = m200Build;
    if (!room.addSeat(player)) {
      conn.sendJSON({ type: "error", message: "room or team is full" });
      conn.destroy();
      return;
    }
    if (!room.hostId) room.hostId = player.id;

    conn.sendJSON({
      type: "welcome", id: player.id, room: room.code, resume: false,
      resumeToken: player.resumeToken, inputSeq: 0, weapons: WEAPON_SPECS,
      m200Build: player.m200Build,
    });
    conn.sendJSON(room.rosterPayload());
    manager.onRoomChanged();
  }

  return {
    onText(text) {
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;

        if (!player) {
          if (msg.type === "hello") onHello(msg);
          continue;
        }
        if (room) room.handleCommand(player, msg);
      }
    },
    onBinary(bytes) {
      if (!player || !room) return;
      const input = decodeInput(bytes);
      if (input) {
        player.input = input;
        player.ack = input.seq;
      }
    },
    onClose() {
      if (room && player) room.dropPlayer(player.id);
    },
  };
}

function libraryDefaultMap(manager) {
  return manager.library.defaultMap;
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = typeof forwarded === "string" && forwarded
    ? forwarded.split(",")[0].trim()
    : req.socket.remoteAddress;
  return String(raw || "unknown").replace(/^::ffff:/i, "").toLowerCase();
}

export function createServer(library, { tls = null } = {}) {
  const manager = new RoomManager(library);
  const rtcPeers = new Set();
  const ipCount = new Map();
  const MAX_RTC_PEERS = 128;
  const MAX_IP_CONNECTIONS = 3;

  function acquireIp(ip) {
    const count = ipCount.get(ip) || 0;
    if (count >= MAX_IP_CONNECTIONS) return false;
    ipCount.set(ip, count + 1);
    return true;
  }

  function releaseIp(ip) {
    const count = ipCount.get(ip) || 0;
    if (count <= 1) ipCount.delete(ip);
    else ipCount.set(ip, count - 1);
  }

  const requestHandler = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const p = url.pathname;

    if (p === "/api/health" && req.method === "GET") {
      return sendJSON(res, 200, {
        ok: true, status: "up", rooms: manager.directory().length,
        transports: ["webrtc", "websocket"], rtcPeers: rtcPeers.size,
      });
    }

    if (p === "/api/config" && req.method === "GET") {
      return sendJSON(res, 200, {
        websocket: true,
        preferredTransport: "webrtc",
        rtc: { url: "/api/rtc", iceServers: RTC_ICE_SERVERS },
      });
    }

    if (p === "/api/catalog" && req.method === "GET") {
      const maps = library.maps.map((m) => ({
        id: m.id, name: m.name, version: m.version,
        clientScene: m.clientScene, sceneAsset: m.sceneAsset,
        sceneSHA256: m.sceneSHA256, sceneBytes: m.sceneBytes,
        environment: m.environment, modes: MODES.map((x) => x.id),
      }));
      return sendJSON(res, 200, {
        schema: 1,
        defaultMap: library.defaultMap,
        defaultMode: library.defaultMode,
        maps,
        modes: MODES,
      });
    }

    const mapMatch = p.match(/^\/api\/maps\/([a-z0-9_-]+)$/);
    if (mapMatch && req.method === "GET") {
      const map = library.maps.find((m) => m.id === mapMatch[1]);
      if (!map) return sendJSON(res, 404, { error: "map not found" });
      const world = map.world || {};
      return sendJSON(res, 200, {
        mapId: map.id, version: map.version, name: map.name,
        clientScene: map.clientScene, sceneAsset: map.sceneAsset,
        sceneSHA256: map.sceneSHA256, sceneBytes: map.sceneBytes,
        environment: map.environment,
        bounds: world.bounds || { minX: -31, maxX: 31, minZ: -24, maxZ: 25 },
        colliders: world.colliders || [],
        glass: world.glass || [],
        nodes: world.nodes || [],
        gameplay: map.gameplay,
      });
    }

    if (p === "/api/rooms/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write(": connected\n\n");
      manager.addSse(res);
      req.on("close", () => manager.removeSse(res));
      return;
    }

    if (p === "/api/rtc") {
      if (req.method === "OPTIONS") {
        return sendJSON(res, 200, { ok: true }, {
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
      }
      if (req.method !== "POST") {
        return sendJSON(res, 405, { error: "WebRTC signaling requires POST" });
      }

      if (rtcPeers.size >= MAX_RTC_PEERS) {
        return sendJSON(res, 503, { error: "too many WebRTC peers" });
      }

      let offer;
      try {
        offer = JSON.parse(await readBody(req));
      } catch (error) {
        return sendJSON(res, 400, { error: error.message || "invalid JSON" });
      }

      if (!offer || offer.type !== "offer" || typeof offer.sdp !== "string") {
        return sendJSON(res, 400, { error: "invalid SDP offer" });
      }

      let relay;
      const ip = clientIp(req);
      if (!acquireIp(ip)) {
        return sendJSON(res, 429, { error: "too many connections from this IP" });
      }
      try {
        relay = await createRtcRelay(offer, RTC_ICE_SERVERS);
      } catch (error) {
        releaseIp(ip);
        return sendJSON(res, 400, { error: error.message || "WebRTC negotiation failed" });
      }

      const conn = relay.connection;
      const session = createSession(manager, conn);
      const idleTimer = setTimeout(() => conn.destroy(), 60_000);
      conn.onText = (text) => {
        clearTimeout(idleTimer);
        session.onText(text);
      };
      conn.onBinary = session.onBinary;
      conn.onClose = () => {
        clearTimeout(idleTimer);
        releaseIp(ip);
        rtcPeers.delete(relay);
        session.onClose();
      };
      rtcPeers.add(relay);

      return sendJSON(res, 200, relay.answer);
    }

    if (req.method === "GET") return serveStatic(req, res, url, library.mapsDir);
    return sendJSON(res, 404, { error: "not found" });
  };

  const server = tls
    ? https.createServer(tls, requestHandler)
    : http.createServer(requestHandler);

  server.on("upgrade", (req, socket) => {
    if (new URL(req.url, "http://x").pathname !== "/api/socket") {
      socket.destroy();
      return;
    }

    const ip = clientIp(req);
    if (!acquireIp(ip)) {
      socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }

    try {
      acceptUpgrade(req, socket);
    } catch {
      releaseIp(ip);
      socket.destroy();
      return;
    }

    const conn = new WsConnection(socket);
    const session = createSession(manager, conn);
    conn.onText = session.onText;
    conn.onBinary = session.onBinary;
    conn.onClose = () => {
      releaseIp(ip);
      session.onClose();
    };
  });

  return { server, manager, rtcPeers, ipCount };
}

function serveStatic(req, res, url, mapsDir) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return sendJSON(res, 400, { error: "invalid path" });
  }
  if (rel === "/") rel = "/index.html";
  let file = null;

  if (mapsDir && rel.startsWith("/assets/maps/")) {
    const mapRel = rel.slice("/assets/maps/".length);
    const mapFile = safeJoin(mapsDir, mapRel);
    if (mapFile && fs.existsSync(mapFile) && fs.statSync(mapFile).isFile()) file = mapFile;
  }

  if (!file) file = safeJoin(ASSETS_DIR, rel);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return sendJSON(res, 404, { error: "asset not found", path: rel });
  }
  const ext = path.extname(file);
  let data = fs.readFileSync(file);

  if (ext === ".html") {
    const origin = `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`;
    let html = data.toString("utf-8");
    html = html.replace(/<script>if\(window\.self===window\.top\)[\s\S]*?<\/script>/g, "");
    html = html.replace(/https?:\/\/[0-9a-zA-Z.-]+(:\d+)?/g, origin);
    data = Buffer.from(html);
  }
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": data.length,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}
