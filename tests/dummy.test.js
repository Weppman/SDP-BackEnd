jest.setTimeout(30000); // 30 seconds for all tests and hooks

const request = require("supertest");
const { app, pool } = require("../server");

describe("Express API", () => {

  // Wait for Postgres to be ready
  beforeAll(async () => {
    let connected = false;
    let attempts = 0;
    while (!connected && attempts < 10) { // increase attempts
      try {
        await pool.query("SELECT 1");
        connected = true;
      } catch (err) {
        attempts++;
        console.log(`DB not ready, retrying (${attempts}/10)...`);
        await new Promise(r => setTimeout(r, 2000)); // 2s delay
      }
    }
    if (!connected) throw new Error("Could not connect to DB");
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
