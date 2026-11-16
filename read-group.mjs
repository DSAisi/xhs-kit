// read-group.mjs —— 读小红书群消息（纯 HTTP，不用浏览器）
//
// 用法：
//   node read-group.mjs --group <群ID>                  # 最近 40 条
//   node read-group.mjs --group <群ID> --limit 80       # 最近 80 条（接口上限约 100）
//   node read-group.mjs --group <群ID> --since 14:00    # 只要 14:00 之后（北京时）
//   node read-group.mjs --group <群ID> --json           # 打原始 JSON
//   node read-group.mjs --group <群ID> --save out.txt   # 顺手存一份
//
// Cookie：
//   默认读环境变量 XHS_COOKIE_FILE 指向的文件（一行，浏览器里复制的那串 cookie）。
//   也可以 --cookie <路径> 直接指定。
//
// 接口（2026-09-22 实测，别再猜）：
//   GET https://edith.xiaohongshu.com/api/im/web/red/group/messages/history
//       ?group_id=X&last_id=0&start_id=0&limit=N
//   ⇒ data.out_message_list[]，**倒序**（L[0] 最新，L[len-1] 最早）
//   ⚠ limit 上限约 100：limit=100/200/500 都只回 97 条。**不需要翻页**，一把拿全。
//   ⚠ last_id 必须是**整数毫秒时间戳**；传消息 id（形如 "群ID.uuid"）会
//     500 + `parse: ... strconv.ParseInt`。
//   ⚠ 实测用毫秒当 last_id 分页，会回一堆**同时间戳的空壳**，把真内容挤出结果 ——
//      已弃用翻页，一律单次 limit 拿。
//   ⚠ 约两成条目没有正文（撤回 / 系统提示 / "点击关注"卡片），body 会是空的。
//
// "@ 我" 的标记在 command 里，不在正文：
//   {"type":"AtMe","info":"{\"atUsers\":[{\"userName\":\"<你的昵称>\"...}]}"}
//   ⇒ 别只在正文里 grep "@昵称"，那会漏（@ 可能挂在正文第 251 字之后）。
//   把你的昵称用 --me 传进来（或环境变量 XHS_MY_NAME），脚本才知道哪条是 @ 你的。
import fs from "node:fs";
import https from "node:https";

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  argv.splice(i, v && !v.startsWith("--") ? 2 : 1);
  return v && !v.startsWith("--") ? v : true;
}

const GROUP = flag("--group") || process.env.XHS_GROUP_ID || "";
const SINCE = flag("--since");
const WANT_JSON = !!flag("--json");
const SAVE = flag("--save");
const MINENAME = flag("--me") || process.env.XHS_MY_NAME || "";
const LIMIT = Math.min(Math.max(Number(flag("--limit") || argv[0] || 40), 1), 100);
const COOKIE_FILE = flag("--cookie") || process.env.XHS_COOKIE_FILE || "";

if (!GROUP) {
  console.error("缺 --group <群ID>（或环境变量 XHS_GROUP_ID）");
  process.exit(2);
}
if (!COOKIE_FILE || !fs.existsSync(COOKIE_FILE)) {
  console.error("缺 cookie 文件：用 --cookie <路径> 或环境变量 XHS_COOKIE_FILE（一行，浏览器里复制的那串）");
  process.exit(2);
}

const COOKIE = fs.readFileSync(COOKIE_FILE, "utf8").trim();

const HEAD = {
  cookie: COOKIE,
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
  referer: "https://www.xiaohongshu.com/chat/" + GROUP,
  origin: "https://www.xiaohongshu.com",
};

function get(url) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: HEAD, timeout: 15000 }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch {
            resolve(null);
          }
        });
      })
      .on("error", () => resolve(null))
      .on("timeout", function () {
        this.destroy();
        resolve(null);
      });
  });
}

const toMs = (t) => (Number(t) > 1e12 ? Number(t) : Number(t) * 1000);
const bj = (t) => new Date(toMs(t) + 8 * 3600 * 1000);
const hhmmss = (t) => bj(t).toISOString().slice(11, 19);

// 从一条原始消息里把「谁 / 说了什么 / 有没有 @ 我」摘出来
function parse(m) {
  let nick = "?";
  let body = "";
  let atMe = false;
  const atNames = [];
  try {
    const c = JSON.parse(m.content || "{}");
    nick = c.nickname || c.sender?.nickname || "?";
    body = String(c.content ?? "");
    const cmd = typeof c.command === "string" ? safeJson(c.command) : c.command;
    if (cmd) {
      const info = typeof cmd.info === "string" ? safeJson(cmd.info) : cmd.info;
      for (const u of info?.atUsers || []) {
        const n = String(u.userName || "").trim();
        if (n) atNames.push(n);
        if (MINENAME && n.toLowerCase().includes(MINENAME.toLowerCase())) atMe = true;
      }
      if (/AtMe/i.test(String(cmd.type || ""))) atMe = true;
    }
  } catch {
    body = String(m.content || "");
  }
  if (!atMe && MINENAME && new RegExp("@" + MINENAME, "i").test(body)) atMe = true;
  return { id: m.id || m.uuid, t: toMs(m.created_at), nick, body, atMe, atNames };
}
function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const url = `https://edith.xiaohongshu.com/api/im/web/red/group/messages/history?group_id=${GROUP}&last_id=0&start_id=0&limit=${LIMIT}`;
const j = await get(url);
if (!j) {
  console.error("拉取失败（网络/超时）");
  process.exit(1);
}
if (j.code !== 0) {
  console.error(`接口报错 code=${j.code} msg=${String(j.msg || "").slice(0, 200)}`);
  process.exit(1);
}

const raw = (j.data && j.data.out_message_list) || [];
const all = new Map();
for (const m of raw) {
  const r = parse(m);
  const key = r.id || `${r.t}|${r.nick}|${r.body.slice(0, 40)}`;
  if (!all.has(key)) all.set(key, r);
}

let rows = [...all.values()].filter((x) => x.t).sort((a, b) => a.t - b.t);
if (SINCE) rows = rows.filter((x) => hhmmss(x.t).slice(0, 5) >= SINCE);
const shown = rows.slice(-LIMIT);

if (WANT_JSON) {
  console.log(JSON.stringify(shown, null, 2));
} else {
  const out = rows
    .filter((x) => x.body.trim() || x.atMe)
    .map((x) => {
      const mark = x.atMe ? "  ★@我" : x.atNames.length ? `  (@${x.atNames.join(",")})` : "";
      return `[${hhmmss(x.t)}] ${x.nick}：${x.body.replace(/\s+/g, " ").slice(0, 400)}${mark}`;
    })
    .join("\n");
  const mine = rows.filter((x) => x.atMe);
  const blank = rows.length - rows.filter((x) => x.body.trim()).length;
  const head = `群 ${GROUP}｜接口回 ${raw.length} 条，有效 ${rows.length} 条（无正文 ${blank}）${SINCE ? `｜${SINCE} 之后` : ""}｜@我 ${mine.length} 条`;
  console.log(head);
  console.log("─".repeat(40));
  console.log(out || "（空）");
  if (mine.length) {
    console.log("\n★ @我：" + mine.map((x) => `${hhmmss(x.t)} ${x.nick}`).join(" ／ "));
  }
  if (SAVE) fs.writeFileSync(SAVE, head + "\n" + out + "\n");
}
