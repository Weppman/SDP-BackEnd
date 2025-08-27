jest.setTimeout(60000); // 60 seconds for all tests

const request = require("supertest");
const { app, pool } = require("../server");

describe("Express API", () => {
  beforeAll(async () => {
    console.log("Attempting to connect to database...");
    
    let connected = false;
    let attempts = 0;
    const maxAttempts = 30;
    
    while (!connected && attempts < maxAttempts) {
      try {
        // Try a simple query to check connection
        const result = await pool.query("SELECT NOW()");
        console.log("Database connection successful:", result.rows[0]);
        connected = true;
      } catch (err) {
        attempts++;
        console.log(`Database not ready, retrying (${attempts}/${maxAttempts})... Error:`, err.message);
        await new Promise(r => setTimeout(r, 2000)); // 2s delay
      }
    }
    
    if (!connected) {
      console.error("Could not connect to database after", maxAttempts, "attempts");
      throw new Error("Database connection failed");
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  test("GET / should return current time", async () => {
    const res = await request(app).get("/");
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("time");
  });

  test("POST /query should return error if sql missing", async () => {
    const res = await request(app)
      .post("/query")
      .send({});
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty("error", "SQL query is required");
  });

  test("POST /query should return rows for valid SQL", async () => {
    const res = await request(app)
      .post("/query")
      .send({ sql: "SELECT 1 as num" });
    expect(res.statusCode).toBe(200);
    expect(res.body.rows[0]).toHaveProperty("num", 1);
  });
});