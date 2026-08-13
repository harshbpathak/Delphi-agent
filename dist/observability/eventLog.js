import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const logPath = process.env.DELPHI_AGENT_LOG ?? path.join(os.homedir(), '.delphi', 'agent-events.jsonl');
let dirReady = false;
export function logEvent(type, text, extra = {}) {
    try {
        if (!dirReady) {
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            dirReady = true;
        }
        fs.appendFileSync(logPath, JSON.stringify({ ts: Date.now(), type, text, ...extra }) + '\n');
    }
    catch (e) {
        console.warn('eventLog write failed:', e.message);
    }
}
export function eventLogPath() {
    return logPath;
}
/** Read the most recent `limit` events (oldest first). Missing file → []. */
export function readEvents(limit = 300) {
    let raw;
    try {
        raw = fs.readFileSync(logPath, 'utf8');
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of raw.split('\n').slice(-limit)) {
        if (!line.trim())
            continue;
        try {
            const e = JSON.parse(line);
            if (e && typeof e.ts === 'number')
                out.push(e);
        }
        catch { /* skip malformed line */ }
    }
    return out;
}
