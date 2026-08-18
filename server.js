require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const db = require('./config/db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'RamaGanteng';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── ANTI-CHEAT CONFIG ───────────────────────────────────────────────────────
const AC = {
    MAX_TAPS_PER_REQUEST : 20,    // maks tap per sync (3 detik → ~6-7 TPS normal)
    MAX_TPS_INSTANT      : 8,     // maks TPS dalam 1 interval
    MAX_SCORE_PER_MINUTE : 400,   // skor wajar per menit
    VELOCITY_WINDOW_MS   : 60000,
    MAX_STRIKES          : 3,
    BAN_DURATION_MS      : 300000, // 5 menit
    // Interval tap (dikirim client)
    MIN_INTERVAL_STDDEV  : 60,    // ms — std-dev interval tap < nilai ini = sangat curiga
    MIN_SAMPLES_FOR_INTERVAL: 8,  // minimal sample interval sebelum dicek
};

const userSyncData = {};

function getOrInitUser(tg_id, now) {
    if (!userSyncData[tg_id]) {
        userSyncData[tg_id] = {
            lastSync       : now - 3000,
            scoreThisWindow: 0,
            windowStart    : now,
            strikes        : 0,
            bannedUntil    : 0,
            syncHistory    : [],   // { time, taps, elapsed } — untuk cek pola sync
            intervalBuffer : [],   // interval antar-tap (ms) dikirim client
        };
    }
    return userSyncData[tg_id];
}

/**
 * Hitung std-dev dari array angka.
 */
function stdDev(arr) {
    if (arr.length < 2) return Infinity;
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((a, b) => a + (b - avg) ** 2, 0) / arr.length);
}

/**
 * Multi-layer anti-cheat.
 * @param {string} tg_id
 * @param {number} taps
 * @param {number} now   - Date.now()
 * @param {number[]} tapIntervals - array interval antar-tap (ms) dari client (bisa kosong)
 */
function checkAntiCheat(tg_id, taps, now, tapIntervals) {
    const ud = getOrInitUser(tg_id, now);

    // 1. BAN CHECK
    if (ud.bannedUntil > now) {
        const s = Math.ceil((ud.bannedUntil - now) / 1000);
        return { blocked: true, reason: `Anti-cheat: banned sementara, coba lagi dalam ${s}s.` };
    }

    // 2. MAX TAPS PER REQUEST
    if (taps > AC.MAX_TAPS_PER_REQUEST) {
        if (++ud.strikes >= AC.MAX_STRIKES) ud.bannedUntil = now + AC.BAN_DURATION_MS;
        return { blocked: true, reason: `Anti-cheat: terlalu banyak tap dalam 1 request.` };
    }

    // 3. INSTANT TPS
    const elapsed = Math.max((now - ud.lastSync) / 1000, 0.1);
    const tps = taps / elapsed;
    if (tps > AC.MAX_TPS_INSTANT) {
        if (++ud.strikes >= AC.MAX_STRIKES) ud.bannedUntil = now + AC.BAN_DURATION_MS;
        return { blocked: true, reason: `Anti-cheat: kecepatan tap abnormal (${tps.toFixed(1)} TPS).` };
    }

    // 4. VELOCITY WINDOW (score/menit)
    if (now - ud.windowStart > AC.VELOCITY_WINDOW_MS) {
        ud.scoreThisWindow = 0;
        ud.windowStart = now;
    }
    ud.scoreThisWindow += taps;
    if (ud.scoreThisWindow > AC.MAX_SCORE_PER_MINUTE) {
        if (++ud.strikes >= AC.MAX_STRIKES) ud.bannedUntil = now + AC.BAN_DURATION_MS;
        return { blocked: true, reason: `Anti-cheat: skor per menit terlalu tinggi.` };
    }

    // 5. SYNC-LEVEL BURST PATTERN (interval antar sync request)
    ud.syncHistory.push({ time: now, taps, elapsed });
    if (ud.syncHistory.length > 8) ud.syncHistory.shift();
    if (ud.syncHistory.length >= 6) {
        const syncIntervals = [];
        for (let i = 1; i < ud.syncHistory.length; i++)
            syncIntervals.push(ud.syncHistory[i].time - ud.syncHistory[i-1].time);
        const sd = stdDev(syncIntervals);
        // Sync request yang sangat konsisten (< 80ms std-dev) dengan interval < 3.5 detik = bot
        if (sd < 80 && (syncIntervals.reduce((a,b)=>a+b,0)/syncIntervals.length) < 3500) {
            if (++ud.strikes >= AC.MAX_STRIKES) ud.bannedUntil = now + AC.BAN_DURATION_MS;
            return { blocked: true, reason: `Anti-cheat: pola sync otomatis terdeteksi.` };
        }
    }

    // 6. TAP-LEVEL INTERVAL ANALYSIS (dari data yang dikirim client)
    //    Client mengirim array interval antar-tap dalam batch ini.
    //    Auto-clicker menghasilkan interval yang SANGAT seragam (mis. selalu 100ms ± 5ms).
    //    Manusia asli memiliki variasi > 60ms std-dev.
    if (Array.isArray(tapIntervals) && tapIntervals.length >= AC.MIN_SAMPLES_FOR_INTERVAL) {
        // Tambahkan ke buffer per-user
        ud.intervalBuffer.push(...tapIntervals);
        if (ud.intervalBuffer.length > 50) ud.intervalBuffer.splice(0, ud.intervalBuffer.length - 50);

        if (ud.intervalBuffer.length >= AC.MIN_SAMPLES_FOR_INTERVAL) {
            const sd = stdDev(ud.intervalBuffer);
            const avg = ud.intervalBuffer.reduce((a,b)=>a+b,0) / ud.intervalBuffer.length;
            // Curiga jika std-dev rendah DAN interval rata-rata < 300ms (tap cepat tapi seragam)
            if (sd < AC.MIN_INTERVAL_STDDEV && avg < 300) {
                if (++ud.strikes >= AC.MAX_STRIKES) ud.bannedUntil = now + AC.BAN_DURATION_MS;
                return {
                    blocked: true,
                    reason: `Anti-cheat: interval tap terlalu konsisten (stdDev=${sd.toFixed(1)}ms, avg=${avg.toFixed(0)}ms). Terdeteksi auto-click.`
                };
            }
        }
    }

    // Lulus semua cek
    ud.lastSync = now;
    return { blocked: false };
}
// ─────────────────────────────────────────────────────────────────────────────

