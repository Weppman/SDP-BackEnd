jest.setTimeout(60000);

const request = require("supertest");
const { app, pool } = require("../server");

describe("Express API", () => {
  beforeAll(() => {
    // Mock the database for all tests
    pool.query = jest.fn().mockImplementation((sql, params) => {
      if (sql.includes("SELECT NOW()")) {
        return { rows: [{ now: new Date().toISOString() }] };
      }
      if (sql.includes("SELECT authid FROM usertable")) {
        const uid = params[0];
        if (uid === "1") return { rows: [{ authid: "user_abc123" }] };
        if (uid === "2") return { rows: [{ authid: "user_xyz456" }] };
        return { rows: [] };
      }
      if (sql.includes("SELECT 1")) {
        return { rows: [{ num: 1 }] };
      }
      return { rows: [] };
    });

    // Mock Clerk
    const { clerkClient } = require("@clerk/clerk-sdk-node");
    clerkClient.users.getUser = jest.fn().mockImplementation(async (authid) => {
      if (authid === "user_abc123") return { id: authid, primaryEmailAddress: { emailAddress: "alice@example.com" }, firstName: "Alice", lastName: "A", username: "alice123", imageUrl: "http://example.com/alice.png" };
      if (authid === "user_xyz456") return { id: authid, primaryEmailAddress: { emailAddress: "bob@example.com" }, firstName: "Bob", lastName: "B", username: "bob456", imageUrl: "http://example.com/bob.png" };
      throw new Error("User not found");
    });
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
    const res = await request(app).post("/query").send({});
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty("error", "SQL query is required");
  });

  test("POST /query should return rows for valid SQL", async () => {
    const res = await request(app).post("/query").send({ sql: "SELECT 1 as num" });
    expect(res.statusCode).toBe(200);
    expect(res.body.rows[0]).toHaveProperty("num", 1);
  });

  test("POST /uid returns user data for valid uidArr", async () => {
    const res = await request(app).post("/uid").send({ uidArr: ["1", "2"] });
    expect(res.statusCode).toBe(200);
    expect(res.body.userDatas["1"]).toMatchObject({
      id: "user_abc123",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "A",
      username: "alice123",
      imageUrl: "http://example.com/alice.png",
    });
    expect(res.body.userDatas["2"]).toMatchObject({
      id: "user_xyz456",
      email: "bob@example.com",
      firstName: "Bob",
      lastName: "B",
      username: "bob456",
      imageUrl: "http://example.com/bob.png",
    });
  });
});
