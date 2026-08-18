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

// ─── ANTI-CHEAT CONFIG ──────────────────────────────────────────────────────
const AC = {
    MAX_TAPS_PER_REQUEST: 20,   // Maks tap dalam 1 request (sync tiap 3 detik = maks ~6-7 TPS)
    MAX_TPS_INSTANT: 8,         // Maks TPS instan (manusia top ~6-7)
    MAX_SCORE_PER_MINUTE: 400,  // Maks skor yang wajar per menit (~6.6 TPS x 60)
    VELOCITY_WINDOW_MS: 60000,  // Window 1 menit untuk cek velocity
    MAX_STRIKES: 3,             // Berapa kali pelanggaran sebelum banned sesi ini
    BAN_DURATION_MS: 300000,    // Ban 5 menit setelah melebihi strikes
};

// userSyncData: { lastSync, scoreThisWindow, windowStart, strikes, bannedUntil, tapHistory[] }
const userSyncData = {};

function getOrInitUser(tg_id, now) {
    if (!userSyncData[tg_id]) {
        userSyncData[tg_id] = {
            lastSync: now - 3000,
            scoreThisWindow: 0,
            windowStart: now,
            strikes: 0,
            bannedUntil: 0,
            recentTaps: [] // array of { time, count }
        };
    }
    return userSyncData[tg_id];
}

function checkAntiCheat(tg_id, taps, now) {
    const ud = getOrInitUser(tg_id, now);

    // 1. BAN CHECK
    if (ud.bannedUntil > now) {
        const remainSec = Math.ceil((ud.bannedUntil - now) / 1000);
        return { blocked: true, reason: `Banned sementara. Coba lagi dalam ${remainSec} detik.` };
    }

    // 2. MAX TAPS PER REQUEST
    if (taps > AC.MAX_TAPS_PER_REQUEST) {
        ud.strikes++;
        if (ud.strikes >= AC.MAX_STRIKES) ud.bannedUntil = now + AC.BAN_DURATION_MS;
        return { blocked: true, reason: `Tap terlalu banyak dalam 1 request (maks ${AC.MAX_TAPS_PER_REQUEST}).` };
    }

    // 3. INSTANT TPS CHECK
    const elapsed = (now - ud.lastSync) / 1000 || 1;
    const instantTps = taps / elapsed;
    if (instantTps > AC.MAX_TPS_INSTANT) {
        ud.strikes++;
        if (ud.strikes >= AC.MAX_STRIKES) ud.bannedUntil = now + AC.BAN_DURATION_MS;
        return { blocked: true, reason: `Kecepatan tap abnormal (${instantTps.toFixed(1)} TPS). Maks ${AC.MAX_TPS_INSTANT} TPS.` };
    }

    // 4. VELOCITY WINDOW (skor per menit)
    // Reset window jika sudah lebih dari 1 menit
    if (now - ud.windowStart > AC.VELOCITY_WINDOW_MS) {
        ud.scoreThisWindow = 0;
        ud.windowStart = now;
    }
    ud.scoreThisWindow += taps;
    if (ud.scoreThisWindow > AC.MAX_SCORE_PER_MINUTE) {
        ud.strikes++;
        if (ud.strikes >= AC.MAX_STRIKES) ud.bannedUntil = now + AC.BAN_DURATION_MS;
        return { blocked: true, reason: `Skor per menit terlalu tinggi (${ud.scoreThisWindow}). Maks ${AC.MAX_SCORE_PER_MINUTE}/menit.` };
    }

    // 5. BURST PATTERN DETECTION (cek apakah tap interval sangat konsisten = bot pattern)
    // Simpan 5 request terakhir
    ud.recentTaps.push({ time: now, taps, elapsed });
    if (ud.recentTaps.length > 6) ud.recentTaps.shift();

    if (ud.recentTaps.length >= 5) {
        // Cek apakah semua request masuk dengan interval SANGAT konsisten (±50ms) = bot
        const intervals = [];
        for (let i = 1; i < ud.recentTaps.length; i++) {
            intervals.push(ud.recentTaps[i].time - ud.recentTaps[i-1].time);
        }
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const variance = intervals.reduce((a, b) => a + Math.pow(b - avgInterval, 2), 0) / intervals.length;
        const stdDev = Math.sqrt(variance);
        // Manusia memiliki variasi interval natural. StdDev < 80ms = sangat mencurigakan
        if (stdDev < 80 && avgInterval < 3500) {
            ud.strikes++;
            if (ud.strikes >= AC.MAX_STRIKES) ud.bannedUntil = now + AC.BAN_DURATION_MS;
            return { blocked: true, reason: `Pola tap bot terdeteksi (interval terlalu konsisten).` };
        }
    }

    // Lulus semua cek
    ud.lastSync = now;
    return { blocked: false };
}
// ────────────────────────────────────────────────────────────────────────────

let winHistory = [];

let gameState = {
    isActive: false,
    endTime: null,
    winnerLink: '',
    previousWinner: null,
    sessionId: 0
};

function findWinByToken(token) {
    return winHistory.find(w => w.token === token);
}

// --- API STATE ---
app.get('/api/state', (req, res) => {
    res.json({
        isActive: gameState.isActive,
        endTime: gameState.endTime,
        previousWinner: gameState.previousWinner,
        sessionId: gameState.sessionId
    });
});

