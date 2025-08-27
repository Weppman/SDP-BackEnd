require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const { clerkMiddleware, requireAuth } = require("@clerk/express");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(clerkMiddleware());

app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://sdp-frontend-production.up.railway.app"
  ],
  methods: ["GET", "POST"],
  credentials: true,
}));

// Use test database configuration when in test environment
const connectionString = process.env.NODE_ENV === 'test' 
  ? 'postgres://postgres:postgres@localhost:5432/testdb'
  : process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: connectionString,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10
});

// Test database connection on startup
pool.on('connect', (client) => {
  console.log('Database connected successfully');
});

pool.on('error', (err) => {
  console.error('Database connection error:', err);
});

app.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ time: result.rows[0].now });
  } catch (error) {
    console.error("Database query error:", error);
    res.status(500).json({ error: "Database connection failed" });
  }
});

app.post("/query", async (req, res) => {
  const { sql } = req.body;

  if (!sql) return res.status(400).json({ error: "SQL query is required" });

  try {
    const result = await pool.query(sql);
    res.json({ rows: result.rows });
  } catch (error) {
    console.error("Query error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/protected", requireAuth(), async (req, res) => {
  const userId = req.auth.userId;
  res.json({ message: "You are logged in!", userId });
});

// Only start server if not in test environment
if (process.env.NODE_ENV !== "test") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = { app, pool };