jest.setTimeout(30000); // 30 seconds for all tests and hooks

const request = require("supertest");
const { app, pool } = require("../server");

describe("Express API", () => {

  // Wait for Postgres to be ready
  beforeAll(async () => {
    let connected = false;
    let attempts = 0;
    const maxAttempts = 20;
    
    while (!connected && attempts < maxAttempts) {
      try {
        await pool.query("SELECT 1");
        connected = true;
        console.log("Connected to database successfully");
      } catch (err) {
        attempts++;
        console.log(`DB not ready, retrying (${attempts}/${maxAttempts})...`);
        await new Promise(r => setTimeout(r, 1000)); // 1s delay
      }
    }
    
    if (!connected) {
      console.error("Could not connect to DB after", maxAttempts, "attempts");
      throw new Error("Could not connect to DB");
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