// --- API MY WINS ---
app.get('/api/my-wins/:tg_id', (req, res) => {
    const wins = winHistory
        .filter(w => w.tg_id === req.params.tg_id)
        .map(w => ({
            sessionId: w.sessionId,
            wonAt: w.wonAt,
            total_score: w.total_score,
            token: w.tokenUsed ? null : w.token,
            tokenUsed: w.tokenUsed
        }));
    res.json(wins);
});

// --- API ME ---
app.get('/api/me/:tg_id', async (req, res) => {
    try {
        const result = await db.query(`
            WITH R AS (SELECT tg_id, total_score, RANK() OVER(ORDER BY total_score DESC) as rank FROM users)
            SELECT rank, total_score FROM R WHERE tg_id = $1;
        `, [req.params.tg_id]);
        res.json(result.rows[0] || { rank: '-', total_score: 0 });
    } catch { res.status(500).json({ error: 'Server Error' }); }
});

// --- API SAVE SCORE ---
app.post('/api/save-score', async (req, res) => {
    const { tg_id, username, first_name, taps } = req.body;
    if (!tg_id || taps === undefined) return res.status(400).json({ error: 'Data tidak valid' });
    if (!gameState.isActive) return res.status(403).json({ error: 'Sesi telah berakhir' });
    if (typeof taps !== 'number' || taps <= 0) return res.status(400).json({ error: 'Jumlah tap tidak valid' });

    const now = Date.now();
    const check = checkAntiCheat(tg_id, taps, now);
    if (check.blocked) {
        return res.status(429).json({ error: check.reason, cheat: true });
    }

    try {
        const result = await db.query(`
            INSERT INTO users (tg_id, username, first_name, total_score, last_sync)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            ON CONFLICT (tg_id) DO UPDATE SET
                total_score = users.total_score + EXCLUDED.total_score,
                username = EXCLUDED.username,
                first_name = EXCLUDED.first_name,
                last_sync = CURRENT_TIMESTAMP
            RETURNING total_score;
        `, [tg_id, username, first_name, taps]);
        res.json({ success: true, total_score: result.rows[0].total_score });
    } catch { res.status(500).json({ error: 'Server Error' }); }
});

// --- API LEADERBOARD ---
app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await db.query(`SELECT tg_id, username, first_name, total_score FROM users ORDER BY total_score DESC LIMIT 10`);
        res.json(result.rows);
    } catch { res.status(500).json({ error: 'Server Error' }); }
});

// --- API CLAIM ---
app.get('/api/claim/:token', (req, res) => {
    const { token } = req.params;
    const { tg_id } = req.query;
    const win = findWinByToken(token);
    if (!win) return res.status(403).send('<h2>Token tidak valid atau tidak ditemukan.</h2>');
    if (win.tg_id !== tg_id) return res.status(403).send('<h2>Akses ditolak. Token ini bukan milikmu.</h2>');
    if (win.tokenUsed) return res.status(410).send('<h2>Link klaim ini sudah pernah digunakan.</h2>');
    if (!win.link) return res.status(404).send('<h2>Link hadiah belum disiapkan admin.</h2>');
    win.tokenUsed = true;
    res.redirect(win.link);
});

// --- ADMIN MIDDLEWARE ---
const isAdmin = (req, res, next) => {
    if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Akses Ditolak!' });
    next();
};

// --- API ADMIN ACTION ---
app.post('/api/admin/action', isAdmin, async (req, res) => {
    const { action, endTime, winnerLink } = req.body;
    try {
        if (action === 'update_config') {
            if (endTime !== undefined) gameState.endTime = endTime;
            if (winnerLink !== undefined) gameState.winnerLink = winnerLink;
        }
        else if (action === 'start') {
            await db.query(`UPDATE users SET total_score = 0`);
            // Reset semua tracking anti-cheat untuk sesi baru
            Object.keys(userSyncData).forEach(k => delete userSyncData[k]);
            gameState.isActive = true;
            gameState.sessionId += 1;
            if (endTime !== undefined) gameState.endTime = endTime;
            if (winnerLink !== undefined) gameState.winnerLink = winnerLink;
        }
        else if (action === 'end') {
            gameState.isActive = false;
            gameState.endTime = new Date().toISOString();
            const top = await db.query(`SELECT tg_id, first_name, total_score FROM users ORDER BY total_score DESC LIMIT 1`);
            if (top.rows.length > 0 && parseInt(top.rows[0].total_score) > 0) {
                const winner = top.rows[0];
                const token = crypto.randomBytes(24).toString('hex');
                winHistory.push({
                    tg_id: winner.tg_id,
                    first_name: winner.first_name,
                    total_score: winner.total_score,
                    token,
                    tokenUsed: false,
                    link: gameState.winnerLink,
                    sessionId: gameState.sessionId,
                    wonAt: new Date().toISOString()
                });
                gameState.previousWinner = { tg_id: winner.tg_id, first_name: winner.first_name, total_score: winner.total_score };
            }
        }
        else if (action === 'reset') {
            const topUser = await db.query(`SELECT first_name, total_score, tg_id FROM users ORDER BY total_score DESC LIMIT 1`);
            if (topUser.rows.length > 0) gameState.previousWinner = topUser.rows[0];
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
