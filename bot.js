import bedrock from "bedrock-protocol";
import OpenAI from "openai";

const SERVER_HOST = process.env.MC_HOST || "YOUR_SERVER_IP";
const SERVER_PORT = Number(process.env.MC_PORT || 19132);
const USERNAME = process.env.MC_USERNAME || "AI_Player";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const bot = bedrock.createClient({
  host: SERVER_HOST,
  port: SERVER_PORT,
  username: USERNAME,
  offline: true,
});

// =========================================================
// 状態管理 (44 HP / 45 空腹 / 46 夜判断 / 47 敵発見 など)
// =========================================================
const state = {
  pos: { x: 0, y: 64, z: 0 },
  yaw: 0,
  pitch: 0,
  velocity: { x: 0, y: 0, z: 0 },
  hp: 20,
  maxHp: 20,
  hunger: 20,
  saturation: 5,
  inWater: false,
  onGround: true,
  timeOfDay: 0, // 0-24000
  runtimeId: 0n,
  hotbarSlot: 0,
  inventory: new Array(36).fill(null), // {name, count, slot}
  hotbar: new Array(9).fill(null),
  players: new Map(), // runtimeId -> {name, pos, runtimeId}
  entities: new Map(), // runtimeId -> {type, pos, runtimeId, hostile}
  // 行動状態
  currentTask: null, // 進行中のタスク名
  taskTimers: [], // setInterval/setTimeout の ID 一覧（停止用）
  followTarget: null, // 追従対象プレイヤー名
  history: [], // 会話履歴
  joined: false,
  lastChatAt: 0,
  lastTickAt: Date.now(),
};

// 敵性 mob リスト
const HOSTILE_MOBS = new Set([
  "minecraft:zombie", "minecraft:skeleton", "minecraft:creeper", "minecraft:spider",
  "minecraft:enderman", "minecraft:witch", "minecraft:husk", "minecraft:stray",
  "minecraft:drowned", "minecraft:phantom", "minecraft:pillager", "minecraft:vindicator",
  "minecraft:evoker", "minecraft:ravager", "minecraft:blaze", "minecraft:ghast",
  "minecraft:magma_cube", "minecraft:slime", "minecraft:wither_skeleton",
  "minecraft:zombie_villager", "minecraft:cave_spider", "minecraft:silverfish",
  "minecraft:guardian", "minecraft:elder_guardian", "minecraft:shulker",
  "minecraft:hoglin", "minecraft:zoglin", "minecraft:piglin_brute", "minecraft:warden",
]);

const FRIENDLY_MOBS = new Set([
  "minecraft:villager", "minecraft:wandering_trader", "minecraft:cow", "minecraft:pig",
  "minecraft:sheep", "minecraft:chicken", "minecraft:horse", "minecraft:cat",
  "minecraft:wolf", "minecraft:fox", "minecraft:rabbit",
]);

function log(...args) {
  const t = new Date().toLocaleTimeString("ja-JP");
  console.log(`[${t}]`, ...args);
}

// =========================================================
// パケット送信ヘルパー
// =========================================================
function sendChat(message) {
  if (!message) return;
  try {
    bot.queue("text", {
      type: "chat",
      needs_translation: false,
      source_name: USERNAME,
      xuid: "",
      platform_chat_id: "",
      filtered_message: "",
      message: String(message).slice(0, 256),
    });
    state.lastChatAt = Date.now();
  } catch (e) {
    log("チャット送信エラー:", e.message);
  }
}

// 移動入力 (1〜9: 移動系)
function sendInput(opts = {}) {
  const {
    forward = false, back = false, left = false, right = false,
    jump = false, sneak = false, sprint = false, swim = false,
  } = opts;

  // yaw に応じた進行方向ベクトル
  const yawRad = (state.yaw * Math.PI) / 180;
  const speed = sprint ? 0.28 : 0.18;
  let mx = 0, mz = 0;
  if (forward) { mx -= Math.sin(yawRad) * speed; mz += Math.cos(yawRad) * speed; }
  if (back)    { mx += Math.sin(yawRad) * speed; mz -= Math.cos(yawRad) * speed; }
  if (left)    { mx -= Math.cos(yawRad) * speed; mz -= Math.sin(yawRad) * speed; }
  if (right)   { mx += Math.cos(yawRad) * speed; mz += Math.sin(yawRad) * speed; }

  // 9 落下回避: 落下中で水なし、地面ない場合はジャンプ
  let actualJump = jump;
  if (state.velocity.y < -0.5 && !state.onGround && !state.inWater) {
    actualJump = true;
  }

  try {
    bot.queue("player_auth_input", {
      pitch: state.pitch,
      yaw: state.yaw,
      position: state.pos,
      move_vector: { x: forward || back ? (forward ? 1 : -1) : 0, z: left || right ? (right ? 1 : -1) : 0 },
      head_yaw: state.yaw,
      input_data: {
        ascend: false, descend: false, north_jump: false,
        jump_down: actualJump, sprint_down: sprint,
        change_height: false, jumping: actualJump,
        auto_jumping_in_water: swim,
        sneaking: sneak, sneak_down: sneak,
        up: forward, down: back, left, right,
        up_left: forward && left, up_right: forward && right,
        want_up: actualJump || swim, want_down: sneak,
        want_down_slow: false, want_up_slow: false,
        sprinting: sprint,
        ascend_block: false, descend_block: false,
        sneak_toggle_down: false, persist_sneak: sneak,
        start_sprinting: sprint, stop_sprinting: false,
        start_sneaking: sneak, stop_sneaking: false,
        start_swimming: swim, stop_swimming: false,
        start_jumping: actualJump,
        start_gliding: false, stop_gliding: false,
      },
      input_mode: "mouse",
      play_mode: "screen",
      interaction_model: 0,
      tick: BigInt(Math.floor((Date.now() - state.lastTickAt) / 50)),
      delta: { x: mx, y: 0, z: mz },
    });

    // 楽観的に位置更新
    state.pos = {
      x: state.pos.x + mx,
      y: state.pos.y,
      z: state.pos.z + mz,
    };
  } catch (e) {
    // バージョン差で失敗することがあるので静かに無視
  }
}

