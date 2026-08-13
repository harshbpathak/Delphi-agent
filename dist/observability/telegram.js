import { getState, setState, performanceSnapshot } from '../persistence/db.js';
import { readEvents } from './eventLog.js';
import * as dotenv from 'dotenv';
dotenv.config();
/**
 * Telegram bot: push notifications + remote control from your phone.
 *
 * Setup (free, 2 minutes):
 *  1. Message @BotFather on Telegram → /newbot → copy the token.
 *  2. Put TELEGRAM_BOT_TOKEN=<token> in .env.
 *  3. Message your new bot anything, then start the agent — it captures your
 *     chat id automatically on the first message and stores it.
 *
 * Commands: /status /holdings /pnl /halt /resume /logs
 * Without a token configured, every function here is a silent no-op.
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
const api = (method) => `https://api.telegram.org/bot${token}/${method}`;
let chatId = process.env.TELEGRAM_CHAT_ID || null;
let pollOffset = 0;
let statusProvider = null;
let holdingsProvider = null;
export function telegramEnabled() {
    return !!token;
}
export async function notify(text) {
    if (!token || !chatId)
        return;
    try {
        await fetch(api('sendMessage'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(10_000),
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
        });
    }
    catch { /* notifications must never break trading */ }
}
async function handleCommand(cmd) {
    switch (cmd.split(/[@\s]/)[0]) {
        case '/status': {
            return statusProvider ? await statusProvider() : 'Agent running. No status provider registered.';
        }
        case '/holdings': {
            return holdingsProvider ? await holdingsProvider() : 'No holdings provider registered.';
        }
        case '/pnl': {
            const p = await performanceSnapshot();
            return `📒 Journal: ${p.totalTrades} live trades, ${p.settled} settled\nNet realized PnL: ${p.netPnl.toFixed(4)} TST`;
        }
        case '/halt': {
            await setState('halted', '1');
            return '🛑 Trading HALTED. Positions and sweeps continue; no new trades. /resume to re-enable.';
        }
        case '/resume': {
            await setState('halted', '0');
            return '▶️ Trading RESUMED.';
        }
        case '/logs': {
            const events = readEvents(10);
            if (events.length === 0)
                return 'No events yet.';
            return events.map(e => `${new Date(e.ts).toISOString().slice(11, 19)} [${e.type}] ${e.text.slice(0, 120)}`).join('\n');
        }
        default:
            return 'Commands: /status /holdings /pnl /halt /resume /logs';
    }
}
async function pollUpdates() {
    if (!token)
        return;
    try {
        const res = await fetch(api(`getUpdates?timeout=25&offset=${pollOffset}`), {
            signal: AbortSignal.timeout(35_000),
        });
        const data = await res.json();
        for (const upd of data.result || []) {
            pollOffset = upd.update_id + 1;
            const msg = upd.message;
            if (!msg?.text)
                continue;
            // First contact captures the chat id (so no manual chat-id hunting).
            if (!chatId) {
                chatId = String(msg.chat.id);
                await setState('telegramChatId', chatId);
                await notify('✅ Connected. This chat now receives MHA agent notifications.');
            }
            if (String(msg.chat.id) !== chatId)
                continue; // only the owner controls the agent
            const reply = await handleCommand(msg.text.trim());
            await notify(reply);
        }
    }
    catch { /* poll errors are routine (timeouts); just re-loop */ }
    setTimeout(pollUpdates, 1000);
}
export async function startTelegram(providers) {
    if (!token) {
        console.log('ℹ️  Telegram bot disabled (no TELEGRAM_BOT_TOKEN).');
        return;
    }
    statusProvider = providers.status;
    holdingsProvider = providers.holdings;
    if (!chatId)
        chatId = await getState('telegramChatId');
    pollUpdates();
    console.log(`✅ Telegram bot active${chatId ? '' : ' — message your bot once to link this chat'}.`);
}
