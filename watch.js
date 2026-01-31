import fs from "fs";
import dotenv from "dotenv";
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

const stealth = stealthPlugin();
chromium.use(stealth);

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
let isBuying = false;

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
            console.log("🚀 Запускаю авто-додавання в кошик...");
            
            // Проходимо по всіх знайдених розмірах (раптом і S, і M з'явилися)
            for (const item of myFoundSizes) {
                // Викликаємо нашу функцію для кожного знайденого SKU
                // item.sku - це те саме число 4527...
                if (isBuying) {
                    console.log("🚦 Бот зайнятий іншою покупкою. Пропускаю авто-додавання, щоб не зламати браузер.");
                } else {
                    isBuying = true; // Займаємо чергу
                    console.log("🚀 Запускаю авто-додавання в кошик...");
                    
                    // Беремо ТІЛЬКИ ПЕРШИЙ знайдений розмір (щоб не відкривати 5 вікон підряд)
                    const firstItem = myFoundSizes[0];
                    await addToCart(product, firstItem.sku);
                    
                    isBuying = false; // Звільняємо чергу
                } 
            }

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
// --- ФУНКЦІЯ ДОДАВАННЯ В КОШИК ---
// (Network -> Headers -> Request Headers -> Cookie)починається з "wk_d2=...; ak_bmsc=..."
const MY_COOKIE = "MicrosoftApplicationsTelemetryDeviceId=454ac88c-6739-4698-a81f-00587aa14f58; MicrosoftApplicationsTelemetryFirstLaunchTime=2026-01-18T13:50:48.037Z; MicrosoftApplicationsTelemetryDeviceId=454ac88c-6739-4698-a81f-00587aa14f58; MicrosoftApplicationsTelemetryFirstLaunchTime=2026-01-18T13:50:48.037Z; selectedRegion=ua; MicrosoftApplicationsTelemetryDeviceId=454ac88c-6739-4698-a81f-00587aa14f58; MicrosoftApplicationsTelemetryFirstLaunchTime=2026-01-18T13:50:48.037Z; access_token=eyJ4NXQjUzI1NiI6ImV6eW96cXZrQjJqem1NMmZSNElBZklJWm5sYjZYN2VidUdwYmxhb2ZXeWciLCJraWQiOiJwcm8taWUtemEtcnNhLWNlcnQtMDYyMDI0IiwiYWxnIjoiUlMyNTYifQ.eyJzdWIiOiIyNzMwMDg3MTMwIiwiYXVkaXRUcmFja2luZ0lkIjoiZjM3MTZlYTctZjNkOS00OTliLWI2YWItOGNjYmIwYzY4OTIxIiwiaXNzIjoiaHR0cHM6Ly9hY2NvdW50LnphcmEuY29tIiwidG9rZW5OYW1lIjoiYWNjZXNzX3Rva2VuIiwic2Vzc2lvbklkIjoiMjc2NzIwNDE4MDE5MjI5Njk4Iiwic3RvcmVJZCI6IjExNzY3IiwidXNlcklkIjoiMjczMDA4NzEzMCIsInVuaXF1ZVVzZXJJZCI6IjQ4MjI2Mzk3OTA1OTUzNDI0MDciLCJhdWQiOiJ3ZWItc3RhbmRhcmQiLCJuYmYiOjE3Njk4NTMxODYsImlkZW50aXR5VHlwZSI6IlIiLCJhdXRoX3RpbWUiOjE3Njk4NTMxODYsInJlYWxtIjoiL3phL2FjY291bnQvIiwidXNlclR5cGUiOiJjdXN0b21lciIsImV4cCI6MTc2OTg1Njc4NiwidG9rZW5UeXBlIjoiSldUVG9rZW4iLCJhdXRoTWV0aG9kIjoiTGVnYWN5LlphcmEuU2Vzc2lvblRva2VuIiwiaWF0IjoxNzY5ODUzMTg2LCJhdXRoTGV2ZWwiOiIxIiwiYnJhbmQiOiJ6YSIsImp0aSI6IjU5YjU5YjljLWNjNzQtNDZmNi04NjBlLWM4NTk2MzNiZTNjZSJ9.DPxjjr_339OeP4pusE4IxeDa_8yVvAQK7rI-ILOLnhPeS2j6uBgrb7N0d32bU7kFjcQ_P15r00JKG_kFVQ5-RNtq8RYpAMZqtHjS-ypSsFVA4l7C17nqtSemI5YrQOgRobllglrcxjSZEZR9jswzjsdZpBfalTO81NLGZ4z0XtKDlt2s08LTz3ln281qG_i4iQk--R0u3eXyHX26EOsFnqCA-RTWQsnu4Q5wTWT97fW3ET6ZItk9BLCFh1TK6WR6na86BCqBBIvl-F2-EWICgd8HL2xcRtDk8fFELrMJtGeb0C55daSMZcUGvfMapac5tDjBT3SYmvMWDj1j436AwuPdG2SHlAILSd1MqNhBvcCq9bBXVtaSGvIy16zpFYe_bzFNpTijU54_qCFzQlcL8t_PnT1pcLquOisOzwmsMp-_EtHy7vpMlUTKoHV49PTUkn-JdgQ9Ifi2djrXxIMCUM18B1nB1srVRa3xqBez30DcrSXRN6URY3rqahPZJfpLR0aNaNlIdPV-QaXnlOHKbe0tGzBP9W9vMym3r9fpoD0s9jzAljcalkefU-wEuo5FwjfLi7QOCwpdqfF-JyyAtAUuzCaV4DNjJCIjLKInGptn7vIES_VW9Y9uToXjSSGehdvUK9edwtResaOO95W74OvUCz8GVXKn42NpGZKctyo; access_token_expires=Sat Jan 31 2026 10:53:04 GMT+0000 (Greenwich Mean Time); user_type=registered; user_id=2730087130; TS019cdd4c=01e6195b12221bcfa85680cecc7a3300825c1ed248ec656ec6ebc7ab107094ffa0588356cedd075654a031eed6581c80825c5c6d88; rid=0a46952a-0ce1-4387-9e56-e3e3da872415; MicrosoftApplicationsTelemetryDeviceId=454ac88c-6739-4698-a81f-00587aa14f58; MicrosoftApplicationsTelemetryFirstLaunchTime=2026-01-18T13:50:48.037Z; OptanonAlertBoxClosed=2026-01-18T13:50:50.938Z; CookiesConsent=C0001%3BC0002%3BC0003%3BC0004; ITXDEVICEID=b4743b9c4e58a0af9470f0ca44c2b4b4; UAITXID=ac21361e97a3bbe0253135280cbc902a1907fcce2c4028cd602fe83da136e740; storepath=ua%2Fen; cart-was-updated-in-standard=true; _gcl_au=1.1.1555159650.1769719590; _ga=GA1.1.1383533387.1769719590; rskxRunCookie=0; rCookie=omip5l25k46u3pyqvri6dmkzxcnda; _fbp=fb.1.1769781002542.1843482119; FPLC=a9956Yf16X5tpYqLkVxCJq8mp2AvGvNmH2gPJYTaMLwGvUB4%2BTLCGiicNsnn4m2ReElTEq5cvqKMlzt4hAibVufqpiww1iSZgoQL5X6n2CNzirXQTpOVC36wkS3aZg%3D%3D; ITXSESSIONID=e15174000e9485d4a6cd6dc730618d0d; bm_mi=9C197E5F2D472F2F7B2ECDA3738F02CF~YAAQBb17XBSigtabAQAAgDpBEx4p4KyEF0nOnxSp5QP0BH4+cSRDbEk3u51Oc8o3jA0Q+9DCxLvdgLxf3Uxg+opqdLmQe8Go7h0Yr5peZB5TGOdC48SmjcYD89p+xbrbqdn4mPzO2Ky3F8BVdzK58foPczJAuk7tDcsQ0CyMmjCTmCfKoRsn2UAclXGroTJ4eE1Yb9cSK/ArfqNmM7mRt2gxUkrvCaaGRjLULF9PT5q5mPR5gY3i0krUqrceqa1pdTk20uCFLWS3MjDQDvzm7PwGAbtFleCxLyvh/P56ru2ALgQtjtOKODsXTqnHo3BbfCnxfc3TnJzgKUAVjIZ8xMvINMc4nj7t2BaFBQwEnmlkOubbzSqfiVHuDUF9oKGwkjnPBwLm0EENHkoT2jxgphA4qumvq21/OMyuRfK7+B29Dr3ysIo7AcKg338Kgf4IvU/5Bco9jr6SWdfG55huRDNNo65f9T1MMC3d6t1YFIG22biHCxOn+d85mZB/7OwRzUJghtQqJ7a0i5DwdeLstGASlBevIVUQEDDL26hHY3nTn9nomTCRgySYFgG/OjsC+zfCWnmwrj85mYsVjXLQkvF0nlID27fGG2RUsetvVU4ZT2DnTVRwZ9JrhEf6EHXskez+AmBToC6Irc4H~1; _abck=CE86C7753E5F5775DEA28706CCE874C7~0~YAAQRL17XEg7kwqcAQAA8294Ew8yfBfk7PsQkI1vH4DnptbE3iZX63nEg8hZl4vJ3gE9d+6c4+9veTuj/hyYvt3PR9eCTCgpFnflrhb/JUp/L62zQks20ArZzkvXa3s4vShKyYrDWy+KLSY3+Cz+Axwqd4yqoWnzbS4RW4FKwyVG626ePe0LSGg4wf9+NDZEPSI2WYEUy/3/0YTAprOVLdV18CjHkFiZyJkKbTHZcu4vrdTuEuw7P5O6Jm+IwCwtTy4fTaBi6yltaM0f6u4jFGE4cE419onv4tZQqqsmjof4eEIL7Ud9CCYYpq31W75vXhhZ1otKPbNphfc9o3Jfw35+FoQmzYotm0Jt8ZAQ81Gwt6jkufZLnTlfHgJmo48svZKPofkdbtcAFCgMrIra4fXb2HmRfXIonHQzoRbqb0PkYoOU6hXrC3UHEJFLqF1g1FeipFT71jYDdg6HVipYme5InKkNRl+fJ/q1qldu099X/DIbi25koTmJvyy0YQEuxNiNrAwgsDa+5/SQE8UFrOjolfzonbMwdCZvDpo3lGkR6Tc0QiHBY6uXNmRsW7TcNQ7WGRAH2KJSgjUfbJGPXjjEwngrbUMWzpywsRh4xjeDAvvof3OugBEZgP1E3aA1MBpUYuNPiBw5H7HLA3XUQlBnMxBmVnbhhLLSFTybdkaPjpEVE9sZ1knZlq5UXpN3o3C5WQ6v0CSI2HF8eFGKzKzBLwuWNDhLjKxfDCqqNRttOWME00h1/4VnJXm1Cdvr7akuSfwwBMR7lWdruuB6JT8Bg+4CetbGVEpaeAgkSTBNIFCnMTJL7Lv3vEbpGYmuq6TEb1NWVLAnfl7myVz4lfAKzUktROYGIvsqQDqzMRjcCS++LDChVzZ1SrF6u4PbIncFug7EsjyuejU9D9m6yYp/T0syzVWVTiaELohtnImjd3/6NW+8zU7/eg==~-1~-1~1769856708~AAQAAAAF%2f%2f%2f%2f%2f0EEPCGaPQ9yZyQMbPYpIo8lcFTmiJ4hD0lCHpnoJwqwdMK4sK97heNUNluL0KnpnuBCq1VfPrjAo0vLQLdJ1xXbocaNTE8T29mfuZzsXLTWvBoIZk9JuAX8cmZ7WCTwNinPetrOhmLDtN1vZLnNMuj%2fMOp1SosMS%2fRK4sHLug%3d%3d~-1; gut=3oscN04a%2Bpdr%2BZMDwR5mfNUL5mqZXhdcobOSyO9Kyw0%3D; bm_sz=C39BBE37480CCB891687291A801763ED~YAAQHr17XN+PLAmcAQAAzf14Ex5h/iWHZRLflndTZMApPvkgIPwzqSTrTcUJHHXAZ4mfS0FcxqMdveS75BAn7YX1cTFaQ2Bb2f1AeqRiLWOjteNLwbNEjoWs2Mr69dEoIyPL+KsukKo3S4N4NyQmKsY+aSQFEGE4B5HOqkRCwvMhPYxiseG1bw9LzKJ3kDKk1vxJjwKunSdGd0TTYzwSZbwKrTpaej9cw14Y1P2yMZhp1XenCFkEv9LUquuKeoLkUKVQTNz+HQpcDc0t8BplMC5MFX6SbHkp3KDtbEgl3Kn5l2C+FBvGZgAOrQD1BuFx1j2vVog50c6aUzQrJqDtG68i1IWPIbcj31kAjLvG5bBjOP92SSUHXB1pNwMJVjET5Bco1h42su2/dzX054wwzbnmx9+TasF3Gha7Ms2YRfbcyixQ7l8wkaqgJx7oXIAmm1Blg55sjdoGctfkSUtqZxwMoW1m9cvD5DRsErmD1AnF3E1mebsrCeWMkE/uieldd1NzTbhrN03o4Kb8kD/lXg==~4277059~3486277; lastRskxRun=1769853252404; OptanonConsent=isGpcEnabled=0&datestamp=Sat+Jan+31+2026+11%3A54%3A12+GMT%2B0200+(%D0%B7%D0%B0+%D1%81%D1%85%D1%96%D0%B4%D0%BD%D0%BE%D1%94%D0%B2%D1%80%D0%BE%D0%BF%D0%B5%D0%B9%D1%81%D1%8C%D0%BA%D0%B8%D0%BC+%D1%81%D1%82%D0%B0%D0%BD%D0%B4%D0%B0%D1%80%D1%82%D0%BD%D0%B8%D0%BC+%D1%87%D0%B0%D1%81%D0%BE%D0%BC)&version=202510.2.0&browserGpcFlag=0&isIABGlobal=false&hosts=&consentId=baaa923f-8e98-46bc-9bee-f87ddb728371&interactionCount=1&isAnonUser=1&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A1&intType=1&geolocation=UA%3B30&AwaitingReconsent=false; _ga_NOTFORGA4TRACKING=GS2.1.s1769849570$o12$g1$t1769853252$j60$l0$h480151595; _ga_HCEXQGE0MW=GS2.1.s1769849570$o12$g1$t1769853252$j55$l0$h0; TS0122c9b6=01e6195b1294873c103f12c5b7cf08536ad1cec111f08c55bfa4dbfef817df07bf7b1ae227dbdc5baa605b4d9f770ab1a6a663b4e5; bm_sv=02E8F2629BB06BC99EA728B2E93D3F6A~YAAQHr17XFmWLAmcAQAA+pp5Ex4qmKPheQMQISHIK1TqsbqOe/D4zNs9kKviUv1icvqzSEafumCdo6Ij964HZWQL2U0pXfeZF9uv5lz97qGqw/FH4YBA3QiAGEAzDbww4hgMI7n6JzvQ5tWdir2zJOPZhG5pb5VW6XLmNpnddO1bQTM28w/T4pIdUwh6++qsBRaEKYy3M8ac0QZvyrYUdyXYNloYKtOq065LRYzpKh4gYTj6o1NX+QSz2v26PUKj~1";

