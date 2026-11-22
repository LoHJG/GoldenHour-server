                                                                
import { WEAPONS } from "./config.js";

export const MAGIC = 0x4748;
export const INPUT_BYTES = 25;
export const PLAYER_STRIDE = 64;
export const ZOMBIE_STRIDE = 14;

export const PHASE_INDEX = { lobby: 0, countdown: 1, live: 2, over: 3 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const finite = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const f32 = (v) => finite(v);
const u16 = (v) => clamp(Math.round(finite(v)), 0, 65535);
const u8 = (v) => clamp(Math.round(finite(v)), 0, 255);

                        
export function decodeInput(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < INPUT_BYTES) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint16(0, true) !== MAGIC || v.getUint8(2) !== 1 || v.getUint8(3) !== 1) return null;
  return {
    seq: v.getUint32(4, true),
    forward: v.getFloat32(8, true),
    right: v.getFloat32(12, true),
    yaw: v.getFloat32(16, true),
    pitch: v.getFloat32(20, true),
    buttons: v.getUint8(24),
  };
}

function playerFlags(p) {
  let flags = 0;
  if (p.alive) flags |= 1;
  if (p.crouch) flags |= 2;
  if (p.ground) flags |= 4;
  if (p.connected) flags |= 8;
  if (p.protected) flags |= 16;
  if (p.jumpHeld) flags |= 32;
  if (p.bot) flags |= 64;
  if (p.sliding) flags |= 128;
  return flags;
}

                                  
export function encodeSnapshot({ tick, time, phase, scores, remaining, winner, players, zombies = [] }) {
  const count = clamp(players.length, 0, 10);
  const zombieCount = clamp(zombies.length, 0, 16);
  const header = 24;
  const body = header + count * PLAYER_STRIDE + zombieCount * ZOMBIE_STRIDE;
  const buf = new ArrayBuffer(body);
  const v = new DataView(buf);

  v.setUint16(0, MAGIC, true);
  v.setUint8(2, 1);
  v.setUint8(3, 2);
  v.setUint32(4, tick >>> 0, true);
  v.setUint32(8, Number(time) >>> 0, true);
  v.setUint8(12, PHASE_INDEX[phase] ?? 0);
  v.setUint8(13, count);
  v.setUint16(14, u16(scores[0] || 0), true);
  v.setUint16(16, u16(scores[1] || 0), true);
  v.setUint32(18, u32(remaining), true);
  v.setInt8(22, Number.isInteger(winner) ? winner : -1);
  v.setUint8(23, zombieCount);

  players.slice(0, count).forEach((p, i) => {
    const o = header + i * PLAYER_STRIDE;
    const weaponIdx = Math.max(0, WEAPONS.indexOf(p.weapon || "ar"));
    v.setUint32(o, p.id >>> 0, true);
    v.setUint32(o + 4, u32(p.ack), true);
    v.setFloat32(o + 8, f32(p.pos.x), true);
    v.setFloat32(o + 12, f32(p.pos.y), true);
    v.setFloat32(o + 16, f32(p.pos.z), true);
    v.setFloat32(o + 20, f32(p.vel.x), true);
    v.setFloat32(o + 24, f32(p.vel.y), true);
    v.setFloat32(o + 28, f32(p.vel.z), true);
    v.setFloat32(o + 32, f32(p.yaw), true);
    v.setFloat32(o + 36, f32(p.pitch), true);
    v.setUint16(o + 40, u16(p.hp), true);
    v.setUint16(o + 42, u16(p.ammo), true);
    v.setUint16(o + 44, u16(p.reserve), true);
    v.setUint16(o + 46, u16(p.kills), true);
    v.setUint16(o + 48, u16(p.deaths), true);
    v.setUint16(o + 50, u16(p.score), true);
    v.setUint16(o + 52, u16(p.respawn), true);
    v.setUint16(o + 54, u16(p.reload), true);
    v.setUint8(o + 56, u8(p.team));
    v.setUint8(o + 57, playerFlags(p));
    v.setUint8(o + 58, weaponIdx);
    v.setUint8(o + 59, u8((p.slideCooldown || 0) * 100));
    v.setUint16(o + 60, u16(p.cooldown), true);
    v.setUint16(o + 62, u16((p.slideTime || 0) * 1000), true);
  });

  zombies.slice(0, zombieCount).forEach((z, i) => {
    const o = header + count * PLAYER_STRIDE + i * ZOMBIE_STRIDE;
    v.setUint32(o, z.id >>> 0, true);
    v.setInt16(o + 4, Math.round(z.x * 100), true);
    v.setInt16(o + 6, Math.round(z.y * 100), true);
    v.setInt16(o + 8, Math.round(z.z * 100), true);
    v.setInt16(o + 10, Math.round((z.yaw || 0) * 32767 / Math.PI), true);
    v.setUint8(o + 12, u8(z.kind));
    v.setUint8(o + 13, u8((z.moving ? 1 : 0) | (z.attacking ? 2 : 0)));
  });

  return Buffer.from(buf);
}

function u32(v) {
  return clamp(Math.round(finite(v)), 0, 4294967295) >>> 0;
}
