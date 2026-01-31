/**
 * 🚀 SMART SNIPER v3.1 (Hold & Pay Mode)
 * * ОПИС:
 * Бот для Zara з постійною сесією.
 * ГОЛОВНА ФІШКА: Після додавання товару в кошик браузер НЕ ЗАКРИВАЄТЬСЯ.
 * Ти можеш сісти за комп'ютер і оплатити товар прямо у вікні бота.
 * * ⚙️ ІНСТРУКЦІЯ:
 * 1. Якщо бот купив товар -> почуєш звук "БІП-БІП".
 * 2. Підійди до ПК -> Вікно з кошиком буде відкрите.
 * 3. Оплати товар у цьому вікні.
 * 4. Закрий браузер вручну, щоб бот продовжив роботу (або перезапусти його).
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
    userDataDir: "./zara_session",
    cookieFile: "./cookies.txt"
};

// --- АВТО-ЗАВАНТАЖЕННЯ КУКІВ ---
let GLOBAL_COOKIE = "";

function loadCookies() {
    try {
        if (fs.existsSync(CONFIG.cookieFile)) {
            GLOBAL_COOKIE = fs.readFileSync(CONFIG.cookieFile, "utf-8").trim();
            console.log("🍪 Куки завантажено для API-сканера.");
        } else {
            console.log("⚠️ Файл cookies.txt не знайдено! (API працюватиме гірше)");
        }
    } catch (e) { console.error(e); }
}
loadCookies();

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

// --- ЗВУКОВИЙ СИГНАЛ ---
function playAlarm() {
    // Робить системний "БІП" у терміналі (працює на Windows/Mac)
    process.stdout.write('\x07');
    setTimeout(() => process.stdout.write('\x07'), 500);
    setTimeout(() => process.stdout.write('\x07'), 1000);
}

// --- ОБРОБКА ЧЕРГИ ---
async function processBuyQueue() {
    if (isBuyingProcessActive || buyQueue.length === 0) return;
    isBuyingProcessActive = true;

    while (buyQueue.length > 0) {
        const task = buyQueue.shift();
        console.log(`\n🛍️ [ЧЕРГА] Купуємо: ${task.productName} (${task.sizeName})`);
        await addToCart(task.product, task.skuId, task.sizeName);
        console.log(`✅ [ЧЕРГА] Завдання завершено.`);
    }
    isBuyingProcessActive = false;
}

// --- ФУНКЦІЯ ПОКУПКИ (UI + ХІРУРГІЯ) ---
async function addToCart(product, skuId, sizeName) {
    console.log(`🚀 (SNIPER) Відкриваю вікно з твоїм профілем...`);

    let context = null;
    let browserClosed = false; 

    try {
        context = await chromium.launchPersistentContext(CONFIG.userDataDir, {
            headless: false, 
            channel: "chrome", 
            viewport: { width: 1280, height: 800 },
            args: ['--disable-blink-features=AutomationControlled']
        });

        const page = await context.pages()[0] || await context.newPage();
        
        // Блокування поки залишаємо для швидкості покупки
        const blockResources = '**/*.{png,jpg,jpeg,svg,woff,woff2}';
        await page.route(blockResources, route => route.abort());

        console.log("🌍 Завантажую сторінку...");
        await page.goto(product.pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

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

        console.log("\n✅✅✅ ТОВАР У КОШИКУ! ✅✅✅");
        playAlarm(); 

        await sendTelegram(`🛒 <b>ТОВАР У КОШИКУ!</b>\n👗 ${product.name}\n📏 Розмір: ${sizeName}\n\n👉 <b>Швидше біжи до комп'ютера!</b>`);

        // --- ПІДГОТОВКА ДЛЯ ЛЮДИНИ (НОВА ЛОГІКА) ---
        console.log("🔓 Знімаю блокування і йду в кошик...");
        await page.unroute(blockResources); 
        
        // Переходимо в кошик
        await page.goto("https://www.zara.com/ua/uk/shop/cart", { waitUntil: "domcontentloaded" });
        
        // Чекаємо секунду, щоб сторінка (і глюки) провантажились
        await page.waitForTimeout(2000);

        // 🔥 ХІРУРГІЧНЕ ВТРУЧАННЯ: ВИДАЛЯЄМО ШТОРКУ 🔥
        console.log("🔪 Вирізаю сіру шторку і розблоковую прокрутку...");
        
        await page.evaluate(() => {
            // 1. Знаходимо всі елементи, схожі на "шторку" (overlay/backdrop/mask) і видаляємо їх
            // Zara використовує класи типу 'zds-modal-backdrop', 'mask', або просто div на весь екран
            const blockers = document.querySelectorAll('div[class*="backdrop"], div[class*="overlay"], div[class*="mask"], div[class*="modal"]');
            blockers.forEach(el => el.remove());

            // 2. Дуже важливо: Модальні вікна блокують <body> (роблять overflow: hidden)
            // Ми примусово вмикаємо прокрутку назад
            document.body.style.overflow = 'auto';
            document.body.style.position = 'static';
            document.documentElement.style.overflow = 'auto';
            
            console.log("Cleaned UI.");
        });

        console.log("🛑 Я НЕ ЗАКРИВАЮ БРАУЗЕР.");
        console.log("💳 Інтерфейс розблоковано. Оплачуй!");
        console.log("⏳ Чекаю 1 годину...");

        // Тримаємо вікно відкритим
        await new Promise(resolve => {
            context.on('close', resolve);
            setTimeout(resolve, 3600000); 
        });

        browserClosed = true;

    } catch (e) {
        console.error("Sniper Error:", e.message);
        if (context) await context.close();
    } finally {
        if (context && !browserClosed) {
            // await context.close(); 
        }
    }
}

// --- API МОНІТОРИНГ (Без змін) ---
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
                "Cookie": GLOBAL_COOKIE 
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

console.log(`🚀 Smart Sniper v3.1 (Pay in Bot) запущено!`);
smartLoop();