require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./config/db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'RamaGanteng';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- STATE KONTROL ---
let gameState = {
    isActive: true,
    endTime: null,
    winnerLink: "https://t.me/",
    previousWinner: null
};

const userSyncData = {};

// --- API GAME & LEADERBOARD ---
app.get('/api/state', (req, res) => res.json(gameState));

// Endpoint untuk cek rank/posisi user saat ini
app.get('/api/me/:tg_id', async (req, res) => {
    try {
        const query = `
            WITH RankedUsers AS (
                SELECT tg_id, total_score, RANK() OVER(ORDER BY total_score DESC) as rank
                FROM users
            )
            SELECT rank, total_score FROM RankedUsers WHERE tg_id = $1;
        `;
        const result = await db.query(query, [req.params.tg_id]);
        if (result.rows.length > 0) res.json(result.rows[0]);
        else res.json({ rank: '-', total_score: 0 });
    } catch (err) {
        res.status(500).json({ error: "Server Error" });
    }
});

app.post('/api/save-score', async (req, res) => {
    const { tg_id, username, first_name, taps } = req.body;
    if (!tg_id || taps === undefined) return res.status(400).json({ error: "Data tidak valid" });
    if (!gameState.isActive) return res.status(403).json({ error: "Sesi telah berakhir" });

    const now = Date.now();
    const userData = userSyncData[tg_id] || { lastSync: now - 3000 };
    const tps = taps / ((now - userData.lastSync) / 1000 || 1); 
    if (tps > 15) return res.status(429).json({ error: "Auto-clicker terdeteksi!" });

    userSyncData[tg_id] = { lastSync: now };

    try {
        const query = `
            INSERT INTO users (tg_id, username, first_name, total_score, last_sync)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            ON CONFLICT (tg_id) 
            DO UPDATE SET 
                total_score = users.total_score + EXCLUDED.total_score,
                username = EXCLUDED.username,
                first_name = EXCLUDED.first_name,
                last_sync = CURRENT_TIMESTAMP
            RETURNING total_score;
        `;
        const result = await db.query(query, [tg_id, username, first_name, taps]);
        res.json({ success: true, total_score: result.rows[0].total_score });
    } catch (err) {
        res.status(500).json({ error: "Server Error" });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await db.query(`SELECT tg_id, username, first_name, total_score FROM users ORDER BY total_score DESC LIMIT 10`);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Server Error" });
    }
});

// --- API ADMIN PANEL ---
const isAdmin = (req, res, next) => {
    if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(403).json({ error: "Akses Ditolak!" });
    next();
};

app.post('/api/admin/action', isAdmin, async (req, res) => {
    const { action, endTime, winnerLink } = req.body;
    
    try {
        if (action === 'update_config') {
            if (endTime !== undefined) gameState.endTime = endTime;
            if (winnerLink !== undefined) gameState.winnerLink = winnerLink;
        } 
        else if (action === 'start') {
            gameState.isActive = true;
            if (endTime !== undefined) gameState.endTime = endTime;
        } 
        else if (action === 'end') {
            gameState.isActive = false;
            gameState.endTime = new Date().toISOString();
        } 
        else if (action === 'reset') {
            // Simpan juara sebelumnya, skor direset 0
            const topUser = await db.query(`SELECT first_name, total_score, tg_id FROM users ORDER BY total_score DESC LIMIT 1`);
            if (topUser.rows.length > 0) gameState.previousWinner = topUser.rows[0];
            await db.query(`UPDATE users SET total_score = 0`);
        } 
        else if (action === 'delete') {
            // Hapus data total (bersih)
            gameState.previousWinner = null;
            await db.query(`DELETE FROM users`);
        }
        
        res.json({ success: true, gameState });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server Error" });
    }
});

app.listen(PORT, () => console.log(`🚀 Server berjalan di Port ${PORT}`));