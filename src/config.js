import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_ASSETS_DIR = path.resolve(__dirname, "../../golden-hour/game");
const CRAWL_DIR = path.resolve(__dirname, "../../Game/crawl");
const LOCAL_CLIENT_DIR = (() => {
  try {
    const versions = fs.readdirSync(CRAWL_DIR)
      .filter((name) => /^app-v\d+$/.test(name))
      .sort((a, b) => Number(b.slice(5)) - Number(a.slice(5)));
    for (const name of versions) {
      const candidate = path.join(CRAWL_DIR, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}
  return path.join(CRAWL_DIR, "app");
})();

export const ASSETS_DIR =
  process.env.ASSETS_DIR ||
  (fs.existsSync(DEFAULT_ASSETS_DIR) ? DEFAULT_ASSETS_DIR : LOCAL_CLIENT_DIR);

export const MAPS_DIR =
  process.env.MAPS_DIR ||
  path.resolve(__dirname, "../map");

export const PORT = Number(process.env.PORT || 8123);

export const RTC_ICE_SERVERS = (() => {
  const raw = process.env.ICE_SERVERS;
  if (!raw) return [{ urls: "stun:stun.l.google.com:19302" }];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
})();

export const WEAPONS = ["ar", "smg", "shotgun", "pistol", "m200"];

export const WEAPON_SPECS = [
  { id: "ar",      interval: 0.1,  reloadMs: 2000, mag: 30, reserve: 120, pellets: 1, range: 140, damage: 28, name: "KR-7 CARBINE" },
  { id: "smg",     interval: 0.07, reloadMs: 1700, mag: 32, reserve: 128, pellets: 1, range: 90,  damage: 22, name: "VESPER 9" },
  { id: "shotgun", interval: 0.9,  reloadMs: 2600, mag: 6,  reserve: 24,  pellets: 8, range: 30,  damage: 12, name: "M12 BREACHER" },
  { id: "pistol",  interval: 0.18, reloadMs: 1300, mag: 12, reserve: 60,  pellets: 1, range: 80,  damage: 34, name: "STRIX 9" },
  { id: "m200",    interval: 60 / 38, reloadMs: 2800, mag: 5, reserve: 25, pellets: 1, range: 180, rangeStart: 70, damage: 110, damageFar: 100, headMultiplier: 2.25, name: "M200 INTERVENTION" },
];

export const weaponSpec = (id) =>
  WEAPON_SPECS.find((w) => w.id === id) || WEAPON_SPECS[0];

export const MATCH = {
  capacity: 10,
  teamCount: 2,
  teamSize: 5,
  scoreLimit: 40,
  timeLimitMs: 180_000,
  countdownMs: 3_000,
  respawnMs: 3_000,
  spawnProtectionMs: 3_000,
  snapshotHz: 15,
  tickHz: 30,
  startHealth: 100,
  killScore: 100,
  lagCompensationMs: 1_000,
  lagHistoryMs: 5_000,
};

export const MODES = [
  { id: "tdm", name: "团队死斗", clientAdapter: "teams" },
  { id: "test", name: "反作弊测试", clientAdapter: "teams", hidden: true },
  { id: "hackbot", name: "Bot测试", clientAdapter: "teams", hidden: true },
];

export function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

const MAP_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAP_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function discoverMaps(dir) {
  let entries = [];
  try {
    for (const mapDir of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!mapDir.isDirectory() || !MAP_ID.test(mapDir.name)) continue;
      const mapPath = path.join(dir, mapDir.name);
      const versions = fs.readdirSync(mapPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && MAP_VERSION.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of versions) {
        const folder = path.join(mapPath, version);
        if (readJsonSafe(path.join(folder, "manifest.json")) &&
            readJsonSafe(path.join(folder, "world.json"))) {
          entries.push({ id: mapDir.name, version });
          break;
        }
      }
    }
  } catch {
    entries = [];
  }
  return entries.length
    ? { defaultMap: entries[0].id, defaultMode: "tdm", maps: entries }
    : null;
}

export function loadMapLibrary() {
  const legacyDir = path.join(ASSETS_DIR, "assets", "maps");
  let mapsDir = legacyDir;
  let catalog = readJsonSafe(path.join(MAPS_DIR, "catalog.json"));

  if (catalog) {
    mapsDir = MAPS_DIR;
  } else {
    const discovered = discoverMaps(MAPS_DIR);
    if (discovered) {
      mapsDir = MAPS_DIR;
      catalog = discovered;
    } else {
      catalog = readJsonSafe(path.join(legacyDir, "catalog.json"));
    }
  }

  const maps = [];
  if (catalog && Array.isArray(catalog.maps)) {
    for (const entry of catalog.maps) {
      if (!entry || !MAP_ID.test(entry.id) || !MAP_VERSION.test(entry.version)) continue;
      const folder = path.join(mapsDir, entry.id, entry.version);
      const manifest = readJsonSafe(path.join(folder, "manifest.json"));
      const world = readJsonSafe(path.join(folder, "world.json"));
      const gameplay = readJsonSafe(path.join(folder, "gameplay.json"));
      if (!manifest || !world) continue;
      maps.push({
        id: entry.id,
        version: entry.version,
        name: manifest.name || entry.id,
        clientScene: manifest.clientScene || "hotel",
        sceneAsset: manifest.sceneAsset || null,
        sceneSHA256: manifest.sceneSHA256 || null,
        sceneBytes: manifest.sceneBytes || null,
        environment: manifest.environment || null,
        world,
        gameplay: gameplay || { spawns: [] },
      });
    }
  }

  return {
    defaultMap: catalog?.defaultMap || maps[0]?.id || "hotel",
    defaultMode: catalog?.defaultMode || "tdm",
    maps,
    mapsDir,
  };
}