let winHistory = [];

let gameState = {
    isActive  : false,
    endTime   : null,
    winnerLink: '',
    previousWinner: null,
    sessionId : 0
};

let autoEndTimer = null; // setInterval/setTimeout handle

/**
 * Fungsi end-session yang dipanggil baik oleh admin maupun auto-timer.
 */
async function endSession() {
    if (!gameState.isActive) return; // sudah berakhir, skip
    gameState.isActive = false;
    gameState.endTime  = new Date().toISOString();
    if (autoEndTimer) { clearTimeout(autoEndTimer); autoEndTimer = null; }

    try {
        const top = await db.query(
            `SELECT tg_id, first_name, total_score FROM users ORDER BY total_score DESC LIMIT 1`
        );
        if (top.rows.length > 0 && parseInt(top.rows[0].total_score) > 0) {
            const winner = top.rows[0];
            const token  = crypto.randomBytes(24).toString('hex');
            winHistory.push({
                tg_id      : winner.tg_id,
                first_name : winner.first_name,
                total_score: winner.total_score,
                token,
                tokenUsed  : false,
                link       : gameState.winnerLink,
                sessionId  : gameState.sessionId,
                wonAt      : new Date().toISOString()
            });
            gameState.previousWinner = {
                tg_id      : winner.tg_id,
                first_name : winner.first_name,
                total_score: winner.total_score
            };
        }
    } catch (err) {
        console.error('[endSession] DB error:', err);
    }
}

/**
 * Jadwalkan auto-end berdasarkan endTime di gameState.
 * Dipanggil setiap kali endTime diperbarui atau sesi dimulai.
 */
function scheduleAutoEnd() {
    if (autoEndTimer) { clearTimeout(autoEndTimer); autoEndTimer = null; }
    if (!gameState.endTime || !gameState.isActive) return;
    const delay = new Date(gameState.endTime).getTime() - Date.now();
    if (delay <= 0) {
        // Waktu sudah lewat, langsung akhiri
        endSession();
        return;
    }
    autoEndTimer = setTimeout(() => endSession(), delay);
    console.log(`[autoEnd] Sesi akan otomatis berakhir dalam ${Math.round(delay/1000)}s`);
}

// ─── API STATE ───────────────────────────────────────────────────────────────
app.get('/api/state', (req, res) => {
    res.json({
        isActive      : gameState.isActive,
        endTime       : gameState.endTime,
        previousWinner: gameState.previousWinner,
        sessionId     : gameState.sessionId
    });
});

// ─── API MY WINS ─────────────────────────────────────────────────────────────
app.get('/api/my-wins/:tg_id', (req, res) => {
    const wins = winHistory
        .filter(w => w.tg_id === req.params.tg_id)
        .map(w => ({
            sessionId  : w.sessionId,
            wonAt      : w.wonAt,
            total_score: w.total_score,
            token      : w.tokenUsed ? null : w.token,
            tokenUsed  : w.tokenUsed
        }));
    res.json(wins);
});