// =========================================================
// タスク管理（行動の停止/開始）
// =========================================================
function stopAllTasks() {
  for (const id of state.taskTimers) {
    clearInterval(id);
    clearTimeout(id);
  }
  state.taskTimers = [];
  state.followTarget = null;
  state.currentTask = null;
}

function setTask(name) {
  stopAllTasks();
  state.currentTask = name;
  log(`タスク開始: ${name}`);
}

function addTimer(id) {
  state.taskTimers.push(id);
  return id;
}

// =========================================================
// 1〜9: 移動系
// =========================================================
function moveDirection(dir, durationMs = 1000, sprint = false) {
  setTask(`移動(${dir})`);
  const opts = { sprint };
  opts[dir] = true;
  const t = addTimer(setInterval(() => sendInput(opts), 100));
  addTimer(setTimeout(() => { clearInterval(t); state.currentTask = null; }, durationMs));
}

const moveForward  = (ms = 1500, sprint = false) => moveDirection("forward", ms, sprint);
const moveBack     = (ms = 1500) => moveDirection("back", ms, false);
const moveLeft     = (ms = 1000) => moveDirection("left", ms, false);
const moveRight    = (ms = 1000) => moveDirection("right", ms, false);

function jump() {
  sendInput({ jump: true });
  setTimeout(() => sendInput({ jump: true, forward: true }), 50);
}

function sneak(durationMs = 2000) {
  setTask("しゃがむ");
  const t = addTimer(setInterval(() => sendInput({ sneak: true }), 100));
  addTimer(setTimeout(() => { clearInterval(t); state.currentTask = null; }, durationMs));
}

function sprint(durationMs = 3000) {
  moveDirection("forward", durationMs, true);
}

function swim(durationMs = 3000) {
  setTask("泳ぐ");
  const t = addTimer(setInterval(() => sendInput({ forward: true, swim: true, jump: true }), 100));
  addTimer(setTimeout(() => { clearInterval(t); state.currentTask = null; }, durationMs));
}

// =========================================================
// 10〜14: 視点系
// =========================================================
function setRotation(yaw, pitch = state.pitch) {
  state.yaw = ((yaw % 360) + 360) % 360;
  state.pitch = Math.max(-90, Math.min(90, pitch));
  sendInput({});
}

function lookAt(targetPos) {
  const dx = targetPos.x - state.pos.x;
  const dy = targetPos.y - (state.pos.y + 1.6);
  const dz = targetPos.z - state.pos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const yaw = (-Math.atan2(dx, dz) * 180) / Math.PI;
  const pitch = (-Math.atan2(dy, dist) * 180) / Math.PI;
  setRotation(yaw, pitch);
}

function lookAround() {
  setTask("見回す");
  let i = 0;
  const t = addTimer(setInterval(() => {
    setRotation(state.yaw + 45, Math.sin(i * 0.5) * 20);
    i++;
    if (i >= 8) { clearInterval(t); state.currentTask = null; }
  }, 250));
}

function lookAtPlayer(playerName) {
  const p = findPlayerByName(playerName);
  if (p) { lookAt(p.pos); return true; }
  return false;
}

function lookAtNearestEnemy() {
  const e = findNearestEnemy();
  if (e) { lookAt(e.pos); return true; }
  return false;
}

function lookDown() {
  setRotation(state.yaw, 60); // 足元のブロックを見る
}

