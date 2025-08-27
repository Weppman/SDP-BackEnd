const request = require("supertest");
const { app, pool } = require("../server"); // Make sure server.js exports both app and pool

describe("Express API", () => {

  // Optional: wait a short time before tests if DB is slow
  beforeAll(async () => {
    // Wait 1 second to ensure DB is ready (adjust if needed)
    await new Promise(resolve => setTimeout(resolve, 1000));
  });

  afterAll(async () => {
    // Close database connections to prevent Jest open handle warning
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
