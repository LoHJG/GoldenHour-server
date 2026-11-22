import { loadMapLibrary, MODES, PORT } from "./config.js";
import { createServer } from "./http.js";
import { loadTlsConfig } from "./tls.js";

const library = loadMapLibrary();
library.modes = MODES;
library.defaultMode = MODES.some((mode) => mode.id === library.defaultMode) ? library.defaultMode : MODES[0].id;

if (!library.maps.length) {
  console.error("未在镜像目录找到地图数据，请检查 ASSETS_DIR：", process.env.ASSETS_DIR || "../../golden-hour/game");
  process.exit(1);
}

const tls = loadTlsConfig();
if (tls.status !== "missing") console.log(`TLS: ${tls.message}`);

const { server, manager } = createServer(library, { tls: tls.options });
const scheme = tls.options ? "https" : "http";
const wsScheme = tls.options ? "wss" : "ws";

server.listen(PORT, () => {
  console.log(`Golden Hour 联机后端已启动：${scheme}://127.0.0.1:${PORT}/`);
  console.log(`地图 ${library.maps.length} 张：${library.maps.map((m) => m.id).join(", ")}`);
  console.log("REST: /api/config /api/catalog /api/maps/:id /api/rooms/events /api/health");
  console.log(`${wsScheme.toUpperCase()}: ${wsScheme}://127.0.0.1:${PORT}/api/socket`);
  console.log(`WebRTC signaling: POST ${scheme}://127.0.0.1:${PORT}/api/rtc`);
});

process.on("SIGINT", () => {
  manager.shutdown();
  server.close(() => process.exit(0));
});