// =========================================================
// 15〜19: 採掘系
// =========================================================
function mineFront(durationMs = 2000) {
  setTask("採掘");
  const target = blockInFront();
  try {
    bot.queue("player_action", {
      runtime_entity_id: state.runtimeId,
      action: "start_break",
      position: target,
      result_position: target,
      face: 2,
    });
  } catch (e) {}
  // 連続スイング
  const t = addTimer(setInterval(() => {
    try {
      bot.queue("animate", { action_id: 1, runtime_entity_id: state.runtimeId });
    } catch (e) {}
  }, 200));
  addTimer(setTimeout(() => {
    try {
      bot.queue("player_action", {
        runtime_entity_id: state.runtimeId,
        action: "stop_break",
        position: target,
        result_position: target,
        face: 2,
      });
    } catch (e) {}
    clearInterval(t);
    state.currentTask = null;
  }, durationMs));
}

// 16/17/18: 「木を切る」「石を掘る」「鉱石を掘る」 — 種類別ブロック判別は protocol だけでは困難なので、
// AI が周囲を見て「mine」を呼ぶ形で対応。長めに掘る。
const chopWood = () => mineFront(4000);
const mineStone = () => mineFront(3000);
const mineOre = () => mineFront(5000);

// 19: 洞窟探索 — 暗い方向（y を下げながら）に移動 + 採掘ループ
function exploreCave() {
  setTask("洞窟探索");
  setRotation(state.yaw, 30); // 下向き
  let count = 0;
  const t = addTimer(setInterval(() => {
    sendInput({ forward: true });
    if (count % 3 === 0) {
      try {
        bot.queue("player_action", {
          runtime_entity_id: state.runtimeId,
          action: "start_break",
          position: blockInFront(),
          result_position: blockInFront(),
          face: 2,
        });
      } catch (e) {}
    }
    count++;
  }, 300));
  addTimer(setTimeout(() => { clearInterval(t); state.currentTask = null; }, 30000));
}

// =========================================================
// 20〜24: 建築系
// =========================================================
function blockInFront(offsetY = 0) {
  const yawRad = (state.yaw * Math.PI) / 180;
  return {
    x: Math.floor(state.pos.x - Math.sin(yawRad)),
    y: Math.floor(state.pos.y + offsetY),
    z: Math.floor(state.pos.z + Math.cos(yawRad)),
  };
}

function placeBlock(pos = null) {
  const target = pos || blockInFront(-1);
  try {
    bot.queue("inventory_transaction", {
      transaction: {
        legacy: { legacy_request_id: 0 },
        transaction_type: "item_use",
        actions: [],
        transaction_data: {
          action_type: 0, // place
          trigger_type: "player_input",
          block_position: target,
          face: 1, // top
          hotbar_slot: state.hotbarSlot,
          held_item: { network_id: 0 },
          player_pos: state.pos,
          click_pos: { x: 0.5, y: 1.0, z: 0.5 },
          block_runtime_id: 0,
          client_interact_prediction: "success",
        },
      },
    });
  } catch (e) {}
}

// 21: 家を建てる — 簡易的に4面壁＋屋根
function buildHouse() {
  setTask("家を建てる");
  const startX = Math.floor(state.pos.x);
  const startY = Math.floor(state.pos.y);
  const startZ = Math.floor(state.pos.z);
  const positions = [];
  // 5x5 の壁を3段
  for (let y = 0; y < 3; y++) {
    for (let i = 0; i < 5; i++) {
      positions.push({ x: startX + i, y: startY + y, z: startZ });
      positions.push({ x: startX + i, y: startY + y, z: startZ + 4 });
      positions.push({ x: startX, y: startY + y, z: startZ + i });
      positions.push({ x: startX + 4, y: startY + y, z: startZ + i });
    }
  }
  // 屋根
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
    positions.push({ x: startX + i, y: startY + 3, z: startZ + j });
  }
  let idx = 0;
  const t = addTimer(setInterval(() => {
    if (idx >= positions.length) { clearInterval(t); state.currentTask = null; sendChat("家できた！"); return; }
    placeBlock(positions[idx++]);
  }, 200));
}

// 22: 壁を作る
function buildWall(length = 5, height = 3) {
  setTask("壁を作る");
  const yawRad = (state.yaw * Math.PI) / 180;
  const dx = Math.cos(yawRad), dz = Math.sin(yawRad);
  const positions = [];
  for (let y = 0; y < height; y++) for (let i = 0; i < length; i++) {
    positions.push({
      x: Math.floor(state.pos.x + dx * i),
      y: Math.floor(state.pos.y) + y,
      z: Math.floor(state.pos.z + dz * i),
    });
  }
  let idx = 0;
  const t = addTimer(setInterval(() => {
    if (idx >= positions.length) { clearInterval(t); state.currentTask = null; return; }
    placeBlock(positions[idx++]);
  }, 200));
}

// 23: 橋を作る
function buildBridge(length = 10) {
  setTask("橋を作る");
  let i = 0;
  const t = addTimer(setInterval(() => {
    if (i >= length) { clearInterval(t); state.currentTask = null; return; }
    sneak(100);
    placeBlock(blockInFront(-1));
    setTimeout(() => sendInput({ forward: true }), 150);
    i++;
  }, 400));
}

