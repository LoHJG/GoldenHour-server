import crypto from "node:crypto";
import { MATCH, WEAPONS, WEAPON_SPECS, weaponSpec } from "./config.js";
import { encodeSnapshot } from "./snapshot.js";
import { World, STEP, heightOf } from "./world.js";

let nextPlayerId = 1;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function makeCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function boundsOf(map) {
  const b = map?.world?.bounds || {};
  const num = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  return {
    minX: num(b.minX, -31), maxX: num(b.maxX, 31),
    minZ: num(b.minZ, -24), maxZ: num(b.maxZ, 25),
  };
}

                                               
function rayPlayer(o, d, p, height = 1.8) {
  const min = { x: p.pos.x - 0.32, y: p.pos.y, z: p.pos.z - 0.32 };
  const max = { x: p.pos.x + 0.32, y: p.pos.y + height, z: p.pos.z + 0.32 };
  let tmin = 0, tmax = Infinity;
  const axes = ["x", "y", "z"];
  for (const a of axes) {
    const oa = o[a], da = d[a];
    if (Math.abs(da) < 1e-9) {
      if (oa < min[a] || oa > max[a]) return null;
    } else {
      let t1 = (min[a] - oa) / da;
      let t2 = (max[a] - oa) / da;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin >= 0 ? tmin : null;
}

export class Player {
  constructor(room, { uid, name, team, conn, bot = false, ai = false }) {
    this.id = nextPlayerId++;
    this.uid = uid || `anon-${this.id}`;
    this.resumeToken = crypto.randomBytes(16).toString("hex");
    this.name = (name || `玩家${this.id}`).slice(0, 16);
    this.team = team;
    this.bot = !!bot;
    this.ai = !!ai;
    this.conn = conn || null;
    this.connected = true;
    this.alive = false;
    this.protected = false;
    this.protectedUntil = 0;
    this.crouch = false;
    this.ground = true;
    this.sliding = false;
    this.jumpHeld = false;
    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.pitch = 0;
    this.hp = MATCH.startHealth;
    this.ammo = 0;
    this.reserve = 0;
    this.kills = 0;
    this.deaths = 0;
    this.score = 0;
    this.respawn = 0;
    this.reload = 0;
    this.reloadEndAt = 0;
    this.reloadTake = 0;
    this.reloadWeapon = "";
    this.cooldown = 0;
    this.slideCooldown = 0;
    this.slideTime = 0;
    this.slideX = 0;
    this.slideZ = 0;
    this.slideHeld = false;
    this.crouchHeld = false;
    this.weapon = "ar";
    this.weaponStates = new Map();
    this.resetWeaponStates();
    this.switchReadyAt = 0;
    this.lastMeleeAt = 0;
    this.input = { seq: 0, forward: 0, right: 0, yaw: 0, pitch: 0, buttons: 0 };
    this.ack = 0;
    this.respawnAt = 0;
    this.lastShotAt = 0;
    this.rttMs = 0;
    this.maxLagMs = MATCH.lagCompensationMs;
    this.nextPingAt = 0;
    this.pingSentAt = 0;
    this.waypoint = null;
    this.room = room;
  }

  resetWeaponStates() {
    this.weaponStates.clear();
    for (const id of WEAPONS) {
      const spec = weaponSpec(id);
      this.weaponStates.set(id, { ammo: spec.mag, reserve: spec.reserve });
    }
  }

  saveWeaponState() {
    const state = this.weaponStates.get(this.weapon);
    if (state) {
      state.ammo = this.ammo;
      state.reserve = this.reserve;
    }
  }

  loadWeaponState(weapon) {
    const spec = weaponSpec(weapon);
    const state = this.weaponStates.get(weapon) || { ammo: spec.mag, reserve: spec.reserve };
    this.ammo = state.ammo;
    this.reserve = state.reserve;
  }

  cancelReload() {
    this.reload = 0;
    this.reloadEndAt = 0;
    this.reloadTake = 0;
    this.reloadWeapon = "";
  }

  spawn() {
    const room = this.room;
    const spawns = room.spawnsFor(this.team);
    const s = spawns[Math.floor(Math.random() * spawns.length)] || { pos: [0, 0, 0], yaw: 0 };
    const num = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    this.pos = {
      x: num(s.pos?.[0], 0),
      y: num(s.pos?.[1], 0),
      z: num(s.pos?.[2], 0),
    };
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = num(s.yaw, 0);
    this.pitch = 0;
    this.hp = MATCH.startHealth;
    this.resetWeaponStates();
    this.loadWeaponState(this.weapon);
    this.cancelReload();
    this.switchReadyAt = 0;
    this.lastMeleeAt = 0;
    this.ground = false;
    this.sliding = false;
    this.crouch = false;
    this.jumpHeld = false;
    this.slideHeld = false;
    this.crouchHeld = false;
    this.slideTime = 0;
    this.slideCooldown = 0;
    this.slideX = 0;
    this.slideZ = 0;
    this.alive = true;
    this.respawn = 0;
    this.cooldown = 0;
    if (this.room.testMode && this.bot) {
      this.protected = false;
      this.protectedUntil = 0;
    } else {
      this.protected = true;
      this.protectedUntil = Date.now() + MATCH.spawnProtectionMs;
    }
    if (this.room.testMode && !this.bot) this.reserve = 9999;
  }

  eye() {
    const height = this.sliding ? 0.95 : this.crouch ? 1.2 : 1.8;
    return { x: this.pos.x, y: this.pos.y + (height >= 1.8 ? 1.62 : height >= 1.2 ? 1 : 0.72), z: this.pos.z };
  }

  forwardDir() {
    return {
      x: -Math.sin(this.yaw) * Math.cos(this.pitch),
      y: Math.sin(this.pitch),
      z: -Math.cos(this.yaw) * Math.cos(this.pitch),
    };
  }
}

export class Room {
  constructor(manager, { map, mode, difficulty, hostPlayer, quick }) {
    this.manager = manager;
    this.code = makeCode();
    this.map = map;
    this.mode = mode;
    this.difficulty = difficulty || "normal";
    this.phase = "lobby";
    this.hostId = hostPlayer?.id ?? null;
    this.players = new Map();
    this.scores = [0, 0];
    this.winner = -1;
    this.round = 0;
    this.tick = 0;
    this.countdownEnd = 0;
    this.liveEnd = 0;
    this.createdAt = Date.now();
    this.quick = !!quick;
    this.testMode = mode.id === "test";
    this.hackbotMode = mode.id === "hackbot";
    this.hidden = this.testMode || Boolean(mode.hidden);
    this.modeBot = null;
    this.testDummy = null;
    this.botBrain = null;
    this.navNodes = [];
    this.navGraph = new Map();
    this.history = new Map();
    this.lagMaxTicks = Math.max(1, Math.round(MATCH.tickHz * MATCH.lagCompensationMs / 1000));
    this.historyMaxTicks = Math.max(this.lagMaxTicks, Math.round(MATCH.tickHz * MATCH.lagHistoryMs / 1000));
    this.buildNavigation();
    this.bounds = boundsOf(map);
    this.world = new World(map?.world?.colliders || [], this.bounds);
    if (hostPlayer) this.addSeat(hostPlayer);
  }

                                
  spawnsFor(team) {
    const all = this.map.gameplay.spawns || [];
    const byTeam = all.filter((s) => (s.team ?? 0) === team);
    return byTeam.length ? byTeam : all;
  }

  addSeat(player) {
    if (this.players.has(player.id)) return false;
    if (!player.bot && !this.canJoin()) return false;
    if (!this.assignTeam(player)) return false;
    this.players.set(player.id, player);
    if ((this.testMode || this.hackbotMode) && !player.bot) this.ensureModeBot();
    if (player.conn) {
      const connection = player.conn;
      const previousClose = connection.onClose;
      connection.onClose = () => {
        if (previousClose) previousClose();
        if (player.conn === connection) this.dropPlayer(player.id);
      };
    }
    this.publish();
    return true;
  }

  ensureModeBot() {
    if ((!this.testMode && !this.hackbotMode) || this.modeBot) return;
    const human = [...this.players.values()].find((player) => !player.bot);
    const bot = new Player(this, {
      uid: `bot-${this.code}`,
      name: this.hackbotMode ? "HackBot" : "测试假人",
      team: human ? 1 - human.team : 1,
      conn: null,
      bot: true,
      ai: this.hackbotMode,
    });
    this.modeBot = bot;
    this.players.set(bot.id, bot);
    bot.spawn();
    if (this.testMode) this.testDummy = bot;
    if (this.hackbotMode) {
      this.botBrain = {
        path: [], pathAt: 0, pathTarget: null,
        target: null, targetAt: 0, nextShot: 0, nextReload: 0,
        nextJump: 0, jumpTicks: 0, dodgeUntil: 0, dodge: null,
        jiggleSide: 1, nextJiggle: 0,
        fakeYaw: 0, fakeAt: 0,
      };
    }
  }

  syncModeBotTeam() {
    if (!this.modeBot) return;
    const human = [...this.players.values()].find((player) => !player.bot);
    this.modeBot.team = human ? 1 - human.team : 1;
  }

  syncTestDummyTeam() {
    this.syncModeBotTeam();
  }

  recordHistory() {
    const frame = new Map();
    for (const player of this.players.values()) {
      frame.set(player.id, {
        x: player.pos.x, y: player.pos.y, z: player.pos.z,
        alive: player.alive, crouch: player.crouch, sliding: player.sliding,
        protected: player.protected, team: player.team,
      });
    }
    this.history.set(this.tick, frame);
    const cutoff = this.tick - this.historyMaxTicks - 1;
    for (const tick of this.history.keys()) {
      if (tick < cutoff) this.history.delete(tick);
    }
  }

  lagTick(requested, maxMs = MATCH.lagCompensationMs) {
    const maxTicks = Math.max(1, Math.round(MATCH.tickHz * Math.max(0, Number(maxMs) || 0) / 1000));
    const target = Math.round(Number(requested));
    if (!Number.isFinite(target) || target <= 0) return this.tick;
    const oldest = Math.max(0, this.tick - maxTicks);
    return Math.max(oldest, Math.min(this.tick, target));
  }

  lagTickFromOrigin(player, requested, origin) {
    const maxTicks = Math.max(1, Math.round(MATCH.tickHz * Math.max(0, player.maxLagMs || 0) / 1000));
    const fallback = this.lagTick(requested, player.maxLagMs);
    if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y) || !Number.isFinite(origin.z)) {
      return fallback;
    }
    const oldest = Math.max(0, this.tick - maxTicks);
    let bestTick = null;
    let bestDistance = Infinity;
    let bestRequestDelta = Infinity;
    for (const [tick, frame] of this.history) {
      if (tick < oldest || tick > this.tick) continue;
      const state = frame.get(player.id);
      if (!state) continue;
      const height = state.sliding ? 0.72 : state.crouch ? 1 : 1.62;
      const dx = state.x - origin.x;
      const dy = state.y + height - origin.y;
      const dz = state.z - origin.z;
      const distance = dx * dx + dy * dy + dz * dz;
      const requestDelta = Math.abs(tick - fallback);
      if (distance < bestDistance - 1e-6 ||
          (Math.abs(distance - bestDistance) <= 1e-6 && requestDelta < bestRequestDelta)) {
        bestDistance = distance;
        bestRequestDelta = requestDelta;
        bestTick = tick;
      }
    }
                                                                              
                                                                     
    return bestTick !== null && bestDistance <= 2.5 * 2.5 ? bestTick : fallback;
  }

  parseOrigin(value) {
    if (!value) return null;
    if (Array.isArray(value) && value.length >= 3) {
      return { x: Number(value[0]), y: Number(value[1]), z: Number(value[2]) };
    }
    if (typeof value === "object") {
      return { x: Number(value.x), y: Number(value.y), z: Number(value.z) };
    }
    return null;
  }

  lagState(tick, playerId) {
    let selected = null;
    for (const [sampleTick, frame] of this.history) {
      if (sampleTick <= tick && (!selected || sampleTick > selected.tick)) {
        selected = { tick: sampleTick, frame };
      }
    }
    if (!selected) return null;
    return selected.frame.get(playerId) || null;
  }

  eyeFromHistory(state, player) {
    if (!state) return player.eye();
    const height = state.sliding ? 0.95 : state.crouch ? 1.2 : 1.8;
    return {
      x: state.x,
      y: state.y + (height >= 1.8 ? 1.62 : height >= 1.2 ? 1 : 0.72),
      z: state.z,
    };
  }

  triggerHackBotDodge(bot, direction = null) {
    const brain = this.botBrain;
    if (!bot?.ai || !brain) return;
    let lateral;
    if (direction) {
      lateral = Math.random() < 0.5
        ? { x: -direction.z, z: direction.x }
        : { x: direction.z, z: -direction.x };
    } else {
      const angle = Math.random() * Math.PI * 2;
      lateral = { x: Math.cos(angle), z: Math.sin(angle) };
    }
    brain.dodge = lateral;
    brain.dodgeUntil = Date.now() + 300;
    brain.jumpTicks = Math.max(brain.jumpTicks, 1);
  }

  buildNavigation() {
    const nodes = Array.isArray(this.map?.world?.nodes) ? this.map.world.nodes : [];
    this.navNodes = nodes
      .filter((node) => Array.isArray(node?.pos) && node.pos.length === 3 && node.pos.every(Number.isFinite))
      .map((node, index) => ({
        index,
        x: node.pos[0], y: node.pos[1], z: node.pos[2],
        links: Array.isArray(node.links) ? node.links : [],
      }));
    this.navGraph = new Map(this.navNodes.map((node) => [node.index, node]));
  }

  nearestNavNode(position) {
    let best = null;
    let bestDistance = Infinity;
    for (const node of this.navNodes) {
      const dx = node.x - position.x;
      const dz = node.z - position.z;
      const dy = Math.abs(node.y - position.y);
      if (dy > 4) continue;
      const distance = dx * dx + dz * dz + dy * dy * 4;
      if (distance < bestDistance) { bestDistance = distance; best = node; }
    }
    return best;
  }

  findNavPath(from, to) {
    const start = this.nearestNavNode(from);
    const goal = this.nearestNavNode(to);
    if (!start || !goal) return [];
    if (start.index === goal.index) return [goal];
    const open = new Set([start.index]);
    const came = new Map();
    const g = new Map([[start.index, 0]]);
    const f = new Map([[start.index, Math.hypot(start.x - goal.x, start.z - goal.z)]]);
    while (open.size) {
      let current = null;
      let score = Infinity;
      for (const index of open) {
        const value = f.get(index) ?? Infinity;
        if (value < score) { score = value; current = index; }
      }
      if (current === goal.index) {
        const path = [goal];
        let cursor = current;
        while (came.has(cursor)) {
          cursor = came.get(cursor);
          path.push(this.navGraph.get(cursor));
        }
        return path.reverse();
      }
      open.delete(current);
      const node = this.navGraph.get(current);
      for (const link of node.links) {
        const next = this.navGraph.get(link);
        if (!next) continue;
        const tentative = (g.get(current) ?? Infinity) +
          Math.hypot(next.x - node.x, next.y - node.y, next.z - node.z);
        if (tentative < (g.get(link) ?? Infinity)) {
          came.set(link, current);
          g.set(link, tentative);
          f.set(link, tentative + Math.hypot(next.x - goal.x, next.z - goal.z));
          open.add(link);
        }
      }
    }
    return [];
  }

  lineClear(eye, point) {
    const dx = point.x - eye.x;
    const dy = point.y - eye.y;
    const dz = point.z - eye.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 0.01) return true;
    const dir = { x: dx / distance, y: dy / distance, z: dz / distance };
    const wall = this.world.raycast(eye, dir, distance);
    return !wall || wall.distance >= distance - 0.1;
  }

  hackBotThink(p, now) {
    const brain = this.botBrain;
    if (!brain) return;
    if (!p.alive || this.phase !== "live") {
      p.input = { seq: p.input.seq, forward: 0, right: 0, yaw: p.yaw, pitch: 0, buttons: 0 };
      return;
    }

    const eye = p.eye();
    const enemies = [...this.players.values()]
      .filter((target) => target.id !== p.id && target.team !== p.team && target.alive);
    let target = null;
    let bestScore = Infinity;
    for (const enemy of enemies) {
      const point = { x: enemy.pos.x, y: enemy.pos.y + (enemy.sliding ? 0.74 : enemy.crouch ? 1.04 : 1.66), z: enemy.pos.z };
      const distance = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z);
      if (distance > 100) continue;
      const score = distance + (this.lineClear(eye, point) ? 0 : 100);
      if (score < bestScore) { bestScore = score; target = { enemy, point }; }
    }
    brain.target = target?.enemy || null;

    let mx = 0;
    let mz = 0;
    if (now < brain.dodgeUntil && brain.dodge) {
      mx = brain.dodge.x;
      mz = brain.dodge.z;
    } else if (target) {
      const dx = target.enemy.pos.x - p.pos.x;
      const dz = target.enemy.pos.z - p.pos.z;
      const distance = Math.hypot(dx, dz) || 1;
      const forwardX = dx / distance;
      const forwardZ = dz / distance;
      const visible = this.lineClear(eye, target.point);
      if (visible && distance < 18) {
        const side = Math.sin(now / 450) > 0 ? 1 : -1;
        const scale = distance > 10 ? 0.8 : 0.45;
        mx = forwardX * scale + -forwardZ * side * 0.7;
        mz = forwardZ * scale + forwardX * side * 0.7;
      } else {
        const needsPath = now - brain.pathAt > 550 || !brain.pathTarget ||
          Math.hypot(target.enemy.pos.x - brain.pathTarget.x, target.enemy.pos.z - brain.pathTarget.z) > 1.5;
        if (needsPath) {
          brain.pathAt = now;
          brain.pathTarget = { x: target.enemy.pos.x, y: target.enemy.pos.y, z: target.enemy.pos.z };
          brain.path = this.findNavPath(p.pos, target.enemy.pos);
        }
        while (brain.path.length) {
          const node = brain.path[0];
          if (Math.hypot(node.x - p.pos.x, node.z - p.pos.z) < 1.1) {
            brain.path.shift();
            continue;
          }
          mx = node.x - p.pos.x;
          mz = node.z - p.pos.z;
          if (node.y > p.pos.y + 0.35 && p.ground) brain.jumpTicks = Math.max(brain.jumpTicks, 1);
          break;
        }
      }
    }

    const length = Math.hypot(mx, mz);
    if (length > 1e-6) { mx /= length; mz /= length; }
    const aimYaw = target
      ? Math.atan2(-(target.point.x - eye.x), -(target.point.z - eye.z))
      : p.yaw;
    if (now >= (brain.nextJiggle || 0)) {
      brain.jiggleSide = -(brain.jiggleSide || 1);
      brain.nextJiggle = now + 35 + Math.random() * 25;
    }
    const viewYaw = aimYaw + Math.PI + brain.jiggleSide * 0.6;
    const forward = -Math.sin(viewYaw) * mx - Math.cos(viewYaw) * mz;
    const right = Math.cos(viewYaw) * mx - Math.sin(viewYaw) * mz;
    let buttons = 2;
    if (brain.jumpTicks > 0) {
      buttons |= 1;
      brain.jumpTicks--;
    } else if (p.ground && now > brain.nextJump) {
      brain.jumpTicks = 1;
      buttons |= 1;
      brain.nextJump = now + 1200 + Math.random() * 800;
    }
    p.input = {
      seq: p.input.seq,
      forward,
      right,
      yaw: viewYaw,
      pitch: -1.0,
      buttons,
    };

    if (p.ammo <= 0 && p.reload <= 0 && now >= brain.nextReload) {
      brain.nextReload = now + 700;
      this.tryReload(p);
    }
    if (target && p.ammo > 0 && p.reload <= 0 && now >= brain.nextShot && this.lineClear(eye, target.point)) {
      const point = target.point;
      const dx = point.x - eye.x;
      const dy = point.y - eye.y;
      const dz = point.z - eye.z;
      this.tryShoot(p, {
        yaw: Math.atan2(-dx, -dz),
        pitch: Math.atan2(dy, Math.hypot(dx, dz)),
      });
      brain.nextShot = now + 120;
    }
  }

                              
