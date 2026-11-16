// send-group.mjs —— 用浏览器把一段文本发进小红书群
//
// 用法：
//   node send-group.mjs --group <群ID> --text "要发的话"
//   node send-group.mjs --group <群ID> --file msg.txt
//   node send-group.mjs --group <群ID> --text "..." --dry     # 演练：填好不回车
//
// Cookie：--cookie <路径> 或环境变量 XHS_COOKIE_FILE（一行，浏览器里复制的那串）
//
// 依赖：camoufox（`npm i camoufox`）。用它是因为它带反检测，普通 playwright 容易被判定。
//
// ⚠ 四条硬事实（都是栽出来的）：
//   1. 文本必须单行。多行会被小红书打乱行序。
//   2. 先跑 --dry。走到"输入框已填好"就停，不污染群。
//   3. 两个判据才算发出去：① 输入框被清空 ② 读回群里真有这条（用 read-group.mjs 验）。
//      "我点了发送"不是证据，"群里读得到"才是。
//   4. 回车才是真发送。只 dispatchEvent input 不会发出去。
import fs from "node:fs";

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  argv.splice(i, v && !v.startsWith("--") ? 2 : 1);
  return v && !v.startsWith("--") ? v : true;
}
const argTrue = (n) => argv.includes(n);

const GROUP = flag("--group") || process.env.XHS_GROUP_ID || "";
const COOKIE_FILE = flag("--cookie") || process.env.XHS_COOKIE_FILE || "";
const FILE = flag("--file");
const DRY = argTrue("--dry");

if (!GROUP) {
  console.error("缺 --group <群ID>");
  process.exit(2);
}
if (!COOKIE_FILE || !fs.existsSync(COOKIE_FILE)) {
  console.error("缺 cookie 文件：--cookie <路径> 或 XHS_COOKIE_FILE");
  process.exit(2);
}

let MSG_TEXT = flag("--text");
if (typeof MSG_TEXT !== "string" || !MSG_TEXT) {
  if (FILE && fs.existsSync(FILE)) MSG_TEXT = fs.readFileSync(FILE, "utf8").trim();
}
if (!MSG_TEXT) {
  console.error("缺正文：--text \"...\" 或 --file msg.txt");
  process.exit(2);
}

// 硬事实 1：单行
MSG_TEXT = MSG_TEXT.replace(/\s*\n\s*/g, " ").trim();

const { Camoufox } = await import("camoufox");

const cookieStr = fs.readFileSync(COOKIE_FILE, "utf8").trim();
const browser = await Camoufox({ headless: true, args: ["--no-sandbox"] }).catch((e) => {
  console.log("FAIL", String(e.message || e).slice(0, 120));
  process.exit(1);
});
const ctx = browser.contexts()[0] || (await browser.newContext());
const cookies = cookieStr
  .split(";")
  .map((p) => {
    const [n, ...v] = p.trim().split("=");
    return { name: n.trim(), value: v.join("="), domain: ".xiaohongshu.com", path: "/" };
  })
  .filter((c) => c.name && c.value);
await ctx.addCookies(cookies);

const page = await ctx.newPage();
await page
  .goto(`https://www.xiaohongshu.com/chat/${GROUP}`, { waitUntil: "domcontentloaded", timeout: 25000 })
  .catch(() => {});
await new Promise((r) => setTimeout(r, 12000));

const typed = await page.evaluate((text) => {
  const input = document.querySelector("textarea") || document.querySelector("[contenteditable=true]");
  if (!input) return "no-input";
  if (input.tagName === "TEXTAREA") {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(input, text);
  } else {
    input.focus();
    document.execCommand("insertText", false, text);
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.focus();
  return "typed";
}, MSG_TEXT);
console.log("输入框:", typed);
if (typed !== "typed") {
  await browser.close().catch(() => {});
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 1500));

if (DRY) {
  console.log("DRY：填好了，没回车。确认无误再去掉 --dry。");
  await browser.close().catch(() => {});
  process.exit(0);
}

// 硬事实 4：回车才是真发送
await page.evaluate(() => {
  const input = document.querySelector("textarea") || document.querySelector("[contenteditable=true]");
  if (!input) return;
  input.focus();
  const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
  input.dispatchEvent(new KeyboardEvent("keydown", opts));
  input.dispatchEvent(new KeyboardEvent("keypress", opts));
  input.dispatchEvent(new KeyboardEvent("keyup", opts));
});
await new Promise((r) => setTimeout(r, 5000));

// 判据 ①：输入框被清空
const emptied = await page.evaluate(() => {
  const i = document.querySelector("textarea") || document.querySelector("[contenteditable=true]");
  return i ? (i.value || "").length === 0 : false;
});
console.log("SENT:", emptied, "| 文本长度:", MSG_TEXT.length);
console.log("⚠ 判据①（输入框清空）不算数，判据②得用 read-group.mjs 读回来验。");
await browser.close().catch(() => {});
process.exit(emptied ? 0 : 1);
