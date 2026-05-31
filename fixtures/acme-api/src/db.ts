import Database from "better-sqlite3";

// single shared connection — no pooling (flagged in #research)
const db = new Database("acme.db");

export function getUser(id: string) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

export function listUsers() {
  return db.prepare("SELECT * FROM users").all();
}
