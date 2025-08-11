require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Railway Postgres requires SSL
});

// Test route
app.get("/", async (req, res) => {
  const result = await pool.query("SELECT NOW()");
  res.json({ time: result.rows[0].now });
});

// Example: create a table
app.get("/init", async (req, res) => {
  await pool.query(`CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    text VARCHAR(255)
  )`);
  res.send("Table created!");
});

// Example: insert + fetch
app.post("/message", async (req, res) => {
  const { text } = req.body;
  await pool.query("INSERT INTO messages (text) VALUES ($1)", [text]);
  res.send("Message saved!");
});

app.get("/messages", async (req, res) => {
  const result = await pool.query("SELECT * FROM messages");
  res.json(result.rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
