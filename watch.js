import "dotenv/config";
import { chromium } from "playwright";
import fetch from "node-fetch";
import nodemailer from "nodemailer";

const ZARA_URL = process.env.ZARA_URL;
const WANTED_SIZES = (process.env.WANTED_SIZES || "S,M")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const CHECK_EVERY_SECONDS = Number(process.env.CHECK_EVERY_SECONDS || 120);
const NOTIFY_EVERY_SECONDS = Number(process.env.NOTIFY_EVERY_SECONDS || 60);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const EMAIL_TO = process.env.EMAIL_TO;

if (
  !ZARA_URL ||
  !BOT_TOKEN ||
  !CHAT_ID ||
  !SMTP_HOST ||
  !SMTP_USER ||
  !SMTP_PASS ||
  !EMAIL_TO
) {
  console.error("❌ Missing env vars. Check .env (URL, Telegram, SMTP).");
  process.exit(1);
}

const OUT_OF_STOCK_TEXT = "НЕМАЄ В НАЯВНОСТІ";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

const mailer = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

async function sendEmail(subject, text) {
  await mailer.sendMail({ from: SMTP_USER, to: EMAIL_TO, subject, text });
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      disable_web_page_preview: false,
    }),
  });
  if (!res.ok) throw new Error(`Telegram error: ${res.status} ${await res.text()}`);
}

function normalizeSize(s) {
  return String(s).replace(/\s+/g, " ").trim().toUpperCase();
}

function hasWantedSize(sizes) {
  const set = new Set(sizes.map(normalizeSize));
  return WANTED_SIZES.some((ws) => set.has(normalizeSize(ws)));
}

// Дуже проста евристика: з JSON відповіді збираємо доступні розміри
function extractSizesFromJsonHeuristic(obj) {
  const found = new Set();

  function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object") return;

    // шукаємо комбінацію "size"+"available/stock"
    const keys = Object.keys(node);
    const lower = keys.map((k) => k.toLowerCase());

    const sizeKey = keys.find((k) =>
      ["size", "sizename", "name", "value", "label"].includes(k.toLowerCase())
    );
    const availKey = keys.find((k) => {
      const lk = k.toLowerCase();
      return lk.includes("available") || lk.includes("availability") || lk.includes("instock") || lk === "stock";
    });

    let sizeVal = null;
    if (sizeKey) {
      const v = node[sizeKey];
      if (typeof v === "string" || typeof v === "number") sizeVal = normalizeSize(v);
    }

    let available = null;
    if (availKey) {
      const v = node[availKey];
      if (typeof v === "boolean") available = v;
      if (typeof v === "number") available = v > 0;
      if (typeof v === "string") {
        const s = v.toLowerCase();
        if (["in_stock", "instock", "available", "true", "yes"].includes(s)) available = true;
        if (["out_of_stock", "outofstock", "unavailable", "false", "no"].includes(s)) available = false;
      }
    }

    if (sizeVal && available === true) {
      if (/^(XXS|XS|S|M|L|XL|XXL|\d{2,3})$/.test(sizeVal)) found.add(sizeVal);
    }

    for (const k of keys) walk(node[k]);
  }

  walk(obj);
  return [...found];
}

