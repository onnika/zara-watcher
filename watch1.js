import fetch from "node-fetch";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();


const products = JSON.parse(fs.readFileSync("./products.json", "utf-8"));

let fastModeUntil = 0;

let isTickRunning = false;

function getNextDelay() {
  const now = Date.now();

  // якщо був in_stock останні 10 хв → швидкий режим
  if (now < fastModeUntil) {
    return 10000 + Math.random() * 5000; // 10–15 сек
  }

  // звичайний режим
  return 40000 + Math.random() * 30000; // 40–70 сек
}

async function smartLoop() {
  try {
    if (isTickRunning) {
      // на всякий випадок: не накладаємо перевірки
      const delay = getNextDelay();
      console.log(`⏭️ Tick still running. Next try in ${(delay / 1000).toFixed(0)} sec`);
      return setTimeout(smartLoop, delay);
    }

    isTickRunning = true;

    const anyInStock = await tick();

    if (anyInStock) {
      fastModeUntil = Date.now() + 10 * 60 * 1000; // 10 хв швидкого режиму
    }
  } catch (e) {
    console.log("Loop error:", e.message);
  } finally {
    isTickRunning = false;
  }

  const delay = getNextDelay();
  console.log(`⏳ Next check in ${(delay / 1000).toFixed(0)} sec`);
  setTimeout(smartLoop, delay);
}


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
    `👉 Відкрити товар:\n${p.pageUrl}\n` 
    /*(skuList ? `\nSKU (in stock): ${skuList}\n` : "") +
    `\nAPI:\n${p.apiUrl}`*/
  );
}

async function checkOne(product) {
  const res = await fetch(product.apiUrl, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
  });

  if (!res.ok) {
    console.log(`[${new Date().toISOString()}] ${product.name}: HTTP ${res.status}`);
    return;
  }

  const data = await res.json();
  console.log(data);
  const skus = data?.skusAvailability || [];
  const inStockSkus = skus.filter((s) => s.availability && s.availability !== "out_of_stock");
  const inStock = inStockSkus.length > 0;

  const myFoundSizes = inStockSkus.filter(item => {
    // 1. Беремо ID товару (наприклад, 452721095)
    const skuId = item.sku; 
    
    // 2. Дізнаємось його людську назву через твій mapping (наприклад, "S")
    const sizeName = product.skuToSize[skuId];

    // 3. Перевіряємо, чи є ця назва у списку бажаних ("S" входить в ["S", "M"]?)
    // Важливо: targetSizes може бути undefined, тому додаємо перевірку
    return sizeName && product.targetSizes.includes(sizeName);
  });

  // Якщо масив myFoundSizes не порожній — значить знайдено саме ТВІЙ розмір
  if (myFoundSizes.length > 0) {
      console.log("🎉 УРА! ЗНАЙДЕНО ПОТРІБНІ РОЗМІРИ:");
      
      myFoundSizes.forEach(item => {
          const sizeName = product.skuToSize[item.sku];
          console.log(`- Розмір: ${sizeName} (SKU: ${item.sku})`);
      });

      // Тут викликаєш sendTelegramNotification(product, myFoundSizes);
  } else {
      // console.log("Доступні інші розміри, але не твої.");
  }

  const prev = state.get(product.apiUrl) || { wasInStock: false };


  // ✅ тільки 1 раз: коли З'ЯВИВСЯ (перехід)
  if (inStock && !prev.wasInStock) {
    const msg = formatMsg(product, inStockSkus);
    const subject = `🛍 Zara: ${product.name} — є в наявності!`;

    await Promise.allSettled([sendTelegram(msg), sendEmail(subject, msg)]);
    console.log(`🔔 Notified once: ${product.name}`);

    console.log(
    `[${new Date().toISOString()}] ${product.name}: inStock=${inStock} skus=[${inStockSkus
      .map((x) => x.sku)
      .join(", ")}]`
    );

    state.set(product.apiUrl, { wasInStock: true });
    return;
  }

  // якщо пропав — скинути, щоб наступного разу знову спрацювало
  if (!inStock && prev.wasInStock) {
    state.set(product.apiUrl, { wasInStock: false });
    console.log(`↩️ Back to out_of_stock: ${product.name}`);
    return;
  }

  // інакше просто оновлюємо
  state.set(product.apiUrl, { wasInStock: inStock });
  return inStock;
}

async function tick() {
  const results = await Promise.allSettled(products.map((p) => checkOne(p)));

  // якщо хоча б один товар in_stock
  const anyInStock = results.some(
    (r) => r.status === "fulfilled" && r.value === true
  );

  return anyInStock;
}

console.log(`Watching ${products.length} products.`);
smartLoop();