import http from 'node:http';
import { setState, performanceSnapshot } from '../persistence/db.js';
import { readEvents } from './eventLog.js';
import * as dotenv from 'dotenv';
dotenv.config();

/**
 * Mobile-first holdings dashboard, served by the agent process itself.
 * Reach it from your phone over Tailscale: http://<tailscale-ip>:8787
 *
 * Control endpoints (halt/resume) require DASHBOARD_TOKEN when set.
 * No external dependencies — plain node:http + Server-Sent Events.
 */

const PORT = Number(process.env.DASHBOARD_PORT) || 8787;
const CONTROL_TOKEN = process.env.DASHBOARD_TOKEN || '';

export interface DashboardData {
    holdings: () => Promise<any>;
    status: () => Promise<any>;
    standings: () => Promise<any>;
}

let data: DashboardData | null = null;

const PAGE = `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MHA Agent</title>
<style>
:root{color-scheme:dark}
body{font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;margin:0;padding:12px;font-size:14px}
h1{font-size:18px;margin:4px 0 12px}h2{font-size:14px;color:#8b949e;margin:16px 0 6px;text-transform:uppercase;letter-spacing:.05em}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px;margin-bottom:10px}
table{width:100%;border-collapse:collapse}td,th{padding:4px 6px;text-align:left;border-bottom:1px solid #21262d;font-size:13px}
th{color:#8b949e;font-weight:500}
.pos{color:#3fb950}.neg{color:#f85149}
button{background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:10px 16px;font-size:14px;margin-right:8px}
button.danger{border-color:#f85149;color:#f85149}
#log{font-family:ui-monospace,monospace;font-size:11px;white-space:pre-wrap;max-height:300px;overflow-y:auto;color:#8b949e}
.stat{display:inline-block;margin-right:16px}.stat b{display:block;font-size:17px}
</style></head><body>
<h1>🤖 MHA — Delphi Agent</h1>
<div class="card" id="status">loading…</div>
<h2>Competition</h2><div class="card" id="standings">loading…</div>
<h2>Holdings</h2><div class="card" id="holdings">loading…</div>
<h2>Controls</h2><div class="card">
<button class="danger" onclick="ctl('halt')">🛑 Halt</button>
<button onclick="ctl('resume')">▶️ Resume</button>
</div>
<h2>Live log</h2><div class="card"><div id="log"></div></div>
<script>
const tok = localStorage.getItem('tok') || '';
async function ctl(a){
  let t = tok || prompt('Control token (from .env DASHBOARD_TOKEN, blank if unset)') || '';
  localStorage.setItem('tok', t);
  const r = await fetch('/api/'+a, {method:'POST', headers:{'x-token':t}});
  alert(await r.text()); refresh();
}
function fmt(n,d=2){return typeof n==='number'?n.toFixed(d):n}
async function refresh(){
  try{
    const s = await (await fetch('/api/status')).json();
    document.getElementById('status').innerHTML =
      '<span class="stat"><b>'+fmt(s.bankroll)+'</b>bankroll TST</span>'+
      '<span class="stat"><b class="'+(s.netPnl>=0?'pos':'neg')+'">'+fmt(s.netPnl)+'</b>realized PnL</span>'+
      '<span class="stat"><b>'+s.trades+'</b>trades today</span>'+
      '<span class="stat"><b>'+(s.halted?'🛑 HALTED':'🟢 ACTIVE')+'</b>state</span>';
    const st = await (await fetch('/api/standings')).json();
    document.getElementById('standings').innerHTML = st.summary ? st.summary :
      'rank '+st.ourRank+' | gap to leader: '+fmt(st.gapToLeader)+' TST';
    const h = await (await fetch('/api/holdings')).json();
    document.getElementById('holdings').innerHTML = h.length===0 ? 'No open positions.' :
      '<table><tr><th>Market</th><th>Side</th><th>Shares</th><th>Mark</th></tr>'+
      h.map(p=>'<tr><td>'+(p.question||p.market).slice(0,48)+'</td><td>'+p.outcome+'</td><td>'+fmt(p.shares)+'</td><td>'+fmt(p.mark)+'</td></tr>').join('')+'</table>';
  }catch(e){}
}
refresh(); setInterval(refresh, 30000);
const es = new EventSource('/api/logstream');
es.onmessage = ev => {
  const el = document.getElementById('log');
  el.textContent += ev.data + '\\n';
  el.scrollTop = el.scrollHeight;
};
</script></body></html>`;

function checkToken(req: http.IncomingMessage): boolean {
    if (!CONTROL_TOKEN) return true;
    return req.headers['x-token'] === CONTROL_TOKEN;
}

export function startDashboard(d: DashboardData) {
    data = d;
    const server = http.createServer(async (req, res) => {
        try {
            const url = req.url || '/';
            if (url === '/' ) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                return res.end(PAGE);
            }
            if (url === '/api/status') {
                const perf = await performanceSnapshot();
                const s = data ? await data.status() : {};
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ ...s, netPnl: perf.netPnl }));
            }
            if (url === '/api/holdings') {
                const h = data ? await data.holdings() : [];
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(h));
            }
            if (url === '/api/standings') {
                const st = data ? await data.standings() : {};
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(st));
            }
            if (url === '/api/logstream') {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive',
                });
                for (const e of readEvents(40)) {
                    res.write(`data: ${new Date(e.ts).toISOString().slice(11, 19)} [${e.type}] ${e.text}\n\n`);
                }
                let lastCount = readEvents(1000).length;
                const timer = setInterval(() => {
                    const all = readEvents(1000);
                    for (const e of all.slice(lastCount)) {
                        res.write(`data: ${new Date(e.ts).toISOString().slice(11, 19)} [${e.type}] ${e.text}\n\n`);
                    }
                    lastCount = all.length;
                }, 5000);
                req.on('close', () => clearInterval(timer));
                return;
            }
            if (url === '/api/halt' && req.method === 'POST') {
                if (!checkToken(req)) { res.writeHead(403); return res.end('bad token'); }
                await setState('halted', '1');
                res.writeHead(200); return res.end('Trading halted.');
            }
            if (url === '/api/resume' && req.method === 'POST') {
                if (!checkToken(req)) { res.writeHead(403); return res.end('bad token'); }
                await setState('halted', '0');
                res.writeHead(200); return res.end('Trading resumed.');
            }
            res.writeHead(404); res.end('not found');
        } catch (e) {
            res.writeHead(500); res.end('error');
        }
    });
    server.listen(PORT, () => console.log(`✅ Dashboard: http://localhost:${PORT} (reach from phone via Tailscale)`));
}