// 24: 階段を作る
function buildStairs(steps = 5) {
  setTask("階段を作る");
  let i = 0;
  const t = addTimer(setInterval(() => {
    if (i >= steps) { clearInterval(t); state.currentTask = null; return; }
    placeBlock(blockInFront(-1));
    jump();
    setTimeout(() => sendInput({ forward: true }), 200);
    i++;
  }, 600));
}

// =========================================================
// 25〜29: 戦闘系
// =========================================================
function attackEntity(entity) {
  if (!entity) return;
  lookAt(entity.pos);
  try {
    bot.queue("inventory_transaction", {
      transaction: {
        legacy: { legacy_request_id: 0 },
        transaction_type: "item_use_on_entity",
        actions: [],
        transaction_data: {
          entity_runtime_id: entity.runtimeId,
          action_type: "attack",
          hotbar_slot: state.hotbarSlot,
          held_item: { network_id: 0 },
          player_pos: state.pos,
          click_pos: { x: 0, y: 0, z: 0 },
        },
      },
    });
    bot.queue("animate", { action_id: 1, runtime_entity_id: state.runtimeId });
  } catch (e) {}
}

function attackNearestEnemy() {
  const e = findNearestEnemy();
  if (!e) return false;
  setTask("攻撃");
  attackEntity(e);
  // 連打
  let count = 0;
  const t = addTimer(setInterval(() => {
    const target = findNearestEnemy();
    if (!target || count > 20) { clearInterval(t); state.currentTask = null; return; }
    attackEntity(target);
    count++;
  }, 600));
  return true;
}

// 26: 弓を撃つ — アイテムを使う動作
function shootBow() {
  setTask("弓を撃つ");
  const e = findNearestEnemy();
  if (e) lookAt(e.pos);
  // チャージ → 離す
  try {
    bot.queue("inventory_transaction", {
      transaction: {
        legacy: { legacy_request_id: 0 },
        transaction_type: "item_use",
        actions: [],
        transaction_data: {
          action_type: 1, // use item
          trigger_type: "player_input",
          block_position: { x: 0, y: 0, z: 0 },
          face: -1,
          hotbar_slot: state.hotbarSlot,
          held_item: { network_id: 0 },
          player_pos: state.pos,
          click_pos: { x: 0, y: 0, z: 0 },
          block_runtime_id: 0,
          client_interact_prediction: "success",
        },
      },
    });
  } catch (e2) {}
  addTimer(setTimeout(() => {
    try {
      bot.queue("player_action", {
        runtime_entity_id: state.runtimeId,
        action: "release_item",
        position: { x: 0, y: 0, z: 0 },
        result_position: { x: 0, y: 0, z: 0 },
        face: 0,
      });
    } catch (e2) {}
    state.currentTask = null;
  }, 1500));
}

// 27: 逃げる
function flee() {
  setTask("逃げる");
  const e = findNearestEnemy();
  if (e) {
    // 敵から離れる方向
    const dx = state.pos.x - e.pos.x;
    const dz = state.pos.z - e.pos.z;
    const yaw = (-Math.atan2(dx, dz) * 180) / Math.PI;
    setRotation(yaw + 180, 0);
  }
  const t = addTimer(setInterval(() => {
    sendInput({ forward: true, sprint: true, jump: Math.random() < 0.2 });
  }, 100));
  addTimer(setTimeout(() => { clearInterval(t); state.currentTask = null; }, 8000));
}

// 28: 盾で防御
function shieldBlock(durationMs = 3000) {
  setTask("盾で防御");
  try {
    bot.queue("inventory_transaction", {
      transaction: {
        legacy: { legacy_request_id: 0 },
        transaction_type: "item_use",
        actions: [],
        transaction_data: {
          action_type: 1,
          trigger_type: "player_input",
          block_position: { x: 0, y: 0, z: 0 },
          face: -1,
          hotbar_slot: state.hotbarSlot,
          held_item: { network_id: 0 },
          player_pos: state.pos,
          click_pos: { x: 0, y: 0, z: 0 },
          block_runtime_id: 0,
          client_interact_prediction: "success",
        },
      },
    });
  } catch (e) {}
  addTimer(setTimeout(() => {
    try {
      bot.queue("player_action", {
        runtime_entity_id: state.runtimeId,
        action: "release_item",
        position: { x: 0, y: 0, z: 0 },
        result_position: { x: 0, y: 0, z: 0 },
        face: 0,
      });
    } catch (e) {}
    state.currentTask = null;
  }, durationMs));
}

// 29: 回復する — 食料を使う
function heal() {
  setTask("回復");
  // 安全な場所に移動 + 食料使用
  shieldBlock(500);
  setTimeout(() => eatFood(), 600);
}

// =========================================================
// 30〜33: 探索系
// =========================================================
function randomExplore(durationMs = 30000) {
  setTask("ランダム探索");
  const t = addTimer(setInterval(() => {
    if (Math.random() < 0.2) state.yaw = (state.yaw + (Math.random() * 90 - 45) + 360) % 360;
    sendInput({
      forward: true,
      sprint: Math.random() < 0.4,
      jump: Math.random() < 0.15,
    });
  }, 200));
  addTimer(setTimeout(() => { clearInterval(t); state.currentTask = null; sendChat("ふぅ、休憩〜"); }, durationMs));
}