publish() {
    this.broadcast(this.rosterPayload());
    this.manager.onRoomChanged();
  }

  assignTeam(player) {
    const counts = [0, 0];
    for (const p of this.players.values()) counts[p.team]++;
    const available = [0, 1].filter((team) => counts[team] < MATCH.teamSize);
    if (!available.length) return false;
    player.team = available.sort((a, b) => counts[a] - counts[b] || a - b)[0];
    return true;
  }

  teamCount(team) {
    let count = 0;
    for (const player of this.players.values()) if (player.team === team) count++;
    return count;
  }

  canJoinTeam(team) {
    return (team === 0 || team === 1) && this.teamCount(team) < MATCH.teamSize;
  }

  humanCount() {
    let count = 0;
    for (const player of this.players.values()) if (!player.bot) count++;
    return count;
  }

  canJoin() {
    return this.phase !== "over" && this.humanCount() < MATCH.capacity &&
      (this.canJoinTeam(0) || this.canJoinTeam(1));
  }

  dropPlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    const wasHost = this.hostId === playerId;
    p.connected = false;
    p.conn = null;
    this.players.delete(playerId);
    if (wasHost) {
      const next = [...this.players.values()].find((x) => x.connected);
      this.hostId = next?.id ?? null;
    }
    if (this.humanCount() === 0) {
      this.manager.removeRoom(this);
      return;
    }
    this.publish();
  }

  findByResume(token) {
    if (typeof token !== "string" || !token) return null;
    return [...this.players.values()].find((p) => p.resumeToken === token);
  }

                               
  broadcast(event) {
    for (const p of this.players.values()) {
      if (p.conn && p.connected) p.conn.sendJSON(event);
    }
  }

  rosterPayload() {
    const players = [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths,
      score: p.score, bot: !!p.bot, connected: p.connected, alive: p.alive, weapon: p.weapon,
    }));
    return {
      type: "room",
      room: this.code,
      host: this.hostId,
      phase: this.phase,
      capacity: MATCH.capacity,
      humans: this.humanCount(),
      bots: [...this.players.values()].filter((player) => player.bot).length,
      hidden: this.hidden,
      joinable: this.canJoin(),
      mapId: this.map.id,
      mapVersion: this.map.version,
      clientScene: this.map.clientScene,
      modeId: this.mode.id,
      modeAdapter: this.mode.clientAdapter,
      mapName: this.map.name,
      modeName: this.mode.name,
      difficulty: this.difficulty,
      teamCount: MATCH.teamCount,
      teamSize: MATCH.teamSize,
      scores: [this.scores[0], this.scores[1]],
      scoreLimit: MATCH.scoreLimit,
      winner: this.winner,
      modeState: {},
      round: this.round,
      players,
    };
  }

  summary() {
    const host = [...this.players.values()].find((p) => p.id === this.hostId);
    return {
      room: this.code,
      hostName: host?.name || "房主",
      phase: this.phase,
      capacity: MATCH.capacity,
      humans: this.humanCount(),
      bots: [...this.players.values()].filter((player) => player.bot).length,
      joinable: this.canJoin(),
      mapId: this.map.id,
      modeId: this.mode.id,
      mapName: this.map.name,
      modeName: this.mode.name,
      difficulty: this.difficulty,
      hidden: this.hidden,
    };
  }

                             
  handleCommand(player, msg) {
    switch (msg.type) {
      case "equip": {
        this.tryEquip(player, msg.weapon);
        break;
      }
      case "team": {
        if (this.phase === "lobby" || this.testMode || this.hackbotMode) {
          const t = Number(msg.team);
          if ((t === 0 || t === 1) && (player.team === t || this.canJoinTeam(t))) {
            player.team = t;
            if (this.modeBot) {
              this.syncModeBotTeam();
              this.modeBot.spawn();
              player.spawn();
            }
            this.publish();
          }
        }
        break;
      }
      case "start": {
        if (player.id === this.hostId && (this.phase === "lobby" || this.phase === "over")) this.beginRound();
        break;
      }
      case "reload": this.tryReload(player); break;
      case "shot": this.tryShoot(player, msg); break;
      case "melee": this.tryMelee(player, msg); break;
      case "ping": player.conn?.sendJSON({ type: "pong", nonce: msg.nonce }); break;
      case "pong": {
        const sent = Number(msg.nonce);
        const now = Date.now();
        if (Number.isFinite(sent) && sent <= now && now - sent <= MATCH.lagHistoryMs) {
          const sample = now - sent;
          player.rttMs = player.rttMs ? player.rttMs * 0.7 + sample * 0.3 : sample;
          player.maxLagMs = clamp(player.rttMs * 2 + 100, 250, MATCH.lagHistoryMs);
        }
        break;
      }
      case "leave": this.dropPlayer(player.id); break;
      default: break;
    }
  }

  beginRound() {
    this.round++;
    this.scores = [0, 0];
    this.winner = -1;
    for (const p of this.players.values()) {
      p.kills = 0; p.deaths = 0; p.score = 0;
      p.spawn();
    }
    this.phase = this.testMode ? "live" : "countdown";
    this.countdownEnd = this.testMode ? 0 : Date.now() + MATCH.countdownMs;
    this.liveEnd = this.testMode ? 0 : Date.now() + MATCH.timeLimitMs;
    this.broadcast({ type: "round-start", round: this.round });
    this.broadcast(this.rosterPayload());
    this.manager.onRoomChanged();
  }

  tryEquip(player, weapon) {
    if (!WEAPONS.includes(weapon) || player.weapon === weapon) return;
    if (this.phase === "live" && !player.alive) return;
    if (!["lobby", "live", "over"].includes(this.phase)) return;

    player.saveWeaponState();
    player.cancelReload();
    player.weapon = weapon;
    player.loadWeaponState(weapon);
    player.switchReadyAt = Date.now() + 350;
  }

  tryReload(player) {
    if (!player.alive || this.phase !== "live" || player.reload > 0) return;
    if (Date.now() < player.switchReadyAt) return;

    const spec = weaponSpec(player.weapon);
    const need = spec.mag - player.ammo;
    const take = Math.min(need, player.reserve);

    if (take <= 0) return;

    player.reload = 1;
    player.reloadEndAt = Date.now() + (spec.reloadMs || 900);
    player.reloadTake = take;
    player.reloadWeapon = player.weapon;
  }

  finishReloads(now) {
    for (const player of this.players.values()) {
      if (player.reload <= 0 || now < player.reloadEndAt) continue;

      if (player.alive && this.phase === "live" && player.weapon === player.reloadWeapon) {
        const spec = weaponSpec(player.weapon);
        const add = Math.min(player.reloadTake, player.reserve, spec.mag - player.ammo);
        player.ammo += add;
        player.reserve -= add;
      }

      player.cancelReload();
    }
  }

  tryShoot(player, msg) {
    if (!player.alive || this.phase !== "live" || !msg || typeof msg !== "object") return;
    if (player.reload > 0) return;

    const spec = weaponSpec(player.weapon);
    const now = Date.now();
    if (now < player.switchReadyAt) return;
    if (now - player.lastShotAt < spec.interval * 1000) return;
    if (player.ammo <= 0) { this.tryReload(player); return; }
    player.lastShotAt = now;
    player.ammo--;

    const shotTick = this.lagTickFromOrigin(player, msg.tick, this.parseOrigin(msg.origin));
    const shooterState = this.lagState(shotTick, player.id);
    const origin = this.eyeFromHistory(shooterState, player);
    const yaw = Number.isFinite(msg.yaw) ? msg.yaw : player.yaw;
    const pitch = clamp(Number.isFinite(msg.pitch) ? msg.pitch : player.pitch, -Math.PI / 2, Math.PI / 2);
    const dir = {
      x: -Math.sin(yaw) * Math.cos(pitch),
      y: Math.sin(pitch),
      z: -Math.cos(yaw) * Math.cos(pitch),
    };

    const wall = this.world.raycast(origin, dir, spec.range);

    let best = null;
    for (const target of this.players.values()) {
      if (target.id === player.id || target.team === player.team || !target.alive) continue;
      const state = this.lagState(shotTick, target.id) || {
        x: target.pos.x, y: target.pos.y, z: target.pos.z,
        alive: target.alive, crouch: target.crouch, sliding: target.sliding,
        protected: target.protected, team: target.team,
      };
      if (!state.alive || state.protected || target.protected) continue;
      const proxy = {
        pos: { x: state.x, y: state.y, z: state.z },
        crouch: state.crouch,
        sliding: state.sliding,
      };
      const t = rayPlayer(origin, dir, proxy, heightOf(proxy));
      if (t !== null && t <= spec.range && (!best || t < best.t)) best = { target, t, state };
    }

    if (wall && (!best || wall.distance < best.t)) best = null;

    const shotEvent = {
      type: "shot", id: player.id,
      x: origin.x, y: origin.y, z: origin.z,
      dx: dir.x, dy: dir.y, dz: dir.z, weapon: player.weapon,
    };
    this.broadcast(shotEvent);

    if (!best) return;
    const victim = best.target;
    if (victim.protected) return;
    const head = origin.y + dir.y * best.t > best.state.y + heightOf(best.state) - 0.25;
    const damage = Math.round(spec.damage * (head ? 1.5 : 1));
    victim.hp = Math.max(0, victim.hp - damage);
    const point = {
      x: origin.x + dir.x * best.t,
      y: origin.y + dir.y * best.t,
      z: origin.z + dir.z * best.t,
    };
    this.broadcast({
      type: "damage", id: victim.id, attacker: player.id, hp: victim.hp,
      amount: damage, head, point: [point.x, point.y, point.z],
      dir: [dir.x, dir.y, dir.z], weapon: player.weapon,
    });
    if (victim.ai) this.triggerHackBotDodge(victim, dir);

    if (victim.hp <= 0) this.handleKill(player, victim, head);
  }

  tryMelee(player, msg = null) {
    if (!player.alive || this.phase !== "live" || player.reload > 0) return;

    const now = Date.now();
    if (now < player.switchReadyAt || now - player.lastMeleeAt < 500) return;

    const shotTick = this.lagTickFromOrigin(player, msg?.tick, this.parseOrigin(msg?.origin));
    const origin = this.eyeFromHistory(this.lagState(shotTick, player.id), player);

    for (const target of this.players.values()) {
      if (target.id === player.id || target.team === player.team || !target.alive || target.protected) continue;
      const state = this.lagState(shotTick, target.id) || {
        x: target.pos.x, y: target.pos.y, z: target.pos.z,
        alive: target.alive, crouch: target.crouch, sliding: target.sliding,
        protected: target.protected, team: target.team,
      };
      if (!state.alive || state.protected) continue;

      const dx = state.x - origin.x;
      const dz = state.z - origin.z;
      const d = Math.hypot(dx, dz);
      const dy = state.y + heightOf(state) * 0.5 - origin.y;

      if (d > 2.2 || Math.abs(dy) > 1.4) continue;

      const length = Math.hypot(dx, dy, dz) || 1;
      const dir = { x: dx / length, y: dy / length, z: dz / length };
      const wall = this.world.raycast(origin, dir, d + 0.5);

      if (wall && wall.distance < d - 0.35) continue;

      player.lastMeleeAt = now;
      target.hp = Math.max(0, target.hp - 50);
      this.broadcast({
        type: "damage", id: target.id, attacker: player.id, hp: target.hp,
        amount: 50, head: false, point: [state.x, state.y + 1, state.z],
        dir: [0, 0, 0], weapon: "knife",
      });

      if (target.hp <= 0) this.handleKill(player, target, false);
      return;
    }
  }

  handleKill(killer, victim, head) {
    victim.alive = false;
    victim.cancelReload();
    victim.deaths++;
    victim.respawnAt = Date.now() + MATCH.respawnMs;
    killer.kills++;
    if (!this.testMode) {
      killer.score += MATCH.killScore;
      this.scores[killer.team]++;
    }
    this.broadcast({
      type: "kill", killer: killer.id, victim: victim.id,
      weapon: killer.weapon, head, kills: killer.kills,
    });
    this.publish();
    if (!this.testMode && this.scores[killer.team] >= MATCH.scoreLimit) this.endRound(killer.team);
  }

  endRound(winner) {
    this.phase = "over";
    for (const player of this.players.values()) player.cancelReload();
    this.winner = winner ?? (this.scores[0] === this.scores[1] ? -1 : this.scores[0] > this.scores[1] ? 0 : 1);
    this.broadcast({ type: "round-end", round: this.round, winner: this.winner, scores: [...this.scores] });
    this.broadcast(this.rosterPayload());
    this.manager.onRoomChanged();
  }

                                
  tickLoop(now) {
    this.tick++;
    this.finishReloads(now);

           
    if (this.phase === "countdown" && now >= this.countdownEnd) {
      this.phase = "live";
      this.liveEnd = now + MATCH.timeLimitMs;
      this.broadcast(this.rosterPayload());
    } else if (this.phase === "live" && !this.testMode && now >= this.liveEnd) {
      this.endRound();
    }

    const dt = 1 / MATCH.tickHz;
    for (const p of this.players.values()) {
      if (p.ai) {
        this.hackBotThink(p, now);
        if (this.phase === "live") this.moveHuman(p, dt);
      } else if (!p.bot) {
        this.moveHuman(p, dt);
      }

             
      if (!p.alive && now >= p.respawnAt) p.spawn();
      if (p.protected && now >= p.protectedUntil) p.protected = false;
      p.cooldown = Math.max(0, p.cooldown - dt);
      if (this.testMode && !p.bot) p.reserve = 9999;
      if (!p.bot && p.conn && p.connected && now >= p.nextPingAt) {
        p.nextPingAt = now + 1000;
        p.pingSentAt = now;
        p.conn.sendJSON({ type: "ping", nonce: now });
      }
    }
    this.recordHistory();
  }

  stepPlayer(p, input, dt) {
    const steps = Math.max(1, Math.round(dt / STEP));
    const m = {
      x: p.pos.x, y: p.pos.y, z: p.pos.z,
      vx: p.vel.x, vy: p.vel.y, vz: p.vel.z,
      ground: p.ground, crouch: p.crouch, sliding: p.sliding,
      slideTime: p.slideTime, slideCooldown: p.slideCooldown,
      slideX: p.slideX, slideZ: p.slideZ,
      slideHeld: p.slideHeld, crouchHeld: p.crouchHeld, jumpHeld: p.jumpHeld,
    };

    for (let i = 0; i < steps; i++) this.world.move(m, input);

    p.pos.x = m.x; p.pos.y = m.y; p.pos.z = m.z;
    p.vel.x = m.vx; p.vel.y = m.vy; p.vel.z = m.vz;
    p.ground = m.ground; p.crouch = m.crouch; p.sliding = m.sliding;
    p.slideTime = m.slideTime; p.slideCooldown = m.slideCooldown;
    p.slideX = m.slideX; p.slideZ = m.slideZ;
    p.slideHeld = m.slideHeld; p.crouchHeld = m.crouchHeld; p.jumpHeld = m.jumpHeld;
  }

  moveHuman(p, dt) {
    const inp = p.input || {};
    const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const input = {
      forward: clamp(finite(inp.forward, 0), -1, 1),
      right: clamp(finite(inp.right, 0), -1, 1),
      yaw: finite(inp.yaw, p.yaw),
      pitch: clamp(finite(inp.pitch, p.pitch), -Math.PI / 2, Math.PI / 2),
      buttons: finite(inp.buttons, 0) & 255,
    };

    p.yaw = input.yaw;
    p.pitch = input.pitch;
    this.stepPlayer(p, input, dt);
  }

  snapshot() {
    const remaining = this.phase === "live" ? Math.max(0, this.liveEnd - Date.now())
      : this.phase === "countdown" ? Math.max(0, this.countdownEnd - Date.now()) : 0;
    return encodeSnapshot({
      tick: this.tick,
      time: Date.now(),
      phase: this.phase,
      scores: this.scores,
      remaining,
      winner: this.winner,
      players: [...this.players.values()],
      zombies: [],
    });
  }
}

