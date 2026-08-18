const { Pool } = require('pg');
require('dotenv').config();

// Konfigurasi koneksi ke PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Wajib untuk Railway/Supabase/Neon
});

// Auto-Migrate: Otomatis membuat tabel users jika belum ada
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                tg_id VARCHAR(50) PRIMARY KEY,
                username VARCHAR(100),
                first_name VARCHAR(100),
                total_score INT DEFAULT 0,
                last_sync TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Database PostgreSQL & Tabel 'users' siap digunakan.");
    } catch (err) {
        console.error("❌ Gagal inisialisasi Database:", err);
    }
};

initDB();

module.exports = pool;