// 31: 村を探す — 村人(villager) を周囲探知 + 見つかるまで探索
function findVillage() {
  setTask("村探し");
  let elapsed = 0;
  const t = addTimer(setInterval(() => {
    elapsed += 500;
    // 村人発見チェック
    for (const ent of state.entities.values()) {
      if (ent.type?.includes("villager")) {
        clearInterval(t);
        state.currentTask = null;
        sendChat(`村人見つけた！(${Math.round(ent.pos.x)}, ${Math.round(ent.pos.z)})`);
        lookAt(ent.pos);
        return;
      }
    }
    // 探索継続
    if (elapsed % 3000 === 0) state.yaw = (state.yaw + (Math.random() * 60 - 30) + 360) % 360;
    sendInput({ forward: true, sprint: true });
    if (elapsed > 60000) { clearInterval(t); state.currentTask = null; sendChat("見つからなかった…"); }
  }, 500));
}

// 32: ダンジョン探索
const exploreDungeon = () => exploreCave();

// 33: バイオーム探索
const exploreBiome = () => randomExplore(45000);

// =========================================================
// 34〜38: アイテム系
// =========================================================
// 34: アイテム拾う — 自動 (近接で勝手に拾う) なので近場のアイテムへ移動
function pickupNearby() {
  setTask("アイテム拾う");
  // 簡易: 周囲をぐるぐる
  let i = 0;
  const t = addTimer(setInterval(() => {
    state.yaw = (state.yaw + 45) % 360;
    sendInput({ forward: true });
    i++;
    if (i >= 16) { clearInterval(t); state.currentTask = null; }
  }, 300));
}

// 35: インベントリ整理 — ホットバーをスロット 0 に戻す
function organizeInventory() {
  selectHotbar(0);
  sendChat("整理した〜");
}

// 36: クラフト — クラフト UI の操作は protocol レベルで複雑なので、AI に「何を作るか」だけ伝える
function craft(itemName = "アイテム") {
  setTask("クラフト");
  sendChat(`${itemName} を作るよ`);
  setTimeout(() => { state.currentTask = null; }, 2000);
}

// 37: 道具持ち替え
function selectHotbar(slot) {
  state.hotbarSlot = Math.max(0, Math.min(8, slot));
  try {
    bot.queue("mob_equipment", {
      runtime_entity_id: state.runtimeId,
      item: { network_id: 0 },
      slot: state.hotbarSlot,
      selected_slot: state.hotbarSlot,
      window_id: "inventory",
    });
  } catch (e) {}
}

// 38: 食べる
function eatFood() {
  setTask("食事");
  try {
    bot.queue("inventory_transaction", {
      transaction: {
        legacy: { legacy_request_id: 0 },
        transaction_type: "item_use",
        actions: [],
        transaction_data: {
          action_type: 1,
          trigger_type: "player_input",
          block_position: { x: 0, y: 0, z: 0 },
          face: -1,
          hotbar_slot: state.hotbarSlot,
          held_item: { network_id: 0 },
          player_pos: state.pos,
          click_pos: { x: 0, y: 0, z: 0 },
          block_runtime_id: 0,
          client_interact_prediction: "success",
        },
      },
    });
  } catch (e) {}
  addTimer(setTimeout(() => {
    try {
      bot.queue("player_action", {
        runtime_entity_id: state.runtimeId,
        action: "release_item",
        position: { x: 0, y: 0, z: 0 },
        result_position: { x: 0, y: 0, z: 0 },
        face: 0,
      });
    } catch (e) {}
    state.currentTask = null;
  }, 1700));
}

// =========================================================
// 39〜43: コミュニケーション系
// =========================================================
function greet() {
  const greetings = ["やっほー！", "こんにちは〜", "おはよう！", "やあ！", "ども〜"];
  sendChat(greetings[Math.floor(Math.random() * greetings.length)]);
}

function followPlayer(playerName) {
  setTask(`追従(${playerName})`);
  state.followTarget = playerName;
  const t = addTimer(setInterval(() => {
    const p = findPlayerByName(state.followTarget);
    if (!p) return;
    lookAt(p.pos);
    const dx = p.pos.x - state.pos.x;
    const dz = p.pos.z - state.pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > 3) sendInput({ forward: true, sprint: dist > 8 });
  }, 200));
}

function helpPlayer(playerName) {
  // 攻撃中の敵を倒す or プレイヤーに追従
  const enemy = findNearestEnemy();
  if (enemy) attackNearestEnemy();
  else followPlayer(playerName);
}

// =========================================================
// 44〜48: 状況判断系
// =========================================================
function findPlayerByName(name) {
  for (const p of state.players.values()) {
    if (p.name === name) return p;
  }
  return null;
}

