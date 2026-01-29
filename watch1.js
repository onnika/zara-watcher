import fetch from "node-fetch";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const CHECK_EVERY_MS = Number(process.env.CHECK_EVERY_MS || 120_000); // 2 хв

const products = JSON.parse(fs.readFileSync("./products.json", "utf-8"));

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function sendEmail(subject, text) {
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.SMTP_TO || process.env.SMTP_USER,
    subject,
    text,
  });
}

async function sendTelegram(text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: false,
    }),
  });
}

// Стан по кожному товару: щоб сповіщати лише на "перехід" out_of_stock -> in_stock
const state = new Map(); // key: apiUrl, value: { wasInStock: boolean }

function formatMsg(p, inStockSkus) {
  const skuList = inStockSkus.map((x) => x.sku).join(", ");
  return (
    `🔥 Zara: З'ЯВИВСЯ ONLINE!\n` +
    `📌 ${p.name}\n\n` +
    `👉 Відкрити товар:\n${p.pageUrl}\n` +
    (skuList ? `\nSKU (in stock): ${skuList}\n` : "") +
    `\nAPI:\n${p.apiUrl}`
  );
}

async function checkOne(p) {
  const res = await fetch(p.apiUrl, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
  });

  if (!res.ok) {
    console.log(`[${new Date().toISOString()}] ${p.name}: HTTP ${res.status}`);
    return;
  }

  const data = await res.json();
  const skus = data?.skusAvailability || [];
  const inStockSkus = skus.filter((s) => s.availability && s.availability !== "out_of_stock");
  const inStock = inStockSkus.length > 0;

  const prev = state.get(p.apiUrl) || { wasInStock: false };

  console.log(
    `[${new Date().toISOString()}] ${p.name}: inStock=${inStock} skus=[${inStockSkus
      .map((x) => x.sku)
      .join(", ")}]`
  );

  // ✅ тільки 1 раз: коли З'ЯВИВСЯ (перехід)
  if (inStock && !prev.wasInStock) {
    const msg = formatMsg(p, inStockSkus);
    const subject = `🛍 Zara: ${p.name} — є в наявності!`;

    await Promise.allSettled([sendTelegram(msg), sendEmail(subject, msg)]);
    console.log(`🔔 Notified once: ${p.name}`);

    state.set(p.apiUrl, { wasInStock: true });
    return;
  }

  // якщо пропав — скинути, щоб наступного разу знову спрацювало
  if (!inStock && prev.wasInStock) {
    state.set(p.apiUrl, { wasInStock: false });
    console.log(`↩️ Back to out_of_stock: ${p.name}`);
    return;
  }

  // інакше просто оновлюємо
  state.set(p.apiUrl, { wasInStock: inStock });
}

async function tick() {
  await Promise.allSettled(products.map((p) => checkOne(p)));
}

console.log(`Watching ${products.length} products. Check every ${Math.round(CHECK_EVERY_MS / 1000)}s`);
setInterval(() => tick().catch(() => {}), CHECK_EVERY_MS);
tick().catch(() => {});