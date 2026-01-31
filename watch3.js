/**
 * 🚀 SMART SNIPER v3.0 (Persistent Session / Постійна Сесія)
 * * ОПИС:
 * Цей бот автоматично моніторить наявність товарів на Zara і купує їх.
 * Використовує збережений профіль браузера, щоб не вводити логін щоразу.
 * * ⚙️ ЯК КОРИСТУВАТИСЯ:
 * 1. Перший запуск (або якщо злетів логін):
 * - Запустити: node login.js
 * - Ввести логін/пароль вручну у вікні, що відкриється.
 * - Переконатися, що вхід виконано.
 * - Закрити браузер хрестиком (скрипт збереже куки у cookies.txt).
 * * 2. Основна робота (Полювання):
 * - Запустити: node smart-sniper.js
 * - Бот підтягне сесію з папки 'zara_session' та файлу 'cookies.txt'.
 * - Залишити працювати.
 * * 3. Якщо бот перестав купувати або сипле помилками:
 * - Повторити пункт 1.
 * * 📁 ФАЙЛИ:
 * - products.json: Список товарів та пріоритет розмірів.
 * - zara_session/: Папка з даними браузера (НЕ ВИДАЛЯТИ ПІД ЧАС РОБОТИ).
 * - cookies.txt: Технічні куки для API-сканера.
 */
import fs from "fs";
import dotenv from "dotenv";
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

const stealth = stealthPlugin();
chromium.use(stealth);

dotenv.config();

const CONFIG = {
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    productsFile: "./products.json",
    userDataDir: "./zara_session", // Папка з профілем
    cookieFile: "./cookies.txt"    // Файл для fetch-запитів
};

// --- АВТО-ЗАВАНТАЖЕННЯ КУКІВ ---
let GLOBAL_COOKIE = "";

function loadCookies() {
    try {
        if (fs.existsSync(CONFIG.cookieFile)) {
            GLOBAL_COOKIE = fs.readFileSync(CONFIG.cookieFile, "utf-8").trim();
            console.log("🍪 Куки завантажено з файлу.");
        } else {
            console.log("⚠️ Файл cookies.txt не знайдено! Запусти спочатку 'node login.js'");
        }
    } catch (e) {
        console.error("Помилка читання куків:", e);
    }
}
loadCookies(); // Завантажуємо при старті

// Читаємо товари
let products = [];
try {
    products = JSON.parse(fs.readFileSync(CONFIG.productsFile, "utf-8"));
} catch (e) {
    console.error("❌ Не вдалося прочитати products.json"); process.exit(1);
}

const state = new Map(); 
let fastModeUntil = 0;
let isTickRunning = false;
const buyQueue = []; 
let isBuyingProcessActive = false;

// --- ОБРОБКА ЧЕРГИ ---
async function processBuyQueue() {
    if (isBuyingProcessActive || buyQueue.length === 0) return;
    isBuyingProcessActive = true;

    while (buyQueue.length > 0) {
        const task = buyQueue.shift();
        console.log(`\n🛍️ [ЧЕРГА] Купуємо: ${task.productName} (${task.sizeName})`);
        await addToCart(task.product, task.skuId, task.sizeName);
        console.log(`✅ [ЧЕРГА] Завершено. У черзі: ${buyQueue.length}`);
        await new Promise(r => setTimeout(r, 2000));
    }
    isBuyingProcessActive = false;
}