function findNearestEnemy() {
  let nearest = null, minDist = Infinity;
  for (const e of state.entities.values()) {
    if (!e.hostile) continue;
    const dx = e.pos.x - state.pos.x;
    const dz = e.pos.z - state.pos.z;
    const d = dx * dx + dz * dz;
    if (d < minDist) { minDist = d; nearest = e; }
  }
  return nearest;
}

function getStatus() {
  return {
    hp: `${state.hp}/${state.maxHp}`,
    hunger: state.hunger,
    pos: `${Math.round(state.pos.x)}, ${Math.round(state.pos.y)}, ${Math.round(state.pos.z)}`,
    time: state.timeOfDay,
    isNight: state.timeOfDay >= 13000 && state.timeOfDay <= 23000,
    nearbyEnemies: [...state.entities.values()].filter(e => e.hostile).length,
    nearbyPlayers: [...state.players.values()].map(p => p.name),
    inventoryEmpty: state.inventory.every(s => !s),
  };
}

// =========================================================
// 49〜53: 高度な行動
// =========================================================
function sleepInBed() {
  setTask("就寝");
  // 簡易: ベッドへの interact
  try {
    bot.queue("inventory_transaction", {
      transaction: {
        legacy: { legacy_request_id: 0 },
        transaction_type: "item_use",
        actions: [],
        transaction_data: {
          action_type: 0,
          trigger_type: "player_input",
          block_position: blockInFront(-1),
          face: 1,
          hotbar_slot: state.hotbarSlot,
          held_item: { network_id: 0 },
          player_pos: state.pos,
          click_pos: { x: 0.5, y: 0.5, z: 0.5 },
          block_runtime_id: 0,
          client_interact_prediction: "success",
        },
      },
    });
  } catch (e) {}
  sendChat("おやすみ〜");
  setTimeout(() => { state.currentTask = null; }, 3000);
}

function makeFarm() {
  setTask("畑作り");
  // 3x3 の畑を耕す動作 (interact を繰り返す)
  let i = 0;
  const t = addTimer(setInterval(() => {
    if (i >= 9) { clearInterval(t); state.currentTask = null; sendChat("畑できた！"); return; }
    placeBlock(blockInFront(-1)); // 仮: ブロック設置で代用
    sendInput({ forward: true });
    i++;
  }, 400));
}

function tradeVillager() {
  setTask("村人取引");
  for (const e of state.entities.values()) {
    if (e.type?.includes("villager")) {
      lookAt(e.pos);
      try {
        bot.queue("inventory_transaction", {
          transaction: {
            legacy: { legacy_request_id: 0 },
            transaction_type: "item_use_on_entity",
            actions: [],
            transaction_data: {
              entity_runtime_id: e.runtimeId,
              action_type: "interact",
              hotbar_slot: state.hotbarSlot,
              held_item: { network_id: 0 },
              player_pos: state.pos,
              click_pos: { x: 0, y: 0, z: 0 },
            },
          },
        });
      } catch (err) {}
      sendChat("取引してみる！");
      setTimeout(() => { state.currentTask = null; }, 3000);
      return;
    }
  }
  sendChat("村人いないな〜");
  state.currentTask = null;
}

function makeBase() {
  // 拠点 = 家を建てる + ベッドを置く
  buildHouse();
}

function teamFight(playerName) {
  setTask("チーム戦闘");
  followPlayer(playerName);
  // 並行して敵がいたら攻撃
  const t = addTimer(setInterval(() => {
    const e = findNearestEnemy();
    if (e) attackEntity(e);
  }, 800));
}

// =========================================================
// アクションディスパッチ表
// =========================================================
const ACTIONS = {
  // 移動
  move_forward:  (a) => moveForward(a.duration || 1500, a.sprint),
  move_back:     (a) => moveBack(a.duration || 1500),
  move_left:     (a) => moveLeft(a.duration || 1000),
  move_right:    (a) => moveRight(a.duration || 1000),
  jump:          () => jump(),
  sneak:         (a) => sneak(a.duration || 2000),
  sprint:        (a) => sprint(a.duration || 3000),
  swim:          (a) => swim(a.duration || 3000),
  // 視点
  look_around:   () => lookAround(),
  look_player:   (a) => lookAtPlayer(a.target),
  look_enemy:    () => lookAtNearestEnemy(),
  look_down:     () => lookDown(),
  // 採掘
  mine:          () => mineFront(2000),
  chop_wood:     () => chopWood(),
  mine_stone:    () => mineStone(),
  mine_ore:      () => mineOre(),
  explore_cave:  () => exploreCave(),
  // 建築
  place_block:   () => placeBlock(),
  build_house:   () => buildHouse(),
  build_wall:    (a) => buildWall(a.length || 5, a.height || 3),
  build_bridge:  (a) => buildBridge(a.length || 10),
  build_stairs:  (a) => buildStairs(a.steps || 5),
  // 戦闘
  attack:        () => attackNearestEnemy(),
  shoot_bow:     () => shootBow(),
  flee:          () => flee(),
  shield:        (a) => shieldBlock(a.duration || 3000),
  heal:          () => heal(),
  // 探索
  random_explore: () => randomExplore(),
  find_village:  () => findVillage(),
  explore_dungeon: () => exploreDungeon(),
  explore_biome: () => exploreBiome(),
  // アイテム
  pickup:        () => pickupNearby(),
  organize:      () => organizeInventory(),
  craft:         (a) => craft(a.item),
  swap_tool:     (a) => selectHotbar(a.slot ?? 0),
  eat:           () => eatFood(),
  // コミュニケーション
  greet:         () => greet(),
  follow:        (a) => followPlayer(a.target),
  help:          (a) => helpPlayer(a.target),
  // 状況判断 (returnのみ)
  check_status:  () => sendChat(JSON.stringify(getStatus())),
  // 高度
  sleep:         () => sleepInBed(),
  make_farm:     () => makeFarm(),
  trade:         () => tradeVillager(),
  make_base:     () => makeBase(),
  team_fight:    (a) => teamFight(a.target),
  // 制御
  stop:          () => { stopAllTasks(); sendChat("止まった！"); },
  chat:          () => {}, // メッセージのみ
};

