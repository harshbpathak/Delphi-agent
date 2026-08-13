import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Structured agent event log in the organizer's format:
 * one JSON object per line — { ts, type, text } — at
 * $DELPHI_AGENT_LOG (default ~/.delphi/agent-events.jsonl).
 * The organizer's Agent TUI tails this file and renders it live.
 */

export type AgentEventType = 'BUY' | 'SELL' | 'LIQUIDATE' | 'REDEEM' | 'SKIP' | 'THINK';

const logPath = process.env.DELPHI_AGENT_LOG ?? path.join(os.homedir(), '.delphi', 'agent-events.jsonl');
let dirReady = false;

export function logEvent(type: AgentEventType, text: string, extra: Record<string, unknown> = {}) {
    try {
        if (!dirReady) {
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            dirReady = true;
        }
        fs.appendFileSync(logPath, JSON.stringify({ ts: Date.now(), type, text, ...extra }) + '\n');
    } catch (e) {
        console.warn('eventLog write failed:', (e as Error).message);
    }
}

export function eventLogPath(): string {
    return logPath;
}

/** Read the most recent `limit` events (oldest first). Missing file → []. */
export function readEvents(limit = 300): Array<{ ts: number; type: string; text: string }> {
    let raw: string;
    try {
        raw = fs.readFileSync(logPath, 'utf8');
    } catch {
        return [];
    }
    const out: Array<{ ts: number; type: string; text: string }> = [];
    for (const line of raw.split('\n').slice(-limit)) {
        if (!line.trim()) continue;
        try {
            const e = JSON.parse(line);
            if (e && typeof e.ts === 'number') out.push(e);
        } catch { /* skip malformed line */ }
    }
    return out;
}
