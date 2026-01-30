import fs from "fs";
import dotenv from "dotenv";

// Якщо Node.js новіший за v18, fetch вбудований. 
// Якщо старий — розкоментуй рядок нижче:
// import fetch from "node-fetch"; 

dotenv.config();

// Налаштування
const CONFIG = {
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    productsFile: "./products.json"
};

// Читаємо товари
let products = [];
try {
    products = JSON.parse(fs.readFileSync(CONFIG.productsFile, "utf-8"));
} catch (e) {
    console.error("❌ Не вдалося прочитати products.json");
    process.exit(1);
}

// СТАН (Пам'ять бота)
// key: pageUrl, value: { wasInStock: boolean }
const state = new Map(); 

let fastModeUntil = 0;
let isTickRunning = false;

// --- ЛОГІКА ІНТЕРВАЛІВ ---
function getNextDelay() {
    const now = Date.now();
    
    // Якщо fastMode активний (знайшли товар недавно) -> перевіряємо кожні 10-15 сек
    if (now < fastModeUntil) {
        return 10000 + Math.random() * 5000; 
    }
    
    // Звичайний режим -> кожні 40-70 сек
    return 40000 + Math.random() * 30000;
}

// --- ЛОГІКА СПОВІЩЕНЬ ---
async function sendTelegram(text) {
    if (!CONFIG.telegramToken || !CONFIG.telegramChatId) {
        console.log("⚠️ Telegram не налаштовано в .env (але я б відправив це):");
        console.log(text);
        return;
    }

    try {
        await fetch(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: CONFIG.telegramChatId,
                text: text,
                parse_mode: "HTML", // Додаємо красу (жирний шрифт, посилання)
                disable_web_page_preview: false,
            }),
        });
    } catch (e) {
        console.error("Telegram Error:", e.message);
    }
}

function formatMsg(p, foundItems) {
    // Формуємо красивий список знайдених розмірів
    const sizesList = foundItems
        .map(item => `<b>${p.skuToSize[item.sku]}</b>`)
        .join(", ");

    return (
        `🔥 Zara: З'ЯВИВСЯ РОЗМІР!\n` +
        `👗 ${p.name}\n\n` +       // Просто назва
        `✅ Розміри: ${sizesList}\n\n` +
        `🔗 Посилання:\n${p.pageUrl}` // Пряме посилання, яке Telegram не блокує
    );
}

// --- ГОЛОВНА ПЕРЕВІРКА ---
async function checkOne(product) {
    try {
        /*const res = await fetch(product.apiUrl, {
            headers: { 
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)",
                "Cache-Control": "no-cache"
            },
        });*/
        // Генеруємо випадкове число, щоб кожен запит був унікальним
        // Це змушує сервер ігнорувати старий кеш і давати свіжі дані
        const cacheBuster = Math.floor(Math.random() * 1000000000);

        // Додаємо його до URL
        const freshUrl = `${product.apiUrl}?cb=${cacheBuster}`;

        const res = await fetch(freshUrl, {
            headers: { 
                // Прикидаємось офіційним додатком Zara на Android (вони менше захищені, ніж iOS)
                "User-Agent": "Zara/13.0.0 (Android 14; Pixel 7)", 
                
                // Критично важливі заголовки для швидкості
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache",
                "Expires": "0",
                
                // Це іноді допомагає, якщо API вимагає тип контенту
                "Accept": "application/json",
                "Connection": "keep-alive"
            },
        });

        if (!res.ok) {
            console.log(`⚠️ ${product.name}: HTTP ${res.status}`);
            return false;
        }

        const data = await res.json();
        const allSkus = data?.skusAvailability || [];
        
        // 1. Фільтруємо все, що в наявності (не out_of_stock)
        const inStockSkus = allSkus.filter((s) => s.availability && s.availability !== "out_of_stock");
        
        // 2. Фільтруємо тільки ТВОЇ розміри (Target Sizes)
        const myFoundSizes = inStockSkus.filter(item => {
            const skuId = item.sku; 
            // Якщо skuToSize ще немає в JSON, пропускаємо
            if (!product.skuToSize) return false;

            const sizeName = product.skuToSize[skuId];
            
            // Чи є цей розмір у списку бажаних?
            return sizeName && product.targetSizes && product.targetSizes.includes(sizeName);
        });

        const hasTargetStock = myFoundSizes.length > 0;

        // Отримуємо попередній стан (або false, якщо вперше)
        const prevState = state.get(product.apiUrl) || { wasInStock: false };

        // --- СЦЕНАРІЙ 1: Товар З'ЯВИВСЯ (Transition: No -> Yes) ---
        if (hasTargetStock && !prevState.wasInStock) {
            console.log(`\n🚨 ALARM! Знайдено розміри для: ${product.name}`);
            
            const msg = formatMsg(product, myFoundSizes);
            await sendTelegram(msg);

            // Оновлюємо стан на "Є"
            state.set(product.apiUrl, { wasInStock: true });
            return true; // Повертаємо true, щоб увімкнути Fast Mode
        }

        // --- СЦЕНАРІЙ 2: Товар ПРОПАВ (Transition: Yes -> No) ---
        if (!hasTargetStock && prevState.wasInStock) {
            console.log(`📉 ${product.name}: Знову зник.`);
            state.set(product.apiUrl, { wasInStock: false });
            return false;
        }

        // --- СЦЕНАРІЙ 3: Статус не змінився ---
        // Якщо товар є, і ми вже про це знаємо — просто оновлюємо таймштамп, але не спамимо
        state.set(product.apiUrl, { wasInStock: hasTargetStock });
        
        if (hasTargetStock) {
            process.stdout.write("!"); // Індикатор, що товар все ще є
            return true; // Тримаємо Fast Mode
        } else {
            process.stdout.write("."); // Індикатор, що нічого немає
            return false;
        }

    } catch (e) {
        console.error(`Error checking ${product.name}:`, e.message);
        return false;
    }
}

// --- ЦИКЛ ---
async function smartLoop() {
    try {
        if (isTickRunning) {
             // Якщо попередній цикл завис, пропускаємо цей крок
            return setTimeout(smartLoop, 1000); 
        }

        isTickRunning = true;

        // Перевіряємо всі товари паралельно
        const results = await Promise.all(products.map(p => checkOne(p)));
        
        // Чи є хоча б один бажаний товар в наявності?
        const anyTargetInStock = results.some(res => res === true);

        if (anyTargetInStock) {
            // Вмикаємо "Форсаж" на 10 хвилин
            fastModeUntil = Date.now() + 10 * 60 * 1000; 
        }

    } catch (e) {
        console.log("Loop error:", e.message);
    } finally {
        isTickRunning = false;
    }

    const delay = getNextDelay();
    // Виводимо лог тільки якщо режим змінився або довга пауза, щоб не засмічувати консоль
    if (delay > 15000) {
        // console.log(`⏳ Спимо ${(delay / 1000).toFixed(0)} сек...`);
    }
    
    setTimeout(smartLoop, delay);
}

console.log(`🚀 Smart Sniper запущено!`);
console.log(`📦 Товарів у списку: ${products.length}`);
console.log(`🎯 Цільові розміри враховано.`);
console.log(`-----------------------------------`);

smartLoop();