export class RoomManager {
  constructor(library) {
    this.library = library;
    this.rooms = new Map();
    this.sseClients = new Set();
    this.nextDirPush = 0;

    this.timer = setInterval(() => {
      const now = Date.now();
      for (const room of this.rooms.values()) room.tickLoop(now);
      for (const room of this.rooms.values()) {
        const buf = room.snapshot();
        for (const p of room.players.values()) {
          if (p.conn && p.connected) p.conn.sendSnapshot(buf);
        }
      }
      if (now >= this.nextDirPush) {
        this.nextDirPush = now + 1000;
        this.pushDirectory();
      }
    }, 1000 / MATCH.tickHz);
  }

  getMap(mapId) {
    return this.library.maps.find((m) => m.id === mapId) || this.library.maps[0];
  }

  getMode(modeId) {
    return this.library.modes.find((m) => m.id === modeId) || this.library.modes[0];
  }

  create({ mapId, modeId, difficulty, hostPlayer, quick }) {
    const room = new Room(this, {
      map: this.getMap(mapId), mode: this.getMode(modeId),
      difficulty, hostPlayer, quick,
    });
    this.rooms.set(room.code, room);
    return room;
  }

  findJoinable({ mapId, modeId }) {
    for (const room of this.rooms.values()) {
      if (room.hidden || !room.canJoin() || room.humanCount() <= 0) continue;
      if (mapId && room.map.id !== mapId) continue;
      if (modeId && room.mode.id !== modeId) continue;
      return room;
    }
    return null;
  }

  get(code) { return this.rooms.get(String(code || "").toUpperCase()); }

  removeRoom(room) {
    if (!room) return;
    this.rooms.delete(room.code);
    this.pushDirectory();
  }

  onRoomChanged() {
    this.pushDirectory();
  }

  directory() {
    return [...this.rooms.values()]
      .filter((room) => !room.hidden && room.humanCount() > 0)
      .map((r) => r.summary());
  }

  pushDirectory() {
    const payload = `event: rooms\ndata: ${JSON.stringify({ type: "rooms", rooms: this.directory() })}\n\n`;
    for (const res of this.sseClients) {
      try { res.write(payload); } catch { this.sseClients.delete(res); }
    }
  }

  addSse(res) {
    this.sseClients.add(res);
    res.write(`event: rooms\ndata: ${JSON.stringify({ type: "rooms", rooms: this.directory() })}\n\n`);
  }

  removeSse(res) { this.sseClients.delete(res); }

  shutdown() { clearInterval(this.timer); }
}

export { WEAPON_SPECS };