// =========================================================
// AI による意思決定
// =========================================================
const PERSONA = `あなたはMinecraft Bedrock版で遊んでいる、明るく好奇心旺盛な日本人プレイヤー「${USERNAME}」です。
プレイヤーと自然に会話しながら、頼まれた行動を実行します。

返答は必ず以下のJSON形式のみ（前後に余計な文字なし）:
{
  "action": "アクション名",
  "params": { ... },
  "message": "プレイヤーへの自然な日本語返答（短く1〜2文）"
}

利用可能なアクション:
[移動] move_forward / move_back / move_left / move_right / jump / sneak / sprint / swim
[視点] look_around / look_player(target) / look_enemy / look_down
[採掘] mine / chop_wood / mine_stone / mine_ore / explore_cave
[建築] place_block / build_house / build_wall(length,height) / build_bridge(length) / build_stairs(steps)
[戦闘] attack / shoot_bow / flee / shield / heal
[探索] random_explore / find_village / explore_dungeon / explore_biome
[アイテム] pickup / organize / craft(item) / swap_tool(slot) / eat
[会話] greet / follow(target) / help(target) / chat
[判断] check_status
[高度] sleep / make_farm / trade / make_base / team_fight(target)
[制御] stop

例:
{"action":"build_house","params":{},"message":"よっしゃ家建てるよ〜"}
{"action":"follow","params":{"target":"Steve"},"message":"ついていくね！"}
{"action":"chat","params":{},"message":"いい天気だね〜"}

口調はフレンドリーでカジュアル。絵文字は使わない。短く返答。`;

async function askAI(playerName, text) {
  const status = getStatus();
  state.history.push({ role: "user", content: `${playerName}: ${text}` });
  if (state.history.length > 10) state.history = state.history.slice(-10);

  const messages = [
    { role: "system", content: PERSONA },
    { role: "system", content: `現在の状態: ${JSON.stringify(status)}` },
    ...state.history,
  ];

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    response_format: { type: "json_object" },
    temperature: 0.85,
    max_tokens: 200,
  });

  const raw = res.choices[0]?.message?.content || "{}";
  state.history.push({ role: "assistant", content: raw });

  try {
    return JSON.parse(raw);
  } catch {
    return { action: "chat", params: {}, message: raw.slice(0, 100) };
  }
}

async function executeDecision(decision, playerName) {
  const { action = "chat", params = {}, message } = decision;
  // 自然な間
  await new Promise(r => setTimeout(r, 400 + Math.random() * 800));
  if (message) sendChat(message);

  const fn = ACTIONS[action];
  if (fn) {
    try {
      // follow/help の target が無い場合は発言者を使う
      if ((action === "follow" || action === "help" || action === "team_fight") && !params.target) {
        params.target = playerName;
      }
      fn(params);
    } catch (e) {
      log(`アクション実行エラー(${action}):`, e.message);
    }
  } else {
    log(`未知のアクション: ${action}`);
  }
}

