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
    console.log(`📦 Завантажено ${products.length} товарів з products.json`);
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
    // Якщо "Турбо-режим" активний (знайшли товар протягом останніх 10 хв)
    // Відпочиваємо мало: 10–15 секунд
    if (now < fastModeUntil) return 10000 + Math.random() * 5000; 
    // Звичайний режим (нічого немає)
    // Відпочиваємо довше: 40–70 секунд, щоб не дратувати сервер
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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // Даємо 10 сек

    try {
        // Генеруємо випадковий ID запиту (RequestId), щоб виглядати як реальний моніторинг
        const requestId = Math.floor(Math.random() * 1000000000);
        
        const res = await fetch(`${product.apiUrl}?cb=${requestId}`, {
            signal: controller.signal,
            headers: { 
                // 🔥 ПОВНИЙ НАБІР ЗАГОЛОВКІВ CHROME (WINDOWS) 🔥
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Cookie": GLOBAL_COOKIE,
                
                // Це критично важливо для обходу 403:
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
                "Accept-Language": "uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache",
                "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                "Sec-Ch-Ua-Mobile": "?0",
                "Sec-Ch-Ua-Platform": '"Windows"',
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "none",
                "Sec-Fetch-User": "?1",
                "Upgrade-Insecure-Requests": "1"
            },
        });

        clearTimeout(timeoutId);

        if (!res.ok) {
            // Якщо 403 - не спамимо в консоль, просто пишемо "Block"
            if (res.status === 403) {
                 process.stdout.write("x"); // 'x' означає 403
                 return false;
            }
            console.log(`\n⚠️ ${product.name}: HTTP ${res.status}`); 
            return false;
        }

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

            myFoundSizes.sort((a, b) => {
                const sizeA = product.skuToSize[a.sku];
                const sizeB = product.skuToSize[b.sku];
                return product.targetSizes.indexOf(sizeA) - product.targetSizes.indexOf(sizeB);
            });

            const bestChoice = myFoundSizes[0];
            const sizeName = product.skuToSize[bestChoice.sku];
            
            buyQueue.push({ product: product, productName: product.name, skuId: bestChoice.sku, sizeName: sizeName });
            processBuyQueue();

            state.set(product.apiUrl, { wasInStock: true });
            return true; 
        }

        state.set(product.apiUrl, { wasInStock: hasTargetStock });
        process.stdout.write(hasTargetStock ? "!" : ".");
        return hasTargetStock;

    } catch (e) {
        clearTimeout(timeoutId);
        return false; 
    }
}

async function smartLoop() {
    if (isTickRunning) return setTimeout(smartLoop, 1000);
    isTickRunning = true;

    try {
        console.log(`\n🔄 Починаю коло перевірки (${new Date().toLocaleTimeString()})...`);
        
        let somethingFound = false;

        // Йдемо по черзі, а не натовпом
        for (const product of products) {
            // Перевіряємо один товар
            const result = await checkOne(product);
            
            // Якщо знайшли - запам'ятовуємо, щоб увімкнути турбо-режим
            if (result) somethingFound = true;
            
            // 🛑 ПАУЗА МІЖ ТОВАРАМИ (Safety Gap)
            // Випадкова затримка від 1 до 3 секунд.
            // Це збиває ритм і обманює захист ботів.
            const interItemDelay = 1000 + Math.random() * 2000;
            await new Promise(r => setTimeout(r, interItemDelay));
        }

        // Якщо хоч щось знайшли у цьому колі — вмикаємо режим "Форсаж" на 10 хвилин
        if (somethingFound) {
            console.log("🔥 Увімкнено ТУРБО-РЕЖИМ на 10 хвилин!");
            fastModeUntil = Date.now() + 4 * 60 * 1000;
        }

    } catch (e) {
        console.log("Loop error:", e.message);
    } finally {
        isTickRunning = false;
    }

    // Пауза ПІСЛЯ всього кола
    const delay = getNextDelay();
    console.log(`💤 Коло завершено. Сплю ${(delay / 1000).toFixed(0)} сек...`);
    
    setTimeout(smartLoop, delay);
}

console.log(`🚀 Smart Sniper v3.0 (Persistent Session) запущено!`);
smartLoop();