// --- ФУНКЦІЯ ПОКУПКИ (ТЕПЕР ЧЕРЕЗ PERSISTENT CONTEXT) ---
async function addToCart(product, skuId, sizeName) {
    console.log(`🚀 (SNIPER) Відкриваю браузер з твоїм профілем...`);

    let context = null;
    try {
        // 🔥 МАГІЯ: Відкриваємо браузер, де ти ВЖЕ залогінена
        context = await chromium.launchPersistentContext(CONFIG.userDataDir, {
            headless: false, 
            channel: "chrome", // Намагаємось використати системний Chrome
            viewport: { width: 1280, height: 800 },
            args: ['--disable-blink-features=AutomationControlled'] // Додаткове маскування
        });

        // Куки вже всередині, додавати нічого не треба!
        
        const page = await context.pages()[0] || await context.newPage();
        await page.route('**/*.{png,jpg,jpeg,svg,woff,woff2}', route => route.abort());

        console.log("🌍 Завантажую сторінку...");
        await page.goto(product.pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Перевірка, чи ми залогінені (опціонально)
        // const loginBtn = page.getByText(/увійти/i);
        // if (await loginBtn.isVisible()) console.log("⚠️ Увага: Схоже, сесія злетіла. Треба перезапустити login.js");

        // 1. Тиснемо ДОДАТИ
        console.log("👇 Клікаю 'ДОДАТИ'...");
        const addBtn = page.locator('button').filter({ hasText: /додати|add|кошик/i }).first();
        await addBtn.click({ force: true });
        
        // 2. Вибір розміру
        console.log(`⏳ Чекаю кнопку "${sizeName}"...`);
        const sizeRegex = new RegExp(`^\\s*${sizeName}\\s*$`, 'i');
        const targetSize = page.getByText(sizeRegex).first();

        try {
            await targetSize.waitFor({ state: 'visible', timeout: 5000 });
            await targetSize.click({ force: true });
            console.log("✅ Розмір натиснуто.");
        } catch (e) {
            console.log("⚠️ Кнопка розміру не з'явилася. Пробую ще раз меню...");
             if (await addBtn.isVisible()) await addBtn.click({ force: true });
        }

        // 3. Фінальне підтвердження
        await page.waitForTimeout(500);
        if (await addBtn.isVisible()) await addBtn.click({ force: true });

        console.log("✅ Товар додано.");
        await sendTelegram(`🛒 <b>Додано в кошик!</b>\n${product.name}\nРозмір: ${sizeName}\nКОШИК ="https://www.zara.com/ua/uk/shop/cart"`);
        
        await page.waitForTimeout(10000); // 10 сек паузи, потім закриваємо

    } catch (e) {
        console.error("Sniper Error:", e.message);
    } finally {
        if (context) await context.close();
    }
}

// --- API МОНІТОРИНГ ---
function getNextDelay() {
    const now = Date.now();
    if (now < fastModeUntil) return 10000 + Math.random() * 5000; 
    return 40000 + Math.random() * 30000;
}

async function sendTelegram(text) {
    if (!CONFIG.telegramToken) return;
    try {
        await fetch(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: CONFIG.telegramChatId, text: text, parse_mode: "HTML", disable_web_page_preview: false }),
        });
    } catch (e) {}
}

async function checkOne(product) {
    try {
        const cacheBuster = Math.floor(Math.random() * 1000000000);
        const res = await fetch(`${product.apiUrl}?cb=${cacheBuster}`, {
            headers: { 
                "User-Agent": "Zara/13.0.0 (Android 14; Pixel 7)", 
                "Cache-Control": "no-cache",
                "Cookie": GLOBAL_COOKIE // Використовуємо куки з файлу
            },
        });

        if (!res.ok) return false;

        const data = await res.json();
        const inStockSkus = (data?.skusAvailability || []).filter((s) => s.availability && s.availability !== "out_of_stock");
        
        const myFoundSizes = inStockSkus.filter(item => {
            const sizeName = product.skuToSize[item.sku];
            return sizeName && product.targetSizes && product.targetSizes.includes(sizeName);
        });

        const hasTargetStock = myFoundSizes.length > 0;
        const prevState = state.get(product.apiUrl) || { wasInStock: false };

        if (hasTargetStock && !prevState.wasInStock) {
            console.log(`\n🚨 ALARM! Знайдено: ${product.name}`);
            
            let sizesMsg = myFoundSizes.map(i => product.skuToSize[i.sku]).join(", ");
            await sendTelegram(`🔥 <b>ЗНАЙДЕНО!</b>\n👗 <a href="${product.pageUrl}">${product.name}</a>\n✅ Розміри: ${sizesMsg}`);

            // Сортування за пріоритетом
            myFoundSizes.sort((a, b) => {
                const sizeA = product.skuToSize[a.sku];
                const sizeB = product.skuToSize[b.sku];
                return product.targetSizes.indexOf(sizeA) - product.targetSizes.indexOf(sizeB);
            });

            const bestChoice = myFoundSizes[0];
            const sizeName = product.skuToSize[bestChoice.sku];

            console.log(`🎯 Пріоритет: ${sizeName}`);
            buyQueue.push({ product: product, productName: product.name, skuId: bestChoice.sku, sizeName: sizeName });
            processBuyQueue();

            state.set(product.apiUrl, { wasInStock: true });
            return true; 
        }

        state.set(product.apiUrl, { wasInStock: hasTargetStock });
        process.stdout.write(hasTargetStock ? "!" : ".");
        return hasTargetStock;

    } catch (e) { return false; }
}

async function smartLoop() {
    if (isTickRunning) return setTimeout(smartLoop, 1000);
    isTickRunning = true;
    try {
        const results = await Promise.all(products.map(p => checkOne(p)));
        if (results.some(r => r === true)) fastModeUntil = Date.now() + 10 * 60 * 1000;
    } finally { isTickRunning = false; }
    setTimeout(smartLoop, getNextDelay());
}

console.log(`🚀 Smart Sniper v3.0 (Persistent Session) запущено!`);
smartLoop();