async function addToCart(product, skuId) {
    const sizeName = product.skuToSize ? product.skuToSize[skuId] : null;
    if (!sizeName) { console.log(`❌ Не знаю розмір`); return; }

    console.log(`🚀 (SNIPER) Запускаю покупку: ${product.name} [${sizeName}]...`);

    let browser = null;
    try {
        browser = await chromium.launch({ headless: false }); 
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 }
        });

        // Куки
        if (MY_COOKIE && !MY_COOKIE.includes("ВСТАВ")) {
            try {
                const cookiesList = MY_COOKIE.split(';').map(pair => {
                    const parts = pair.trim().split('=');
                    if (parts.length < 2) return null;
                    return {
                        name: parts[0].trim(), value: parts.slice(1).join('=').trim(),
                        domain: ".zara.com", path: "/", secure: true
                    };
                }).filter(c => c !== null);
                await context.addCookies(cookiesList);
            } catch (e) {}
        }

        const page = await context.newPage();
        
        // Оптимізація: блокуємо картинки для швидкості
        await page.route('**/*.{png,jpg,jpeg,svg,woff,woff2}', route => route.abort());

        console.log("🌍 Завантажую сторінку...");
        await page.goto(product.pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Закриваємо банер
        try {
            const cookieBtn = page.getByRole('button', { name: /прийняти|дозволити|accept/i });
            if (await cookieBtn.isVisible({ timeout: 2000 })) await cookieBtn.click();
        } catch (e) {}

        // === ЕТАП 1: КЛІКАЄМО "ДОДАТИ" ===
        console.log("👇 Клікаю 'ДОДАТИ'...");
        const addBtn = page.locator('button').filter({ hasText: /додати|add|кошик/i }).first();
        
        // Клікаємо і чекаємо...
        await addBtn.click({ force: true });
        
        // === ЕТАП 2: ЧЕКАЄМО ПОЯВИ РОЗМІРУ (РОЗУМНЕ ОЧІКУВАННЯ) ===
        console.log(`⏳ Чекаю появи кнопки "${sizeName}"...`);
        const sizeRegex = new RegExp(`^\\s*${sizeName}\\s*$`, 'i');
        const targetSize = page.getByText(sizeRegex).first();

        try {
            // Ось тут була проблема! Раніше ми чекали фіксовано, а тепер чекаємо "події".
            // timeout: 5000 означає "чекай до 5 секунд, поки вона з'явиться".
            await targetSize.waitFor({ state: 'visible', timeout: 5000 });
            
            console.log(`👇 Клікаю "${sizeName}"...`);
            await targetSize.click({ force: true });
            console.log("✅ Розмір натиснуто.");
        } catch (e) {
            console.log("⚠️ Кнопка розміру не з'явилася вчасно (або вже вибрана). Пробую натиснути ще раз 'ДОДАТИ'.");
        }

        // === ЕТАП 3: ФІНАЛЬНИЙ КЛІК ===
        // Іноді після вибору розміру треба натиснути Додати ще раз
        await page.waitForTimeout(500);
        if (await addBtn.isVisible()) {
            await addBtn.click({ force: true });
        }

        console.log("\n✅✅✅ ОПЕРАЦІЯ ЗАВЕРШЕНА ✅✅✅");
        await sendTelegram(`🛒 <b>СПРОБА ПОКУПКИ ЗАВЕРШЕНА!</b>\nПеревір кошик: <a href="https://www.zara.com/ua/uk/shop/cart">Посилання</a>`);

        // Тримаємо браузер відкритим довше
        await page.waitForTimeout(60000); 

    } catch (e) {
        console.error("Sniper Error:", e.message);
    } finally {
        if (browser) await browser.close();
    }
}

