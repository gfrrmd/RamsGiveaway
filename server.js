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

/**
 * winHistory: array of { tg_id, first_name, total_score, token, tokenUsed, link, sessionId, wonAt }
 * Setiap sesi yang berakhir dengan pemenang ditambahkan ke sini.
 * Pemenang lama TETAP bisa klaim link lamanya via token masing-masing.
 */
let winHistory = [];

let gameState = {
    isActive: false,
    endTime: null,
    winnerLink: '',
    previousWinner: null,   // Info nama+skor juara terakhir (untuk ditampilkan)
    sessionId: 0            // Incremental session counter
};

const userSyncData = {};

// Helper: cari win record by token
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
        // winnerLink & token TIDAK dikirim di sini
    });
});

// --- API MY WINS: daftar token klaim milik tg_id tertentu ---
app.get('/api/my-wins/:tg_id', (req, res) => {
    const wins = winHistory
        .filter(w => w.tg_id === req.params.tg_id)
        .map(w => ({
            sessionId: w.sessionId,
            wonAt: w.wonAt,
            total_score: w.total_score,
            token: w.tokenUsed ? null : w.token,   // token null jika sudah diklaim
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
    if (taps > 30 || taps <= 0) return res.status(429).json({ error: 'Jumlah tap tidak valid' });

    const now = Date.now();
    const ud = userSyncData[tg_id] || { lastSync: now - 3000 };
    const tps = taps / ((now - ud.lastSync) / 1000 || 1);
    if (tps > 12) return res.status(429).json({ error: 'Auto-clicker terdeteksi!' });
    userSyncData[tg_id] = { lastSync: now };

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

// --- API CLAIM: server-side redirect, link tidak pernah ke client ---
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
            // Sesi baru: reset skor semua user di DB, tapi winHistory tetap
            await db.query(`UPDATE users SET total_score = 0`);
            gameState.isActive = true;
            gameState.sessionId += 1;
            if (endTime !== undefined) gameState.endTime = endTime;
            if (winnerLink !== undefined) gameState.winnerLink = winnerLink;
        }
        else if (action === 'end') {
            gameState.isActive = false;
            gameState.endTime = new Date().toISOString();
            // Cari rank-1, buat token klaim, simpan ke winHistory
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
                    link: gameState.winnerLink,  // Link saat sesi berakhir disimpan permanen di sini
                    sessionId: gameState.sessionId,
                    wonAt: new Date().toISOString()
                });
                gameState.previousWinner = { tg_id: winner.tg_id, first_name: winner.first_name, total_score: winner.total_score };
            }
        }
        else if (action === 'reset') {
            // Simpan pemenang terakhir ke history jika belum tersimpan
            const topUser = await db.query(`SELECT first_name, total_score, tg_id FROM users ORDER BY total_score DESC LIMIT 1`);
            if (topUser.rows.length > 0) gameState.previousWinner = topUser.rows[0];
            await db.query(`UPDATE users SET total_score = 0`);
        }
        else if (action === 'delete') {
            gameState.previousWinner = null;
            winHistory = [];
            await db.query(`DELETE FROM users`);
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server Error' });
    }
});

app.listen(PORT, () => console.log('🚀 Server berjalan di Port ' + PORT));