// =========================================================
// 自動行動ループ (47 敵発見, 46 夜判断, 44 HP, 45 空腹, 9 落下回避)
// =========================================================
function startAutoLoop() {
  // 常時 tick: player_auth_input を毎 50ms 送らないと
  // Bedrock サーバーはプレイヤーを非表示扱いにする
  setInterval(() => {
    if (state.joined) sendInput({});
  }, 50);

  // 緊急対応
  setInterval(() => {
    // HP低下 → 回復
    if (state.hp < 8 && state.currentTask !== "回復" && state.currentTask !== "逃げる") {
      log("HP低下! 回復行動");
      heal();
    }
    // 敵接近 → AI に判断させずに即逃げる/攻撃
    const enemy = findNearestEnemy();
    if (enemy) {
      const dx = enemy.pos.x - state.pos.x;
      const dz = enemy.pos.z - state.pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 5 && !state.currentTask) {
        log(`敵接近(${enemy.type}, ${dist.toFixed(1)}m)`);
        if (state.hp > 12) attackNearestEnemy();
        else flee();
      }
    }
  }, 1500);

  // アイドル行動
  setInterval(() => {
    if (state.currentTask) return;
    const r = Math.random();
    if (r < 0.3) setRotation(state.yaw + (Math.random() * 60 - 30));
    else if (r < 0.4) jump();
    else if (r < 0.45 && Date.now() - state.lastChatAt > 90000) {
      const mutters = ["いい天気だな〜", "なんか楽しいことないかな", "お腹すいた…", "誰かいないかな", "次どこ行こう"];
      sendChat(mutters[Math.floor(Math.random() * mutters.length)]);
    }
  }, 5000);
}

// =========================================================
// パケット受信
// =========================================================
bot.on("spawn", () => {
  state.joined = true;
  log("サーバーに参加");
  setTimeout(() => sendChat("やっほー！来たよ〜"), 3000);
  startAutoLoop();
});

bot.on("join", () => log("接続完了"));
bot.on("disconnect", (p) => log("切断:", p?.reason || ""));
bot.on("kick", (p) => log("キック:", p?.reason || ""));
bot.on("error", (e) => log("エラー:", e.message));

// 自分の位置
bot.on("move_player", (packet) => {
  if (packet.runtime_entity_id === state.runtimeId && packet.position) {
    state.pos = packet.position;
    if (packet.yaw !== undefined) state.yaw = packet.yaw;
    if (packet.pitch !== undefined) state.pitch = packet.pitch;
  } else if (packet.runtime_entity_id) {
    // 他プレイヤー / エンティティの位置更新
    const id = packet.runtime_entity_id;
    if (state.players.has(id)) state.players.get(id).pos = packet.position;
    if (state.entities.has(id)) state.entities.get(id).pos = packet.position;
  }
});

bot.on("start_game", (packet) => {
  if (packet.runtime_entity_id) {
    state.runtimeId = packet.runtime_entity_id;
    log(`自分のID: ${state.runtimeId}`);
  }
  if (packet.player_position) state.pos = packet.player_position;
});

// プレイヤー追加
bot.on("player_list", (packet) => {
  if (packet.records?.type === "add" || packet.records?.records) {
    const records = packet.records.records || [];
    for (const r of records) {
      if (r.username && r.username !== USERNAME) {
        // username だけ覚えておく (位置は add_player で取得)
        log(`プレイヤー追加: ${r.username}`);
      }
    }
  }
});

bot.on("add_player", (packet) => {
  state.players.set(packet.runtime_entity_id, {
    runtimeId: packet.runtime_entity_id,
    name: packet.username,
    pos: packet.position || { x: 0, y: 0, z: 0 },
  });
});

bot.on("add_entity", (packet) => {
  const type = packet.entity_type || "";
  state.entities.set(packet.runtime_entity_id, {
    runtimeId: packet.runtime_entity_id,
    type,
    pos: packet.position || { x: 0, y: 0, z: 0 },
    hostile: HOSTILE_MOBS.has(type),
  });
});

bot.on("remove_entity", (packet) => {
  state.entities.delete(packet.entity_id_self);
  state.players.delete(packet.entity_id_self);
});

// HP / 空腹
bot.on("update_attributes", (packet) => {
  if (packet.runtime_entity_id !== state.runtimeId) return;
  for (const attr of packet.attributes || []) {
    if (attr.name === "minecraft:health") {
      state.hp = attr.current;
      state.maxHp = attr.max;
    }
    if (attr.name === "minecraft:player.hunger") {
      state.hunger = attr.current;
    }
    if (attr.name === "minecraft:player.saturation") {
      state.saturation = attr.current;
    }
  }
});

// 時間
bot.on("set_time", (packet) => {
  state.timeOfDay = packet.time % 24000;
});

// インベントリ
bot.on("inventory_content", (packet) => {
  if (packet.window_id === "inventory") {
    state.inventory = packet.input || [];
  }
});

// チャット
bot.on("text", async (packet) => {
  if (!packet?.message) return;
  if (packet.type !== "chat") return;
  const from = packet.source_name || "誰か";
  if (from === USERNAME) return;
  const msg = packet.message;
  log(`${from}: ${msg}`);

  try {
    const decision = await askAI(from, msg);
    log("AI判断:", JSON.stringify(decision));
    await executeDecision(decision, from);
  } catch (e) {
    log("AIエラー:", e.message);
    sendChat("えっと…ちょっとよく分かんなかった");
  }
});

process.on("SIGINT", () => {
  log("終了");
  stopAllTasks();
  try { bot.disconnect(); } catch {}
  process.exit(0);
});

log(`起動: ${SERVER_HOST}:${SERVER_PORT} として ${USERNAME} で接続中...`);
