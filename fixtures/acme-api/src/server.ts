import express from "express";
import { getUser, listUsers } from "./db";

const app = express();
app.use(express.json());

// TODO: no input validation on :id
app.get("/users/:id", async (req, res) => {
  const user = await getUser(req.params.id);
  if (!user) return res.status(404).json({ error: "not found" });
  res.json(user);
});

app.get("/users", async (_req, res) => {
  res.json(await listUsers());
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`up on :${PORT}`));