// ─── API ME ──────────────────────────────────────────────────────────────────
app.get('/api/me/:tg_id', async (req, res) => {
    try {
        const r = await db.query(`
            WITH R AS (SELECT tg_id, total_score, RANK() OVER(ORDER BY total_score DESC) as rank FROM users)
            SELECT rank, total_score FROM R WHERE tg_id = $1;
        `, [req.params.tg_id]);
        res.json(r.rows[0] || { rank: '-', total_score: 0 });
    } catch { res.status(500).json({ error: 'Server Error' }); }
});

// ─── API SAVE SCORE ──────────────────────────────────────────────────────────
app.post('/api/save-score', async (req, res) => {
    const { tg_id, username, first_name, taps, tapIntervals } = req.body;
    if (!tg_id || taps === undefined) return res.status(400).json({ error: 'Data tidak valid' });
    if (!gameState.isActive)          return res.status(403).json({ error: 'Sesi telah berakhir' });
    if (typeof taps !== 'number' || taps <= 0) return res.status(400).json({ error: 'Jumlah tap tidak valid' });

    const now   = Date.now();
    const check = checkAntiCheat(tg_id, taps, now, tapIntervals || []);
    if (check.blocked) return res.status(429).json({ error: check.reason, cheat: true });

    try {
        const r = await db.query(`
            INSERT INTO users (tg_id, username, first_name, total_score, last_sync)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            ON CONFLICT (tg_id) DO UPDATE SET
                total_score = users.total_score + EXCLUDED.total_score,
                username    = EXCLUDED.username,
                first_name  = EXCLUDED.first_name,
                last_sync   = CURRENT_TIMESTAMP
            RETURNING total_score;
        `, [tg_id, username, first_name, taps]);
        res.json({ success: true, total_score: r.rows[0].total_score });
    } catch { res.status(500).json({ error: 'Server Error' }); }
});

// ─── API LEADERBOARD ─────────────────────────────────────────────────────────
app.get('/api/leaderboard', async (req, res) => {
    try {
        const r = await db.query(`SELECT tg_id, username, first_name, total_score FROM users ORDER BY total_score DESC LIMIT 10`);
        res.json(r.rows);
    } catch { res.status(500).json({ error: 'Server Error' }); }
});

// ─── API CLAIM ───────────────────────────────────────────────────────────────
app.get('/api/claim/:token', (req, res) => {
    const { token } = req.params;
    const { tg_id } = req.query;
    const win = winHistory.find(w => w.token === token);
    if (!win)            return res.status(403).send('<h2>Token tidak valid atau tidak ditemukan.</h2>');
    if (win.tg_id !== tg_id) return res.status(403).send('<h2>Akses ditolak. Token ini bukan milikmu.</h2>');
    if (win.tokenUsed)   return res.status(410).send('<h2>Link klaim ini sudah pernah digunakan.</h2>');
    if (!win.link)       return res.status(404).send('<h2>Link hadiah belum disiapkan admin.</h2>');
    win.tokenUsed = true;
    res.redirect(win.link);
});

// ─── ADMIN MIDDLEWARE ────────────────────────────────────────────────────────
const isAdmin = (req, res, next) => {
    if (req.headers['x-admin-password'] !== ADMIN_PASSWORD)
        return res.status(403).json({ error: 'Akses Ditolak!' });
    next();
};

// ─── API ADMIN ACTION ────────────────────────────────────────────────────────
app.post('/api/admin/action', isAdmin, async (req, res) => {
    const { action, endTime, winnerLink } = req.body;
    try {
        if (action === 'update_config') {
            if (endTime    !== undefined) gameState.endTime     = endTime;
            if (winnerLink !== undefined) gameState.winnerLink  = winnerLink;
            // Jadwal ulang auto-end jika endTime berubah
            scheduleAutoEnd();
        }
        else if (action === 'start') {
            await db.query(`UPDATE users SET total_score = 0`);
            Object.keys(userSyncData).forEach(k => delete userSyncData[k]);
            gameState.isActive  = true;
            gameState.sessionId += 1;
            if (endTime    !== undefined) gameState.endTime    = endTime;
            if (winnerLink !== undefined) gameState.winnerLink = winnerLink;
            scheduleAutoEnd(); // jadwalkan auto-end berdasarkan endTime
        }
        else if (action === 'end') {
            await endSession(); // panggil fungsi shared
        }
        else if (action === 'reset') {
            const top = await db.query(`SELECT first_name, total_score, tg_id FROM users ORDER BY total_score DESC LIMIT 1`);
            if (top.rows.length > 0) gameState.previousWinner = top.rows[0];
            await db.query(`UPDATE users SET total_score = 0`);
            Object.keys(userSyncData).forEach(k => delete userSyncData[k]);
        }
        else if (action === 'delete') {
            gameState.previousWinner = null;
            winHistory = [];
            Object.keys(userSyncData).forEach(k => delete userSyncData[k]);
            await db.query(`DELETE FROM users`);
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server Error' });
    }
});

app.listen(PORT, () => console.log('🚀 Server berjalan di Port ' + PORT));