async function checkOnce() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "uk-UA",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
  });

  const page = await context.newPage();

  const apiSizes = new Set();

  page.on("response", async (res) => {
    try {
      const rt = res.request().resourceType();
      if (rt !== "xhr" && rt !== "fetch") return;

      const ct = (res.headers()["content-type"] || "").toLowerCase();
      if (!ct.includes("application/json")) return;

      const data = await res.json();
      const extracted = extractSizesFromJsonHeuristic(data);
      extracted.forEach((s) => apiSizes.add(s));
    } catch {}
  });

  try {
    await page.goto(ZARA_URL, { waitUntil: "domcontentloaded", timeout: 45000 });

    // UI сигнал: текст "НЕМАЄ В НАЯВНОСТІ"
    const isOut =
      (await page.getByText(OUT_OF_STOCK_TEXT, { exact: false }).count()) > 0;

    // UI сигнал: активні кнопки розмірів
    const sizeButtons = page.locator("button").filter({
      hasText: /^(XXS|XS|S|M|L|XL|XXL|\d{2,3})$/,
    });

    const uiSizes = new Set();
    const count = Math.min(await sizeButtons.count(), 80);

    for (let i = 0; i < count; i++) {
      const btn = sizeButtons.nth(i);
      try {
        if (!(await btn.isVisible())) continue;
        const text = normalizeSize(await btn.innerText());
        if (!text) continue;

        const disabledAttr = await btn.getAttribute("disabled");
        const ariaDisabled = String((await btn.getAttribute("aria-disabled")) || "").toLowerCase();
        const className = String((await btn.getAttribute("class")) || "").toLowerCase();

        const disabled =
          disabledAttr !== null || ariaDisabled === "true" || className.includes("disabled");

        if (!disabled) uiSizes.add(text);
      } catch {}
    }

    // дати мережевим JSON добігти
    await page.waitForTimeout(1500);

    const apiList = [...apiSizes];
    const uiList = [...uiSizes];

    const apiHit = apiList.length > 0 && hasWantedSize(apiList);
    const uiHit = !isOut && uiList.length > 0 && hasWantedSize(uiList);

    const inStock = apiHit || uiHit;
    const sizes = [...new Set([...apiList, ...uiList])];

    return { inStock, apiHit, uiHit, sizes, isOut };
  } finally {
    await browser.close();
  }
}

async function notify(reason, sizes) {
  const sizeText = sizes?.length ? sizes.join(", ") : "S/M (деталі не зчитались)";
  const text =
    `🔔 Zara: ПАЛЬТО ДОСТУПНЕ (${reason})\n` +
    `Розміри: ${sizeText}\n` +
    `Посилання: ${ZARA_URL}`;

  await Promise.all([
    sendTelegram(text),
    sendEmail("Zara: пальто доступне ✅", text),
  ]);
}

async function main() {
  console.log(`Watching: ${ZARA_URL}`);
  console.log(`Wanted sizes: ${WANTED_SIZES.join(", ")}`);
  console.log(`Check every: ${CHECK_EVERY_SECONDS}s | Notify every: ${NOTIFY_EVERY_SECONDS}s`);

    // ✅ TEST: перевіряємо що Telegram+Email працюють
    try {
        await Promise.all([
            sendTelegram("✅ Zara watcher запущено. Тестове повідомлення."),
            sendEmail("✅ Zara watcher запущено", "Це тестовий лист. Якщо ти його бачиш — пошта працює."),
        ]);
            console.log("✅ Test notifications sent (Telegram + Email).");
        } catch (e) {
            console.error("❌ Test notifications failed:", e.message);
    }

  let lastCheckAt = 0;
  let lastNotifyAt = 0;
  let inStock = false;
  let lastSizes = [];

  while (true) {
    const t = Date.now();

    if (t - lastCheckAt >= CHECK_EVERY_SECONDS * 1000) {
      lastCheckAt = t;

      try {
        const r = await checkOnce();
        inStock = r.inStock;
        lastSizes = r.sizes;

        console.log(
          `[${nowIso()}] inStock=${r.inStock} apiHit=${r.apiHit} uiHit=${r.uiHit} sizes=[${r.sizes.join(", ")}] out=${r.isOut}`
        );

        // якщо щойно з'явилось — шлемо одразу
        if (inStock && lastNotifyAt === 0) {
          const reason = r.apiHit && r.uiHit ? "API+UI" : r.apiHit ? "API" : "UI";
          await notify(reason, lastSizes);
          lastNotifyAt = Date.now();
        }

        // якщо зникло — скидаємо таймер повторів
        if (!inStock) {
          lastNotifyAt = 0;
        }
      } catch (e) {
        console.error("Check error:", e.message);
      }
    }

    // повтори кожну хвилину, поки inStock=true
    if (inStock && lastNotifyAt !== 0 && t - lastNotifyAt >= NOTIFY_EVERY_SECONDS * 1000) {
      try {
        await notify("repeat", lastSizes);
        lastNotifyAt = Date.now();
        console.log(`[${nowIso()}] notified (repeat)`);
      } catch (e) {
        console.error("Notify error:", e.message);
      }
    }

    await sleep(1000);
  }
}

main();
